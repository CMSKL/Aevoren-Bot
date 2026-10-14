import { chromium, type BrowserContext, type ElementHandle, type Page } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import { BROWSER_DOWNLOAD_MAX_BYTES, BROWSER_FRAME_MAX_BYTES, BROWSER_TEXT_MAX_CHARACTERS } from "@shared/browser-contracts";
import type { BrowserObservation, BrowserPage, BrowserWorkerFrame } from "@shared/browser-contracts";
import { browserUrlSchema } from "@shared/browser-schemas";
import type { ControlRecord, DownloadRecord } from "./state-store";
import type { EngineAction, EngineEvent, EngineRequest, EngineResponse } from "./engine-protocol";
import { BrowserWorkerError } from "./worker-error";
import { imageDimensions } from "./image";
import { readDownload } from "./download-reader";

type PageRecord = { page: Page; id: string; version: number; createdAt: string };
type ObservationRecord = { id: string; pageId: string; epoch: number; actor: "ai" | "user"; documentVersion: number; refs: Map<string, ElementHandle> };
type Input = Record<string, unknown> & { actor: "ai" | "user"; expectedEpoch: number; pageId?: string; observationId?: string; documentVersion?: number };
const send = (value: EngineResponse | EngineEvent): void => { if (process.connected) process.send?.(value); };

export class BrowserEngine {
  private context: BrowserContext | null = null;
  private readonly pages = new Map<string, PageRecord>();
  private readonly observations = new Map<string, ObservationRecord>();
  private readonly active = new Set<Promise<unknown>>();
  private control: ControlRecord = { owner: "user", epoch: 0, needsObservation: true };
  private activePageId: string | null = null;
  private readonly changeBinding = `aevoren_document_${randomUUID().replaceAll("-", "")}`;
  private readonly operations = new Map<string, { cancelled: boolean; running: boolean; page: Page | null; processes: Set<ChildProcess> }>();

  constructor(readonly options: { browserSessionId: string; profileDirectory: string; downloadsDirectory: string }) {}

