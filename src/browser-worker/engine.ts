import { chromium, type Browser, type BrowserContext, type CDPSession, type ElementHandle, type Page } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import { BROWSER_FRAME_MAX_BYTES, BROWSER_TEXT_MAX_CHARACTERS } from "@shared/browser-contracts";
import type { BrowserObservation, BrowserPage, BrowserWorkerFrame } from "@shared/browser-contracts";
import { browserUrlSchema } from "@shared/browser-schemas";
import type { ControlRecord, DownloadRecord } from "./state-store";
import type { EngineAction, EngineEvent, EngineRequest, EngineResponse } from "./engine-protocol";
import { BrowserWorkerError } from "./worker-error";
import { imageDimensions } from "./image";
import { readDownload } from "./download-reader";
import { OwnedChromium } from "./chromium-control";
import { CdpDownloads } from "./cdp-downloads";

type PageRecord = { page: Page; session: CDPSession; id: string; version: number; createdAt: string };
type ObservationRecord = { id: string; pageId: string; epoch: number; actor: "ai" | "user"; documentVersion: number; refs: Map<string, ElementHandle> };
type Input = Record<string, unknown> & { actor: "ai" | "user"; expectedEpoch: number; pageId?: string; observationId?: string; documentVersion?: number };
const send = (value: EngineResponse | EngineEvent): void => { if (process.connected) process.send?.(value); };

export class BrowserEngine {
  private context: BrowserContext | null = null;
  private browser: Browser | null = null;
  private chrome: OwnedChromium | null = null;
  private downloads: CdpDownloads | null = null;
  private readonly pages = new Map<string, PageRecord>();
  private readonly registering = new Map<Page, Promise<PageRecord>>();
  private readonly observations = new Map<string, ObservationRecord>();
  private readonly active = new Set<Promise<unknown>>();
  private control: ControlRecord = { owner: "user", epoch: 0, needsObservation: true };
  private activePageId: string | null = null;
  private readonly changeBinding = `aevoren_document_${randomUUID().replaceAll("-", "")}`;
  private readonly focusWorld = `aevoren_focus_${randomUUID().replaceAll("-", "")}`;
  private lastFocusCheck: Array<{ focused: boolean; closed: boolean; stage: number; exception: boolean }> = [];
  private readonly operations = new Map<string, { cancelled: boolean; running: boolean; page: Page | null; processes: Set<ChildProcess> }>();

  constructor(readonly options: { browserSessionId: string; profileDirectory: string; downloadsDirectory: string }) {}

