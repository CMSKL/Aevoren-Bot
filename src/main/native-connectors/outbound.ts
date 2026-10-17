import type { ObservedNotionTarget } from "@shared/native-outbound-contracts";
import { createHash } from "node:crypto";
import { bearerToken, NativeHttpClient, object, resourceId, text } from "./http";
import { DRIVE_FILE_SCOPE, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, GoogleNativeOAuth } from "./google-oauth";
import { NOTION_API_VERSION, NotionNativeAdapter } from "./notion";
import { NativeConnectorError, type NativeOutboundRequest, type NativeReconcileHint, type NativeWriteAuthorization, type NativeWriteOutcome } from "./types";
import { NativeWriteHttpClient, safeCommittedHint } from "./write-http";

export function nativeContentDigest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function validate(auth: NativeWriteAuthorization, request: NativeOutboundRequest): void {
  auth.signal?.throwIfAborted(); auth.assertCurrent();
  if (!auth.accountId || !Number.isInteger(auth.authVersion) || auth.authVersion < 1 || !Number.isInteger(auth.writeGrantVersion) || auth.writeGrantVersion < 1
    || !/^[a-f0-9]{64}$/u.test(request.draftDigest)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  resourceId(request.identity.intentId); resourceId(request.identity.dispatchAttemptId);
}
function bounded(value: string, max: number): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  return value;
}
function mailbox(value: string): string {
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u.test(value) || value.length > 320) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  return value;
}
function messageId(value: string | undefined): string {
  if (!value || !/^<[A-Za-z0-9._-]{1,180}@[A-Za-z0-9.-]{1,80}>$/u.test(value)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  return value;
}
function notionId(value: string): string {
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu.test(value)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  return value;
}
function canonicalNotionId(value: string): string { return notionId(value).replace(/-/gu, "").toLowerCase(); }
function richTextValue(value: unknown): string {
  if (!Array.isArray(value) || value.length > 100) throw new NativeConnectorError("RESPONSE_INVALID");
  return value.map(item => { const rich = object(item), txt = object(rich.text);
    if (rich.type !== "text" || typeof txt.content !== "string" || txt.link != null || rich.plain_text !== undefined && rich.plain_text !== txt.content) throw new NativeConnectorError("RESPONSE_INVALID");
    return txt.content;
  }).join("");
}
function notionTarget(page: Record<string, unknown>, expectedId: string): ObservedNotionTarget {
  if (page.object !== "page" || typeof page.id !== "string" || canonicalNotionId(page.id) !== canonicalNotionId(expectedId) || page.in_trash === true || page.archived === true) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  const parent = object(page.parent), kind = parent.type;
  if (kind !== "page_id" && kind !== "data_source_id" && kind !== "workspace") throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  if (kind === "workspace" ? parent.workspace !== true : typeof parent[kind] !== "string" || !canonicalNotionId(parent[kind] as string)) throw new NativeConnectorError("RESPONSE_INVALID");
  const titles = Object.values(object(page.properties)).map(object).filter(property => property.type === "title");
  const property = titles[0];
  if (titles.length !== 1 || !property || typeof property.id !== "string" || !property.id || property.id.length > 256 || /[\0\r\n]/u.test(property.id)) throw new NativeConnectorError("RESPONSE_INVALID");
  const title = richTextValue(property.title);
  if (title.length > 4096 || typeof page.last_edited_time !== "string" || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/u.test(page.last_edited_time)) throw new NativeConnectorError("RESPONSE_INVALID");
  return { pageId: expectedId, titlePropertyId: property.id, title, lastEditedTime: page.last_edited_time, parentType: kind };
}
function matchesParagraph(block: Record<string, unknown>, expectedId: string, pageId: string, expectedText: string): boolean {
  try { const parent = object(block.parent), parentId = parent.type === "page_id" ? parent.page_id : parent.type === "block_id" ? parent.block_id : undefined;
    return block.object === "block" && typeof block.id === "string" && canonicalNotionId(block.id) === canonicalNotionId(expectedId) && block.type === "paragraph" && block.in_trash !== true && block.archived !== true && block.has_children === false
      && typeof parentId === "string" && canonicalNotionId(parentId) === canonicalNotionId(pageId) && richTextValue(object(block.paragraph).rich_text) === expectedText;
  } catch { return false; }
}
function normalizedBody(value: string): string { return value.replace(/\r\n|\r|\n/gu, "\n"); }
function notionParagraphs(value: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (chunk.length + character.length > 2_000) { chunks.push(chunk); chunk = ""; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.length > 100) throw new NativeConnectorError("TOO_LARGE");
  return chunks;
}
function base64Lines(value: string): string { return Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/gu)?.join("\r\n") ?? ""; }
function encodedSubject(value: string): string {
  const chunks: string[] = [];
  let current = "";
  for (const character of value) {
    if (Buffer.byteLength(current + character) > 30 && current) { chunks.push(current); current = ""; }
    current += character;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks.map(chunk => `=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`).join("\r\n ");
}
function gmailPayload(auth: NativeWriteAuthorization, request: NativeOutboundRequest): { mime: string; body: string; subject: string; from: string; to: string[]; cc: string[]; id: string } {
  if (request.content.kind !== "gmail-message") throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  const content = request.content, from = mailbox(auth.accountEmail ?? ""), id = messageId(request.identity.messageId);
  if (!Array.isArray(content.to) || !Array.isArray(content.cc) || !content.to.length || content.to.length + content.cc.length > 100) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  const to = content.to.map(mailbox), cc = content.cc.map(mailbox), subject = bounded(content.subject, 1_024), body = normalizedBody(bounded(content.body, 128_000));
  const allowed = new Set(auth.allowedResourceIds.map(value => value.toLowerCase()));
  if (![...to, ...cc].every(value => allowed.has(value.toLowerCase()))) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  if (/[\r\n]/u.test(subject)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  const mime = [`Message-ID: ${id}`, `From: ${from}`, `To: ${to.join(", ")}`, ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []), `Subject: ${encodedSubject(subject)}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", base64Lines(body)].join("\r\n");
  return { mime, body, subject, from, to, cc, id };
}
function targetId(auth: NativeWriteAuthorization, id: string): string {
  resourceId(id);
  if (!auth.allowedResourceIds.includes(id)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  return id;
}
export function outboundTargetDescriptor(auth: NativeWriteAuthorization, request: NativeOutboundRequest): Record<string, unknown> {
  if (request.operation === "gmail-send") {
    const payload = gmailPayload(auth, request);
    return { operation: request.operation, accountId: auth.accountId, from: payload.from, to: payload.to, cc: payload.cc, messageId: payload.id };
  }
  if ((request.operation === "drive-create-text" || request.operation === "drive-update-text") && request.content.kind === "drive-text") return { operation: request.operation, accountId: auth.accountId,
    fileId: request.operation === "drive-create-text" ? request.identity.reservedResourceId ?? null : request.content.targetFileId, title: request.content.title };
  if (request.operation === "notion-create-page" && request.content.kind === "notion-page") return { operation: request.operation, accountId: auth.accountId, parentPageId: request.content.parentPageId, title: request.content.title };
  if ((request.operation === "notion-update-page-title" && request.content.kind === "notion-page-title" || request.operation === "notion-append-page" && request.content.kind === "notion-page-append") && request.observedNotionTarget)
    return { operation: request.operation, accountId: auth.accountId, pageId: request.content.pageId, observedTarget: request.observedNotionTarget, ...(request.content.kind === "notion-page-append" ? { position: "end" } : {}) };
  throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
}
export function outboundTargetDigest(auth: NativeWriteAuthorization, request: NativeOutboundRequest): string {
  return nativeContentDigest(JSON.stringify(outboundTargetDescriptor(auth, request)));
}

export class NativeOutboundAdapter {
  constructor(private readonly readHttp = new NativeHttpClient(), private readonly writeHttp = new NativeWriteHttpClient()) {}

  private async account(auth: NativeWriteAuthorization, provider: "gmail" | "drive" | "notion"): Promise<void> {
    let identity;
    if (provider === "notion") {
      if (auth.credentials.kind !== "notion") throw new NativeConnectorError("AUTH_REQUIRED");
      identity = await new NotionNativeAdapter(this.readHttp).identity(auth);
    } else {
      if (auth.credentials.kind !== "google" || auth.credentials.provider !== provider) throw new NativeConnectorError("AUTH_REQUIRED");
      if (provider === "gmail" && (!auth.credentials.scopes.includes(GMAIL_READ_SCOPE) || !auth.credentials.scopes.includes(GMAIL_SEND_SCOPE))) throw new NativeConnectorError("AUTH_REQUIRED");
      if (provider === "drive" && (auth.credentials.scopes.length !== 1 || auth.credentials.scopes[0] !== DRIVE_FILE_SCOPE)) throw new NativeConnectorError("AUTH_REQUIRED");
      identity = await new GoogleNativeOAuth(this.readHttp).identity(auth.credentials, auth.signal, auth.assertCurrent);
    }
    if (identity.accountId !== auth.accountId || provider === "gmail" && identity.email?.toLowerCase() !== auth.accountEmail?.toLowerCase()) throw new NativeConnectorError("AUTH_INVALID");
    auth.signal?.throwIfAborted(); auth.assertCurrent();
  }
  private headers(auth: NativeWriteAuthorization): Record<string, string> {
    return { authorization: bearerToken(auth.credentials.kind === "notion" ? auth.credentials.token : auth.credentials.accessToken),
      ...(auth.credentials.kind === "notion" ? { "Notion-Version": NOTION_API_VERSION } : {}) };
  }

  async reserveDriveId(auth: NativeWriteAuthorization): Promise<string> {
    await this.account(auth, "drive");
    const url = new URL("https://www.googleapis.com/drive/v3/files/generateIds"); url.search = "count=1&space=drive&type=files";
    const data = await this.readHttp.json(url, { headers: this.headers(auth), signal: auth.signal }, auth.assertCurrent);
    if (!Array.isArray(data.ids) || data.ids.length !== 1) throw new NativeConnectorError("RESPONSE_INVALID");
    return resourceId(text(data.ids[0], 256));
  }

  async observeDriveVersion(auth: NativeWriteAuthorization, fileId: string): Promise<string> {
    targetId(auth, fileId);
    await this.account(auth, "drive");
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`); url.search = "fields=id,version,trashed,mimeType";
    const current = await this.readHttp.json(url, { headers: this.headers(auth), signal: auth.signal }, auth.assertCurrent);
    if (current.id !== fileId || current.trashed === true || current.mimeType !== "text/plain" || typeof current.version !== "string" || !/^\d{1,30}$/u.test(current.version)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    return current.version;
  }

  async observeNotionTarget(auth: NativeWriteAuthorization, pageId: string): Promise<ObservedNotionTarget> {
    targetId(auth, notionId(pageId)); await this.account(auth, "notion");
    return this.readNotionTarget(auth, pageId);
  }
  private async readNotionTarget(auth: NativeWriteAuthorization, pageId: string): Promise<ObservedNotionTarget> {
    const page = await this.readHttp.json(new URL(`https://api.notion.com/v1/pages/${notionId(pageId)}`), { headers: this.headers(auth), signal: auth.signal }, auth.assertCurrent);
    return notionTarget(page, pageId);
  }
  private async reconcileNotionAppend(auth: NativeWriteAuthorization, request: NativeOutboundRequest, ids?: string[]): Promise<NativeWriteOutcome> {
    if (request.content.kind !== "notion-page-append") throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    const chunks = notionParagraphs(request.content.text), pageId = request.content.pageId;
    if (!ids || ids.length !== chunks.length || new Set(ids.map(canonicalNotionId)).size !== ids.length) return { state: "unknown", reason: "not-proven" };
    for (let index = 0; index < ids.length; index++) {
      const block = await this.readHttp.json(new URL(`https://api.notion.com/v1/blocks/${notionId(ids[index]!)}`), { headers: this.headers(auth), signal: auth.signal }, auth.assertCurrent);
      if (!matchesParagraph(block, ids[index]!, pageId, chunks[index]!)) return { state: "unknown", reason: "not-proven", hint: { childIds: ids } };
    }
    return this.confirmed(request, pageId, { childIds: ids, richTextHashes: chunks.map(nativeContentDigest) });
  }

  async execute(auth: NativeWriteAuthorization, request: NativeOutboundRequest): Promise<NativeWriteOutcome> {
    request = structuredClone(request);
    auth = { ...auth, credentials: structuredClone(auth.credentials), allowedResourceIds: [...auth.allowedResourceIds] };
    validate(auth, request);
    outboundTargetDescriptor(auth, request);
    const provider = request.operation === "gmail-send" ? "gmail" : request.operation.startsWith("notion-") ? "notion" : "drive";
    let url: URL, body: string, method = "POST", contentType = "application/json", resource: string | undefined;
    if (request.operation === "gmail-send") {
      const payload = gmailPayload(auth, request); resource = payload.id;
      url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages/send"); body = JSON.stringify({ raw: Buffer.from(payload.mime).toString("base64url") });
    } else if (request.operation === "drive-create-text" || request.operation === "drive-update-text") {
      if (request.content.kind !== "drive-text") throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
      const name = bounded(request.content.title, 1_024), content = bounded(request.content.text, 128_000);
      resource = request.operation === "drive-create-text" ? resourceId(request.identity.reservedResourceId ?? "") : targetId(auth, request.content.targetFileId ?? "");
      if (request.operation === "drive-create-text" && request.content.targetFileId !== null) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
      let boundary = `aevoren_${nativeContentDigest(request.identity.dispatchAttemptId).slice(0, 32)}`;
      while (content.includes(`--${boundary}`)) boundary += "x";
      const metadata = JSON.stringify({ ...(request.operation === "drive-create-text" ? { id: resource } : {}), name, mimeType: "text/plain", appProperties: { aevorenIntentId: request.identity.intentId } });
      contentType = `multipart/related; boundary=${boundary}`;
      body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--\r\n`;
      url = new URL(`https://www.googleapis.com/upload/drive/v3/files${request.operation === "drive-update-text" ? `/${resource}` : ""}`);
      url.search = "uploadType=multipart&fields=id,name,mimeType,sha256Checksum,version,appProperties";
      if (request.operation === "drive-update-text") method = "PATCH";
    } else if (request.operation === "notion-create-page") {
      if (request.content.kind !== "notion-page") throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
      const parentId = notionId(request.content.parentPageId); targetId(auth, parentId);
      const title = bounded(request.content.title, 2_000), content = bounded(request.content.text, 128_000), chunks = notionParagraphs(content);
      // A flat paragraph sequence stays within Notion's 100-element array and
      // 2,000-character rich-text limits; there are no model-selected properties.
      body = JSON.stringify({ parent: { type: "page_id", page_id: parentId }, properties: { title: { type: "title", title: [{ type: "text", text: { content: title } }] } },
        children: chunks.map(chunk => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] } })) });
      if (Buffer.byteLength(body) > 500_000) throw new NativeConnectorError("TOO_LARGE");
      url = new URL("https://api.notion.com/v1/pages");
    } else if (request.operation === "notion-update-page-title" && request.content.kind === "notion-page-title") {
      resource = targetId(auth, notionId(request.content.pageId));
      if (!request.observedNotionTarget || canonicalNotionId(request.observedNotionTarget.pageId) !== canonicalNotionId(resource)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
      body = JSON.stringify({ properties: { [request.observedNotionTarget.titlePropertyId]: { type: "title", title: [{ type: "text", text: { content: bounded(request.content.title, 2_000) } }] } } });
      method = "PATCH"; url = new URL(`https://api.notion.com/v1/pages/${resource}`);
    } else if (request.operation === "notion-append-page" && request.content.kind === "notion-page-append") {
      resource = targetId(auth, notionId(request.content.pageId));
      if (!request.observedNotionTarget || canonicalNotionId(request.observedNotionTarget.pageId) !== canonicalNotionId(resource)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
      const chunks = notionParagraphs(bounded(request.content.text, 100_000));
      if (!chunks.length) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
      body = JSON.stringify({ children: chunks.map(chunk => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] } })) });
      if (Buffer.byteLength(body) > 500_000) throw new NativeConnectorError("TOO_LARGE");
      // Omitted position appends at the end in API 2026-03-11. Existing body is preserved.
      method = "PATCH"; url = new URL(`https://api.notion.com/v1/blocks/${resource}/children`);
    } else throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    await this.account(auth, provider);
    if (request.operation === "notion-update-page-title" || request.operation === "notion-append-page") {
      const current = await this.readNotionTarget(auth, resource!);
      if (!request.observedNotionTarget || current.titlePropertyId !== request.observedNotionTarget.titlePropertyId || current.parentType !== request.observedNotionTarget.parentType
        || request.operation === "notion-update-page-title" && (current.title !== request.observedNotionTarget.title || current.lastEditedTime !== request.observedNotionTarget.lastEditedTime)) return { state: "rejected", code: "TARGET_CHANGED" };
      // Preflight detects observed changes; Notion does not provide an atomic compare-and-swap here.
    }
    if (request.operation === "drive-update-text") {
      if (!request.observedDriveVersion || !/^\d{1,30}$/u.test(request.observedDriveVersion)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
      const currentUrl = new URL(`https://www.googleapis.com/drive/v3/files/${resource}`); currentUrl.search = "fields=id,version,trashed,mimeType";
      const current = await this.readHttp.json(currentUrl, { headers: this.headers(auth), signal: auth.signal }, auth.assertCurrent);
      if (current.id !== resource || current.trashed === true || current.mimeType !== "text/plain") return { state: "rejected", code: "TARGET_CHANGED" };
      if (current.version !== request.observedDriveVersion) return { state: "rejected", code: "TARGET_CHANGED" };
      // This observes a changed target but does not claim a server-side CAS.
    }
    auth.signal?.throwIfAborted(); auth.assertCurrent();
    const proof = { operation: request.operation, draftDigest: request.draftDigest, targetDigest: outboundTargetDigest(auth, request), wireDigest: nativeContentDigest(body) };
    const result = await this.writeHttp.once(auth, request.identity.dispatchAttemptId, proof, url, { method, headers: { ...this.headers(auth), "content-type": contentType }, body });
    if ("unknown" in result) return { state: "unknown", reason: result.unknown, hint: provider === "gmail" ? { messageId: resource } : resource ? { resourceId: resource } : undefined };
    if (result.status >= 200 && result.status < 300) {
      if (request.operation === "notion-append-page" && request.content.kind === "notion-page-append") {
        const blocks = result.data.results, chunks = notionParagraphs(request.content.text);
        if (!Array.isArray(blocks) || blocks.length !== chunks.length || result.data.has_more !== false) return { state: "unknown", reason: "response-invalid" };
        const ids: string[] = [];
        for (let index = 0; index < blocks.length; index++) {
          const block = object(blocks[index]);
          if (block.object !== "block" || typeof block.id !== "string") return { state: "unknown", reason: "response-invalid" };
          try { notionId(block.id); } catch { return { state: "unknown", reason: "response-invalid" }; }
          ids.push(block.id);
        }
        if (new Set(ids.map(canonicalNotionId)).size !== ids.length) return { state: "unknown", reason: "response-invalid" };
        try { return await this.reconcileNotionAppend(auth, request, ids); }
        catch { return { state: "unknown", reason: "not-proven", hint: { childIds: ids } }; }
      }
      if (request.operation === "notion-update-page-title" && request.content.kind === "notion-page-title") {
        try { const page = notionTarget(result.data, resource!); if (page.titlePropertyId !== request.observedNotionTarget!.titlePropertyId || page.title !== request.content.title) return { state: "unknown", reason: "response-invalid", hint: { resourceId: resource } }; }
        catch { return { state: "unknown", reason: "response-invalid", hint: { resourceId: resource } }; }
        return this.confirmed(request, resource!);
      }
      if (typeof result.data.id !== "string") return { state: "unknown", reason: "response-invalid", ...(resource ? { hint: provider === "gmail" ? { messageId: resource } : { resourceId: resource } } : {}) };
      let id: string;
      try { id = provider === "notion" ? notionId(result.data.id) : resourceId(result.data.id); }
      catch { return { state: "unknown", reason: "response-invalid", ...(resource ? { hint: provider === "gmail" ? { messageId: resource } : { resourceId: resource } } : {}) }; }
      if (provider === "drive" && id !== resource) return { state: "unknown", reason: "response-invalid", hint: { resourceId: resource } };
      return { state: "confirmed", resourceId: id, proofDigest: nativeContentDigest(JSON.stringify({ ...proof, resourceId: id })) };
    }
    if ([400, 401, 403, 404, 413, 422, 429].includes(result.status)) return { state: "rejected", code: `HTTP_${result.status}`, status: result.status };
    return { state: "unknown", reason: "provider-ambiguous", hint: provider === "notion" ? safeCommittedHint(result.data)
      : provider === "gmail" ? { messageId: resource } : { resourceId: resource } };
  }

  async reconcile(auth: NativeWriteAuthorization, request: NativeOutboundRequest, hint?: NativeReconcileHint): Promise<NativeWriteOutcome> {
    request = structuredClone(request);
    hint = hint ? structuredClone(hint) : undefined;
    auth = { ...auth, credentials: structuredClone(auth.credentials), allowedResourceIds: [...auth.allowedResourceIds] };
    validate(auth, request);
    const provider = request.operation === "gmail-send" ? "gmail" : request.operation.startsWith("notion-") ? "notion" : "drive";
    if (provider === "gmail") gmailPayload(auth, request);
    else if (provider === "notion") {
      if (request.content.kind === "notion-page") { targetId(auth, notionId(request.content.parentPageId)); bounded(request.content.title, 2_000); bounded(request.content.text, 128_000); }
      else if (request.content.kind === "notion-page-title" || request.content.kind === "notion-page-append") { targetId(auth, notionId(request.content.pageId)); if (!request.observedNotionTarget) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED"); }
      else throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    } else {
      if (request.content.kind !== "drive-text") throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
      if (request.operation === "drive-update-text") targetId(auth, request.content.targetFileId ?? "");
    }
    await this.account(auth, provider);
    try {
      if (provider === "gmail") return await this.reconcileGmail(auth, request);
      if (provider === "drive") return await this.reconcileDrive(auth, request);
      if (request.content.kind === "notion-page-append") return await this.reconcileNotionAppend(auth, request, hint?.childIds);
      if (request.content.kind === "notion-page-title") {
        const page = await this.readNotionTarget(auth, request.content.pageId);
        if (page.titlePropertyId !== request.observedNotionTarget!.titlePropertyId || page.title !== request.content.title) return { state: "unknown", reason: "not-proven", hint };
        // This proves current target state only, not who caused it or when the write committed.
        return { ...this.confirmed(request, request.content.pageId, { evidence: "target-state", observedTarget: page }), confirmationEvidence: "target-state" };
      }
      if (!hint?.resourceId || request.content.kind !== "notion-page") return { state: "unknown", reason: "not-proven" };
      const id = notionId(hint.resourceId), url = new URL(`https://api.notion.com/v1/pages/${id}`);
      const page = await this.readHttp.json(url, { headers: this.headers(auth), signal: auth.signal }, auth.assertCurrent);
      const parent = object(page.parent);
      if (parent.type !== "page_id" || typeof parent.page_id !== "string" || parent.page_id.replace(/-/gu, "") !== request.content.parentPageId.replace(/-/gu, "")) return { state: "unknown", reason: "not-proven" };
      const read = await new NotionNativeAdapter(this.readHttp).read(auth, id);
      if (read.truncated || read.title !== request.content.title || read.metadata.unsupportedBlocks !== 0
        || read.text !== notionParagraphs(request.content.text).join("\n")) return { state: "unknown", reason: "not-proven" };
      return this.confirmed(request, id);
    } catch (error) {
      auth.signal?.throwIfAborted(); auth.assertCurrent();
      if (error instanceof NativeConnectorError && error.code === "AUTH_INVALID") throw error;
      return { state: "unknown", reason: "not-proven", hint };
    }
  }
  private confirmed(request: NativeOutboundRequest, id: string, evidence?: Record<string, unknown>): Extract<NativeWriteOutcome, { state: "confirmed" }> {
    return { state: "confirmed", resourceId: id, proofDigest: nativeContentDigest(JSON.stringify({ operation: request.operation, draftDigest: request.draftDigest, resourceId: id, ...(evidence ? { evidence } : {}) })) };
  }
  private async reconcileDrive(auth: NativeWriteAuthorization, request: NativeOutboundRequest): Promise<NativeWriteOutcome> {
    if (request.content.kind !== "drive-text") throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    const id = request.operation === "drive-create-text" ? resourceId(request.identity.reservedResourceId ?? "") : targetId(auth, request.content.targetFileId ?? "");
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${id}`); url.search = "fields=id,name,mimeType,sha256Checksum,trashed,appProperties";
    const data = await this.readHttp.json(url, { headers: this.headers(auth), signal: auth.signal }, auth.assertCurrent);
    if (data.id !== id || data.name !== request.content.title || data.mimeType !== "text/plain" || data.trashed === true
      || data.sha256Checksum !== nativeContentDigest(request.content.text) || object(data.appProperties).aevorenIntentId !== request.identity.intentId) return { state: "unknown", reason: "not-proven" };
    return this.confirmed(request, id);
  }
  private async reconcileGmail(auth: NativeWriteAuthorization, request: NativeOutboundRequest): Promise<NativeWriteOutcome> {
    const expected = gmailPayload(auth, request), url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.search = new URLSearchParams({ q: `rfc822msgid:${expected.id}`, labelIds: "SENT", maxResults: "10" }).toString();
    const list = await this.readHttp.json(url, { headers: this.headers(auth), signal: auth.signal }, auth.assertCurrent);
    if (!Array.isArray(list.messages) || list.messages.length !== 1) return { state: "unknown", reason: "not-proven", hint: { messageId: expected.id } };
    const id = resourceId(text(object(list.messages[0]).id, 256)), readUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`); readUrl.search = "format=raw";
    const data = await this.readHttp.json(readUrl, { headers: this.headers(auth), signal: auth.signal }, auth.assertCurrent);
    if (data.id !== id || !Array.isArray(data.labelIds) || !data.labelIds.includes("SENT") || typeof data.raw !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/u.test(data.raw)) return { state: "unknown", reason: "not-proven" };
    const mime = Buffer.from(data.raw, "base64url").toString("utf8"), split = mime.indexOf("\r\n\r\n");
    if (split < 0) return { state: "unknown", reason: "not-proven" };
    const headers = new Map<string, string>();
    for (const line of mime.slice(0, split).replace(/\r\n[ \t]+/gu, " ").split("\r\n")) {
      const colon = line.indexOf(":"); if (colon < 1) continue;
      const key = line.slice(0, colon).toLowerCase(); if (headers.has(key)) return { state: "unknown", reason: "not-proven" };
      headers.set(key, line.slice(colon + 1).trim());
    }
    const expectedHeaders = new Map<string, string>();
    for (const line of expected.mime.slice(0, expected.mime.indexOf("\r\n\r\n")).replace(/\r\n[ \t]+/gu, " ").split("\r\n")) {
      const colon = line.indexOf(":"); expectedHeaders.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
    }
    if (!["message-id", "from", "to", "cc", "subject", "content-type", "content-transfer-encoding"].every(key => headers.get(key) === expectedHeaders.get(key))) return { state: "unknown", reason: "not-proven" };
    const encoded = mime.slice(split + 4).replace(/\s/gu, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || normalizedBody(Buffer.from(encoded, "base64").toString("utf8")) !== expected.body) return { state: "unknown", reason: "not-proven" };
    return this.confirmed(request, id);
  }
}
