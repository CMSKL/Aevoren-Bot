import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CDPSession } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_DOWNLOAD_MAX_BYTES } from "@shared/browser-contracts";
import { CdpDownloads, type DownloadLease } from "./cdp-downloads";
import type { ControlRecord, DownloadFailure, DownloadRecord } from "./state-store";

const resources: Array<{ downloads: CdpDownloads; directory: string }> = [];
async function fixture(resolvePage: (frame: string) => Promise<string | null> = async () => randomUUID()) {
  const directory = await mkdtemp(join(tmpdir(), "aevoren-cdp-download-")), events = new EventEmitter();
  const session = Object.assign(events, { send: vi.fn(async (_method: string, _input?: unknown) => ({})) }) as unknown as CDPSession;
  let control: ControlRecord = { owner: "ai", epoch: 1, needsObservation: false };
  let beforeControlRead: (() => void) | undefined;
  const completed: Array<{ record: DownloadRecord; lease: DownloadLease }> = [], failures: DownloadFailure[] = [];
  const downloads = new CdpDownloads({ session, directory, resolvePage, currentControl: () => { beforeControlRead?.(); return control; },
    onDownload: (record, lease) => completed.push({ record, lease }), onFailure: record => failures.push(record) });
  resources.push({ downloads, directory }); await downloads.start();
  const begin = (guid: string, name = "actual.bin") => events.emit("Browser.downloadWillBegin", { guid, frameId: "owned-frame", suggestedFilename: name, url: "https://private-source.test/no-url-in-record" });
  const progress = (guid: string, bytes: number, state = "completed") => events.emit("Browser.downloadProgress", { guid, receivedBytes: bytes, totalBytes: bytes, state });
  return { downloads, directory, events, session, completed, failures, begin, progress, control(value: ControlRecord) { control = value; }, beforeControlRead(fn: () => void) { beforeControlRead = fn; } };
}
afterEach(async () => {
  for (const resource of resources.splice(0)) { await resource.downloads.close(); await rm(resource.directory, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});

describe("public CDP download events with controlled transport and real filesystem bytes", () => {
  it("configures allowAndName, handles completion before page mapping and publishes exact immutable bytes with the captured lease", async () => {
    let mapped!: (page: string) => void;
    const mapping = new Promise<string>(accept => { mapped = accept; }), pageId = randomUUID();
    const f = await fixture(async () => mapping), guid = randomUUID(), bytes = Buffer.from([0, 1, 2, 255, 13, 10]);
    expect(vi.mocked(f.session.send)).toHaveBeenCalledWith("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: f.downloads.rawDirectory, eventsEnabled: true });
    await writeFile(join(f.downloads.rawDirectory, guid), bytes); f.begin(guid, "../real\\file.bin"); f.progress(guid, bytes.length);
    expect(f.completed).toEqual([]); mapped(pageId);
    await expect.poll(() => f.completed.length).toBe(1);
    const result = f.completed[0]!;
    expect(result).toMatchObject({ lease: { owner: "ai", epoch: 1 }, record: { pageId, name: ".._real_file.bin", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
    expect(JSON.stringify(result)).not.toMatch(/private-source|dataBase64|\.cdp-raw/);
    expect(await readFile(join(f.directory, result.record.id))).toEqual(bytes);
    await expect.poll(async () => (await readdir(f.downloads.rawDirectory)).length).toBe(0);
    f.begin(guid); f.progress(guid, bytes.length); expect(f.completed).toHaveLength(1);
  });
  it("cancels an oversized transfer immediately and emits only failure metadata after its real page is known", async () => {
    let mapped!: (page: string) => void;
    const mapping = new Promise<string>(accept => { mapped = accept; }), pageId = randomUUID(), f = await fixture(async () => mapping), guid = randomUUID();
    await writeFile(join(f.downloads.rawDirectory, `${guid}.crdownload`), "partial"); f.begin(guid); f.progress(guid, BROWSER_DOWNLOAD_MAX_BYTES + 1, "inProgress");
    expect(vi.mocked(f.session.send)).toHaveBeenCalledWith("Browser.cancelDownload", { guid }); mapped(pageId);
    await expect.poll(() => f.failures.length).toBe(1);
    expect(f.failures[0]).toMatchObject({ pageId, errorCode: "BROWSER_DOWNLOAD_TOO_LARGE" });
    expect(JSON.stringify(f.failures[0])).not.toMatch(/sha256|size|url/); expect(f.completed).toEqual([]);
    await expect.poll(async () => (await readdir(f.downloads.rawDirectory)).length).toBe(0);
    expect((await readdir(f.directory)).filter(name => name !== ".cdp-raw")).toEqual([]);
  });
  it("seals an ownership change while frame mapping is pending, cancels only its GUID and cannot publish a late result", async () => {
    let mapped!: (page: string) => void;
    const mapping = new Promise<string>(accept => { mapped = accept; }), f = await fixture(async () => mapping), guid = randomUUID(), sentinel = randomUUID();
    await writeFile(join(f.downloads.rawDirectory, guid), "must be removed"); await writeFile(join(f.directory, sentinel), "other completed download");
    f.begin(guid); f.progress(guid, 15);
    f.control({ owner: "user", epoch: 2, needsObservation: true }); await f.downloads.controlChanged(); mapped(randomUUID());
    expect(f.completed).toEqual([]); expect(f.failures).toEqual([]);
    expect(await readdir(f.downloads.rawDirectory)).toEqual([]); expect(await readFile(join(f.directory, sentinel), "utf8")).toBe("other completed download");
    expect(vi.mocked(f.session.send).mock.calls.filter(([method]) => method === "Browser.cancelDownload")).toEqual([["Browser.cancelDownload", { guid }]]);
  });
  it("does not associate an unknown frame with an active page or invent successful media", async () => {
    const f = await fixture(async () => null), guid = randomUUID(); await writeFile(join(f.downloads.rawDirectory, guid), "unknown source");
    f.begin(guid); f.progress(guid, 14);
    await expect.poll(async () => (await readdir(f.downloads.rawDirectory)).length).toBe(0);
    expect(f.completed).toEqual([]); expect(f.failures).toEqual([]);
    expect(vi.mocked(f.session.send)).toHaveBeenCalledWith("Browser.cancelDownload", { guid });
  });
  it("rejects GUID traversal without issuing control requests or touching files", async () => {
    const f = await fixture(); f.begin("../external-sentinel"); f.progress("../external-sentinel", 17);
    expect(vi.mocked(f.session.send).mock.calls).toHaveLength(1); expect(await readdir(f.directory)).toEqual([".cdp-raw"]);
    expect(f.completed).toEqual([]); expect(f.failures).toEqual([]);
  });
  it.skipIf(process.platform === "win32")("refuses symlink bytes while preserving the external target", async () => {
    const f = await fixture(), guid = randomUUID(), outside = join(f.directory, "external-sentinel"); await writeFile(outside, "keep actual bytes");
    f.begin("../external-sentinel"); f.progress("../external-sentinel", 17); expect(vi.mocked(f.session.send).mock.calls).toHaveLength(1);
    await symlink(outside, join(f.downloads.rawDirectory, guid)); f.begin(guid); f.progress(guid, 17);
    await expect.poll(() => f.failures.length).toBe(1); expect(f.failures[0]?.errorCode).toBe("BROWSER_DOWNLOAD_INVALID");
    expect(await readFile(outside, "utf8")).toBe("keep actual bytes"); expect(f.completed).toEqual([]);
  });
  it("checks the actual completed file size independently of progress metadata and removes every owned partial", async () => {
    const f = await fixture(), guid = randomUUID(); await writeFile(join(f.downloads.rawDirectory, guid), Buffer.alloc(BROWSER_DOWNLOAD_MAX_BYTES + 1));
    f.begin(guid); f.progress(guid, 1);
    await expect.poll(() => f.failures.length).toBe(1); expect(f.failures[0]?.errorCode).toBe("BROWSER_DOWNLOAD_TOO_LARGE");
    await expect.poll(async () => (await readdir(f.downloads.rawDirectory)).length).toBe(0);
    expect((await readdir(f.directory)).filter(name => name !== ".cdp-raw")).toEqual([]); expect(f.completed).toEqual([]);
  });
  it("rechecks the lease after the actual final rename and removes completed bytes instead of publishing during takeover", async () => {
    const f = await fixture(), guid = randomUUID(), bytes = Buffer.from("post-rename boundary");
    await writeFile(join(f.downloads.rawDirectory, guid), bytes);
    let changed = false;
    f.beforeControlRead(() => {
      if (!changed && readdirSync(f.directory).some(name => /^[a-f0-9-]{36}$/.test(name) && readFileSync(join(f.directory, name)).equals(bytes))) {
        changed = true; f.control({ owner: "user", epoch: 2, needsObservation: true });
      }
    });
    f.begin(guid); f.progress(guid, bytes.length);
    await expect.poll(() => changed).toBe(true);
    await expect.poll(async () => (await readdir(f.directory)).filter(name => name !== ".cdp-raw").length).toBe(0);
    expect(await readdir(f.downloads.rawDirectory)).toEqual([]); expect(f.completed).toEqual([]); expect(f.failures).toEqual([]);
  });
  it("accepts the full 1 MiB boundary as real user-owned binary content", async () => {
    const f = await fixture(), guid = randomUUID(), bytes = Buffer.alloc(BROWSER_DOWNLOAD_MAX_BYTES, 255);
    f.control({ owner: "user", epoch: 7, needsObservation: true }); await writeFile(join(f.downloads.rawDirectory, guid), bytes);
    f.begin(guid); f.progress(guid, bytes.length);
    await expect.poll(() => f.completed.length).toBe(1);
    expect(f.completed[0]).toMatchObject({ lease: { owner: "user", epoch: 7 }, record: { size: BROWSER_DOWNLOAD_MAX_BYTES } });
    expect(await readFile(join(f.directory, f.completed[0]!.record.id))).toEqual(bytes);
  });
  it("closes pending downloads and listeners without deleting a sibling's completed data", async () => {
    const f = await fixture(async () => new Promise(() => {})), guid = randomUUID(), sibling = randomUUID();
    await writeFile(join(f.downloads.rawDirectory, `${guid}.crdownload`), "pending"); await writeFile(join(f.directory, sibling), "completed sibling");
    f.begin(guid); await f.downloads.close();
    expect(f.events.listenerCount("Browser.downloadWillBegin")).toBe(0); expect(f.events.listenerCount("Browser.downloadProgress")).toBe(0);
    expect(await readdir(f.downloads.rawDirectory)).toEqual([]); expect(await readFile(join(f.directory, sibling), "utf8")).toBe("completed sibling");
    expect(f.completed).toEqual([]); expect(f.failures).toEqual([]);
  });
});
