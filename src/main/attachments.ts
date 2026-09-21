import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { AttachmentDraft } from "@shared/contracts";
import { AevorenBotError } from "./errors";

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 1_048_576;
export const MAX_TOTAL_ATTACHMENT_BYTES = 4 * 1_048_576;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".sql": "application/sql",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".sh": "application/x-sh",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".log": "text/plain",
  ".diff": "text/plain",
};

function safeName(path: string): string {
  const name = [...basename(path)].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  }).join("").trim();
  return name.slice(0, 200) || "attachment.txt";
}

function decodeText(bytes: Buffer): string {
  if (bytes.includes(0)) throw new AevorenBotError("ATTACHMENT_UNSUPPORTED");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AevorenBotError("ATTACHMENT_INVALID");
  }
}

export async function readAttachment(path: string): Promise<AttachmentDraft> {
  const extension = extname(path).toLocaleLowerCase("en-US");
  const mimeType = MIME_BY_EXTENSION[extension];
  if (!mimeType) throw new AevorenBotError("ATTACHMENT_UNSUPPORTED");
  let file;
  try {
    file = await stat(path);
  } catch {
    throw new AevorenBotError("ATTACHMENT_INVALID");
  }
  if (!file.isFile()) throw new AevorenBotError("ATTACHMENT_INVALID");
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AevorenBotError("ATTACHMENT_TOO_LARGE");
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new AevorenBotError("ATTACHMENT_INVALID");
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new AevorenBotError("ATTACHMENT_TOO_LARGE");
  const content = decodeText(bytes);
  return {
    id: randomUUID(),
    name: safeName(path),
    mimeType,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "text",
    content,
  };
}

export async function readAttachments(paths: readonly string[]): Promise<AttachmentDraft[]> {
  if (paths.length > MAX_ATTACHMENTS) throw new AevorenBotError("ATTACHMENTS_TOO_MANY");
  const result: AttachmentDraft[] = [];
  let total = 0;
  for (const path of paths) {
    const attachment = await readAttachment(path);
    total += attachment.size;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new AevorenBotError("ATTACHMENT_TOO_LARGE");
    result.push(attachment);
  }
  return result;
}
