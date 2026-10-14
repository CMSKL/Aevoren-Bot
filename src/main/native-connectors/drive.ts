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
export class DriveNativeAdapter {
  constructor(private readonly http = new NativeHttpClient()) {}

  async search(auth: NativeAuthorization, query: string, selectedOrCreatedIds: readonly string[], cursor?: string, limit = 25): Promise<NativeSearchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    const allowed = allowedIds(selectedOrCreatedIds), title = queryText(query);
    const target = new URL("https://www.googleapis.com/drive/v3/files");
    target.search = new URLSearchParams({ q: `trashed = false${title ? ` and name contains '${title.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'` : ""}`,
      fields: `nextPageToken,files(${FIELDS})`, pageSize: String(limit), ...(cursor ? { pageToken: text(cursor, 2_048) } : {}) }).toString();
    const data = await this.http.json(target, init(auth), auth.assertCurrent);
    if (!Array.isArray(data.files) || data.files.length > limit) throw new NativeConnectorError("RESPONSE_INVALID");
    return { items: data.files.map(file).filter(item => allowed.has(item.id) && !item.trashed).map(item => ({ id: item.id, title: item.name,
      kind: item.mimeType, ...(item.modifiedTime ? { modifiedAt: item.modifiedTime } : {}) })), nextCursor: optionalText(data.nextPageToken, 2_048) ?? null,
      scopeNotice: "仅显示用户通过文件选择器选择、或本应用创建并明确授权的文件；空页仍可能有下一页。" };
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
