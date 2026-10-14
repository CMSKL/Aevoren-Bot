import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BrowserActionInput, BrowserChangedEvent, BrowserClickInput, BrowserDownloadInput, BrowserDownloadsPage,
  BrowserEpochInput, BrowserMutationInput, BrowserNavigateInput, BrowserNewTabInput, BrowserObserveInput, BrowserPage, BrowserPageMutationInput,
  BrowserReadInput, BrowserScope, BrowserScrollInput, BrowserSession, BrowserTypeInput, BrowserKeyInput, BrowserWorkerHealth,
  ComputerClickInput, ComputerControlInput, ComputerOwner, ComputerScreenshot, ComputerScreenshotInput, ComputerScrollInput, ComputerTypeInput,
  ComputerView, ComputerVncTicket, PreviewCloseInput, PreviewOpenInput, ServicePreview } from "@shared/browser-contracts";
import { BROWSER_WORKER_VERSION } from "@shared/browser-contracts";
import * as schemas from "@shared/browser-schemas";
import type { AppRepository } from "./database";
import type { EnvironmentService } from "./environment-service";
import type { SecretCodec } from "./settings";
import type { ModelImageAttachment } from "./model-image";
import { AevorenBotError } from "./errors";
import { BrowserDockerDriver } from "./browser-docker-driver";
import { ExecutionWorkerClient, ExecutionWorkerError } from "./execution-worker-client";
import { BrowserMediaStore, verifiedFrame } from "./browser-media-store";
import { BrowserViewServer } from "./browser-view-server";