  async initialize(): Promise<void> {
    await mkdir(process.env.HOME!, { recursive: true, mode: 0o700 });
    const executionIp = process.env.AEVOREN_PREVIEW_EXECUTION_IP, environmentId = process.env.AEVOREN_PREVIEW_ENVIRONMENT_ID;
    if (executionIp && (isIP(executionIp) !== 4 || !z.string().uuid().safeParse(environmentId).success)) throw new BrowserWorkerError("BROWSER_PREVIEW_TARGET_INVALID", 503);
    this.chrome = new OwnedChromium(this.options.profileDirectory,
      executionIp ? `MAP *.aevoren-preview-${environmentId}.internal ${executionIp}` : undefined,
      () => send({ type: "browser-stopped" }));
    const rawDownloads = join(this.options.downloadsDirectory, ".cdp-raw");
    await mkdir(rawDownloads, { recursive: true, mode: 0o700 });
    try {
      const endpoint = await this.chrome.start();
      this.browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true, artifactsDir: rawDownloads, timeout: 30_000 });
      this.context = this.browser.contexts()[0]!;
      this.downloads = new CdpDownloads({ session: await this.browser.newBrowserCDPSession(), directory: this.options.downloadsDirectory,
        resolvePage: frameId => this.pageForFrame(frameId), currentControl: () => this.control,
        onDownload: (download, lease) => send({ type: "download", download, lease }),
        onFailure: (error, lease) => send({ type: "download-error", error, lease }) });
      await this.downloads.start();
    } catch {
      await this.chrome.close(); throw new BrowserWorkerError("BROWSER_ENGINE_START_FAILED", 503);
    }
    this.context.setDefaultTimeout(5_000);
    this.context.on("close", () => send({ type: "browser-stopped" }));
    this.context.setDefaultNavigationTimeout(8_000);
    await this.context.exposeBinding(this.changeBinding, source => {
      const record = [...this.pages.values()].find(value => value.page === source.page);
      if (record && source.frame === source.page.mainFrame()) { record.version++; this.invalidate(record.id); }
    });
    const watchDocument = ({ name }: { name: string }): void => {
      let scheduled = false;
      new MutationObserver(() => {
        if (scheduled) return; scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          void (globalThis as unknown as Record<string, () => Promise<void>>)[name]?.();
        });
      }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    };
    await this.context.addInitScript(watchDocument, { name: this.changeBinding });
    await Promise.all(this.context.pages().map(page => this.register(page)));
    await Promise.all(this.context.pages().map(page => page.evaluate(watchDocument, { name: this.changeBinding })));
    this.context.on("page", page => { void this.register(page).catch(() => page.close().catch(() => undefined)); });
    if (this.pages.size === 0) await this.register(await this.context.newPage());
  }

  private register(page: Page): Promise<PageRecord> {
    const existing = [...this.pages.values()].find(value => value.page === page);
    if (existing) return Promise.resolve(existing);
    const pending = this.registering.get(page);
    if (pending) return pending;
    const prepared = (async () => {
      const session = await this.context!.newCDPSession(page);
      await page.setViewportSize({ width: 1_200, height: 700 });
      return this.registerReady(page, session);
    })();
    this.registering.set(page, prepared);
    void prepared.then(() => this.registering.delete(page), () => this.registering.delete(page));
    return prepared;
  }

  private registerReady(page: Page, session: CDPSession): PageRecord {
    const record = { page, session, id: randomUUID(), version: 1, createdAt: new Date().toISOString() };
    this.pages.set(record.id, record);
    this.activePageId = record.id;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) { record.version++; this.invalidate(record.id); } });
    page.on("close", () => { this.pages.delete(record.id); this.invalidate(record.id); void session.detach().catch(() => undefined); if (this.activePageId === record.id) this.activePageId = this.pages.keys().next().value ?? null; });
    return record;
  }

  private invalidate(pageId: string): void {
    for (const [id, observation] of this.observations) {
      if (observation.pageId !== pageId) continue;
      this.observations.delete(id);
      for (const handle of observation.refs.values()) void handle.dispose().catch(() => undefined);
    }
  }

  private assertAccess(epoch: number, actor: "ai" | "user"): void {
    if (actor === "ai" && this.control.owner !== "ai") throw new BrowserWorkerError("BROWSER_USER_CONTROL", 409);
    if (epoch !== this.control.epoch) throw new BrowserWorkerError("BROWSER_CONTROL_CHANGED", 409);
  }

  private page(id: string | undefined): PageRecord {
    const value = this.pages.get(id ?? this.activePageId ?? "");
    if (!value || value.page.isClosed()) throw new BrowserWorkerError("BROWSER_PAGE_NOT_FOUND", 404);
    return value;
  }

  private async pageForFrame(frameId: string): Promise<string | null> {
    await Promise.allSettled([...this.registering.values()]);
    type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
    const contains = (tree: FrameTree): boolean => tree.frame.id === frameId || Boolean(tree.childFrames?.some(contains));
    for (const record of this.pages.values()) {
      try { const tree = await record.session.send("Page.getFrameTree"); if (contains(tree.frameTree)) return record.id; }
      catch { /* A closed target cannot authorize a download association. */ }
    }
    return null;
  }

  private async focusedPage(): Promise<PageRecord | null> {
    const candidates = await Promise.all([...this.pages.values()].map(async record => {
      let stage = 0;
      try {
        const tree = await record.session.send("Page.getFrameTree"); stage = 1;
        const world = await record.session.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id,
          worldName: this.focusWorld, grantUniveralAccess: false }); stage = 2;
        const result = await record.session.send("Runtime.evaluate", { expression: "document.hasFocus()", contextId: world.executionContextId, returnByValue: true, silent: true }); stage = 3;
        return { record, focused: result.result.value === true, stage, exception: Boolean(result.exceptionDetails) };
      } catch { return { record, focused: false, stage, exception: false }; }
    }));
    if (process.env.AEVOREN_BROWSER_DIAGNOSTICS === "1") this.lastFocusCheck = candidates.slice(0, 20).map(({ record, focused, stage, exception }) => ({ focused, closed: !this.pages.has(record.id), stage, exception }));
    const focused = candidates.filter(value => value.focused);
    return focused.length === 1 ? focused[0]!.record : null;
  }

  private async assertFocused(record: PageRecord): Promise<void> {
    if ((await this.focusedPage())?.id !== record.id) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
  }

  private async pageDTO(record: PageRecord): Promise<BrowserPage> {
    return { id: record.id, browserSessionId: this.options.browserSessionId, url: record.page.url().slice(0, 8_192), title: (await record.page.title()).slice(0, 2_000),
      documentVersion: record.version, createdAt: record.createdAt, updatedAt: new Date().toISOString() };
  }

  private proof(input: Input): { page: PageRecord; observation: ObservationRecord } {
    this.assertAccess(input.expectedEpoch, input.actor);
    this.assertOperation(input);
    const page = this.page(input.pageId), observation = this.observations.get(input.observationId ?? "");
    if (input.actor === "ai" && this.control.needsObservation || !observation || observation.actor !== input.actor || observation.epoch !== input.expectedEpoch || observation.pageId !== page.id || observation.documentVersion !== input.documentVersion || page.version !== input.documentVersion) {
      throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
    }
    return { page, observation };
  }

  private assertOperation(input: Input): void {
    if (input.operationId && this.operations.get(String(input.operationId))?.cancelled) throw new BrowserWorkerError("BROWSER_OPERATION_CANCELLED", 409);
  }

  private remember(observation: ObservationRecord): void {
    this.observations.set(observation.id, observation);
    const sameActor = [...this.observations.values()].filter(value => value.pageId === observation.pageId && value.actor === observation.actor);
    for (const oldest of sameActor.slice(0, -10)) {
      this.observations.delete(oldest.id);
      for (const handle of oldest.refs.values()) void handle.dispose().catch(() => undefined);
    }
  }

  private async observe(record: PageRecord, epoch: number, offset = 0, maxCharacters = 18_000, actor: "ai" | "user" = "ai"): Promise<BrowserObservation> {
    const version = record.version;
    const visible = await record.page.evaluate(({ offset, maxCharacters }) => {
      const content = document.body?.innerText ?? "";
      return { text: content.slice(offset, offset + maxCharacters), truncated: content.length > offset + maxCharacters };
    }, { offset, maxCharacters: Math.min(maxCharacters, BROWSER_TEXT_MAX_CHARACTERS) });
    const elements = await record.page.$$("a[href],button,input,textarea,select,[role=button],[role=link],[contenteditable=true]");
    const selected = elements.slice(0, 500), refs = new Map<string, ElementHandle>();
    const descriptors = await Promise.all(selected.map(async element => {
      const description = await element.evaluate(node => {
        const name = node.getAttribute("aria-label") || ("labels" in node ? [...((node as HTMLInputElement).labels ?? [])].map(label => label.textContent).join(" ") : "") || node.getAttribute("placeholder") || node.textContent || "";
        return { role: node.getAttribute("role") || node.tagName.toLowerCase(), name: name.trim().slice(0, 2_000), visible: Boolean(node.getClientRects().length) };
      }).catch(() => null);
      if (!description?.visible) { await element.dispose(); return null; }
      const ref = `element_${randomUUID().replaceAll("-", "")}`;
      refs.set(ref, element); return { ref, role: description.role.slice(0, 120), name: description.name };
    }));
    for (const element of elements.slice(500)) await element.dispose();
    try {
      this.assertAccess(epoch, actor);
      if (record.version !== version) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
      const id = randomUUID();
      this.remember({ id, pageId: record.id, actor, epoch, documentVersion: version, refs });
      if (actor === "ai") this.control.needsObservation = false;
      return { id, browserSessionId: this.options.browserSessionId, pageId: record.id, controlEpoch: epoch, documentVersion: version,
        url: record.page.url().slice(0, 8_192), title: (await record.page.title()).slice(0, 2_000), ...visible,
        elements: descriptors.filter(value => value !== null), truncated: visible.truncated || elements.length > 500, observedAt: new Date().toISOString() };
    } catch (error) {
      for (const element of refs.values()) await element.dispose().catch(() => undefined);
      throw error;
    }
  }

  private async runProgram(command: string, args: string[], input?: string, operationId?: string, maxBytes = BROWSER_FRAME_MAX_BYTES): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const operation = operationId ? this.operations.get(operationId) : undefined;
      if (operation?.cancelled) { reject(new BrowserWorkerError("BROWSER_OPERATION_CANCELLED", 409)); return; }
      const diagnostic = command === "ffmpeg" && process.env.AEVOREN_BROWSER_DIAGNOSTICS === "1";
      const startedAt = Date.now(), stderr: Buffer[] = [];
      const samples: { elapsedMs: number; threads: number | null; rssKiB: number | null }[] = [];
      let stderrSize = 0;
      const child = spawn(command, args, { env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", DISPLAY: ":99", HOME: process.env.HOME }, stdio: ["pipe", "pipe", diagnostic ? "pipe" : "ignore"] });
      child.stderr?.on("data", (chunk: Buffer) => { if (stderrSize < 4_096) { const value = chunk.subarray(0, 4_096 - stderrSize); stderr.push(value); stderrSize += value.length; } });
      const sampling = diagnostic ? setInterval(() => {
        if (!child.pid || samples.length >= 50) return;
        void readFile(`/proc/${child.pid}/status`, "utf8").then(status => samples.push({ elapsedMs: Date.now() - startedAt,
          threads: Number(/^Threads:\s+(\d+)/mu.exec(status)?.[1]) || null, rssKiB: Number(/^VmRSS:\s+(\d+)/mu.exec(status)?.[1]) || null }), () => undefined);
      }, 50) : undefined;
      operation?.processes.add(child);
      const chunks: Buffer[] = []; let size = 0, settled = false;
      const finish = (error?: Error): void => {
        if (settled) return; settled = true; clearTimeout(timer); if (sampling) clearInterval(sampling); operation?.processes.delete(child);
        if (error) {
          child.kill("SIGKILL");
          if (diagnostic) void writeFile("/tmp/aevoren-ffmpeg-diagnostics.json", JSON.stringify({ program: "ffmpeg", elapsedMs: Date.now() - startedAt,
            errorCode: error.message, bytes: size, stderr: Buffer.concat(stderr).toString("utf8"), samples }), { mode: 0o600 }).catch(() => undefined).finally(() => reject(error));
          else reject(error);
        } else {
          if (diagnostic) void writeFile("/tmp/aevoren-ffmpeg-diagnostics.json", JSON.stringify({ program: "ffmpeg", elapsedMs: Date.now() - startedAt,
            errorCode: null, bytes: size, stderr: Buffer.concat(stderr).toString("utf8"), samples }), { mode: 0o600 }).catch(() => undefined).finally(() => resolve(Buffer.concat(chunks)));
          else resolve(Buffer.concat(chunks));
        }
      };
      const timer = setTimeout(() => finish(new BrowserWorkerError("BROWSER_OPERATION_TIMEOUT", 504)), 5_000);
      child.once("error", () => finish(new BrowserWorkerError("BROWSER_DESKTOP_UNAVAILABLE", 503)));
      child.once("exit", code => finish(code === 0 ? undefined : new BrowserWorkerError("BROWSER_DESKTOP_OPERATION_FAILED", 502)));
      child.stdout!.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) finish(new BrowserWorkerError("BROWSER_IMAGE_TOO_LARGE", 413)); else chunks.push(chunk); });
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(input);
    });
  }

  private async frame(input: Input, desktop: boolean): Promise<BrowserWorkerFrame> {
    const record = desktop && input.actor === "user" ? await this.focusedPage() : this.page(input.pageId);
    const startedAt = Date.now(), versionBefore = record?.version;
    let phase = "focus-before", observation: { id: string; documentVersion: number | null } | undefined;
    try {
      if (input.actor === "ai") {
        await record!.page.bringToFront(); this.activePageId = record!.id;
        await this.assertFocused(record!);
      }
      phase = "document-version-before";
      observation = input.actor === "ai" ? await this.observe(record!, input.expectedEpoch, 0, 18_000, "ai") : { id: randomUUID(), documentVersion: record?.version ?? null };
      if (input.actor === "user" && record) this.remember({ id: observation.id, pageId: record.id, actor: "user", epoch: input.expectedEpoch, documentVersion: record.version, refs: new Map() });
      phase = "capture";
      const bytes = desktop
        ? await this.runProgram("ffmpeg", ["-hide_banner", "-loglevel", "error", "-filter_threads", "1", "-f", "x11grab", "-video_size", "1280x800", "-i", ":99", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-threads", "1", "-q:v", "4", "pipe:1"])
        : await record!.page.screenshot({ type: "jpeg", quality: 80, caret: "initial", timeout: 5_000 });
      this.assertAccess(input.expectedEpoch, input.actor);
      if (bytes.length > BROWSER_FRAME_MAX_BYTES) throw new BrowserWorkerError("BROWSER_IMAGE_TOO_LARGE", 413);
      phase = "focus-after";
      if (desktop && (await this.focusedPage())?.id !== record?.id) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
      this.assertAccess(input.expectedEpoch, input.actor);
      phase = "document-version-after";
      if (record && record.version !== observation.documentVersion) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
      return { browserSessionId: this.options.browserSessionId, pageId: record?.id ?? null, observationId: observation.id, controlEpoch: input.expectedEpoch,
        documentVersion: record?.version ?? null, dataBase64: bytes.toString("base64"), mimeType: "image/jpeg", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
        ...imageDimensions(bytes, "image/jpeg"), capturedAt: new Date().toISOString() };
    } catch (error) {
      if (process.env.AEVOREN_BROWSER_DIAGNOSTICS === "1" && error instanceof BrowserWorkerError && error.code === "BROWSER_OBSERVATION_STALE") {
        const version = (value: number | null | undefined): number | null => Number.isSafeInteger(value) && value! >= 0 ? value! : null;
        await writeFile("/tmp/aevoren-frame-diagnostics.json", JSON.stringify({ phase, desktop, ai: input.actor === "ai", elapsedMs: Math.min(60_000, Math.max(0, Date.now() - startedAt)),
          expectedEpoch: version(input.expectedEpoch), currentEpoch: version(this.control.epoch), ownerIsAi: this.control.owner === "ai", needsObservation: this.control.needsObservation,
          pageKnown: Boolean(record && this.pages.get(record.id) === record), pageClosed: record?.page.isClosed() ?? true, pageCount: Math.min(this.pages.size, 20),
          versionBefore: version(versionBefore), versionAfter: version(record?.version), observedVersion: version(observation?.documentVersion),
          focusChecks: this.lastFocusCheck }), { mode: 0o600 }).catch(() => undefined);
      }
      throw error;
    }
  }

  async perform(action: EngineAction, payload: Record<string, unknown> | ControlRecord): Promise<unknown> {
    if (action === "control") {
      this.control = { ...(payload as ControlRecord) };
      for (const pageId of this.pages.keys()) this.invalidate(pageId);
      await this.downloads?.controlChanged();
      const closing: Promise<void>[] = [];
      for (const operation of this.operations.values()) {
        if (!operation.running) continue;
        operation.cancelled = true;
        for (const child of operation.processes) child.kill("SIGKILL");
        if (operation.page) closing.push(operation.page.close().catch(() => undefined));
      }
      await Promise.allSettled(closing);
      await Promise.allSettled([...this.active]);
      return null;
    }
    if (action === "shutdown") {
      await this.downloads?.close();
      if (this.browser?.isConnected()) {
        const session = await this.browser.newBrowserCDPSession().catch(() => null);
        await session?.send("Browser.close").catch(() => undefined);
      }
      await this.chrome?.close();
      await this.context?.close().catch(() => undefined);
      return null;
    }
    if (action === "discard-download") {
      const id = z.string().uuid().parse((payload as Record<string, unknown>).id);
      await rm(join(this.options.downloadsDirectory, id), { force: true });
      return null;
    }
    if (action === "cancel") {
      const id = String((payload as Record<string, unknown>).operationId), operation = this.operations.get(id);
      if (operation) {
        operation.cancelled = true;
        for (const child of operation.processes) child.kill("SIGKILL");
        await operation.page?.close().catch(() => undefined);
      } else this.operations.set(id, { cancelled: true, running: false, page: null, processes: new Set() });
      return null;
    }
    const input = payload as Input;
    this.assertAccess(input.expectedEpoch, input.actor);
    this.assertOperation(input);
    if (input.operationId) this.operations.set(String(input.operationId), { cancelled: false, running: true, page: input.pageId ? this.page(input.pageId).page : null, processes: new Set() });
    const work = this.performAI(action, input);
    this.active.add(work);
    try { const result = await work; this.assertAccess(input.expectedEpoch, input.actor); this.assertOperation(input); return result; }
    finally { this.active.delete(work); const operation = this.operations.get(String(input.operationId)); if (operation) operation.running = false; }
  }

  private async performAI(action: EngineAction, input: Input): Promise<unknown> {
    if (action === "read-download") return { dataBase64: (await readDownload(this.options.downloadsDirectory, input.metadata as DownloadRecord)).toString("base64") };
    if (action === "pages") { await Promise.allSettled([...this.registering.values()]); return Promise.all([...this.pages.values()].map(value => this.pageDTO(value))); }
    if (action === "create") {
      if (input.actor === "ai" && this.control.needsObservation) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
      if (this.pages.size >= 20) throw new BrowserWorkerError("BROWSER_PAGE_LIMIT", 409);
      const record = await this.register(await this.context!.newPage());
      const operation = this.operations.get(String(input.operationId));
      if (operation) operation.page = record.page;
      if (operation?.cancelled) { await record.page.close(); throw new BrowserWorkerError("BROWSER_OPERATION_CANCELLED", 409); }
      this.assertAccess(input.expectedEpoch, input.actor);
      await record.page.goto(browserUrlSchema.parse(input.url ?? "about:blank"), { waitUntil: "domcontentloaded" });
      return this.pageDTO(record);
    }
    const record = this.page(input.pageId);
    if (action === "observe") return this.observe(record, input.expectedEpoch, Number(input.offset ?? 0), Number(input.maxCharacters ?? 18_000), input.actor);
    if (action === "frame" || action === "desktop-frame") return this.frame(input, action === "desktop-frame");
    if (action === "navigate" || action === "close-page") {
      if (input.actor === "ai" && this.control.needsObservation) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
      this.assertOperation(input);
      if (action === "navigate") { await record.page.goto(browserUrlSchema.parse(input.url), { waitUntil: "domcontentloaded" }); return this.pageDTO(record); }
      await record.page.close(); return { pageId: record.id, closed: true };
    }
    this.proof(input);
    if (action === "computer-action") {
      await this.assertFocused(record);
      this.proof(input);
      const button = { left: "1", middle: "2", right: "3" }[String(input.button ?? "left") as "left" | "middle" | "right"];
      if (input.method === "click") {
        if (Number(input.x) >= 1_280 || Number(input.y) >= 800) throw new BrowserWorkerError("BROWSER_COORDINATE_INVALID");
        await this.runProgram("xdotool", ["mousemove", String(input.x), String(input.y), "click", button!], undefined, String(input.operationId));
      } else if (input.method === "type") await this.runProgram("xdotool", ["type", "--clearmodifiers", "--delay", "0", "--file", "-"], String(input.text), String(input.operationId));
      else if (input.method === "key") await this.runProgram("xdotool", ["key", "--clearmodifiers", String(input.key).replaceAll("Control", "ctrl").replaceAll("Meta", "super").replaceAll("Arrow", "")], undefined, String(input.operationId));
      else if (input.method === "scroll") {
        if (input.x !== undefined && input.y !== undefined) await this.runProgram("xdotool", ["mousemove", String(input.x), String(input.y)], undefined, String(input.operationId));
        const deltaY = Number(input.deltaY), deltaX = Number(input.deltaX);
        if (deltaY) await this.runProgram("xdotool", ["click", "--repeat", String(Math.min(100, Math.ceil(Math.abs(deltaY) / 100))), "--delay", "0", deltaY > 0 ? "5" : "4"], undefined, String(input.operationId));
        this.assertAccess(input.expectedEpoch, input.actor);
        if (deltaX) await this.runProgram("xdotool", ["click", "--repeat", String(Math.min(100, Math.ceil(Math.abs(deltaX) / 100))), "--delay", "0", deltaX > 0 ? "7" : "6"], undefined, String(input.operationId));
      } else throw new BrowserWorkerError("BROWSER_INVALID_REQUEST");
    } else {
      await record.page.bringToFront(); this.activePageId = record.id;
      const proof = this.proof(input);
      if (input.method === "click" || input.method === "type") {
        const target = proof.observation.refs.get(String(input.ref));
        if (!target || !await target.evaluate(node => node.isConnected)) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
        this.proof(input);
        if (input.method === "click") await target.click({ button: (input.button ?? "left") as "left" | "middle" | "right", timeout: 5_000 });
        else if (input.replace) await target.fill(String(input.text), { timeout: 5_000 });
        else await target.type(String(input.text), { timeout: 5_000 });
      } else if (input.method === "key") { this.assertAccess(input.expectedEpoch, input.actor); await record.page.keyboard.press(String(input.key)); }
      else if (input.method === "scroll") { this.assertAccess(input.expectedEpoch, input.actor); await record.page.mouse.wheel(Number(input.deltaX), Number(input.deltaY)); }
      else throw new BrowserWorkerError("BROWSER_INVALID_REQUEST");
    }
    this.assertAccess(input.expectedEpoch, input.actor);
    record.version++; this.invalidate(record.id);
    return this.pageDTO(record);
  }
}

export async function runEngine(): Promise<void> {
  const engine = new BrowserEngine({ browserSessionId: process.argv[2]!, profileDirectory: process.argv[3]!, downloadsDirectory: process.argv[4]! });
  await engine.initialize();
  process.on("message", value => {
    const request = value as EngineRequest;
    if (request.type !== "request") return;
    void engine.perform(request.action, request.payload).then(result => {
      send({ type: "response", id: request.id, ok: true, value: result });
    }, error => {
      send({ type: "response", id: request.id, ok: false, code: error instanceof BrowserWorkerError ? error.code : "BROWSER_OPERATION_FAILED", status: error instanceof BrowserWorkerError ? error.status : 502 });
    });
  });
  process.once("disconnect", () => { void engine.perform("shutdown", {}).finally(() => process.exit(0)); });
  send({ type: "ready" });
}
