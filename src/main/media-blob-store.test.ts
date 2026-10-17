import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { linkSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEDIA_PDF_MAX_BYTES } from "@shared/media-schemas";
import { MediaBlobStore, mediaBytesDigest, readMediaSource } from "./media-blob-store";
import { LibraryBlobStore, MAX_LIBRARY_TEXT_BYTES } from "./library-blob-store";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open), lstat: vi.fn(original.lstat) };
});
const directories: string[] = [];
async function fixture() { const root = await realpath(mkdtempSync(join(tmpdir(), "aevoren-media-blobs-"))); directories.push(root); return root; }
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** Real fd/read/link/unlink; only the ctime-only metadata transition is controlled. */
async function withCtimeUnlink(path: string, temporary: string, verify: (reading: Promise<Buffer>) => Promise<void>, digest?: string): Promise<void> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"), before = statSync(path, { bigint: true });
  const observed: BigIntStats[] = []; let unlinked = false, checks = 0, restoreStat: (() => void) | undefined;
  const controlled = (value: BigIntStats): BigIntStats => {
    observed.push(value);
    return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ctimeNs: before.ctimeNs + (unlinked ? 1n : 0n) }) as BigIntStats;
  };
  vi.mocked(lstat).mockImplementation((async (...args: Parameters<typeof lstat>) => {
    const value = await actual.lstat(...args);
    return String(args[0]) === path && args[1]?.bigint ? controlled(value as BigIntStats) : value;
  }) as typeof lstat);
  vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof open>) => {
    const handle = await actual.open(...args), stat = handle.stat.bind(handle);
    const spy = vi.spyOn(handle, "stat").mockImplementation((async (options?: { bigint?: boolean }) => {
      if (!options?.bigint) throw new Error("Controlled reader requires bigint identity");
      return controlled(await stat({ bigint: true }));
    }) as FileHandle["stat"]);
    restoreStat = () => spy.mockRestore(); return handle;
  });
  try {
    expect(before.nlink).toBe(2n);
    await verify(readMediaSource(path, () => { if (++checks === 3) { unlinkSync(temporary); unlinked = true; } }, digest));
    expect(unlinked).toBe(true); expect(observed.length).toBeGreaterThanOrEqual(4);
    for (const value of [...observed, statSync(path, { bigint: true })]) {
      for (const key of ["dev", "ino", "mode", "size", "mtimeNs"] as const) expect(value[key]).toBe(before[key]);
    }
    expect(statSync(path, { bigint: true }).nlink).toBe(1n);
  } finally { restoreStat?.(); vi.mocked(open).mockImplementation(actual.open); vi.mocked(lstat).mockImplementation(actual.lstat); }
}
describe("owned media CAS", () => {
  it("stores bytes above the independent Skill ceiling and deduplicates without changing bytes", async () => {
    const root = await fixture(), bytes = Buffer.alloc(MAX_LIBRARY_TEXT_BYTES + 1, 65), store = new MediaBlobStore(join(root, "media"));
    await expect(new LibraryBlobStore(join(root, "library")).put(bytes)).rejects.toMatchObject({ code: "LIBRARY_IMPORT_TOO_LARGE" });
    const sha = await store.put(bytes);
    expect(sha).toBe(mediaBytesDigest(bytes)); expect(await store.put(bytes)).toBe(sha);
    expect((await store.read(sha, bytes.length)).equals(bytes)).toBe(true);
    expect(readdirSync(join(root, "media", sha.slice(0, 2)))).toEqual([sha]);
    await expect(store.put(Buffer.alloc(MEDIA_PDF_MAX_BYTES + 1))).rejects.toMatchObject({ code: "MEDIA_IMPORT_TOO_LARGE" });
  });
  it("rejects corrupt and replaced blob bytes instead of returning a matching path", async () => {
    const root = await fixture(), store = new MediaBlobStore(join(root, "media")), original = Buffer.from("verified binary");
    const sha = await store.put(original); writeFileSync(join(root, "media", sha.slice(0, 2), sha), Buffer.alloc(original.length, 66));
    await expect(store.read(sha, original.length)).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
    await expect(store.read("../outside", 1)).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
  });
  it("rejects a changed file identity across the actual fd read and respects cancellation", async () => {
    const root = await fixture(), path = join(root, "input.pdf"); writeFileSync(path, "%PDF-1.7\noriginal");
    const before = statSync(path, { bigint: true });
    let checks = 0, mutationObserved = false;
    await expect(readMediaSource(path, () => { if (++checks === 3) {
      writeFileSync(path, "%PDF-1.7\nmodified");
      // A fast same-sized Windows write need not expose a distinct timestamp.
      utimesSync(path, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9 + 1);
      const changed = statSync(path, { bigint: true });
      expect(changed.size).toBe(before.size); expect(changed.mtimeNs).not.toBe(before.mtimeNs);
      mutationObserved = true;
    } })).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
    expect(mutationObserved).toBe(true);
    const controller = new AbortController(); controller.abort();
    await expect(new MediaBlobStore(join(root, "media")).put(Buffer.from("no publication"), controller.signal)).rejects.toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
  });
  it("accepts a controlled ctime-only staging unlink across a real fd read with the known digest", async () => {
    const root = await fixture(), store = new MediaBlobStore(join(root, "media")), bytes = Buffer.from("same verified content");
    const sha = await store.put(bytes), path = join(await realpath(join(root, "media", sha.slice(0, 2))), sha), temporary = join(root, "staging-link");
    linkSync(path, temporary);
    await withCtimeUnlink(path, temporary, async reading => { expect(await reading).toEqual(bytes); }, sha);
  });
  it("keeps ctime validation for raw sources and rejects final digest tampering inside the CAS reader", async () => {
    const root = await fixture(), path = join(root, "source.pdf"), temporary = join(root, "source-link"); writeFileSync(path, "%PDF-1.7 original"); linkSync(path, temporary);
    await withCtimeUnlink(path, temporary, async reading => { await expect(reading).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" }); });
    const expected = mediaBytesDigest(Buffer.from("original")); writeFileSync(path, "tampered");
    await expect(readMediaSource(path, () => {}, expected)).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
  });
  it("publishes equal blobs concurrently without rejecting a sibling's valid content", async () => {
    const root = await fixture(), store = new MediaBlobStore(join(root, "media")), bytes = Buffer.alloc(1_048_576, 87);
    const values = await Promise.all(Array.from({ length: 6 }, () => store.put(bytes)));
    expect(new Set(values)).toEqual(new Set([mediaBytesDigest(bytes)])); expect((await store.read(values[0]!, bytes.length)).equals(bytes)).toBe(true);
  });
  it.skipIf(process.platform === "win32")("does not follow source or CAS symlinks", async () => {
    const root = await fixture(), outside = join(root, "outside.pdf"), alias = join(root, "alias.pdf"); writeFileSync(outside, "%PDF-1.7\nprivate"); symlinkSync(outside, alias);
    await expect(readMediaSource(alias, () => {})).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
    const cas = join(root, "cas"); symlinkSync(root, cas);
    await expect(new MediaBlobStore(cas).put(Buffer.from("private"))).rejects.toMatchObject({ code: "MEDIA_CONTENT_INVALID" });
  });
});
