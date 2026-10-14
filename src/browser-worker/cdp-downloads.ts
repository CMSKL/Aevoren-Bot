import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CDPSession } from "playwright-core";
import { z } from "zod";
import { BROWSER_DOWNLOAD_MAX_BYTES } from "@shared/browser-contracts";
import type { ControlRecord, DownloadFailure, DownloadRecord } from "./state-store";
import { BrowserWorkerError } from "./worker-error";

export type DownloadLease = Pick<ControlRecord, "epoch" | "owner">;
export type CdpDownloadsOptions = {
  session: CDPSession;
  directory: string;
  resolvePage(frameId: string): Promise<string | null>;
  currentControl(): ControlRecord;
  onDownload(record: DownloadRecord, lease: DownloadLease): void;
  onFailure(record: DownloadFailure, lease: DownloadLease): void;
};
const uuid = z.string().uuid();
const beginSchema = z.object({ guid: uuid, frameId: z.string().min(1).max(200), suggestedFilename: z.string().max(8_192).optional() });
const progressSchema = z.object({ guid: uuid, receivedBytes: z.number().finite().nonnegative(), totalBytes: z.number().finite().nonnegative(), state: z.enum(["inProgress", "completed", "canceled"]) });
type Pending = {
  guid: string; id: string; name: string; lease: DownloadLease; pageId: string | null;
  error: string | null; published: boolean; temporaryOwned: boolean; finalOwned: boolean;
  cancelling: Promise<void> | null;
  terminal(): void; cancelMapping(): void; task: Promise<void>; timer: ReturnType<typeof setTimeout>;
};

