import { bearerToken, NativeHttpClient, object, optionalText, queryText, resourceId, text } from "./http";
import { GMAIL_READ_SCOPE } from "./google-oauth";
import { NativeConnectorError, type NativeAuthorization, type NativeReadResult, type NativeSearchResult } from "./types";

const MAX_TEXT = 128_000;
function init(auth: NativeAuthorization): RequestInit {
  const credential = auth.credentials;
  if (credential.kind !== "google" || credential.provider !== "gmail" || !credential.scopes.includes(GMAIL_READ_SCOPE)) throw new NativeConnectorError("AUTH_REQUIRED");
  return { headers: { authorization: bearerToken(credential.accessToken) }, signal: auth.signal };
}
function url(path: string): URL { return new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`); }
function decoded(data: unknown): string {
  const value = text(data, 1_500_000);
  if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(value)) throw new NativeConnectorError("RESPONSE_INVALID");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64url")); }
  catch { throw new NativeConnectorError("RESPONSE_INVALID"); }
}

export class GmailNativeAdapter {
  constructor(private readonly http = new NativeHttpClient()) {}

  async search(auth: NativeAuthorization, query: string, cursor?: string, limit = 25): Promise<NativeSearchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    const target = url("messages");
    target.search = new URLSearchParams({ q: queryText(query), maxResults: String(limit), ...(cursor ? { pageToken: text(cursor, 2_048) } : {}) }).toString();
    const data = await this.http.json(target, init(auth), auth.assertCurrent);
    if (data.messages !== undefined && !Array.isArray(data.messages)) throw new NativeConnectorError("RESPONSE_INVALID");
    const messages = (data.messages ?? []) as unknown[];
    if (messages.length > limit) throw new NativeConnectorError("RESPONSE_INVALID");
    return { items: messages.map(value => { const item = object(value); const id = resourceId(text(item.id, 256));
      return { id, title: id, kind: "email" }; }), nextCursor: optionalText(data.nextPageToken, 2_048) ?? null,
      scopeNotice: "Gmail 搜索返回当前已授权账号的邮件标识；使用读取操作查看标题和正文。" };
  }

  async read(auth: NativeAuthorization, id: string): Promise<NativeReadResult> {
    const target = url(`messages/${resourceId(id)}`); target.search = "format=full";
    const data = await this.http.json(target, init(auth), auth.assertCurrent);
    if (text(data.id, 256) !== id) throw new NativeConnectorError("RESPONSE_INVALID");
    const payload = object(data.payload);
    const metadata: NativeReadResult["metadata"] = { threadId: optionalText(data.threadId, 256) ?? null, snippet: optionalText(data.snippet, 16_384) ?? null };
    if (payload.headers !== undefined && !Array.isArray(payload.headers)) throw new NativeConnectorError("RESPONSE_INVALID");
    for (const value of (payload.headers ?? []) as unknown[]) {
      const header = object(value), name = text(header.name, 256).toLowerCase();
      if (["from", "to", "cc", "subject", "date"].includes(name)) metadata[name] = text(header.value, 16_384);
    }
    const plain: string[] = [], html: string[] = [];
    const attachments: NonNullable<NativeReadResult["attachments"]> = [];
    let partCount = 0, plainText = 0, htmlText = 0, truncated = false;
    const collect = (part: Record<string, unknown>, depth: number): void => {
      if (++partCount > 250 || depth > 16) { truncated = true; return; }
      const mimeType = optionalText(part.mimeType, 256) ?? "application/octet-stream";
      const filename = optionalText(part.filename, 1_024) ?? "";
      const body = part.body === undefined ? {} : object(part.body);
      if (body.attachmentId !== undefined) {
        if (attachments.length >= 100) { truncated = true; return; }
        const size = body.size;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new NativeConnectorError("RESPONSE_INVALID");
        attachments.push({ id: text(body.attachmentId, 2_048), filename, mimeType, size });
      }
      if (!filename && body.data !== undefined && (mimeType === "text/plain" || mimeType === "text/html")) {
        const content = decoded(body.data);
        const remaining = MAX_TEXT - (mimeType === "text/plain" ? plainText : htmlText);
        if (content.length > remaining) truncated = true;
        (mimeType === "text/plain" ? plain : html).push(content.slice(0, Math.max(0, remaining)));
        if (mimeType === "text/plain") plainText += Math.min(content.length, remaining);
        else htmlText += Math.min(content.length, remaining);
      }
      if (part.parts !== undefined) {
        if (!Array.isArray(part.parts)) throw new NativeConnectorError("RESPONSE_INVALID");
        for (const child of part.parts) { if (partCount >= 250) { truncated = true; break; } collect(object(child), depth + 1); }
      }
    };
    collect(payload, 0);
    auth.assertCurrent(); auth.signal?.throwIfAborted();
    const isPlain = plain.length > 0;
    const content = (isPlain ? plain : html).join("\n");
    return { id, title: typeof metadata.subject === "string" ? metadata.subject : id, mimeType: isPlain ? "text/plain" : "text/html",
      text: content.slice(0, MAX_TEXT), truncated: truncated || content.length > MAX_TEXT, metadata, attachments };
  }
}