  async initialize(): Promise<void> {
    await mkdir(process.env.HOME!, { recursive: true, mode: 0o700 });
    const executionIp = process.env.AEVOREN_PREVIEW_EXECUTION_IP, environmentId = process.env.AEVOREN_PREVIEW_ENVIRONMENT_ID;
    if (executionIp && (isIP(executionIp) !== 4 || !z.string().uuid().safeParse(environmentId).success)) throw new BrowserWorkerError("BROWSER_PREVIEW_TARGET_INVALID", 503);
    this.context = await chromium.launchPersistentContext(this.options.profileDirectory, {
      headless: false, viewport: { width: 1_200, height: 700 }, acceptDownloads: true,
      timeout: 30_000, env: { ...process.env },
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions", "--window-size=1280,800", "--window-position=0,0",
        ...(executionIp ? [`--host-resolver-rules=MAP *.aevoren-preview-${environmentId}.internal ${executionIp}`] : [])],
    });
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
    for (const page of this.context.pages()) this.register(page);
    await Promise.all(this.context.pages().map(page => page.evaluate(watchDocument, { name: this.changeBinding })));
    this.context.on("page", page => this.register(page));
    if (this.pages.size === 0) this.register(await this.context.newPage());
  }

  private register(page: Page): PageRecord {
    const existing = [...this.pages.values()].find(value => value.page === page);
    if (existing) return existing;
    const record = { page, id: randomUUID(), version: 1, createdAt: new Date().toISOString() };
    this.pages.set(record.id, record);
    this.activePageId = record.id;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) { record.version++; this.invalidate(record.id); } });
    page.on("close", () => { this.pages.delete(record.id); this.invalidate(record.id); if (this.activePageId === record.id) this.activePageId = this.pages.keys().next().value ?? null; });
    page.on("download", download => {
      const epoch = this.control.epoch, owner = this.control.owner;
      const work = (async () => {
        const id = randomUUID(), temporary = join(this.options.downloadsDirectory, `${id}.partial`), target = join(this.options.downloadsDirectory, id);
        const name = [...download.suggestedFilename()].map(character => character.charCodeAt(0) < 32 || ["/", "\\"].includes(character) ? "_" : character).join("").slice(0, 200) || "download";
        const timeout = setTimeout(() => { void download.cancel().catch(() => undefined); }, 10_000);
        let size = 0;
        const digest = createHash("sha256");
        try {
          const input = await download.createReadStream();
          if (!input) throw new BrowserWorkerError("BROWSER_DOWNLOAD_FAILED", 502);
          const output = await open(temporary, "wx", 0o600);
          try {
            for await (const chunk of input) {
              if (this.control.epoch !== epoch || this.control.owner !== owner) throw new BrowserWorkerError("BROWSER_CONTROL_CHANGED", 409);
              const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
              if (size > BROWSER_DOWNLOAD_MAX_BYTES) { input.destroy(); await download.cancel(); throw new BrowserWorkerError("BROWSER_DOWNLOAD_TOO_LARGE", 413); }
              digest.update(bytes); await output.write(bytes);
            }
            await output.sync();
          } finally { await output.close(); }
          if (this.control.epoch !== epoch || this.control.owner !== owner) throw new BrowserWorkerError("BROWSER_CONTROL_CHANGED", 409);
          await rename(temporary, target);
          send({ type: "download", download: { id, pageId: record.id, name, size, sha256: digest.digest("hex"), createdAt: new Date().toISOString() } });
        } catch (error) {
          await download.cancel().catch(() => undefined);
          await rm(temporary, { force: true });
          await rm(target, { force: true });
          send({ type: "download-error", error: { id, pageId: record.id, name, errorCode: error instanceof BrowserWorkerError ? error.code : "BROWSER_DOWNLOAD_FAILED", createdAt: new Date().toISOString() } });
        } finally { clearTimeout(timeout); }
      })();
      this.active.add(work);
      void work.finally(() => this.active.delete(work));
    });
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
      const child = spawn(command, args, { env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", DISPLAY: ":99", HOME: process.env.HOME }, stdio: ["pipe", "pipe", "ignore"] });
      operation?.processes.add(child);
      const chunks: Buffer[] = []; let size = 0, settled = false;
      const finish = (error?: Error): void => {
        if (settled) return; settled = true; clearTimeout(timer); operation?.processes.delete(child);
        if (error) { child.kill("SIGKILL"); reject(error); } else resolve(Buffer.concat(chunks));
      };
      const timer = setTimeout(() => finish(new BrowserWorkerError("BROWSER_OPERATION_TIMEOUT", 504)), 5_000);
      child.once("error", () => finish(new BrowserWorkerError("BROWSER_DESKTOP_UNAVAILABLE", 503)));
      child.once("exit", code => finish(code === 0 ? undefined : new BrowserWorkerError("BROWSER_DESKTOP_OPERATION_FAILED", 502)));
      child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) finish(new BrowserWorkerError("BROWSER_IMAGE_TOO_LARGE", 413)); else chunks.push(chunk); });
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    });
  }

  private async frame(input: Input, desktop: boolean): Promise<BrowserWorkerFrame> {
    let record = this.page(input.pageId);
    if (desktop && input.actor === "user") {
      const focused = await Promise.all([...this.pages.values()].map(async value => ({ value, focused: await value.page.evaluate(() => document.hasFocus()).catch(() => false) })));
      record = focused.find(value => value.focused)?.value ?? record;
    }
    const observation = input.actor === "ai" ? await this.observe(record, input.expectedEpoch, 0, 18_000, "ai") : { id: randomUUID(), documentVersion: record.version };
    if (input.actor === "user") this.remember({ id: observation.id, pageId: record.id, actor: "user", epoch: input.expectedEpoch, documentVersion: record.version, refs: new Map() });
    if (input.actor === "ai") { await record.page.bringToFront(); this.activePageId = record.id; }
    const bytes = desktop
      ? await this.runProgram("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-video_size", "1280x800", "-i", ":99", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "pipe:1"])
      : await record.page.screenshot({ type: "jpeg", quality: 80, caret: "initial", timeout: 5_000 });
    this.assertAccess(input.expectedEpoch, input.actor);
    if (bytes.length > BROWSER_FRAME_MAX_BYTES) throw new BrowserWorkerError("BROWSER_IMAGE_TOO_LARGE", 413);
    if (record.version !== observation.documentVersion) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
    return { browserSessionId: this.options.browserSessionId, pageId: record.id, observationId: observation.id, controlEpoch: input.expectedEpoch,
      documentVersion: record.version, dataBase64: bytes.toString("base64"), mimeType: "image/jpeg", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      ...imageDimensions(bytes, "image/jpeg"), capturedAt: new Date().toISOString() };
  }

  async perform(action: EngineAction, payload: Record<string, unknown> | ControlRecord): Promise<unknown> {
    if (action === "control") {
      this.control = { ...(payload as ControlRecord) };
      for (const pageId of this.pages.keys()) this.invalidate(pageId);
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
    if (action === "shutdown") { await this.context?.close(); return null; }
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
    if (action === "pages") return Promise.all([...this.pages.values()].map(value => this.pageDTO(value)));
    if (action === "create") {
      if (input.actor === "ai" && this.control.needsObservation) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
      if (this.pages.size >= 20) throw new BrowserWorkerError("BROWSER_PAGE_LIMIT", 409);
      const record = this.register(await this.context!.newPage());
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
    const proof = this.proof(input);
    await record.page.bringToFront(); this.activePageId = record.id;
    this.assertOperation(input);
    if (action === "computer-action") {
      this.assertAccess(input.expectedEpoch, input.actor);
      const button = { left: "1", middle: "2", right: "3" }[String(input.button ?? "left") as "left" | "middle" | "right"];
      if (input.method === "click") {
        if (Number(input.x) >= 1_280 || Number(input.y) >= 800) throw new BrowserWorkerError("BROWSER_COORDINATE_INVALID");
        await this.runProgram("xdotool", ["mousemove", "--sync", String(input.x), String(input.y), "click", button!], undefined, String(input.operationId));
      } else if (input.method === "type") await this.runProgram("xdotool", ["type", "--clearmodifiers", "--delay", "0", "--file", "-"], String(input.text), String(input.operationId));
      else if (input.method === "key") await this.runProgram("xdotool", ["key", "--clearmodifiers", String(input.key).replaceAll("Control", "ctrl").replaceAll("Meta", "super").replaceAll("Arrow", "")], undefined, String(input.operationId));
      else if (input.method === "scroll") {
        if (input.x !== undefined && input.y !== undefined) await this.runProgram("xdotool", ["mousemove", "--sync", String(input.x), String(input.y)], undefined, String(input.operationId));
        const deltaY = Number(input.deltaY), deltaX = Number(input.deltaX);
        if (deltaY) await this.runProgram("xdotool", ["click", "--repeat", String(Math.min(100, Math.ceil(Math.abs(deltaY) / 100))), "--delay", "0", deltaY > 0 ? "5" : "4"], undefined, String(input.operationId));
        this.assertAccess(input.expectedEpoch, input.actor);
        if (deltaX) await this.runProgram("xdotool", ["click", "--repeat", String(Math.min(100, Math.ceil(Math.abs(deltaX) / 100))), "--delay", "0", deltaX > 0 ? "7" : "6"], undefined, String(input.operationId));
      } else throw new BrowserWorkerError("BROWSER_INVALID_REQUEST");
    } else if (input.method === "click" || input.method === "type") {
      const target = proof.observation.refs.get(String(input.ref));
      if (!target || !await target.evaluate(node => node.isConnected)) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
      this.assertAccess(input.expectedEpoch, input.actor);
      if (input.method === "click") await target.click({ button: (input.button ?? "left") as "left" | "middle" | "right", timeout: 5_000 });
      else if (input.replace) await target.fill(String(input.text), { timeout: 5_000 });
      else await target.type(String(input.text), { timeout: 5_000 });
    } else if (input.method === "key") { this.assertAccess(input.expectedEpoch, input.actor); await record.page.keyboard.press(String(input.key)); }
    else if (input.method === "scroll") { this.assertAccess(input.expectedEpoch, input.actor); await record.page.mouse.wheel(Number(input.deltaX), Number(input.deltaY)); }
    else throw new BrowserWorkerError("BROWSER_INVALID_REQUEST");
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
