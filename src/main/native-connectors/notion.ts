import { NativeHttpClient, object, optionalText, queryText, resourceId, text } from "./http";
import { NativeConnectorError, type NativeAuthorization, type NativeIdentity, type NativeReadResult, type NativeSearchResult } from "./types";

export const NOTION_API_VERSION = "2026-03-11";
function init(auth: NativeAuthorization): RequestInit {
  const credential = auth.credentials;
  if (credential.kind !== "notion" || !credential.token || credential.token.length > 16_384 || /[\r\n\0]/u.test(credential.token)) throw new NativeConnectorError("AUTH_REQUIRED");
  return { headers: { authorization: `Bearer ${credential.token}`, "Notion-Version": NOTION_API_VERSION, "content-type": "application/json" }, signal: auth.signal };
}
function notionId(value: string): string {
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu.test(value)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  return value;
}
function richText(value: unknown, maximum = 128_000): string {
  if (value === undefined) return "";
  if (!Array.isArray(value) || value.length > 1_000) throw new NativeConnectorError("RESPONSE_INVALID");
  let result = "";
  for (const part of value) {
    const content = text(object(part).plain_text, 16_384);
    if (result.length + content.length > maximum) throw new NativeConnectorError("TOO_LARGE");
    result += content;
  }
  return result;
}
function pageTitle(item: Record<string, unknown>): string {
  const properties = object(item.properties);
  if (Object.keys(properties).length > 250) throw new NativeConnectorError("RESPONSE_INVALID");
  for (const value of Object.values(properties)) {
    const property = object(value);
    if (property.type === "title") return richText(property.title, 16_384).slice(0, 1_024);
  }
  return "Untitled";
}
const TEXT_BLOCKS = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout", "code"]);

export class NotionNativeAdapter {
  constructor(private readonly http = new NativeHttpClient()) {}

  async identity(auth: NativeAuthorization): Promise<NativeIdentity> {
    const data = await this.http.json(new URL("https://api.notion.com/v1/users/me"), init(auth), auth.assertCurrent);
    if (data.type !== "bot") throw new NativeConnectorError("AUTH_INVALID");
    const id = notionId(text(data.id, 256)), bot = object(data.bot);
    const workspaceName = optionalText(bot.workspace_name, 1_024);
    return { accountId: id, displayName: workspaceName ?? optionalText(data.name, 1_024) ?? id };
  }

  async search(auth: NativeAuthorization, query: string, cursor?: string, limit = 25): Promise<NativeSearchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    const data = await this.http.json(new URL("https://api.notion.com/v1/search"), { ...init(auth), method: "POST",
      body: JSON.stringify({ query: queryText(query), filter: { value: "page", property: "object" }, page_size: limit,
        ...(cursor ? { start_cursor: text(cursor, 2_048) } : {}) }) }, auth.assertCurrent);
    if (!Array.isArray(data.results) || data.results.length > limit || typeof data.has_more !== "boolean") throw new NativeConnectorError("RESPONSE_INVALID");
    const items = data.results.map(value => { const page = object(value);
      if (page.object !== "page") throw new NativeConnectorError("RESPONSE_INVALID");
      return { id: notionId(text(page.id, 256)), title: pageTitle(page), kind: "page", modifiedAt: optionalText(page.last_edited_time, 128), inTrash: page.in_trash === true };
    }).filter(item => !item.inTrash).map(item => ({ id: item.id, title: item.title, kind: item.kind, ...(item.modifiedAt ? { modifiedAt: item.modifiedAt } : {}) }));
    return { items, nextCursor: data.has_more ? text(data.next_cursor, 2_048) : null,
      scopeNotice: "搜索只匹配已共享页面的标题，不是页面正文搜索，也不代表完整的访问范围。" };
  }

  async read(auth: NativeAuthorization, id: string): Promise<NativeReadResult> {
    notionId(id);
    const page = await this.http.json(new URL(`https://api.notion.com/v1/pages/${id}`), init(auth), auth.assertCurrent);
    if (page.object !== "page" || text(page.id, 256).replace(/-/gu, "").toLowerCase() !== id.replace(/-/gu, "").toLowerCase() || page.in_trash === true) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    const title = pageTitle(page), lines: string[] = [], visited = new Set<string>();
    let count = 0, requests = 0, characters = 0, truncated = false, unsupportedBlocks = 0;
    const append = (value: string): void => {
      const remaining = 128_000 - characters;
      if (value.length > remaining) truncated = true;
      lines.push(value.slice(0, Math.max(0, remaining - (lines.length > 0 ? 1 : 0))));
      characters = Math.min(128_000, characters + value.length + (lines.length > 1 ? 1 : 0));
    };
    const children = async (parentId: string, depth: number): Promise<void> => {
      if (visited.has(parentId) || depth > 16 || count >= 500 || requests >= 32 || characters >= 128_000) { truncated = true; return; }
      visited.add(parentId);
      let cursor: string | undefined;
      do {
        if (requests >= 32) { truncated = true; break; }
        const url = new URL(`https://api.notion.com/v1/blocks/${notionId(parentId)}/children`);
        url.search = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) }).toString();
        requests++;
        const data = await this.http.json(url, init(auth), auth.assertCurrent);
        if (!Array.isArray(data.results) || data.results.length > 100 || typeof data.has_more !== "boolean") throw new NativeConnectorError("RESPONSE_INVALID");
        for (const value of data.results) {
          if (count >= 500 || characters >= 128_000) { truncated = true; break; }
          const block = object(value), blockId = notionId(text(block.id, 256)), type = resourceId(text(block.type, 256));
          count++;
          if (block.in_trash === true) continue;
          if (TEXT_BLOCKS.has(type)) append(richText(object(block[type]).rich_text));
          else if (type === "table_row") {
            const cells = object(block[type]).cells;
            if (!Array.isArray(cells) || cells.length > 100) throw new NativeConnectorError("RESPONSE_INVALID");
            let row = "";
            for (const cell of cells) {
              const value = richText(cell, 128_000 - row.length);
              row += `${row ? " | " : ""}${value}`;
              if (row.length > 128_000) throw new NativeConnectorError("TOO_LARGE");
            }
            append(row);
          } else if (type === "child_page") append(`[${text(object(block[type]).title, 1_024)}]`);
          else if (type === "divider") append("---");
          else if (type !== "table" && type !== "column" && type !== "column_list") { unsupportedBlocks++; append(`[${type}]`); }
          if (block.has_children === true) await children(blockId, depth + 1);
        }
        cursor = data.has_more ? text(data.next_cursor, 2_048) : undefined;
        if (count >= 500 || characters >= 128_000) { if (cursor) truncated = true; break; }
      } while (cursor);
    };
    await children(id, 0);
    auth.assertCurrent(); auth.signal?.throwIfAborted();
    return { id, title, mimeType: "text/plain", text: lines.join("\n"), truncated,
      metadata: { lastEditedAt: optionalText(page.last_edited_time, 128) ?? null, blockCount: count, unsupportedBlocks,
        apiVersion: NOTION_API_VERSION } };
  }
}
