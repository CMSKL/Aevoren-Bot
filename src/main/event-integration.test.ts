import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest } from "@shared/contracts";
import { PRODUCT_OPERATIONS } from "@shared/product-operations";
import { AppRepository, MIGRATIONS } from "./database";
import { EventService } from "./event-service";
import { RoutineService } from "./routine-service";
import { SendWorker } from "./send-worker";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";
import { emitAutomationRuntime } from "./event-runtime";
import { apiResult } from "./errors";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aevoren-event-host-")), path = join(root, "app.sqlite"), repository = new AppRepository(path);
  const worker = new SendWorker(repository, null, { transcript: () => {}, sendState: () => {}, runtime: () => {} }, false, { run: async function* () { yield { type: "started", requestId: randomUUID() }; yield { type: "completed", finishReason: "stop" }; }, testConnection: async () => {} });
  const routines = new RoutineService(repository, worker, () => {}), events = new EventService(repository.automationEvents, routines, { isAvailable: () => true, encrypt: value => `test-sealed:${value}`, decrypt: value => value.slice(12) }, () => {}, { assertSourceSession: id => { repository.getSession(id); } });
  cleanup.push(async () => { await events.shutdown(); await routines.shutdown(); await worker.shutdown(); repository.close(); rmSync(root, { recursive: true, force: true }); });
  const owner = repository.createBot(), other = repository.createBot();
  const saved = routines.create({ name: "Current", prompt: "Saved instruction", botId: owner.bot.id, enabled: true, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
  return { root, path, repository, worker, routines, events, owner, other, saved };
}
const call = (operation: string, input?: unknown): ProductToolRequest => ({ kind: "product-call", action: "execute", operation, ...(input === undefined ? {} : { input }) });
function runtime(f: ReturnType<typeof fixture>, sessionId = f.owner.session.id, text = "Instruction") {
  const nonce = randomUUID(); f.repository.prepareMessage({ clientNonce: nonce, sessionId, text }); const entry = f.repository.getUserMessage(nonce);
  const run = f.repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: f.owner.bot.id, profileVersion: f.owner.bot.version, sessionId, generation: entry.generation, inputSeq: entry.seq, blocks: [], digest: "event-test" });
  f.repository.transitionRuntimeRun(run.id, "dispatching"); return f.repository.transitionRuntimeRun(run.id, "running");
}

