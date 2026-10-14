import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserMediaStore, verifiedFrame } from "./browser-media-store";

const directories: string[] = [], png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iFAAAAAASUVORK5CYII=", "base64");
const hash = createHash("sha256").update(png).digest("hex");
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe("owned browser pixel bytes", () => {
  it("verifies actual dimensions and digest and refuses metadata-only pixel claims", () => {
    const frame = { browserSessionId: randomUUID(), pageId: randomUUID(), observationId: randomUUID(), controlEpoch: 1, documentVersion: 1,
      dataBase64: png.toString("base64"), mimeType: "image/png", size: png.length, sha256: hash, width: 1, height: 1, capturedAt: new Date().toISOString() };
    expect(verifiedFrame(frame).bytes).toEqual(png);
    for (const change of [{ width: 99 }, { sha256: "a".repeat(64) }, { dataBase64: "not pixels" }]) expect(() => verifiedFrame({ ...frame, ...change })).toThrow();
  });
  it("deduplicates real byte copies and rejects path escape, conflicting sizes and cancelled reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-owned-browser-media-")); directories.push(directory);
    const store = new BrowserMediaStore(join(directory, "owned"));
    const path = await store.put(png, hash); expect(await store.put(Buffer.from(png), hash)).toBe(path);
    expect(await store.read(path, hash, png.length)).toEqual(png);
    await expect(store.read(join(directory, hash), hash, png.length)).rejects.toMatchObject({ code: "BROWSER_MEDIA_INVALID" });
    await expect(store.read(path, hash, png.length + 1)).rejects.toMatchObject({ code: "BROWSER_MEDIA_INVALID" });
    const cancelled = new AbortController(); cancelled.abort(); await expect(store.read(path, hash, png.length, cancelled.signal)).rejects.toThrow();
  });
});