export type BrowserCallContext = { actor?: ComputerOwner; signal?: AbortSignal; operationId?: string; runtimeRunId?: string };
export type BrowserMutationCall<T extends { clientNonce: string }> = Omit<T, "clientNonce"> & { clientNonce?: string };
function scope(input: BrowserScope): BrowserScope { return schemas.browserScopeSchema.parse({ sessionId: input.sessionId, executorBotId: input.executorBotId }); }
function operationId(seed: string): string { const hash = createHash("sha256").update(seed).digest("hex"); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`; }
function failure(error: unknown): AevorenBotError {
  if (error instanceof AevorenBotError) return error;
  if (error instanceof ExecutionWorkerError) {
    if (/USER_CONTROL/.test(error.code)) return new AevorenBotError("COMPUTER_USER_CONTROLLED");
    if (/CONTROL_CHANGED/.test(error.code)) return new AevorenBotError("COMPUTER_CONTROL_CHANGED");
    if (/OBSERVATION/.test(error.code)) return new AevorenBotError("BROWSER_OBSERVATION_REQUIRED");
    if (/OPERATION_UNKNOWN|OPERATION_CONFLICT/.test(error.code)) return new AevorenBotError("TOOL_STATE_INVALID", "上次操作结果未确认，操作未重复执行；请重新观察实际状态。");
    if (/OPERATION_CANCELLED/.test(error.code)) return new AevorenBotError("TOOL_EXECUTION_CANCELLED");
  }
  return new AevorenBotError("BROWSER_UNAVAILABLE");
}

/** One host-owned business service for the trusted interface and scoped AI tools. */
export class BrowserService {
  private readonly media: BrowserMediaStore;
  private readonly viewers = new BrowserViewServer();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly active = new Map<string, { scope: BrowserScope; runtimeRunId?: string }>();
  private readonly controls = new Map<string, { scope: BrowserScope; owner: ComputerOwner; previousEpoch: number; claimedEpoch: number; bootId: string | null; completedEpoch?: number }>();
  private readonly ticketResults = new Map<string, ComputerVncTicket>();
  private preparing?: Promise<import("./docker-driver").DockerImage>;
  private closing = false;
  constructor(private readonly repository: AppRepository, private readonly codec: SecretCodec, private readonly contextPath: string, mediaRoot: string,
    private readonly environments: EnvironmentService, private readonly changed: (event: BrowserChangedEvent) => void = () => undefined,
    private readonly docker: BrowserDockerDriver = new BrowserDockerDriver()) { this.media = new BrowserMediaStore(mediaRoot); }
  private async locked<T>(input: BrowserScope, work: () => Promise<T>): Promise<T> {
    const key = `${input.sessionId}:${input.executorBotId}`, previous = this.locks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work); this.locks.set(key, pending);
    try { return await pending; } finally { if (this.locks.get(key) === pending) this.locks.delete(key); }
  }
  private actor(context: BrowserCallContext): ComputerOwner { return context.actor ?? "user"; }
  private live(input: BrowserScope, context: BrowserCallContext): void {
    context.signal?.throwIfAborted(); this.repository.assertSessionExecutor(input.sessionId, input.executorBotId);
    if (this.closing) throw new AevorenBotError("BROWSER_UNAVAILABLE");
    if (context.runtimeRunId) { const run = this.repository.getRuntimeRun(context.runtimeRunId); if (run.sessionId !== input.sessionId || run.executorBotId !== input.executorBotId) throw new AevorenBotError("BROWSER_SCOPE_INVALID"); }
  }
  private emit(input: BrowserScope, type: BrowserChangedEvent["type"], beforeVersion?: number): void {
    const current = this.repository.browsers.get(input); if (!current || beforeVersion === current.version) return;
    this.changed({ ...scope(input), type, browserSessionId: current.id, controlEpoch: current.controlEpoch });
  }
  private parseMutation<T extends { clientNonce: string }>(schema: z.ZodType<T>, input: BrowserMutationCall<T>, context: BrowserCallContext): T {
    return schema.parse({ ...input, clientNonce: context.operationId ?? input.clientNonce });
  }
  private intent(input: BrowserScope & { clientNonce: string }, name: string, context: BrowserCallContext): string {
    return context.operationId ?? operationId(`${input.sessionId}:${input.executorBotId}:${name}:${input.clientNonce}`);
  }
  private async client(input: BrowserScope): Promise<ExecutionWorkerClient> {
    const record = this.repository.browsers.getInternal(input);
    if (!record?.workerPort || !record.encryptedToken) throw new AevorenBotError("BROWSER_UNAVAILABLE");
    return new ExecutionWorkerClient(record.workerPort, this.codec.decrypt(record.encryptedToken), record.environmentId);
  }
  private async health(input: BrowserScope, signal?: AbortSignal): Promise<BrowserWorkerHealth> {
    const record = this.repository.browsers.getInternal(input); if (!record) throw new AevorenBotError("BROWSER_NOT_FOUND");
    const health = schemas.browserWorkerHealthSchema.parse(await (await this.client(input)).request("/v1/health", "GET", undefined, signal));
    if (health.browserSessionId !== record.id || health.environmentId !== record.environmentId || health.workerVersion !== record.workerVersion) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    return health;
  }
  async get(input: BrowserScope, context: BrowserCallContext = {}): Promise<BrowserSession | null> {
    const target = scope(input); this.live(target, context); const existing = this.repository.browsers.get(target); if (!existing) return null;
    if (this.locks.has(`${target.sessionId}:${target.executorBotId}`)) return existing;
    const before = existing.version;
    try {
      const container = await this.docker.inspectBrowser(existing.id, existing.environmentId, context.signal);
      if (!container || container.state !== "running") this.repository.browsers.update(target, this.repository.browsers.get(target)!.version, { state: "stopped" });
      else {
        const privateRecord = this.repository.browsers.getInternal(target)!;
        if (container.imageId !== privateRecord.imageDigest || !container.workerPort) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
        this.repository.browsers.updateConnection(target, { workerPort: container.workerPort, containerId: container.id });
        const health = await this.health(target, context.signal);
        this.repository.browsers.syncControl(target, health.control, health.bootId);
        this.repository.browsers.update(target, this.repository.browsers.get(target)!.version, { state: "running" });
      }
    } catch (error) { context.signal?.throwIfAborted(); const current = this.repository.browsers.get(target); if (!current) throw failure(error); this.repository.browsers.update(target, current.version, { state: "unknown" }); }
    this.live(target, context); this.emit(target, "browser", before); return this.repository.browsers.get(target);
  }
  async view(input: BrowserScope, context: BrowserCallContext = {}): Promise<ComputerView | null> { await this.get(input, context); return this.repository.browsers.view(input); }
  private async bundleDigest(): Promise<string> { const hash = createHash("sha256"); for (const name of ["index.mjs", "engine.mjs", "Dockerfile", "package.json"]) { hash.update(name); hash.update(await readFile(join(this.contextPath, name))); } return hash.digest("hex"); }
  private async prepare(signal?: AbortSignal) {
    if (this.preparing) return this.preparing;
    const task = (async () => { const digest = await this.bundleDigest(), existing = await this.docker.inspectBrowserImage(undefined, signal);
      return existing?.bundleSha256 === digest && existing.workerVersion === BROWSER_WORKER_VERSION ? existing : this.docker.initializeBrowser(this.contextPath, digest, signal); })();
    this.preparing = task; try { return await task; } finally { if (this.preparing === task) this.preparing = undefined; }
  }
  async start(input: BrowserMutationCall<BrowserMutationInput>, context: BrowserCallContext = {}): Promise<BrowserSession> {
    const parsed = this.parseMutation(schemas.browserMutationSchema, input, context);
    return this.locked(parsed, async () => {
      this.live(parsed, context); const environment = this.repository.environments.get(parsed);
      if (!environment || environment.state !== "running") throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
      const current = this.repository.browsers.get(parsed);
      if (current && parsed.expectedVersion !== undefined && current.version !== parsed.expectedVersion) throw new AevorenBotError("BROWSER_VERSION_CONFLICT");
      let record = this.repository.browsers.getInternal(parsed);
      if (record?.state === "running") {
        const existing = await this.docker.inspectBrowser(record.id, record.environmentId, context.signal);
        if (existing?.state === "running" && existing.imageId === record.imageDigest) {
          const healthy = await this.health(parsed, context.signal); this.live(parsed, context);
          this.repository.browsers.syncControl(parsed, healthy.control, healthy.bootId);
          this.emit(parsed, "browser", current!.version); return this.repository.browsers.get(parsed)!;
        }
      }
      const image = record?.imageDigest ? await this.docker.inspectBrowserImage(record.imageDigest, context.signal) : await this.prepare(context.signal);
      this.live(parsed, context); if (!image || !this.codec.isAvailable()) throw new AevorenBotError("BROWSER_UNAVAILABLE");
      if (!record) { this.repository.browsers.ensure(parsed, { environmentId: environment.id }); record = this.repository.browsers.getInternal(parsed)!; }
      const token = record.encryptedToken ? this.codec.decrypt(record.encryptedToken) : randomBytes(32).toString("hex");
      this.repository.browsers.updateConnection(parsed, { encryptedToken: this.codec.encrypt(token), imageRef: image.ref, imageDigest: image.id, workerVersion: image.workerVersion, platform: image.platform });
      this.repository.browsers.update(parsed, this.repository.browsers.get(parsed)!.version, { state: "starting" });
      try {
        const old = await this.docker.inspectBrowser(record.id, environment.id, context.signal);
        if (old && old.imageId !== image.id) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
        const container = old?.state === "running" ? old : old ? await this.docker.startBrowser(record.id, environment.id, context.signal) : await this.docker.createBrowser(record.id, environment.id, image, token, context.signal);
        this.repository.browsers.updateConnection(parsed, { containerId: container.id, workerPort: container.workerPort });
        const client = await this.client(parsed); await client.waitHealthy(context.signal, 50_000);
        const health = await this.health(parsed, context.signal); this.live(parsed, context);
        this.repository.browsers.syncControl(parsed, health.control, health.bootId);
        this.repository.browsers.update(parsed, this.repository.browsers.get(parsed)!.version, { state: "running" });
        await this.tabs({ ...scope(parsed), expectedEpoch: health.control.controlEpoch }, context); this.emit(parsed, "browser"); return this.repository.browsers.get(parsed)!;
      } catch (error) { const now = this.repository.browsers.get(parsed); if (now) this.repository.browsers.update(parsed, now.version, { state: "unknown" }); throw failure(error); }
    });
  }
  async stop(input: BrowserMutationCall<BrowserMutationInput>, context: BrowserCallContext = {}): Promise<BrowserSession> {
    const parsed = this.parseMutation(schemas.browserMutationSchema, input, context);
    return this.locked(parsed, async () => { this.live(parsed, context); const current = this.repository.browsers.get(parsed); if (!current) throw new AevorenBotError("BROWSER_NOT_FOUND");
      if (parsed.expectedVersion !== undefined && current.version !== parsed.expectedVersion) throw new AevorenBotError("BROWSER_VERSION_CONFLICT");
      this.viewers.revoke(parsed); await this.docker.stopBrowser(current.id, current.environmentId); this.live(parsed, context);
      const result = this.repository.browsers.update(parsed, this.repository.browsers.get(parsed)!.version, { state: "stopped" }); this.emit(parsed, "browser", current.version); return result; });
  }
  private access(input: BrowserEpochInput, context: BrowserCallContext, fresh = false): void { this.live(input, context); const method = fresh ? "assertFresh" : "assertAccess"; this.repository.browsers[method](input, input.expectedEpoch, this.actor(context)); }
  private wire(input: Record<string, unknown>, context: BrowserCallContext, id?: string): Record<string, unknown> {
    const body = Object.fromEntries(Object.entries(input).filter(([key]) => !["sessionId", "executorBotId", "clientNonce", "expectedVersion"].includes(key)));
    return { ...body, actor: this.actor(context), ...(id ? { operationId: id } : {}) };
  }
  private async request(input: BrowserEpochInput, path: string, method: "GET" | "POST", body: unknown, context: BrowserCallContext): Promise<unknown> {
    this.access(input, context); try { const result = await (await this.client(input)).request(path, method, body, context.signal); this.access(input, context); return result; } catch (error) { throw failure(error); }
  }
  private async mutation(input: BrowserEpochInput & { clientNonce: string }, name: string, path: string, context: BrowserCallContext): Promise<unknown> {
    const id = this.intent(input, name, context); this.access(input, context); this.active.set(id, { scope: scope(input), ...(context.runtimeRunId ? { runtimeRunId: context.runtimeRunId } : {}) });
    try { return await this.request(input, path, "POST", this.wire(input, context, id), context); }
    catch (error) { if (context.signal?.aborted) await this.cancelOperation(scope(input), id).catch(() => undefined); throw failure(error); }
    finally { this.active.delete(id); }
  }
  async tabs(input: BrowserEpochInput, context: BrowserCallContext = {}): Promise<BrowserPage[]> {
    const parsed = schemas.browserEpochSchema.parse(input), query = new URLSearchParams({ actor: this.actor(context), expectedEpoch: String(parsed.expectedEpoch) });
    const values = z.array(schemas.browserPageSchema).max(50).parse(await this.request(parsed, `/v1/browser/pages?${query}`, "GET", undefined, context));
    const old = this.repository.browsers.pages(parsed, parsed.expectedEpoch, this.actor(context)); this.repository.browsers.upsertPages(parsed, values, parsed.expectedEpoch, this.actor(context));
    const current = this.repository.browsers.get(parsed)!;
    if (!current.activePageId && values[0]) this.repository.browsers.update(parsed, current.version, { activePageId: values[0].id });
    const semantic = (pages: BrowserPage[]) => JSON.stringify(pages.map(({ id, url, title, documentVersion }) => ({ id, url, title, documentVersion })).sort((a, b) => a.id.localeCompare(b.id)));
    if (semantic(old) !== semantic(values)) this.emit(parsed, "pages"); return values;
  }
  private page(input: BrowserEpochInput, raw: unknown, context: BrowserCallContext): BrowserPage {
    const value = schemas.browserPageSchema.parse(raw), expectedPage = (input as BrowserEpochInput & { pageId?: string }).pageId;
    if (expectedPage && expectedPage !== value.id) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    const old = this.repository.browsers.pages(input, input.expectedEpoch, this.actor(context)).find(page => page.id === value.id);
    if (old && old.documentVersion > value.documentVersion) return old;
    const result = this.repository.browsers.upsertPage(input, value, input.expectedEpoch, this.actor(context));
    if (!old || old.documentVersion !== value.documentVersion || old.url !== value.url || old.title !== value.title) this.emit(input, "pages"); return result;
  }
  async newTab(input: BrowserMutationCall<BrowserNewTabInput>, context: BrowserCallContext = {}): Promise<BrowserPage> {
    const parsed = this.parseMutation(schemas.browserNewTabSchema, input, context); this.access(parsed, context, true); return this.page(parsed, await this.mutation(parsed, "newTab", "/v1/browser/pages", context), context);
  }
  async closeTab(input: BrowserMutationCall<BrowserPageMutationInput>, context: BrowserCallContext = {}): Promise<BrowserSession> {
    const parsed = this.parseMutation(schemas.browserPageMutationSchema, input, context); this.access(parsed, context, true);
    const result = z.object({ pageId: z.string().uuid(), closed: z.literal(true) }).strict().parse(await this.mutation(parsed, "closeTab", `/v1/browser/pages/${parsed.pageId}/close`, context));
    if (result.pageId !== parsed.pageId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    this.repository.browsers.removePage(parsed, parsed.pageId, parsed.expectedEpoch, this.actor(context)); this.emit(parsed, "pages"); return this.repository.browsers.get(parsed)!;
  }
  async navigate(input: BrowserMutationCall<BrowserNavigateInput>, context: BrowserCallContext = {}): Promise<BrowserPage> {
    const parsed = this.parseMutation(schemas.browserNavigateSchema, input, context); this.access(parsed, context, true); return this.page(parsed, await this.mutation(parsed, "navigate", `/v1/browser/pages/${parsed.pageId}/navigate`, context), context);
  }
  async observe(input: BrowserObserveInput, context: BrowserCallContext = {}) { return this.readObservation(schemas.browserObserveSchema.parse(input), "observe", context); }
  async read(input: BrowserReadInput, context: BrowserCallContext = {}) { return this.readObservation(schemas.browserReadSchema.parse(input), "read", context); }
  private async readObservation(input: BrowserObserveInput, method: string, context: BrowserCallContext) {
    const value = schemas.browserObservationSchema.parse(await this.request(input, `/v1/browser/pages/${input.pageId}/${method}`, "POST", this.wire(input, context), context));
    if (value.pageId !== input.pageId || value.controlEpoch !== input.expectedEpoch) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    const previous = this.repository.browsers.pages(input, input.expectedEpoch, this.actor(context)).find(page => page.id === input.pageId);
    const at = value.observedAt;
    this.repository.browsers.upsertPage(input, { id: value.pageId, browserSessionId: value.browserSessionId, url: value.url, title: value.title, documentVersion: value.documentVersion, createdAt: previous?.createdAt ?? at, updatedAt: at }, input.expectedEpoch, this.actor(context));
    return this.repository.browsers.recordObservation(input, value, this.actor(context));
  }
  private async action<T extends BrowserActionInput>(schema: z.ZodType<T>, input: BrowserMutationCall<T>, family: "browser" | "computer", method: string, context: BrowserCallContext): Promise<BrowserPage> {
    const parsed = this.parseMutation(schema, input, context); this.access(parsed, context, true);
    const path = family === "browser" ? `/v1/browser/pages/${parsed.pageId}/${method}` : `/v1/computer/${method}`;
    return this.page(parsed, await this.mutation(parsed, `${family}.${method}`, path, context), context);
  }
  click(input: BrowserMutationCall<BrowserClickInput>, context: BrowserCallContext = {}) { return this.action(schemas.browserClickSchema, input, "browser", "click", context); }
  type(input: BrowserMutationCall<BrowserTypeInput>, context: BrowserCallContext = {}) { return this.action(schemas.browserTypeSchema, input, "browser", "type", context); }
  key(input: BrowserMutationCall<BrowserKeyInput>, context: BrowserCallContext = {}) { return this.action(schemas.browserKeySchema, input, "browser", "key", context); }
  scroll(input: BrowserMutationCall<BrowserScrollInput>, context: BrowserCallContext = {}) { return this.action(schemas.browserScrollSchema, input, "browser", "scroll", context); }
  computerClick(input: BrowserMutationCall<ComputerClickInput>, context: BrowserCallContext = {}) { return this.action(schemas.computerClickSchema, input, "computer", "click", context); }
  computerType(input: BrowserMutationCall<ComputerTypeInput>, context: BrowserCallContext = {}) { return this.action(schemas.computerTypeSchema, input, "computer", "type", context); }
  computerKey(input: BrowserMutationCall<BrowserKeyInput>, context: BrowserCallContext = {}) { return this.action(schemas.browserKeySchema, input, "computer", "key", context); }
  computerScroll(input: BrowserMutationCall<ComputerScrollInput>, context: BrowserCallContext = {}) { return this.action(schemas.computerScrollSchema, input, "computer", "scroll", context); }
  async computerScreenshot(input: ComputerScreenshotInput, context: BrowserCallContext = {}): Promise<ComputerScreenshot> {
    const parsed = schemas.computerScreenshotSchema.parse(input); const { frame, bytes } = verifiedFrame(await this.request(parsed, "/v1/computer/screenshot", "POST", this.wire(parsed, context), context));
    if (frame.controlEpoch !== parsed.expectedEpoch || frame.browserSessionId !== this.repository.browsers.get(parsed)!.id) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    if (frame.pageId) await this.tabs({ ...scope(parsed), expectedEpoch: parsed.expectedEpoch }, context);
    const blobPath = await this.media.put(bytes, frame.sha256, context.signal); this.access(parsed, context);
    const metadata = schemas.screenshotMediaSchema.parse({ ...Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "dataBase64")), ...scope(parsed),
      id: randomUUID(), name: `screenshot.${frame.mimeType === "image/png" ? "png" : "jpg"}` });
    const media = this.repository.browsers.recordFrame(parsed, { ...metadata, blobPath }, this.actor(context));
    return { media, frame };
  }
  async imageAttachment(input: BrowserScope, id: string, expectedEpoch: number): Promise<ModelImageAttachment> {
    const record = this.repository.browsers.getFrame(input, id, expectedEpoch, "ai"), bytes = await this.media.read(record.blobPath, record.sha256, record.size);
    this.repository.browsers.assertFrame(input, id, expectedEpoch, "ai");
    return { reference: this.repository.browsers.assertFrame(input, id, expectedEpoch, "ai"), dataBase64: bytes.toString("base64"), isAuthorized: () => { try { this.repository.browsers.assertFrame(input, id, expectedEpoch, "ai"); return true; } catch { return false; } } };
  }
  async downloads(input: BrowserEpochInput, context: BrowserCallContext = {}): Promise<BrowserDownloadsPage> {
    const parsed = schemas.browserEpochSchema.parse(input), result = schemas.browserDownloadsPageSchema.parse(await this.request(parsed, "/v1/browser/downloads/list", "POST", this.wire(parsed, context), context));
    if (result.items.some(item => item.browserSessionId !== this.repository.browsers.get(parsed)!.id)) throw new AevorenBotError("BROWSER_SCOPE_INVALID"); return result;
  }
  async downloadData(input: BrowserMutationCall<BrowserDownloadInput>, context: BrowserCallContext = {}) {
    const parsed = this.parseMutation(schemas.browserDownloadInputSchema, input, context);
    const value = schemas.browserWorkerDownloadSchema.parse(await this.request(parsed, `/v1/browser/downloads/${parsed.id}/content`, "POST", { actor: this.actor(context), expectedEpoch: parsed.expectedEpoch }, context));
    if (value.id !== parsed.id || value.browserSessionId !== this.repository.browsers.get(parsed)!.id) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    const bytes = Buffer.from(value.dataBase64, "base64"); if (createHash("sha256").update(bytes).digest("hex") !== value.sha256) throw new AevorenBotError("BROWSER_MEDIA_INVALID");
    const metadata = schemas.browserDownloadSchema.parse(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "dataBase64"))); const blobPath = await this.media.put(bytes, value.sha256, context.signal); this.access(parsed, context);
    this.repository.browsers.recordDownload(parsed, metadata, blobPath, parsed.expectedEpoch, this.actor(context)); return { download: metadata, bytes };
  }
  private async control(input: BrowserMutationCall<ComputerControlInput>, owner: ComputerOwner, context: BrowserCallContext): Promise<ComputerView> {
    const parsed = this.parseMutation(schemas.computerControlSchema, input, context); if (this.actor(context) !== "user") throw new AevorenBotError("COMPUTER_USER_CONTROLLED");
    return this.locked(parsed, async () => {
      this.live(parsed, context); const id = this.intent(parsed, `control.${owner}`, context), before = this.repository.browsers.get(parsed)!;
      let intent = this.controls.get(id);
      if (!intent) { const claimed = this.repository.browsers.claimControl(parsed, { owner: "user", expectedEpoch: parsed.expectedEpoch, ...(parsed.expectedVersion ? { expectedVersion: parsed.expectedVersion } : {}) });
        intent = { scope: scope(parsed), owner, previousEpoch: parsed.expectedEpoch, claimedEpoch: claimed.epoch, bootId: before.bootId }; this.controls.set(id, intent); this.viewers.revoke(parsed); this.emit(parsed, "control", before.version); }
      if (intent.owner !== owner || intent.previousEpoch !== parsed.expectedEpoch) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
      const currentView = this.repository.browsers.view(parsed)!;
      if (intent.completedEpoch !== undefined) {
        if (currentView.epoch !== intent.completedEpoch || currentView.owner !== intent.owner || this.repository.browsers.get(parsed)!.bootId !== intent.bootId) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
        const actual = await this.health(parsed, context.signal); this.live(parsed, context);
        if (actual.control.controlEpoch !== intent.completedEpoch || actual.control.owner !== intent.owner || actual.bootId !== intent.bootId) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
        return this.repository.browsers.view(parsed)!;
      }
      if (currentView.epoch !== intent.claimedEpoch || currentView.owner !== "user") throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
      try {
        let health = await this.health(parsed, context.signal);
        if (health.bootId !== intent.bootId || health.control.controlEpoch > intent.claimedEpoch) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
        while (health.control.controlEpoch < intent.claimedEpoch || health.control.owner !== owner) {
          const expectedEpoch = health.control.controlEpoch;
          const result = schemas.browserWorkerControlSchema.parse(await (await this.client(parsed)).request(`/v1/computer/${owner === "user" ? "takeover" : "return"}`, "POST",
            { actor: "user", expectedEpoch, operationId: operationId(`${id}:${owner}:${expectedEpoch}`) }, context.signal));
          if (result.controlEpoch <= expectedEpoch) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
          health = await this.health(parsed, context.signal);
        }
        this.live(parsed, context); if (health.control.owner !== owner) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
        this.repository.browsers.syncControl(parsed, health.control, health.bootId, { explicitReturn: owner === "ai" });
        this.repository.browsers.update(parsed, this.repository.browsers.get(parsed)!.version, { state: "running" }); intent.completedEpoch = health.control.controlEpoch;
        this.emit(parsed, "control", before.version); return this.repository.browsers.view(parsed)!;
      } catch (error) { this.repository.browsers.update(parsed, this.repository.browsers.get(parsed)!.version, { state: "unknown" }); throw failure(error); }
    });
  }
  takeover(input: BrowserMutationCall<ComputerControlInput>, context: BrowserCallContext = {}) { return this.control(input, "user", context); }
  returnControl(input: BrowserMutationCall<ComputerControlInput>, context: BrowserCallContext = {}) { return this.control(input, "ai", context); }
  async vncTicket(input: BrowserEpochInput & { clientNonce?: string }, context: BrowserCallContext = {}): Promise<ComputerVncTicket> {
    if (this.actor(context) !== "user") throw new AevorenBotError("COMPUTER_USER_CONTROLLED");
    const parsed = this.parseMutation(schemas.computerVncTicketSchema, input, context);
    return this.locked(parsed, async () => {
      this.access(parsed, context, true); const id = this.intent(parsed, "vncTicket", context), previous = this.ticketResults.get(id);
      if (previous) { if (previous.epoch !== parsed.expectedEpoch || Date.parse(previous.expiresAt) <= Date.now()) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED"); return previous; }
      const record = this.repository.browsers.getInternal(parsed)!;
      const ticket = await this.viewers.ticket({ scope: scope(parsed), browserSessionId: record.id, epoch: parsed.expectedEpoch, port: record.workerPort!, token: this.codec.decrypt(record.encryptedToken!),
        isAuthorized: () => { try { return this.repository.browsers.assertFresh(parsed, parsed.expectedEpoch, "user").owner === "user"; } catch { return false; } } });
      this.access(parsed, context, true); this.ticketResults.set(id, ticket); return ticket;
    });
  }
  async previewList(input: BrowserEpochInput, context: BrowserCallContext = {}): Promise<ServicePreview[]> {
    const parsed = schemas.browserEpochSchema.parse(input); this.access(parsed, context); const ports = await this.environments.listPorts(scope(parsed)); this.access(parsed, context);
    const previous = this.repository.browsers.listPreviews(parsed, parsed.expectedEpoch, this.actor(context));
    for (const item of previous.filter(item => item.state !== "closed")) {
      const port = ports.find(port => port.id === item.registeredPortId && port.state === "listening");
      let valid = Boolean(port);
      if (port) { try { await this.environments.createPreview(scope(parsed), item.id, item.registeredPortId, context.signal); } catch { valid = false; } }
      this.access(parsed, context);
      if (!valid) this.repository.browsers.closePreview(parsed, item.id, parsed.expectedEpoch, this.actor(context));
    }
    return this.repository.browsers.listPreviews(parsed, parsed.expectedEpoch, this.actor(context));
  }
  async previewOpen(input: BrowserMutationCall<PreviewOpenInput>, context: BrowserCallContext = {}): Promise<ServicePreview> {
    const parsed = this.parseMutation(schemas.previewOpenSchema, input, context); this.access(parsed, context, true);
    const ports = await this.environments.listPorts(scope(parsed)); this.access(parsed, context); const port = ports.find(port => port.id === parsed.registeredPortId && port.state === "listening");
    if (!port) throw new AevorenBotError("PREVIEW_UNAVAILABLE"); const current = this.repository.browsers.get(parsed)!;
    const id = operationId(`${this.intent(parsed, "preview.open", context)}:preview`);
    const previous = this.repository.browsers.listPreviews(parsed, parsed.expectedEpoch, this.actor(context)).find(item => item.id === id);
    if (previous) {
      if (previous.registeredPortId !== parsed.registeredPortId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
      if (previous.state !== "closed") await this.environments.createPreview(scope(parsed), id, port.id, context.signal);
      this.access(parsed, context);
      await this.tabs({ ...scope(parsed), expectedEpoch: parsed.expectedEpoch }, context);
      return this.repository.browsers.listPreviews(parsed, parsed.expectedEpoch, this.actor(context)).find(item => item.id === id)!;
    }
    const ticket = schemas.executionPreviewTicketSchema.parse(await this.environments.createPreview(scope(parsed), id, port.id, context.signal));
    if (ticket.id !== id || ticket.registeredPortId !== port.id || ticket.processId !== port.processId || ticket.port !== port.port || !ticket.host.endsWith(`.aevoren-preview-${current.environmentId}.internal`) || Date.parse(ticket.expiresAt) <= Date.now()) throw new AevorenBotError("PREVIEW_UNAVAILABLE");
    this.access(parsed, context); const url = `http://${ticket.host}:8080/`;
    const page = await this.newTab({ ...scope(parsed), expectedEpoch: parsed.expectedEpoch, clientNonce: parsed.clientNonce, url }, { ...context, operationId: this.intent(parsed, "preview.open", context) });
    this.access(parsed, context); const preview = this.repository.browsers.recordPreview(parsed, { registeredPortId: port.id, pageId: page.id, url, id }, parsed.expectedEpoch, this.actor(context)); this.emit(parsed, "preview"); return preview;
  }
  async previewClose(input: BrowserMutationCall<PreviewCloseInput>, context: BrowserCallContext = {}): Promise<ServicePreview> {
    const parsed = this.parseMutation(schemas.previewCloseSchema, input, context); this.access(parsed, context, true);
    const preview = this.repository.browsers.listPreviews(parsed, parsed.expectedEpoch, this.actor(context)).find(value => value.id === parsed.id);
    if (!preview) throw new AevorenBotError("PREVIEW_NOT_FOUND");
    await this.environments.closePreview(scope(parsed), parsed.id); this.access(parsed, context);
    if (preview.state !== "closed") await this.closeTab({ ...scope(parsed), expectedEpoch: parsed.expectedEpoch, pageId: preview.pageId, clientNonce: parsed.clientNonce }, context);
    return this.repository.browsers.closePreview(parsed, parsed.id, parsed.expectedEpoch, this.actor(context));
  }
  private async cancelOperation(input: BrowserScope, id: string) { return schemas.browserWorkerCancelAckSchema.parse(await (await this.client(input)).request(`/v1/operations/${id}/cancel`, "POST", {})); }
  async cancelRuntime(runtimeRunId: string): Promise<void> { await Promise.allSettled([...this.active].filter(([, entry]) => entry.runtimeRunId === runtimeRunId).map(([id, entry]) => this.cancelOperation(entry.scope, id))); }
  async release(input: BrowserScope, remove = false): Promise<void> { return this.locked(input, async () => { const record = this.repository.browsers.getInternal(input); if (!record) return;
    this.viewers.revoke(input); await this.docker.stopBrowser(record.id, record.environmentId, remove); const current = this.repository.browsers.get(input);
    if (current) {
      if (remove) this.repository.browsers.updateConnection(input, { imageDigest: null, imageRef: null, workerVersion: null, platform: null, workerPort: null, containerId: null });
      this.repository.browsers.update(input, this.repository.browsers.get(input)!.version, { state: "stopped" });
    }
  }); }
  async shutdown(): Promise<void> { this.closing = true; await Promise.allSettled([...this.active].map(([id, entry]) => this.cancelOperation(entry.scope, id))); await this.viewers.shutdown(); }
}
