import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readAttachments, readAttachment } from "./attachments";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});
describe("attachments", () => {
  it("reads bounded UTF-8 text without exposing the source path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-attachments-"));
    directories.push(directory);
    const filename = join(directory, "brief.md");
    const content = "# Brief\n\nKeep this source bounded.";
    writeFileSync(filename, content, "utf8");

    const [attachment] = await readAttachments([filename]);
    expect(attachment).toMatchObject({
      name: "brief.md",
      mimeType: "text/markdown",
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      kind: "text",
      content,
    });
    expect(JSON.stringify(attachment)).not.toContain(directory);
  });

  it("rejects unsupported, binary, oversized and excessive selections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-attachments-invalid-"));
    directories.push(directory);
    const binary = join(directory, "image.png");
    writeFileSync(binary, Buffer.from([0, 1, 2]));
    await expect(readAttachment(binary)).rejects.toMatchObject({ code: "ATTACHMENT_UNSUPPORTED" });

    const unknown = join(directory, "payload.bin");
    writeFileSync(unknown, "not allowed", "utf8");
    await expect(readAttachment(unknown)).rejects.toMatchObject({ code: "ATTACHMENT_UNSUPPORTED" });

    const files = Array.from({ length: 7 }, (_, index) => {
      const path = join(directory, `${index}.txt`);
      writeFileSync(path, "x", "utf8");
      return path;
    });
    await expect(readAttachments(files)).rejects.toMatchObject({ code: "ATTACHMENTS_TOO_MANY" });
  });
});
