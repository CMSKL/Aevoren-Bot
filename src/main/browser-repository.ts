import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { BrowserDownload, BrowserObservation, BrowserPage, BrowserScope, BrowserSession, BrowserWorkerControl, ComputerOwner,
  ComputerView, InternalBrowserRecord, InternalScreenshotRecord, ScreenshotMedia, ServicePreview } from "@shared/browser-contracts";
import { browserDownloadSchema, browserObservationSchema, browserPageSchema, browserScopeSchema, browserSessionSchema, browserWorkerControlSchema,
  computerViewSchema, screenshotMediaSchema, servicePreviewSchema } from "@shared/browser-schemas";
import { AevorenBotError } from "./errors";

export const BROWSER_MIGRATION = { version: 36, sql: `
  CREATE TABLE browser_sessions (
    id TEXT PRIMARY KEY, environment_id TEXT NOT NULL UNIQUE REFERENCES environments(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id), executor_bot_id TEXT NOT NULL REFERENCES bots(id),
    state TEXT NOT NULL CHECK(state IN ('starting','running','stopped','error','unknown')), version INTEGER NOT NULL CHECK(version>0),
    boot_id TEXT, control_epoch INTEGER NOT NULL CHECK(control_epoch>0), owner TEXT NOT NULL CHECK(owner IN ('ai','user')),
    connection_state TEXT NOT NULL CHECK(connection_state IN ('connected','disconnected')), observed_epoch INTEGER, active_page_id TEXT,
    encrypted_token TEXT, container_id TEXT, worker_port INTEGER, image_ref TEXT, image_digest TEXT, worker_version TEXT, platform TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(session_id,executor_bot_id)
  );
  CREATE TABLE browser_pages (
    id TEXT PRIMARY KEY, browser_session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
    url TEXT NOT NULL, title TEXT NOT NULL, document_version INTEGER NOT NULL CHECK(document_version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE browser_observations (
    id TEXT PRIMARY KEY, browser_session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
    page_id TEXT, control_epoch INTEGER NOT NULL, document_version INTEGER, actor TEXT NOT NULL CHECK(actor IN ('ai','user')), observed_at TEXT NOT NULL
  );
  CREATE TABLE browser_screenshots (
    id TEXT PRIMARY KEY, browser_session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
    page_id TEXT, observation_id TEXT NOT NULL, control_epoch INTEGER NOT NULL, document_version INTEGER,
    name TEXT NOT NULL, size INTEGER NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
    captured_at TEXT NOT NULL, blob_path TEXT NOT NULL
  );
  CREATE TABLE browser_downloads (
    id TEXT PRIMARY KEY, browser_session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL, blob_path TEXT NOT NULL
  );
  CREATE TABLE browser_previews (
    id TEXT PRIMARY KEY, browser_session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    registered_port_id TEXT NOT NULL REFERENCES environment_ports(id) ON DELETE CASCADE, page_id TEXT NOT NULL,
    url TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','closed','unknown')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX browser_page_scope ON browser_pages(browser_session_id);
  CREATE INDEX browser_observation_scope ON browser_observations(browser_session_id,control_epoch);
  CREATE INDEX browser_screenshot_scope ON browser_screenshots(browser_session_id,captured_at);
` } as const;

type SessionRow = { id: string; environment_id: string; session_id: string; executor_bot_id: string; state: BrowserSession["state"]; version: number;
  boot_id: string | null; control_epoch: number; owner: ComputerOwner; connection_state: ComputerView["connectionState"]; observed_epoch: number | null;
  active_page_id: string | null; encrypted_token: string | null; container_id: string | null; worker_port: number | null;
  image_ref: string | null; image_digest: string | null; worker_version: string | null; platform: InternalBrowserRecord["platform"]; created_at: string; updated_at: string };
type PageRow = { id: string; browser_session_id: string; url: string; title: string; document_version: number; created_at: string; updated_at: string };
type ObservationRow = { id: string; browser_session_id: string; page_id: string | null; control_epoch: number; document_version: number | null; actor: ComputerOwner; observed_at: string };
type MediaRow = { id: string; browser_session_id: string; page_id: string | null; observation_id: string; control_epoch: number; document_version: number | null;
  name: string; size: number; mime_type: "image/png" | "image/jpeg"; sha256: string; width: number; height: number; captured_at: string; blob_path: string };
