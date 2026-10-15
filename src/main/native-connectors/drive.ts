import { bearerToken, MAX_NATIVE_FILE_BYTES, NativeHttpClient, object, optionalText, queryText, resourceId, text } from "./http";
import { DRIVE_FILE_SCOPE } from "./google-oauth";
import { NativeConnectorError, type NativeAuthorization, type NativeReadResult, type NativeSearchResult } from "./types";

const FIELDS = "id,name,mimeType,size,modifiedTime,trashed";
const EXPORT_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};
function init(auth: NativeAuthorization): RequestInit {
  const credential = auth.credentials;
  if (credential.kind !== "google" || credential.provider !== "drive" || credential.scopes.length !== 1 || credential.scopes[0] !== DRIVE_FILE_SCOPE) throw new NativeConnectorError("AUTH_REQUIRED");
  return { headers: { authorization: bearerToken(credential.accessToken) }, signal: auth.signal };
}
function allowedIds(values: readonly string[]): Set<string> {
  if (values.length > 500) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  return new Set(values.map(resourceId));
}
function file(value: unknown): { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string; trashed: boolean } {
  const item = object(value);
  return { id: resourceId(text(item.id, 256)), name: text(item.name, 1_024), mimeType: text(item.mimeType, 256), size: optionalText(item.size, 32),
    modifiedTime: optionalText(item.modifiedTime, 128), trashed: item.trashed === true };
}
function searchCursor(index: number, digest: string): string {
  return Buffer.from(JSON.stringify({ index, digest })).toString("base64url");
}
function cursorIndex(cursor: string | undefined, digest: string, count: number): number {
  if (cursor === undefined) return 0;
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(cursor)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  try {
    const value = object(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (value.digest !== digest || typeof value.index !== "number" || !Number.isInteger(value.index) || value.index < 0 || value.index >= count) {
      throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    }
    return value.index;
  } catch { throw new NativeConnectorError("RESOURCE_NOT_ALLOWED"); }
}
export class DriveNativeAdapter {
  constructor(private readonly http = new NativeHttpClient()) {}

  async search(auth: NativeAuthorization, query: string, selectedOrCreatedIds: readonly string[], cursor?: string, limit = 25): Promise<NativeSearchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    const ids = [...allowedIds(selectedOrCreatedIds)].sort(), title = queryText(query);
    const request = init(auth);
    auth.signal?.throwIfAborted(); auth.assertCurrent();
    const digest = createHash("sha256").update(JSON.stringify({ ids, query: title })).digest("hex");
    const start = cursorIndex(cursor, digest, ids.length), end = Math.min(start + limit, ids.length);
    const items: NativeSearchResult["items"] = [];
    for (let index = start; index < end; index++) {
      const id = ids[index]!;
      const target = new URL(`https://www.googleapis.com/drive/v3/files/${id}`);
      target.search = new URLSearchParams({ fields: FIELDS }).toString();
      let item: ReturnType<typeof file>;
      try { item = file(await this.http.json(target, request, auth.assertCurrent)); }
      catch (error) {
        // A previously selected file can be removed or unshared. Skip only that
        // explicit target; never fall back to listing the broader OAuth grant.
        if (error instanceof NativeConnectorError && (error.status === 403 || error.status === 404)) continue;
        throw error;
      }
      if (item.id !== id) throw new NativeConnectorError("RESPONSE_INVALID");
      if (!item.trashed && item.name.toLowerCase().includes(title.toLowerCase())) items.push({ id: item.id, title: item.name,
        kind: item.mimeType, ...(item.modifiedTime ? { modifiedAt: item.modifiedTime } : {}) });
    }
    auth.signal?.throwIfAborted(); auth.assertCurrent();
    return { items, nextCursor: end < ids.length ? searchCursor(end, digest) : null,
      scopeNotice: "只读取当前授权文件标识的元信息，按文件名包含查询文字进行匹配；每页最多检查 limit 个文件，空页仍可能有下一页。" };
  }

  async read(auth: NativeAuthorization, id: string, selectedOrCreatedIds: readonly string[]): Promise<NativeReadResult> {
    resourceId(id);
    if (!allowedIds(selectedOrCreatedIds).has(id)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    const target = new URL(`https://www.googleapis.com/drive/v3/files/${id}`); target.search = new URLSearchParams({ fields: FIELDS }).toString();
    const item = file(await this.http.json(target, init(auth), auth.assertCurrent));
    if (item.id !== id || item.trashed || item.mimeType === "application/vnd.google-apps.shortcut") throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    if (item.size !== undefined && (!/^\d+$/u.test(item.size) || Number(item.size) > MAX_NATIVE_FILE_BYTES)) throw new NativeConnectorError("TOO_LARGE");
    const metadata = { modifiedAt: item.modifiedTime ?? null, sourceMimeType: item.mimeType, size: item.size ?? null };
    if (item.mimeType === "application/vnd.google-apps.folder") return { id, title: item.name, mimeType: item.mimeType, text: "", truncated: false, metadata };
    const exportType = EXPORT_TYPES[item.mimeType];
    if (item.mimeType.startsWith("application/vnd.google-apps.") && !exportType) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    const contentUrl = new URL(`https://www.googleapis.com/drive/v3/files/${id}${exportType ? "/export" : ""}`);
    contentUrl.search = new URLSearchParams(exportType ? { mimeType: exportType } : { alt: "media" }).toString();
    const content = await this.http.bytes(contentUrl, init(auth), MAX_NATIVE_FILE_BYTES, auth.assertCurrent);
    const mimeType = exportType ?? item.mimeType;
    let contentText = "";
    if (mimeType.startsWith("text/") || ["application/json", "application/xml"].includes(mimeType)) {
      try { contentText = new TextDecoder("utf-8", { fatal: true }).decode(content.bytes); } catch { throw new NativeConnectorError("RESPONSE_INVALID"); }
    }
    auth.assertCurrent(); auth.signal?.throwIfAborted();
    return { id, title: item.name, mimeType, text: contentText.slice(0, 128_000), truncated: contentText.length > 128_000,
      metadata, bytes: content.bytes };
  }
}
import { createHash } from "node:crypto";