describe("automation host integration", () => {
  it("has a separate public directory without listener or bearer operations and preserves Runtime events", () => {
    const names = PRODUCT_OPERATIONS.filter(item => item.name.startsWith("automationEvents.")).map(item => item.name);
    expect(names).toEqual(["automationEvents.snapshot", "automationEvents.create", "automationEvents.update", "automationEvents.revoke", "automationEvents.cancel"]);
    for (const secret of ["rotateToken", "startListener", "stopListener", "emitRuntime", "authenticate"]) expect(PRODUCT_OPERATIONS.some(item => item.name.endsWith(`.${secret}`))).toBe(false);
  });

  it("rejects unknown trusted source sessions and maps event conflicts to useful structured errors", async () => {
    const f = fixture();
    expect(() => f.events.create({ name: "Missing", source: { kind: "runtime.completed", sessionId: randomUUID() }, routineId: f.saved.id, expectedRoutineVersion: f.saved.version })).toThrowError(expect.objectContaining({ code: "SESSION_NOT_FOUND" }));
    const hook = f.events.create({ name: "Current", source: { kind: "webhook" }, routineId: f.saved.id, expectedRoutineVersion: f.saved.version });
    const result = await apiResult(() => f.events.revoke({ id: hook.id, expectedVersion: hook.version + 1 }));
    expect(result).toMatchObject({ ok: false, error: { code: "EVENT_VERSION_CONFLICT", details: { currentVersion: hook.version } } });
  });

  it("scopes shared Product reads and mutations before approval and rejects TASK actors", async () => {
    const f = fixture(), run = runtime(f);
    const product = new ProductOperationService({ repository: f.repository, routineService: f.routines, automationEventService: f.events } as ProductDependencies);
    const current = f.events.create({ name: "Visible", source: { kind: "webhook" }, routineId: f.saved.id, expectedRoutineVersion: f.saved.version });
    const foreignRule = f.routines.create({ name: "Other", prompt: "PRIVATE_OTHER_PROMPT", botId: f.other.bot.id, enabled: true, schedule: f.saved.schedule });
    const foreign = f.events.create({ name: "PRIVATE_OTHER_HOOK", source: { kind: "webhook" }, routineId: foreignRule.id, expectedRoutineVersion: foreignRule.version });
    expect(() => product.validate(call("automationEvents.snapshot"), run.id)).not.toThrow();
    expect(() => product.validate(call("automationEvents.revoke", { id: foreign.id, expectedVersion: foreign.version }), run.id)).toThrowError(expect.objectContaining({ code: "APPROVAL_SCOPE_INVALID" }));
    expect(product.requiresApproval(call("automationEvents.create", {}))).toBe(true); expect(product.requiresApproval(call("automationEvents.snapshot"))).toBe(false);
    expect(f.events.snapshot({ sessionId: f.owner.session.id }).subscriptions.map(item => item.id)).toEqual([current.id]);
    const task = f.repository.tasks.create({ parentSessionId: f.owner.session.id, expectedScopeVersion: f.repository.tasks.scopeVersion(f.owner.session.id), clientNonce: randomUUID(), title: "Task", selections: [{ executorBotId: f.owner.bot.id, memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: ["automationEvents.snapshot"], network: false, clipboard: false }] });
    const taskRun = runtime(f, task.session.id);
    expect(() => product.validate(call("automationEvents.snapshot"), taskRun.id)).toThrowError(expect.objectContaining({ code: "RUNTIME_CONTROL_SCOPE_INVALID" }));
  });

  it("emits only opaque terminal metadata from a real Runtime, never the private user body", async () => {
    const f = fixture(), run = runtime(f, f.owner.session.id, "PRIVATE_USER_BODY_AND_MEMORY"), completed = f.repository.transitionRuntimeRun(run.id, "completed");
    const emit = vi.spyOn(f.events, "emitRuntime").mockResolvedValue([]);
    await emitAutomationRuntime(f.repository, f.events, completed);
    expect(emit).toHaveBeenCalledExactlyOnceWith({ eventId: `runtime:${run.id}:completed`, sessionId: f.owner.session.id, runtimeRunId: run.id, state: "completed" });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE_USER_BODY");
    await emitAutomationRuntime(f.repository, f.events, { ...completed, version: completed.version - 1 }); expect(emit).toHaveBeenCalledTimes(1);
  });

  it("backs up and fills a later lower-numbered migration without losing existing higher versions or chat data", () => {
    const root = mkdtempSync(join(tmpdir(), "aevoren-event-gap-")), path = join(root, "app.sqlite");
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    let repository = new AppRepository(path); const owner = repository.createBot(); repository.close();
    const before = new DatabaseSync(path), oldRows = before.prepare("SELECT * FROM sessions ORDER BY id").all();
    expect(before.prepare("SELECT version FROM schema_migrations WHERE version>=46 ORDER BY version").all()).toEqual([{ version: 46 }, { version: 47 }, { version: 49 }]); before.close();
    const migrations = MIGRATIONS as unknown as Array<{ version: number; sql: string }>, index = migrations.findIndex(item => item.version === 49);
    migrations.splice(index, 0, { version: 48, sql: "CREATE TABLE event_gap_probe(id TEXT PRIMARY KEY)" });
    try {
      repository = new AppRepository(path); expect(repository.getSession(owner.session.id)).toEqual(owner.session); repository.close();
      const after = new DatabaseSync(path);
      expect(after.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(oldRows);
      expect(after.prepare("SELECT version FROM schema_migrations WHERE version>=46 ORDER BY version").all()).toEqual([{ version: 46 }, { version: 47 }, { version: 48 }, { version: 49 }]);
      expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]); after.close();
      expect(readdirSync(join(root, "Backups")).filter(name => name.endsWith(".sqlite"))).toHaveLength(1);
    } finally { migrations.splice(index, 1); }
  });
});