type DownloadRow = { id: string; browser_session_id: string; page_id: string; name: string; size: number; mime_type: string; sha256: string; created_at: string; blob_path: string };
type PreviewRow = { id: string; browser_session_id: string; environment_id: string; registered_port_id: string; page_id: string; url: string;
  state: ServicePreview["state"]; created_at: string; updated_at: string };
const uuid = z.string().uuid(), epoch = z.number().int().positive();
const actorSchema = z.enum(["ai", "user"]);
const blobPathSchema = z.string().min(1).max(2_048);
export type BrowserPatch = Partial<Pick<BrowserSession, "state" | "bootId" | "activePageId">>;
export type BrowserConnectionPatch = Partial<Pick<InternalBrowserRecord, "encryptedToken" | "containerId" | "workerPort" | "imageRef" | "imageDigest" | "workerVersion" | "platform">>;
const connectionPatchSchema = z.object({ encryptedToken: z.string().max(8_192).nullable().optional(), containerId: z.string().max(200).nullable().optional(),
  workerPort: z.number().int().min(1).max(65_535).nullable().optional(), imageRef: z.string().min(1).max(256).nullable().optional(),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable().optional(), workerVersion: z.string().min(1).max(80).nullable().optional(),
  platform: z.enum(["linux/arm64", "linux/amd64"]).nullable().optional() }).strict();
function session(row: SessionRow): BrowserSession { return browserSessionSchema.parse({ id: row.id, environmentId: row.environment_id,
  sessionId: row.session_id, executorBotId: row.executor_bot_id, state: row.state, version: row.version, bootId: row.boot_id, controlEpoch: row.control_epoch,
  activePageId: row.active_page_id, createdAt: row.created_at, updatedAt: row.updated_at }); }
function view(row: SessionRow): ComputerView { return computerViewSchema.parse({ sessionId: row.session_id, executorBotId: row.executor_bot_id,
  browserSessionId: row.id, owner: row.owner, epoch: row.control_epoch, version: row.version, connectionState: row.connection_state, observedEpoch: row.observed_epoch, updatedAt: row.updated_at }); }
function internal(row: SessionRow): InternalBrowserRecord { return { ...session(row), encryptedToken: row.encrypted_token, containerId: row.container_id, workerPort: row.worker_port,
  imageRef: row.image_ref, imageDigest: row.image_digest, workerVersion: row.worker_version, platform: row.platform }; }
function page(row: PageRow): BrowserPage { return { id: row.id, browserSessionId: row.browser_session_id, url: row.url, title: row.title,
  documentVersion: row.document_version, createdAt: row.created_at, updatedAt: row.updated_at }; }
function download(row: DownloadRow): BrowserDownload { return { id: row.id, browserSessionId: row.browser_session_id, pageId: row.page_id, name: row.name,
  size: row.size, mimeType: row.mime_type, sha256: row.sha256, createdAt: row.created_at }; }
function preview(row: PreviewRow): ServicePreview { return { id: row.id, environmentId: row.environment_id, registeredPortId: row.registered_port_id,
  browserSessionId: row.browser_session_id, pageId: row.page_id, url: row.url, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at }; }

