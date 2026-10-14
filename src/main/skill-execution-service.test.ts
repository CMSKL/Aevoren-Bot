import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerExecution } from "@shared/environment-contracts";
import { skillPackageDescriptor, skillScriptCommand, type WorkerSkillInstallRequest, type WorkerSkillRunRequest } from "@shared/skill-execution-contracts";
import { AppRepository } from "./database";
import { LibraryService } from "./library-service";
import { EnvironmentService } from "./environment-service";
import { SkillExecutionService } from "./skill-execution-service";

const cleanups: (() => Promise<void>)[] = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function fixture(workerVersion = "1.2.0") {
  const root = mkdtempSync(join(tmpdir(), "aevoren-skill-service-")), repository = new AppRepository(join(root, "app.sqlite"));
  const owner = repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
  const library = new LibraryService(repository, join(root, "owned")), source = join(root, "source");
  mkdirSync(join(source, "scripts"), { recursive: true }); mkdirSync(join(source, "assets"));
  const body = "---\nname: immutable-script\ndescription: Script fixture\n---\nOriginal Skill bytes.\n";
  const script = Buffer.from("\uFEFFconsole.log(process.argv.slice(2));\n", "utf8"), binary = Buffer.from([0, 255, 254, 128, 1]);
  writeFileSync(join(source, "SKILL.md"), body); writeFileSync(join(source, "scripts", "task.mjs"), script); writeFileSync(join(source, "assets", "value.png"), binary);
  const content = (await library.importPaths(scope.sessionId, [source], "skill")).imported[0]!; rmSync(source, { recursive: true });
  const initial = repository.environments.ensure(scope, { workerVersion, imageRef: `aevoren-execution-worker:${workerVersion}`, imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" });
  const bootId = randomUUID(), calls: { path: string; body?: unknown }[] = [], executions = new Map<string, WorkerExecution>();
  let installHook: ((input: WorkerSkillInstallRequest, response: ServerResponse) => Promise<void>) | undefined, unsupported = false;
  // A controlled loopback protocol peer for host validation tests. It does not execute scripts or claim Docker acceptance.
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://127.0.0.1").pathname;
    const parts: Buffer[] = []; for await (const bytes of request) parts.push(Buffer.from(bytes));
    const input = parts.length ? JSON.parse(Buffer.concat(parts).toString()) as unknown : undefined;
    calls.push({ path, body: input }); response.setHeader("content-type", "application/json");
    if (path === "/v1/health") { response.end(JSON.stringify({ environmentId: initial.id, bootId, workerVersion, protocolVersion: 1, capabilities: unsupported ? ["execution"] : ["execution", "skill-script"] })); return; }
    if (path === "/v1/skill-packages") {
      const install = input as WorkerSkillInstallRequest;
      if (installHook) { await installHook(install, response); return; }
      response.end(JSON.stringify({ id: install.id, reference: install.reference, packageDigest: createHash("sha256").update(skillPackageDescriptor(install)).digest("hex"),
        fileCount: install.files.length, size: install.files.reduce((size, file) => size + file.size, 0) })); return;
    }
    if (path === "/v1/skill-runs") {
      const run = input as WorkerSkillRunRequest, at = new Date().toISOString();
      const execution: WorkerExecution = { id: run.id, environmentId: initial.id, executionSessionId: run.sessionId, runtimeRunId: run.runtimeRunId,
        kind: "foreground", command: skillScriptCommand(run), cwd: run.cwd, state: "running", pid: 1010, exitCode: null, signal: null,
        createdAt: at, startedAt: at, endedAt: null, lastSeq: 0, truncated: false };
      executions.set(run.id, execution); response.end(JSON.stringify(execution)); return;
    }
    if (path.endsWith("/events")) { response.setHeader("content-type", "text/event-stream"); response.end(); return; }
    const id = path.split("/")[3]!;
    if (path.endsWith("/cancel")) {
      const value = executions.get(id);
      if (value) { value.state = "cancelled"; value.signal = "SIGTERM"; value.endedAt = new Date().toISOString(); response.end(JSON.stringify(value)); }
      else response.end(JSON.stringify({ id, state: "cancelled", pending: true })); return;
    }
    if (executions.has(id)) { response.end(JSON.stringify(executions.get(id))); return; }
    response.statusCode = 404; response.end(JSON.stringify({ error: { code: "WORKER_EXECUTION_NOT_FOUND" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const environment = repository.environments.update(scope, initial.version, { state: "running", workerPort: port, encryptedToken: "a".repeat(64), bootId });
  const environments = new EnvironmentService(repository.environments, { isAvailable: () => true, encrypt: value => value, decrypt: value => value }, root);
  const service = new SkillExecutionService(repository, library, environments);
  cleanups.push(async () => { await environments.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); repository.close(); rmSync(root, { recursive: true, force: true }); });
  const grantInput = { ...scope, environmentId: environment.id, expectedImageDigest: environment.imageDigest, expectedWorkerVersion: environment.workerVersion,
    reference: content.reference, entryPath: "scripts/task.mjs", interpreter: "node" as const };
  return { root, repository, scope, library, content, environments, service, grantInput, calls, executions, body, script, binary,
    installHook: (hook: typeof installHook) => { installHook = hook; }, unsupported: () => { unsupported = true; } };
}
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe("script host authorization with real SQLite, CAS bytes and a controlled loopback protocol peer", () => {
  it("installs exact older bytes including a script BOM and binary assets, without export rewriting or shell dispatch", async () => {
    const f = await fixture(), grant = await f.service.grantExecution(f.grantInput);
    const descriptors = await f.service.scripts({ ...f.scope, reference: f.content.reference });
    expect(descriptors[0]?.entrySha256).toBe(createHash("sha256").update(f.script).digest("hex"));
    f.repository.library.update({ sessionId: f.scope.sessionId, id: f.content.resource.id, expectedVersion: 1, body: "LATEST_BODY", name: "LATEST_NAME" });
    const input = { ...f.scope, clientNonce: randomUUID(), grantId: grant.id, expectedGrantVersion: grant.version, args: ["hello", "$(never-shell)"] };
    const result = await f.service.runScript(input);
    const install = f.calls.find(call => call.path === "/v1/skill-packages")!.body as WorkerSkillInstallRequest;
    const bytes = (path: string) => Buffer.from(install.files.find(file => file.relativePath === path)!.dataBase64, "base64");
    expect(bytes("SKILL.md")).toEqual(Buffer.from(f.body)); expect(bytes("scripts/task.mjs")).toEqual(f.script); expect(bytes("assets/value.png")).toEqual(f.binary);
    expect(result.reference).toEqual(f.content.reference); expect(result.args).toEqual(input.args);
    expect(f.calls.some(call => call.path === "/v1/executions" || call.path === "/v1/processes")).toBe(false);
    expect(result.execution.command).toContain('"kind":"skill-script"');
    expect((await f.service.runScript({ ...input, cwd: ".", timeoutMs: 120_000 })).execution.id).toBe(result.execution.id);
    expect(f.calls.filter(call => call.path === "/v1/skill-runs")).toHaveLength(1);
    await expect(f.service.runScript({ ...input, args: ["different"] })).rejects.toMatchObject({ code: "SKILL_EXECUTION_CONFLICT" });
  });

  it("does not grant execution from metadata declarations and denies a missing Worker capability without publishing a grant", async () => {
    const f = await fixture(); f.unsupported();
    await expect(f.service.grantExecution(f.grantInput)).rejects.toMatchObject({ code: "SKILL_SCRIPT_UNSUPPORTED" });
    expect(f.repository.skillExecutions.list(f.scope)).toEqual([]);
    expect(f.calls.some(call => call.path === "/v1/skill-runs")).toBe(false);
  });

  it("keeps a pinned 1.1 environment unchanged when its controlled health reports no script capability", async () => {
    const f = await fixture("1.1.0"); f.unsupported();
    const before = f.repository.environments.get(f.scope), rebuild = vi.spyOn(f.environments, "rebuild");
    await expect(f.service.grantExecution(f.grantInput)).rejects.toMatchObject({ code: "SKILL_SCRIPT_UNSUPPORTED" });
    expect(f.repository.environments.get(f.scope)).toEqual(before); expect(rebuild).not.toHaveBeenCalled();
    expect(f.repository.skillExecutions.list(f.scope)).toEqual([]);
  });

  it("revokes a package still being read before any install or dispatch", async () => {
    const f = await fixture(), grant = await f.service.grantExecution(f.grantInput), entered = deferred(), ready = deferred();
    const read = f.library.readResourceBytes.bind(f.library);
    vi.spyOn(f.library, "readResourceBytes").mockImplementation(async (...args) => { entered.resolve(); await ready.promise; return read(...args); });
    const pending = f.service.runScript({ ...f.scope, clientNonce: randomUUID(), grantId: grant.id, expectedGrantVersion: 1 }).catch(error => error);
    await entered.promise;
    await f.service.revokeExecution({ ...f.scope, id: grant.id, expectedVersion: 1 }); ready.resolve();
    expect(await pending).toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
    expect(f.calls.some(call => call.path === "/v1/skill-packages" || call.path === "/v1/skill-runs")).toBe(false);
    expect(f.repository.environments.listExecutions(f.scope)).toEqual([]);
    await expect(f.service.runScript({ ...f.scope, clientNonce: randomUUID(), grantId: grant.id, expectedGrantVersion: 1 })).rejects.toMatchObject({ code: "SKILL_GRANT_REVOKED" });
  });

  it("rejects an unbind that happens during byte preparation and never installs a stale permission snapshot", async () => {
    const f = await fixture(), grant = await f.service.grantExecution(f.grantInput), entered = deferred(), ready = deferred();
    const read = f.library.readResourceBytes.bind(f.library);
    vi.spyOn(f.library, "readResourceBytes").mockImplementation(async (...args) => { const value = await read(...args); entered.resolve(); await ready.promise; return value; });
    const pending = f.service.runScript({ ...f.scope, clientNonce: randomUUID(), grantId: grant.id, expectedGrantVersion: 1 }).catch(error => error);
    await entered.promise; f.repository.library.unbind({ sessionId: f.scope.sessionId, id: f.content.resource.id }); ready.resolve();
    expect(await pending).toMatchObject({ code: "LIBRARY_NOT_BOUND" });
    expect(f.calls.some(call => call.path === "/v1/skill-runs")).toBe(false);
  });

  it("rejects a bad install receipt, preserves unknown provenance and never replays the original dispatch", async () => {
    const f = await fixture(), grant = await f.service.grantExecution(f.grantInput);
    f.installHook(async (install, response) => { response.end(JSON.stringify({ id: install.id, reference: install.reference, packageDigest: "f".repeat(64), fileCount: install.files.length,
      size: install.files.reduce((size, file) => size + file.size, 0) })); });
    const input = { ...f.scope, clientNonce: randomUUID(), grantId: grant.id, expectedGrantVersion: 1 };
    await expect(f.service.runScript(input)).rejects.toMatchObject({ code: "SKILL_PACKAGE_INVALID" });
    const previous = f.repository.environments.findExecutionByNonce(f.scope, input.clientNonce)!;
    expect(previous.state).toBe("unknown"); expect(f.repository.skillExecutions.execution(f.scope, previous).reference).toEqual(f.content.reference);
    expect((await f.service.runScript(input)).execution.state).toBe("unknown");
    expect(f.calls.filter(call => call.path === "/v1/skill-packages")).toHaveLength(1);
    expect(f.calls.filter(call => call.path === "/v1/skill-runs")).toHaveLength(0);
  });

  it("cancels only executions mapped to the revoked grant while leaving an independent background record intact", async () => {
    const f = await fixture(), grant = await f.service.grantExecution(f.grantInput);
    const first = await f.service.runScript({ ...f.scope, clientNonce: randomUUID(), grantId: grant.id, expectedGrantVersion: 1 });
    const session = f.repository.environments.createSession(f.scope, null);
    const background = f.repository.environments.createExecution(f.scope, { clientNonce: randomUUID(), executionSessionId: session.id, kind: "background", command: "unit provenance only" }).execution;
    await f.service.revokeExecution({ ...f.scope, id: grant.id, expectedVersion: 1 });
    expect(f.calls.filter(call => call.path.endsWith("/cancel")).map(call => call.path)).toEqual([`/v1/executions/${first.execution.id}/cancel`]);
    expect(f.repository.environments.getExecution(f.scope, first.execution.id).state).toBe("cancelled");
    expect(f.repository.environments.getExecution(f.scope, background.id)).toEqual(background);
  });

  it("cancels a Runtime's unconfirmed install without dispatching late or replaying the cancelled execution", async () => {
    const f = await fixture(), grant = await f.service.grantExecution(f.grantInput), entered = deferred(), ready = deferred();
    f.installHook(async (install, response) => {
      entered.resolve(); await ready.promise;
      response.end(JSON.stringify({ id: install.id, reference: install.reference, packageDigest: createHash("sha256").update(skillPackageDescriptor(install)).digest("hex"),
        fileCount: install.files.length, size: install.files.reduce((size, file) => size + file.size, 0) }));
    });
    const controller = new AbortController(), input = { ...f.scope, clientNonce: randomUUID(), grantId: grant.id, expectedGrantVersion: 1 };
    const pending = f.service.runScript(input, { signal: controller.signal }).catch(error => error);
    await entered.promise; controller.abort(); ready.resolve();
    expect(await pending).toMatchObject({ name: "AbortError" });
    const original = f.repository.environments.findExecutionByNonce(f.scope, input.clientNonce)!;
    expect(original.state).toBe("cancelled");
    expect((await f.service.runScript(input)).execution.id).toBe(original.id);
    expect(f.calls.filter(call => call.path === "/v1/skill-packages")).toHaveLength(1);
    expect(f.calls.filter(call => call.path === "/v1/skill-runs")).toHaveLength(0);
  });

  it("preserves fixed jobs on edits but cancels only the resource whose execution authority is disabled", async () => {
    const f = await fixture(), grant = await f.service.grantExecution(f.grantInput);
    const firstInput = { ...f.scope, clientNonce: randomUUID(), grantId: grant.id, expectedGrantVersion: 1 };
    const first = await f.service.runScript(firstInput);
    const other = f.repository.library.create({ sessionId: f.scope.sessionId, kind: "skill", name: "Other Skill", body: "Other original body", files: f.content.revision.files });
    const otherGrant = await f.service.grantExecution({ ...f.grantInput, reference: other.reference });
    const sibling = await f.service.runScript({ ...f.scope, clientNonce: randomUUID(), grantId: otherGrant.id, expectedGrantVersion: 1 });
    const next = f.repository.library.update({ sessionId: f.scope.sessionId, id: f.content.resource.id, expectedVersion: 1, body: "NEW_BODY" });
    await f.service.libraryChanged({ sessionId: f.scope.sessionId, resourceId: f.content.resource.id, action: "updated" });
    expect(f.calls.filter(call => call.path.endsWith("/cancel"))).toHaveLength(0);
    f.repository.library.setEnabled({ sessionId: f.scope.sessionId, id: f.content.resource.id, expectedVersion: next.resource.version, enabled: false });
    await f.service.libraryChanged({ sessionId: f.scope.sessionId, resourceId: f.content.resource.id, action: "enabled" });
    expect(f.repository.environments.getExecution(f.scope, first.execution.id).state).toBe("cancelled");
    expect(f.repository.environments.getExecution(f.scope, sibling.execution.id).state).toBe("running");
    f.repository.library.setEnabled({ sessionId: f.scope.sessionId, id: f.content.resource.id, expectedVersion: 3, enabled: true });
    await f.service.libraryChanged({ sessionId: f.scope.sessionId, resourceId: f.content.resource.id, action: "enabled" });
    expect((await f.service.runScript(firstInput)).execution.state).toBe("cancelled");
    expect(f.calls.filter(call => call.path === "/v1/skill-runs")).toHaveLength(2);
  });

  it("seals and drains a delayed native byte preparation on shutdown without touching a background record", async () => {
    const f = await fixture(), grant = await f.service.grantExecution(f.grantInput), entered = deferred(), ready = deferred();
    const session = f.repository.environments.createSession(f.scope, null);
    const background = f.repository.environments.createExecution(f.scope, { executionSessionId: session.id, clientNonce: randomUUID(), kind: "background", command: "independent unit background provenance" }).execution;
    const read = f.library.readResourceBytes.bind(f.library);
    vi.spyOn(f.library, "readResourceBytes").mockImplementation(async (...args) => { entered.resolve(); await ready.promise; return read(...args); });
    const input = { ...f.scope, clientNonce: randomUUID(), grantId: grant.id, expectedGrantVersion: 1 };
    const pending = f.service.runScript(input).catch(error => error); await entered.promise;
    let drained = false; const closing = f.service.shutdown().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    await expect(f.service.runScript(input)).rejects.toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
    await expect(f.service.grantExecution(f.grantInput)).rejects.toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
    ready.resolve(); expect(await pending).toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" }); await closing;
    expect(drained).toBe(true); expect(f.calls.some(call => call.path === "/v1/skill-runs")).toBe(false);
    expect(f.repository.environments.listExecutions(f.scope)).toEqual([background]);
  });
});
