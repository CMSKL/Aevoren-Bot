import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { BROWSER_DOWNLOAD_MAX_BYTES } from "@shared/browser-contracts";
import type { BrowserWorkerControl, BrowserWorkerDownload, BrowserDownloadsPage } from "@shared/browser-contracts";
import { browserDownloadSchema, browserDownloadFailureSchema, browserObservationSchema, browserPageSchema, browserWorkerFrameSchema } from "@shared/browser-schemas";
import type { EngineAction } from "./engine-protocol";
import type { EngineClient } from "./engine-client";
import { BrowserStateStore } from "./state-store";
import { BrowserWorkerError } from "./worker-error";

export class BrowserWorker {
  readonly bootId = randomUUID();
  readonly store: BrowserStateStore;
  controlBusy = false;
  private connectionCount = 0;
  private readyEpoch: number | null = null;
  private closeViewers: () => void = () => undefined;

  constructor(readonly options: { environmentId: string; browserSessionId: string; stateDirectory: string; downloadsDirectory: string }, readonly engine: Pick<EngineClient, "request" | "close"> & Partial<Pick<EngineClient, "isAlive">>) {
    this.store = new BrowserStateStore(join(options.stateDirectory, "browser.sqlite"), options.browserSessionId);
  }

  control(): BrowserWorkerControl {
    const value = this.store.control();
    return { owner: value.owner, controlEpoch: value.epoch, observedEpoch: value.needsObservation ? null : value.epoch,
      connectionState: this.connectionCount > 0 ? "connected" : "disconnected" };
  }
  assertHealthy(): void { if (this.engine.isAlive === false) throw new BrowserWorkerError("BROWSER_ENGINE_STOPPED", 503); }

  viewerConnected(): void { this.connectionCount++; }
  viewerDisconnected(): void { this.connectionCount = Math.max(0, this.connectionCount - 1); }
  setViewerCloser(closer: () => void): void { this.closeViewers = closer; }
  acknowledgeControl(): void { this.readyEpoch = this.store.control().epoch; }
  engineStopped(): void { this.readyEpoch = null; this.closeViewers(); }
  canConnectViewer(epoch: number): boolean { const value = this.store.control(); return this.engine.isAlive !== false && !this.controlBusy && this.readyEpoch === epoch && value.owner === "user" && value.epoch === epoch; }

  async changeControl(owner: "ai" | "user", input: Record<string, unknown>): Promise<BrowserWorkerControl> {
    if (input.actor !== "user") throw new BrowserWorkerError("BROWSER_CONTROL_FORBIDDEN", 403);
    if (this.controlBusy) throw new BrowserWorkerError("BROWSER_CONTROL_CHANGED", 409);
    const operation = this.store.beginOperation(String(input.operationId), `control-${owner}`, input);
    if (operation.reused) return this.control();
    const control = this.store.transition(owner, Number(input.expectedEpoch));
    this.readyEpoch = null;
    this.closeViewers();
    this.controlBusy = true;
    try {
      // The persisted lease is sealed first. Human input is enabled only after old AI calls drain.
      await this.engine.request("control", control);
      this.acknowledgeControl();
      const result = this.control();
      this.store.completeOperation(String(input.operationId), result);
      return result;
    } finally { this.controlBusy = false; }
  }

  async perform(action: EngineAction, input: Record<string, unknown>, mutation = false): Promise<unknown> {
    const epoch = Number(input.expectedEpoch);
    this.store.assertAccess(epoch, input.actor as "ai" | "user");
    if (this.controlBusy || this.readyEpoch !== epoch) throw new BrowserWorkerError("BROWSER_CONTROL_CHANGED", 409);
    if (mutation) {
      const prior = this.store.beginOperation(String(input.operationId), `${action}-${String(input.method ?? "")}`, input);
      if (prior.reused) { this.store.assertAccess(epoch, input.actor as "ai" | "user"); return prior.result; }
    }
    const result = await this.engine.request<unknown>(action, input);
    this.store.assertAccess(epoch, input.actor as "ai" | "user");
    if (mutation) this.store.assertOperation(String(input.operationId));
    if (this.controlBusy) throw new BrowserWorkerError("BROWSER_CONTROL_CHANGED", 409);
    if (action === "observe") browserObservationSchema.parse(result);
    else if (action === "frame" || action === "desktop-frame") browserWorkerFrameSchema.parse(result);
    else if (["create", "navigate", "action", "computer-action"].includes(action)) browserPageSchema.parse(result);
    if (input.actor === "ai" && ["observe", "frame", "desktop-frame"].includes(action)) this.store.observed(epoch);
    if (mutation) this.store.completeOperation(String(input.operationId), result);
    return result;
  }

  async cancelOperation(operationId: string): Promise<{ operationId: string; state: "cancelled" | "unknown" | "completed" }> {
    const state = this.store.cancelOperation(operationId);
    if (state === "unknown") await this.engine.request("cancel", { operationId });
    return { operationId, state };
  }

  listDownloads(input: Record<string, unknown>): BrowserDownloadsPage {
    this.store.assertAccess(Number(input.expectedEpoch), input.actor as "ai" | "user");
    return { items: this.store.listDownloads().map(value => browserDownloadSchema.parse({ ...value, browserSessionId: this.options.browserSessionId, mimeType: "application/octet-stream" })),
      errors: this.store.listDownloadFailures().map(value => browserDownloadFailureSchema.parse(value)) };
  }

  async download(input: Record<string, unknown>): Promise<BrowserWorkerDownload> {
    const epoch = Number(input.expectedEpoch);
    this.store.assertAccess(epoch, input.actor as "ai" | "user");
    const metadata = this.store.download(String(input.id));
    const content = await this.engine.request<{ dataBase64: string }>("read-download", { ...input, metadata });
    if (typeof content.dataBase64 !== "string" || content.dataBase64.length > Math.ceil(BROWSER_DOWNLOAD_MAX_BYTES / 3) * 4) throw new BrowserWorkerError("BROWSER_DOWNLOAD_INVALID", 409);
    const bytes = Buffer.from(content.dataBase64, "base64");
    this.store.assertAccess(epoch, input.actor as "ai" | "user");
    if (bytes.length !== metadata.size || createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw new BrowserWorkerError("BROWSER_DOWNLOAD_INVALID", 409);
    return { ...metadata, browserSessionId: this.options.browserSessionId, mimeType: "application/octet-stream", dataBase64: bytes.toString("base64") };
  }

  async close(): Promise<void> { this.closeViewers(); await this.engine.close(); this.store.close(); }
}
