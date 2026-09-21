import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ArtifactSaveInput, ArtifactSaveResult } from "@shared/contracts";
import { AevorenBotError } from "./errors";

const MAX_ARTIFACT_BYTES = 2 * 1_048_576;

function safeName(value: string): string {
  const name = [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  }).join("").trim();
  const base = basename(name || "aevoren-result.md");
  return base.toLocaleLowerCase("en-US").endsWith(".md") ? base : `${base}.md`;
}
export async function saveArtifact(path: string, input: ArtifactSaveInput): Promise<ArtifactSaveResult> {
  const name = safeName(input.name);
  const size = Buffer.byteLength(input.content, "utf8");
  if (size > MAX_ARTIFACT_BYTES) throw new AevorenBotError("ARTIFACT_TOO_LARGE");
  try {
    await writeFile(path, input.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new AevorenBotError("ARTIFACT_ALREADY_EXISTS");
    }
    throw new AevorenBotError("ARTIFACT_SAVE_FAILED");
  }
  return { name, path, size };
}