/** Public CDP events plus immutable application IDs; no Playwright download internals. */
export class CdpDownloads {
  readonly rawDirectory: string;
  private root: string | null = null;
  private closed = false;
  private started = false;
  private readonly active = new Map<string, Pending>();
  private readonly seen = new Set<string>();
  constructor(private readonly options: CdpDownloadsOptions) { this.rawDirectory = join(options.directory, ".cdp-raw"); }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new BrowserWorkerError("BROWSER_DOWNLOAD_INVALID", 409);
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.options.directory)).isDirectory() || (await lstat(this.options.directory)).isSymbolicLink()) throw new BrowserWorkerError("BROWSER_DOWNLOAD_INVALID", 409);
    this.root = await realpath(this.options.directory);
    await mkdir(this.rawDirectory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await this.assertDirectories();
    this.options.session.on("Browser.downloadWillBegin", this.begin);
    this.options.session.on("Browser.downloadProgress", this.progress);
    try {
      await this.options.session.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.rawDirectory, eventsEnabled: true });
      this.started = true;
    } catch (error) { this.removeListeners(); throw error; }
  }

  private async assertDirectories(): Promise<void> {
    const raw = await lstat(this.rawDirectory);
    if (!this.root || !raw.isDirectory() || raw.isSymbolicLink() || await realpath(this.options.directory) !== this.root
      || await realpath(this.rawDirectory) !== join(this.root, ".cdp-raw")) throw new BrowserWorkerError("BROWSER_DOWNLOAD_INVALID", 409);
  }
  private current(record: Pending): boolean {
    const control = this.options.currentControl();
    return !this.closed && control.epoch === record.lease.epoch && control.owner === record.lease.owner;
  }
  private assertCurrent(record: Pending): void {
    if (record.error) throw new BrowserWorkerError(record.error, 409);
    if (!this.current(record)) throw new BrowserWorkerError("BROWSER_CONTROL_CHANGED", 409);
  }
  private readonly begin = (event: unknown): void => {
    const parsed = beginSchema.safeParse(event);
    if (!parsed.success || this.closed || this.seen.has(parsed.data.guid)) return;
    const input = parsed.data, control = this.options.currentControl(); this.seen.add(input.guid);
    let terminal!: () => void, cancelMapping!: () => void;
    const finished = new Promise<void>(accept => { terminal = accept; });
    const cancelledMapping = new Promise<null>(accept => { cancelMapping = () => accept(null); });
    const record: Pending = { guid: input.guid, id: randomUUID(), name: [...input.suggestedFilename ?? "download"].map(character =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || ["/", "\\"].includes(character) ? "_" : character).join("").slice(0, 200) || "download",
      lease: { epoch: control.epoch, owner: control.owner }, pageId: null, error: null, published: false, temporaryOwned: false, finalOwned: false,
      cancelling: null,
      terminal, cancelMapping, task: Promise.resolve(), timer: setTimeout(() => this.cancel(record, "BROWSER_DOWNLOAD_TIMEOUT", true), 10_000) };
    record.timer.unref(); this.active.set(record.guid, record);
    record.task = (async () => {
      const page = await Promise.race([this.options.resolvePage(input.frameId), cancelledMapping]);
      if (!uuid.safeParse(page).success) throw new BrowserWorkerError("BROWSER_DOWNLOAD_INVALID", 409);
      record.pageId = page; await finished; this.assertCurrent(record);
      await this.publish(record);
    })().catch(async error => {
      const code = record.error ?? (error instanceof BrowserWorkerError ? error.code : "BROWSER_DOWNLOAD_FAILED");
      await this.cancelDownload(record);
      if (record.pageId && this.current(record)) this.options.onFailure({ id: record.id, pageId: record.pageId, name: record.name, errorCode: code, createdAt: new Date().toISOString() }, record.lease);
    }).finally(async () => {
      clearTimeout(record.timer); await this.cleanup(record);
      if (this.active.get(record.guid) === record) this.active.delete(record.guid);
    });
    void record.task.catch(() => undefined);
  };
  private readonly progress = (event: unknown): void => {
    const parsed = progressSchema.safeParse(event); if (!parsed.success) return;
    const progress = parsed.data, record = this.active.get(progress.guid); if (!record) return;
    if (progress.receivedBytes > BROWSER_DOWNLOAD_MAX_BYTES || progress.totalBytes > BROWSER_DOWNLOAD_MAX_BYTES) this.cancel(record, "BROWSER_DOWNLOAD_TOO_LARGE");
    else if (progress.state === "canceled") this.cancel(record, "BROWSER_DOWNLOAD_FAILED");
    else if (progress.state === "completed") record.terminal();
  };
  private cancel(record: Pending, code: string, cancelMapping = false): void {
    record.error ??= code; record.terminal(); if (cancelMapping) record.cancelMapping();
    void this.cancelDownload(record);
  }
  private cancelDownload(record: Pending): Promise<void> {
    record.cancelling ??= this.options.session.send("Browser.cancelDownload", { guid: record.guid }).then(() => undefined, () => undefined);
    return record.cancelling;
  }

  private async publish(record: Pending): Promise<void> {
    this.assertCurrent(record); await this.assertDirectories(); this.assertCurrent(record);
    const source = join(this.rawDirectory, record.guid), temporary = join(this.options.directory, `${record.id}.partial`), target = join(this.options.directory, record.id);
    const before = await lstat(source, { bigint: true }); this.assertCurrent(record);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new BrowserWorkerError("BROWSER_DOWNLOAD_INVALID", 409);
    if (before.size > BigInt(BROWSER_DOWNLOAD_MAX_BYTES)) throw new BrowserWorkerError("BROWSER_DOWNLOAD_TOO_LARGE", 413);
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      this.assertCurrent(record);
      const opened = await input.stat({ bigint: true }); this.assertCurrent(record);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1n) throw new BrowserWorkerError("BROWSER_DOWNLOAD_INVALID", 409);
      const buffer = Buffer.alloc(BROWSER_DOWNLOAD_MAX_BYTES + 1); let size = 0;
      while (size < buffer.length) {
        const chunk = await input.read(buffer, size, buffer.length - size, size); this.assertCurrent(record);
        size += chunk.bytesRead; if (!chunk.bytesRead) break;
      }
      if (size > BROWSER_DOWNLOAD_MAX_BYTES) throw new BrowserWorkerError("BROWSER_DOWNLOAD_TOO_LARGE", 413);
      const after = await input.stat({ bigint: true }); this.assertCurrent(record);
      if (size !== Number(opened.size) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw new BrowserWorkerError("BROWSER_DOWNLOAD_INVALID", 409);
      const bytes = buffer.subarray(0, size), sha256 = createHash("sha256").update(bytes).digest("hex");
      const output = await open(temporary, "wx", 0o600); record.temporaryOwned = true;
      try { this.assertCurrent(record); await output.writeFile(bytes); this.assertCurrent(record); await output.sync(); this.assertCurrent(record); }
      finally { await output.close(); }
      const reserved = await open(target, "wx", 0o600); record.finalOwned = true; await reserved.close(); this.assertCurrent(record);
      await this.assertDirectories(); this.assertCurrent(record);
      await rename(temporary, target); record.temporaryOwned = false; this.assertCurrent(record);
      this.options.onDownload({ id: record.id, pageId: record.pageId!, name: record.name, size, sha256, createdAt: new Date().toISOString() }, record.lease);
      record.published = true;
    } finally { await input.close(); }
  }
  private async cleanup(record: Pending): Promise<void> {
    // A replaced directory must not redirect cleanup into someone else's files.
    try { await this.assertDirectories(); } catch { return; }
    await Promise.all([unlink(join(this.rawDirectory, record.guid)), unlink(join(this.rawDirectory, `${record.guid}.crdownload`)),
      ...(record.temporaryOwned ? [unlink(join(this.options.directory, `${record.id}.partial`))] : []),
      ...(record.finalOwned && !record.published ? [unlink(join(this.options.directory, record.id))] : [])].map(task => task.catch(() => undefined)));
  }
  async controlChanged(): Promise<void> {
    const old = [...this.active.values()].filter(record => !this.current(record));
    old.forEach(record => this.cancel(record, "BROWSER_CONTROL_CHANGED", true));
    await Promise.allSettled(old.map(record => record.task));
  }
  private removeListeners(): void {
    this.options.session.off("Browser.downloadWillBegin", this.begin); this.options.session.off("Browser.downloadProgress", this.progress);
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.removeListeners();
    const records = [...this.active.values()]; records.forEach(record => this.cancel(record, "BROWSER_DOWNLOAD_FAILED", true));
    await Promise.allSettled(records.map(record => record.task));
  }
}