export class BrowserRepository {
  private transactionSequence = 0;
  constructor(private readonly database: DatabaseSync, private readonly assertScope: (scope: BrowserScope) => void) {}
  transaction<T>(operation: () => T): T {
    const savepoint = `aevoren_browser_${++this.transactionSequence}`;
    this.database.exec(`SAVEPOINT ${savepoint};`);
    try { const result = operation(); this.database.exec(`RELEASE SAVEPOINT ${savepoint};`); return result; }
    catch (error) { this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint};`); throw error; }
  }
  private scope(input: BrowserScope): BrowserScope {
    const scope = browserScopeSchema.parse({ sessionId: input.sessionId, executorBotId: input.executorBotId }); this.assertScope(scope); return scope;
  }
  private row(input: BrowserScope): SessionRow {
    const scope = this.scope(input);
    const value = this.database.prepare("SELECT * FROM browser_sessions WHERE session_id=? AND executor_bot_id=?").get(scope.sessionId, scope.executorBotId) as SessionRow | undefined;
    if (!value) throw new AevorenBotError("BROWSER_NOT_FOUND"); return value;
  }
  get(input: BrowserScope): BrowserSession | null {
    const scope = this.scope(input);
    const value = this.database.prepare("SELECT * FROM browser_sessions WHERE session_id=? AND executor_bot_id=?").get(scope.sessionId, scope.executorBotId) as SessionRow | undefined;
    return value ? session(value) : null;
  }
  view(input: BrowserScope): ComputerView | null { return this.get(input) ? view(this.row(input)) : null; }
  getInternal(input: BrowserScope): InternalBrowserRecord | null {
    if (!this.get(input)) return null;
    return internal(this.row(input));
  }
  /** Host startup and retirement only; this private inventory is never a transport operation. */
  listInternal(): InternalBrowserRecord[] { return (this.database.prepare("SELECT * FROM browser_sessions ORDER BY created_at,id").all() as SessionRow[]).map(internal); }
  ensure(input: BrowserScope, configuration: { environmentId: string; id?: string }): BrowserSession {
    const scope = this.scope(input), parsed = z.object({ environmentId: uuid, id: uuid.optional() }).strict().parse(configuration);
    return this.transaction(() => {
      const environment = this.database.prepare("SELECT session_id,executor_bot_id FROM environments WHERE id=?").get(parsed.environmentId) as { session_id: string; executor_bot_id: string } | undefined;
      if (!environment || environment.session_id !== scope.sessionId || environment.executor_bot_id !== scope.executorBotId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
      const existing = this.get(scope); if (existing) { if (existing.environmentId !== parsed.environmentId) throw new AevorenBotError("BROWSER_SCOPE_INVALID"); return existing; }
      const at = new Date().toISOString();
      this.database.prepare(`INSERT INTO browser_sessions(id,environment_id,session_id,executor_bot_id,state,version,control_epoch,owner,connection_state,created_at,updated_at)
        VALUES(?,?,?,?,'stopped',1,1,'ai','disconnected',?,?)`).run(parsed.id ?? randomUUID(), parsed.environmentId, scope.sessionId, scope.executorBotId, at, at);
      return this.get(scope)!;
    });
  }
  update(input: BrowserScope, expectedVersion: number, patch: BrowserPatch): BrowserSession {
    const scope = this.scope(input);
    const parsed = z.object({ state: browserSessionSchema.shape.state.optional(), bootId: uuid.nullable().optional(), activePageId: uuid.nullable().optional() }).strict().parse(patch);
    return this.transaction(() => {
      const current = this.row(scope); this.assertVersion(current, expectedVersion);
      if (parsed.activePageId) this.pageRow(current.id, parsed.activePageId);
      const columns = { state: "state", bootId: "boot_id", activePageId: "active_page_id" } as const;
      const values = Object.entries(parsed).filter(([, value]) => value !== undefined) as [keyof BrowserPatch, string | null][];
      const changed = values.filter(([key, value]) => current[columns[key]] !== value);
      if (changed.length) this.database.prepare(`UPDATE browser_sessions SET ${changed.map(([key]) => `${columns[key]}=?`).join(",")},version=version+1,updated_at=? WHERE id=?`)
        .run(...changed.map(([, value]) => value), new Date().toISOString(), current.id);
      return this.get(scope)!;
    });
  }
  updateConnection(input: BrowserScope, patch: BrowserConnectionPatch): InternalBrowserRecord {
    const parsed = connectionPatchSchema.parse(patch);
    return this.transaction(() => {
      const current = this.row(input);
      const columns = { encryptedToken: "encrypted_token", containerId: "container_id", workerPort: "worker_port", imageRef: "image_ref", imageDigest: "image_digest", workerVersion: "worker_version", platform: "platform" } as const;
      const changed = (Object.entries(parsed) as [keyof BrowserConnectionPatch, string | number | null | undefined][])
        .filter(([key, value]) => value !== undefined && current[columns[key]] !== value);
      if (changed.length) this.database.prepare(`UPDATE browser_sessions SET ${changed.map(([key]) => `${columns[key]}=?`).join(",")},version=version+1,updated_at=? WHERE id=?`)
        .run(...changed.map(([, value]) => value as string | number | null), new Date().toISOString(), current.id);
      return this.getInternal(input)!;
    });
  }
  private assertVersion(current: SessionRow, expected: number): void {
    epoch.parse(expected); if (current.version !== expected) throw new AevorenBotError("BROWSER_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
  }
  assertAccess(input: BrowserScope, expectedEpoch: number, actor: ComputerOwner = "ai"): ComputerView {
    const current = this.row(input); epoch.parse(expectedEpoch); actorSchema.parse(actor);
    if (current.control_epoch !== expectedEpoch) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
    if (actor === "ai" && current.owner !== "ai") throw new AevorenBotError("COMPUTER_USER_CONTROLLED");
    if (current.state !== "running") throw new AevorenBotError("BROWSER_UNAVAILABLE");
    return view(current);
  }
  assertFresh(input: BrowserScope, expectedEpoch: number, actor: ComputerOwner = "ai"): ComputerView {
    const control = this.assertAccess(input, expectedEpoch, actor);
    if (actor === "user" && control.owner !== "user") throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
    if (actor === "ai" && control.observedEpoch !== expectedEpoch) throw new AevorenBotError("BROWSER_OBSERVATION_REQUIRED");
    return control;
  }
  claimControl(input: BrowserScope, command: { owner: ComputerOwner; expectedEpoch: number; expectedVersion?: number }): ComputerView {
    const parsed = z.object({ owner: actorSchema, expectedEpoch: epoch, expectedVersion: epoch.optional() }).strict().parse(command);
    return this.transaction(() => {
      const current = this.row(input);
      if (parsed.expectedVersion !== undefined) this.assertVersion(current, parsed.expectedVersion);
      if (parsed.expectedEpoch !== current.control_epoch) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
      this.database.prepare("UPDATE browser_sessions SET owner=?,control_epoch=control_epoch+1,observed_epoch=NULL,connection_state='disconnected',version=version+1,updated_at=? WHERE id=?")
        .run(parsed.owner, new Date().toISOString(), current.id);
      return this.view(input)!;
    });
  }
  syncControl(input: BrowserScope, control: BrowserWorkerControl, bootId: string, options: { explicitReturn?: boolean } = {}): ComputerView {
    const parsed = browserWorkerControlSchema.parse(control); uuid.parse(bootId);
    return this.transaction(() => {
      const current = this.row(input);
      if (parsed.controlEpoch < current.control_epoch || current.boot_id && current.boot_id !== bootId && parsed.controlEpoch <= current.control_epoch
        || current.owner === "user" && parsed.owner === "ai" && !options.explicitReturn) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
      const observed = parsed.controlEpoch === current.control_epoch && current.boot_id === bootId ? current.observed_epoch : null;
      if (current.owner !== parsed.owner || current.control_epoch !== parsed.controlEpoch || current.boot_id !== bootId || current.observed_epoch !== observed || current.connection_state !== parsed.connectionState) {
        this.database.prepare("UPDATE browser_sessions SET owner=?,control_epoch=?,boot_id=?,observed_epoch=?,connection_state=?,version=version+1,updated_at=? WHERE id=?")
          .run(parsed.owner, parsed.controlEpoch, bootId, observed, parsed.connectionState, new Date().toISOString(), current.id);
      }
      return this.view(input)!;
    });
  }
  private pageRow(browserSessionId: string, id: string): PageRow {
    uuid.parse(id); const row = this.database.prepare("SELECT * FROM browser_pages WHERE id=? AND browser_session_id=?").get(id, browserSessionId) as PageRow | undefined;
    if (!row) throw new AevorenBotError("BROWSER_PAGE_NOT_FOUND"); return row;
  }
  pages(input: BrowserScope, expectedEpoch: number, actor: ComputerOwner = "ai"): BrowserPage[] {
    const control = this.assertAccess(input, expectedEpoch, actor);
    return (this.database.prepare("SELECT * FROM browser_pages WHERE browser_session_id=? ORDER BY created_at,id").all(control.browserSessionId) as PageRow[]).map(page);
  }
  upsertPage(input: BrowserScope, value: BrowserPage, expectedEpoch: number, actor: ComputerOwner = "ai"): BrowserPage {
    const control = this.assertAccess(input, expectedEpoch, actor), parsed = browserPageSchema.parse(value);
    if (parsed.browserSessionId !== control.browserSessionId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    const old = this.database.prepare("SELECT * FROM browser_pages WHERE id=?").get(parsed.id) as PageRow | undefined;
    if (old && (old.browser_session_id !== control.browserSessionId || old.document_version > parsed.documentVersion)) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    this.database.prepare(`INSERT INTO browser_pages(id,browser_session_id,url,title,document_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET url=excluded.url,title=excluded.title,document_version=excluded.document_version,updated_at=excluded.updated_at`)
      .run(parsed.id, parsed.browserSessionId, parsed.url, parsed.title, parsed.documentVersion, parsed.createdAt, parsed.updatedAt);
    return page(this.pageRow(control.browserSessionId, parsed.id));
  }
  upsertPages(input: BrowserScope, values: BrowserPage[], expectedEpoch: number, actor: ComputerOwner = "ai"): BrowserPage[] {
    z.array(browserPageSchema).max(50).parse(values);
    if (new Set(values.map(value => value.id)).size !== values.length) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    return this.transaction(() => {
      this.assertAccess(input, expectedEpoch, actor);
      values.forEach(value => this.upsertPage(input, value, expectedEpoch, actor));
      for (const old of this.pages(input, expectedEpoch, actor)) if (!values.some(value => value.id === old.id)) this.removePage(input, old.id, expectedEpoch, actor);
      return this.pages(input, expectedEpoch, actor);
    });
  }
  removePage(input: BrowserScope, id: string, expectedEpoch: number, actor: ComputerOwner = "ai"): void {
    const control = this.assertAccess(input, expectedEpoch, actor); this.pageRow(control.browserSessionId, id);
    this.transaction(() => {
      this.database.prepare("DELETE FROM browser_pages WHERE id=? AND browser_session_id=?").run(id, control.browserSessionId);
      this.database.prepare("UPDATE browser_previews SET state='closed',updated_at=? WHERE page_id=? AND browser_session_id=?").run(new Date().toISOString(), id, control.browserSessionId);
      if (this.row(input).active_page_id === id) this.update(input, this.row(input).version, { activePageId: null });
    });
  }
  private saveObservation(input: BrowserScope, value: { id: string; browserSessionId: string; pageId: string | null; controlEpoch: number; documentVersion: number | null; observedAt: string }, actor: ComputerOwner): void {
    const control = this.assertAccess(input, value.controlEpoch, actor); uuid.parse(value.id);
    if (value.browserSessionId !== control.browserSessionId || (value.pageId === null) !== (value.documentVersion === null)) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    if (value.pageId && this.pageRow(control.browserSessionId, value.pageId).document_version !== value.documentVersion) throw new AevorenBotError("BROWSER_OBSERVATION_REQUIRED");
    const old = this.database.prepare("SELECT * FROM browser_observations WHERE id=?").get(value.id) as ObservationRow | undefined;
    if (old && (old.browser_session_id !== value.browserSessionId || old.control_epoch !== value.controlEpoch || old.page_id !== value.pageId || old.document_version !== value.documentVersion || old.actor !== actor)) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    this.database.prepare("INSERT OR IGNORE INTO browser_observations(id,browser_session_id,page_id,control_epoch,document_version,actor,observed_at) VALUES(?,?,?,?,?,?,?)")
      .run(value.id, value.browserSessionId, value.pageId, value.controlEpoch, value.documentVersion, actor, value.observedAt);
    if (actor === "ai" && value.pageId && control.observedEpoch !== value.controlEpoch) this.database.prepare("UPDATE browser_sessions SET observed_epoch=?,version=version+1,updated_at=? WHERE id=?")
      .run(value.controlEpoch, new Date().toISOString(), control.browserSessionId);
  }
  recordObservation(input: BrowserScope, observation: BrowserObservation, actor: ComputerOwner = "ai"): BrowserObservation {
    const parsed = browserObservationSchema.parse(observation);
    return this.transaction(() => { this.saveObservation(input, parsed, actor); return parsed; });
  }
  assertInput(input: BrowserScope, proof: { pageId: string; expectedEpoch: number; observationId: string; documentVersion: number }, actor: ComputerOwner = "ai"): ComputerView {
    const control = this.assertAccess(input, proof.expectedEpoch, actor); uuid.parse(proof.observationId); epoch.parse(proof.documentVersion);
    if (actor === "user" && control.owner !== "user") throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
    const current = this.pageRow(control.browserSessionId, proof.pageId);
    const observed = this.database.prepare("SELECT * FROM browser_observations WHERE id=? AND browser_session_id=?").get(proof.observationId, control.browserSessionId) as ObservationRow | undefined;
    if (actor === "ai" && control.observedEpoch !== proof.expectedEpoch || !observed || observed.actor !== actor || observed.page_id !== proof.pageId
      || observed.control_epoch !== proof.expectedEpoch || observed.document_version !== proof.documentVersion || current.document_version !== proof.documentVersion) throw new AevorenBotError("BROWSER_OBSERVATION_REQUIRED");
    return control;
  }
  private media(input: BrowserScope, row: MediaRow): InternalScreenshotRecord {
    const scope = this.scope(input);
    return { ...screenshotMediaSchema.parse({ ...scope, id: row.id, name: row.name, browserSessionId: row.browser_session_id, pageId: row.page_id,
      observationId: row.observation_id, controlEpoch: row.control_epoch, documentVersion: row.document_version, size: row.size, mimeType: row.mime_type,
      sha256: row.sha256, width: row.width, height: row.height, capturedAt: row.captured_at }), blobPath: row.blob_path };
  }
  recordFrame(input: BrowserScope, value: InternalScreenshotRecord, actor: ComputerOwner = "ai"): ScreenshotMedia {
    const { blobPath: privatePath, ...metadata } = value;
    const parsed = screenshotMediaSchema.parse(metadata);
    const blobPath = blobPathSchema.parse(privatePath);
    return this.transaction(() => {
      this.saveObservation(input, { id: parsed.observationId, browserSessionId: parsed.browserSessionId, pageId: parsed.pageId, controlEpoch: parsed.controlEpoch,
        documentVersion: parsed.documentVersion, observedAt: parsed.capturedAt }, actor);
      const scope = this.scope(input);
      if (parsed.sessionId !== scope.sessionId || parsed.executorBotId !== scope.executorBotId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
      const old = this.database.prepare("SELECT * FROM browser_screenshots WHERE id=?").get(parsed.id) as MediaRow | undefined;
      if (old) { const existing = this.media(input, old); if (JSON.stringify(existing) !== JSON.stringify({ ...parsed, blobPath })) throw new AevorenBotError("BROWSER_MEDIA_INVALID"); return parsed; }
      this.database.prepare(`INSERT INTO browser_screenshots(id,browser_session_id,page_id,observation_id,control_epoch,document_version,name,size,mime_type,sha256,width,height,captured_at,blob_path)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(parsed.id, parsed.browserSessionId, parsed.pageId, parsed.observationId, parsed.controlEpoch, parsed.documentVersion,
        parsed.name, parsed.size, parsed.mimeType, parsed.sha256, parsed.width, parsed.height, parsed.capturedAt, blobPath);
      return parsed;
    });
  }
  getFrame(input: BrowserScope, id: string, expectedEpoch: number, actor: ComputerOwner = "ai"): InternalScreenshotRecord {
    const control = this.assertAccess(input, expectedEpoch, actor); uuid.parse(id);
    const row = this.database.prepare("SELECT * FROM browser_screenshots WHERE id=? AND browser_session_id=?").get(id, control.browserSessionId) as MediaRow | undefined;
    if (!row) throw new AevorenBotError("BROWSER_MEDIA_NOT_FOUND");
    if (row.control_epoch !== expectedEpoch) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED"); return this.media(input, row);
  }
  assertFrame(input: BrowserScope, id: string, expectedEpoch: number, actor: ComputerOwner = "ai"): ScreenshotMedia {
    return screenshotMediaSchema.strip().parse(this.getFrame(input, id, expectedEpoch, actor));
  }
  recordDownload(input: BrowserScope, value: BrowserDownload, blobPath: string, expectedEpoch: number, actor: ComputerOwner = "ai"): BrowserDownload {
    const control = this.assertAccess(input, expectedEpoch, actor), parsed = browserDownloadSchema.parse(value); blobPathSchema.parse(blobPath);
    if (parsed.browserSessionId !== control.browserSessionId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    const existing = this.database.prepare("SELECT * FROM browser_downloads WHERE id=?").get(parsed.id) as DownloadRow | undefined;
    if (existing) {
      if (JSON.stringify(browserDownloadSchema.parse(download(existing))) !== JSON.stringify(parsed) || existing.blob_path !== blobPath) throw new AevorenBotError("BROWSER_MEDIA_INVALID");
      return parsed;
    }
    this.database.prepare("INSERT INTO browser_downloads(id,browser_session_id,page_id,name,size,mime_type,sha256,created_at,blob_path) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(parsed.id, parsed.browserSessionId, parsed.pageId, parsed.name, parsed.size, parsed.mimeType, parsed.sha256, parsed.createdAt, blobPath);
    return parsed;
  }
  downloads(input: BrowserScope, expectedEpoch: number, actor: ComputerOwner = "ai"): BrowserDownload[] {
    const control = this.assertAccess(input, expectedEpoch, actor);
    return (this.database.prepare("SELECT * FROM browser_downloads WHERE browser_session_id=? ORDER BY created_at,id").all(control.browserSessionId) as DownloadRow[]).map(download);
  }
  getDownload(input: BrowserScope, id: string, expectedEpoch: number, actor: ComputerOwner = "ai"): BrowserDownload & { blobPath: string } {
    const control = this.assertAccess(input, expectedEpoch, actor); uuid.parse(id);
    const row = this.database.prepare("SELECT * FROM browser_downloads WHERE id=? AND browser_session_id=?").get(id, control.browserSessionId) as DownloadRow | undefined;
    if (!row) throw new AevorenBotError("BROWSER_MEDIA_NOT_FOUND"); return { ...download(row), blobPath: row.blob_path };
  }
  recordPreview(input: BrowserScope, value: { registeredPortId: string; pageId: string; url: string; id?: string }, expectedEpoch: number, actor: ComputerOwner = "ai"): ServicePreview {
    const control = this.assertAccess(input, expectedEpoch, actor), current = this.row(input); uuid.parse(value.registeredPortId); this.pageRow(current.id, value.pageId);
    const port = this.database.prepare("SELECT state FROM environment_ports WHERE id=? AND environment_id=?").get(value.registeredPortId, current.environment_id) as { state: string } | undefined;
    if (!port || port.state !== "listening") throw new AevorenBotError("PREVIEW_UNAVAILABLE");
    const at = new Date().toISOString();
    const parsed = servicePreviewSchema.parse({ ...value, id: value.id ?? randomUUID(), environmentId: current.environment_id, browserSessionId: control.browserSessionId, state: "open", createdAt: at, updatedAt: at });
    const existing = this.database.prepare("SELECT * FROM browser_previews WHERE id=?").get(parsed.id) as PreviewRow | undefined;
    if (existing) {
      if (existing.browser_session_id !== parsed.browserSessionId || existing.environment_id !== parsed.environmentId || existing.registered_port_id !== parsed.registeredPortId || existing.page_id !== parsed.pageId || existing.url !== parsed.url) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
      return preview(existing);
    }
    this.database.prepare("INSERT INTO browser_previews(id,browser_session_id,environment_id,registered_port_id,page_id,url,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(parsed.id, parsed.browserSessionId, parsed.environmentId, parsed.registeredPortId, parsed.pageId, parsed.url, parsed.state, at, at); return parsed;
  }
  listPreviews(input: BrowserScope, expectedEpoch: number, actor: ComputerOwner = "ai"): ServicePreview[] {
    const control = this.assertAccess(input, expectedEpoch, actor);
    return (this.database.prepare("SELECT * FROM browser_previews WHERE browser_session_id=? ORDER BY created_at,id").all(control.browserSessionId) as PreviewRow[]).map(preview);
  }
  closePreview(input: BrowserScope, id: string, expectedEpoch: number, actor: ComputerOwner = "ai"): ServicePreview {
    const control = this.assertAccess(input, expectedEpoch, actor); uuid.parse(id);
    this.database.prepare("UPDATE browser_previews SET state='closed',updated_at=? WHERE id=? AND browser_session_id=?").run(new Date().toISOString(), id, control.browserSessionId);
    const row = this.database.prepare("SELECT * FROM browser_previews WHERE id=? AND browser_session_id=?").get(id, control.browserSessionId) as PreviewRow | undefined;
    if (!row) throw new AevorenBotError("PREVIEW_NOT_FOUND"); return preview(row);
  }
  deleteScope(input: BrowserScope): number {
    const scope = this.scope(input); return Number(this.database.prepare("DELETE FROM browser_sessions WHERE session_id=? AND executor_bot_id=?").run(scope.sessionId, scope.executorBotId).changes);
  }
}
