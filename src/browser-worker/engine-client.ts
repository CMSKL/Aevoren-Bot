import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ControlRecord, DownloadRecord, DownloadFailure } from "./state-store";
import type { EngineAction, EngineEvent, EngineResponse } from "./engine-protocol";
import { BrowserWorkerError } from "./worker-error";
import type { DownloadLease } from "./cdp-downloads";

export const ENGINE_ENVIRONMENT = {
  PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/tmp/aevoren-browser-home",
  DISPLAY: ":99", PLAYWRIGHT_BROWSERS_PATH: "/opt/aevoren-browsers",
};

export class EngineClient {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private child: ChildProcess | null = null;
  private closed = false;
  private browserReady = false;
  get isAlive(): boolean { return !this.closed && this.browserReady && Boolean(this.child?.connected); }

  constructor(private readonly options: { enginePath: string; browserSessionId: string; environmentId: string; previewExecutionIp?: string; profileDirectory: string; downloadsDirectory: string; onDownload(record: DownloadRecord, lease: DownloadLease): void; onDownloadFailure(record: DownloadFailure, lease: DownloadLease): void; onStopped(): void }) {}

  async start(control: ControlRecord): Promise<void> {
    const child = spawn(process.execPath, [this.options.enginePath, this.options.browserSessionId, this.options.profileDirectory, this.options.downloadsDirectory], {
      uid: 1_000, gid: 1_000, cwd: "/", env: { ...ENGINE_ENVIRONMENT, AEVOREN_PREVIEW_ENVIRONMENT_ID: this.options.environmentId,
        ...(process.env.AEVOREN_BROWSER_DIAGNOSTICS === "1" ? { AEVOREN_BROWSER_DIAGNOSTICS: "1" } : {}),
        ...(this.options.previewExecutionIp ? { AEVOREN_PREVIEW_EXECUTION_IP: this.options.previewExecutionIp } : {}) }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child = child;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BrowserWorkerError("BROWSER_ENGINE_START_FAILED", 503)), 45_000);
      child.once("error", () => { clearTimeout(timer); reject(new BrowserWorkerError("BROWSER_ENGINE_START_FAILED", 503)); });
      child.once("exit", () => { clearTimeout(timer); reject(new BrowserWorkerError("BROWSER_ENGINE_STOPPED", 503)); });
      child.on("message", value => {
        const message = value as EngineEvent | EngineResponse;
        if (message.type === "ready") { this.browserReady = true; clearTimeout(timer); resolve(); return; }
        if (message.type === "browser-stopped") { this.browserReady = false; this.options.onStopped(); return; }
        if (message.type === "download") { this.options.onDownload(message.download, message.lease); return; }
        if (message.type === "download-error") { this.options.onDownloadFailure(message.error, message.lease); return; }
        if (message.type !== "response") return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new BrowserWorkerError(message.code, message.status));
      });
    });
    // Chromium failures are represented by a safe code. Raw stderr may contain browsing data.
    child.stderr?.resume();
    child.on("exit", () => {
      this.child = null;
      this.browserReady = false;
      this.options.onStopped();
      for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(new BrowserWorkerError("BROWSER_ENGINE_STOPPED", 503)); }
      this.pending.clear();
    });
    await ready;
    await this.request("control", control);
  }

  request<T>(action: EngineAction, payload: Record<string, unknown> | ControlRecord): Promise<T> {
    if (this.closed || !this.child?.connected || !this.browserReady && action !== "shutdown") return Promise.reject(new BrowserWorkerError("BROWSER_ENGINE_STOPPED", 503));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserWorkerError("BROWSER_OPERATION_TIMEOUT", 504));
      }, 15_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.child!.send({ type: "request", id, action, payload }, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); clearTimeout(timer); reject(new BrowserWorkerError("BROWSER_ENGINE_STOPPED", 503));
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.request("shutdown", {}).catch(() => undefined);
    this.closed = true;
    this.child?.kill("SIGTERM");
  }
}
