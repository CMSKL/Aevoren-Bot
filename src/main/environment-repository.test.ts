import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentScope, WorkerLog } from "@shared/environment-contracts";
import { ENV_FOREGROUND_TIMEOUT_MS, ENV_LOG_CHUNK_MAX_BYTES } from "@shared/environment-contracts";
import { environmentDirectoryPathSchema, environmentFilePathSchema, environmentFileWriteSchema, executionCommandSchema, executionRunSchema, processStartSchema, workerExecutionRequestSchema, workerHealthSchema } from "@shared/environment-schemas";
import { ENVIRONMENT_OPERATION_SCHEMAS, ENVIRONMENT_PRODUCT_OPERATIONS } from "@shared/environment-product";
import { AppRepository } from "./database";

const repositories: AppRepository[] = [];
const directories: string[] = [];
const configuration = { workerVersion: "1.0.0", imageRef: "aevoren-execution-worker:1.0.0", imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" as const };
function fixture(filename = ":memory:") {
  const repository = new AppRepository(filename);
  repositories.push(repository);
  const actor = repository.createBot();
  const scope = { sessionId: actor.session.id, executorBotId: actor.bot.id };
  return { repository, actor, scope, environments: repository.environments };
}
function createTask(f: ReturnType<typeof fixture>, kind: "foreground" | "background" = "foreground", clientNonce = randomUUID(), command = "printf hello") {
  f.environments.ensure(f.scope, configuration);
  const session = f.environments.createSession(f.scope, null);
  return f.environments.createExecution(f.scope, { executionSessionId: session.id, clientNonce, kind, command });
}
function sourceRuntime(f: ReturnType<typeof fixture>) {
  const clientNonce = randomUUID();
  f.repository.prepareMessage({ sessionId: f.scope.sessionId, clientNonce, text: "Execute this task" });
  return f.repository.createRuntimeRun(clientNonce, "fake", { schemaVersion: 1, botId: f.actor.bot.id, profileVersion: 1,
    sessionId: f.scope.sessionId, generation: 1, inputSeq: 1, blocks: [], digest: "environment-test" });
}
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("scope-owned execution environment SQLite state", () => {
  it("projects real metadata and never returns encrypted tokens, container ids or worker ports", () => {
    const f = fixture();
    expect(f.environments.get(f.scope)).toBeNull();
    const original = f.environments.ensure(f.scope, configuration);
    expect(original).toMatchObject({ ...f.scope, state: "stopped", workerVersion: "1.0.0", version: 1 });
    f.environments.update({ ...f.scope, id: original.id } as EnvironmentScope, original.version, {
      state: "running", encryptedToken: "PRIVATE_ENCRYPTED_TOKEN", containerId: "PRIVATE_CONTAINER", workerPort: 49_001, bootId: randomUUID(),
    });
    const publicData = f.environments.get(f.scope)!;
    expect(publicData.state).toBe("running");
    expect(JSON.stringify(f.environments.list(f.scope))).not.toContain("PRIVATE_");
    expect(publicData).not.toHaveProperty("encryptedToken");
    expect(publicData).not.toHaveProperty("workerPort");
    expect(publicData).not.toHaveProperty("containerId");
    expect(f.environments.getInternal(f.scope)?.encryptedToken).toBe("PRIVATE_ENCRYPTED_TOKEN");
    expect(f.environments.listInternal()[0]?.workerPort).toBe(49_001);
  });

  it("keeps an existing environment image unchanged when a newer app proposes a different image", () => {
    const f = fixture();
    const first = f.environments.ensure(f.scope, configuration);
    const repeated = f.environments.ensure(f.scope, { ...configuration, workerVersion: "1.1.0", imageDigest: `sha256:${"b".repeat(64)}` });
    expect(repeated).toEqual(first);
    expect(f.environments.list(f.scope)).toHaveLength(1);
  });

  it("gives six group members independent environments and never inherits a Bot's private one", () => {
    const f = fixture();
    const members = [f.actor.bot, ...Array.from({ length: 5 }, () => f.repository.createBot().bot)];
    const room = f.repository.createRoom({ memberBotIds: members.map((bot) => bot.id) });
    const privateEnv = f.environments.ensure(f.scope, configuration);
    const groupEnvs = members.map((bot) => f.environments.ensure({ sessionId: room.session.id, executorBotId: bot.id }, configuration));
    expect(new Set(groupEnvs.map((env) => env.id)).size).toBe(6);
    expect(groupEnvs.map((env) => env.id)).not.toContain(privateEnv.id);
    const outsider = f.repository.createBot();
    expect(() => f.environments.get({ sessionId: room.session.id, executorBotId: outsider.bot.id })).toThrow();
    f.repository.removeRoomMember(room.room.id, members[0]!.id, room.room.membershipVersion);
    expect(() => f.environments.get({ sessionId: room.session.id, executorBotId: members[0]!.id })).toThrow();
    expect(f.environments.get(f.scope)?.id).toBe(privateEnv.id);
  });

  it("checks environment version conflicts and does not overwrite a newer observation", () => {
    const f = fixture();
    const first = f.environments.ensure(f.scope, configuration);
    const second = f.environments.update(f.scope, first.version, { state: "starting" });
    expect(() => f.environments.update(f.scope, first.version, { state: "running" })).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_VERSION_CONFLICT" }));
    expect(f.environments.get(f.scope)).toEqual(second);
  });

  it("records unconfirmed dispatch as unknown and reuses its intent nonce without manufacturing a start", () => {
    const f = fixture();
    const nonce = randomUUID();
    const first = createTask(f, "foreground", nonce);
    expect(first.execution).toMatchObject({ state: "unknown", pid: null, startedAt: null, endedAt: null });
    const repeated = createTask(f, "foreground", nonce);
    expect(repeated).toEqual({ disposition: "existing", execution: first.execution });
    expect(f.environments.listExecutions(f.scope)).toHaveLength(1);
    expect(() => createTask(f, "foreground", nonce, "different command")).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_EXECUTION_CONFLICT" }));
    expect(f.environments.findExecutionByNonce(f.scope, nonce)?.state).toBe("unknown");
  });

  it("reuses the same foreground nonce when omitted defaults are made explicit", () => {
    const f = fixture();
    const nonce = randomUUID();
    const first = createTask(f, "foreground", nonce);
    const session = f.environments.createSession(f.scope, null);
    const input = { executionSessionId: session.id, clientNonce: nonce, kind: "foreground" as const, command: "printf hello", cwd: ".", timeoutMs: ENV_FOREGROUND_TIMEOUT_MS };
    expect(f.environments.createExecution(f.scope, input)).toEqual({ disposition: "existing", execution: first.execution });
    expect(() => f.environments.createExecution(f.scope, { ...input, timeoutMs: ENV_FOREGROUND_TIMEOUT_MS + 1 })).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_EXECUTION_CONFLICT" }));
    expect(f.environments.listExecutions(f.scope)).toHaveLength(1);
  });

  it("binds an execution session to its real Runtime scope and preserves the old task on Runtime retry", () => {
    const f = fixture();
    f.environments.ensure(f.scope, configuration);
    const runtime = sourceRuntime(f);
    const session = f.environments.createSession(f.scope, runtime.id);
    expect(f.environments.createSession(f.scope, runtime.id)).toEqual(session);
    const nonce = randomUUID();
    const first = f.environments.createExecution(f.scope, { executionSessionId: session.id, clientNonce: nonce, kind: "foreground", command: "echo once" });
    f.repository.transitionRuntimeRun(runtime.id, "failed");
    const retry = f.repository.createRuntimeRun(runtime.clientNonce, "fake", runtime.promptManifest);
    const retrySession = f.environments.createSession(f.scope, retry.id);
    const repeated = f.environments.createExecution(f.scope, { executionSessionId: retrySession.id, clientNonce: nonce, kind: "foreground", command: "echo once" });
    expect(repeated.execution.runtimeRunId).toBe(runtime.id);
    expect(repeated.execution.id).toBe(first.execution.id);
    const other = f.repository.createBot();
    const otherScope = { sessionId: other.session.id, executorBotId: other.bot.id };
    f.environments.ensure(otherScope, configuration);
    expect(() => f.environments.createSession(otherScope, runtime.id)).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_SCOPE_INVALID" }));
    expect(() => f.environments.getExecution(otherScope, first.execution.id)).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_EXECUTION_NOT_FOUND" }));
  });

  it("allows genuine confirmation of unknown status, then prevents terminal tasks from being revived", () => {
    const f = fixture();
    const first = createTask(f).execution;
    const running = f.environments.updateExecution(f.scope, first.id, first.version, { state: "running", pid: 4321, startedAt: new Date().toISOString() });
    const complete = f.environments.updateExecution(f.scope, first.id, running.version, { state: "completed", exitCode: 0 });
    expect(complete.endedAt).toBeTruthy();
    expect(() => f.environments.updateExecution(f.scope, first.id, complete.version, { state: "running" })).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_EXECUTION_STATE_INVALID" }));
    expect(() => f.environments.updateExecution(f.scope, first.id, first.version, { signal: "SIGTERM" })).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_VERSION_CONFLICT" }));
  });

  it("rolls local intent state back inside an outer host receipt transaction", () => {
    const f = fixture();
    f.environments.ensure(f.scope, configuration);
    const session = f.environments.createSession(f.scope, null);
    expect(() => f.environments.transaction(() => {
      f.environments.createExecution(f.scope, { executionSessionId: session.id, clientNonce: randomUUID(), kind: "foreground", command: "not remotely dispatched" });
      throw new Error("local receipt refused");
    })).toThrow("local receipt refused");
    expect(f.environments.listExecutions(f.scope)).toEqual([]);
  });

  it("accepts log payloads after the Worker high-water mark was observed and deduplicates raw byte chunks", () => {
    const f = fixture();
    const task = createTask(f).execution;
    f.environments.updateExecution(f.scope, task.id, task.version, { lastSeq: 2 });
    const rows: WorkerLog[] = [1, 2].map((seq) => ({ seq, executionId: task.id, stream: "stdout", text: `chunk ${seq}`, bytesBase64: Buffer.from(`chunk ${seq}`).toString("base64"), at: new Date().toISOString() }));
    expect(f.environments.appendLogs(f.scope, task.id, rows).logs).toEqual(rows);
    const version = f.environments.getExecution(f.scope, task.id).version;
    f.environments.appendLogs(f.scope, task.id, rows);
    expect(f.environments.getExecution(f.scope, task.id).version).toBe(version);
    expect(() => f.environments.appendLogs(f.scope, task.id, [{ ...rows[0]!, text: "changed bytes" }])).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_EXECUTION_CONFLICT" }));
  });

  it("advances a completed high-water snapshot for newly received log bytes, then keeps duplicate delivery stable", () => {
    const f = fixture(), task = createTask(f).execution;
    const running = f.environments.updateExecution(f.scope, task.id, task.version, { state: "running", pid: 4321, startedAt: new Date().toISOString() });
    const completed = f.environments.updateExecution(f.scope, task.id, running.version, { state: "completed", exitCode: 0, lastSeq: 2 });
    const rows: WorkerLog[] = [1, 2].map(seq => ({ seq, executionId: task.id, stream: "stdout", text: `completed chunk ${seq}`, at: new Date().toISOString() }));
    f.environments.appendLogs(f.scope, task.id, rows);
    const withLogs = f.environments.getExecution(f.scope, task.id);
    expect(withLogs).toMatchObject({ state: "completed", exitCode: 0, lastSeq: completed.lastSeq, version: completed.version + 1 });
    expect(withLogs.version).not.toBe(completed.version);
    f.environments.appendLogs(f.scope, task.id, rows);
    expect(f.environments.getExecution(f.scope, task.id)).toEqual(withLogs);
    expect(f.environments.logs(f.scope, task.id).logs).toEqual(rows);
  });

  it("bounds retained logs, lets a new reader use zero and rejects a genuinely expired nonzero cursor", () => {
    const f = fixture();
    const task = createTask(f).execution;
    const text = "x".repeat(ENV_LOG_CHUNK_MAX_BYTES);
    const bytesBase64 = Buffer.from(text).toString("base64");
    const rows: WorkerLog[] = Array.from({ length: 80 }, (_, index) => ({ seq: index + 1, executionId: task.id, stream: "stdout", text, bytesBase64, at: new Date().toISOString() }));
    f.environments.appendLogs(f.scope, task.id, rows);
    const page = f.environments.logs(f.scope, task.id, { afterSeq: 0 });
    expect(page.firstSeq).toBe(17);
    expect(page.logs[0]?.seq).toBe(17);
    expect(page.truncated).toBe(true);
    expect(() => f.environments.logs(f.scope, task.id, { afterSeq: 1 })).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_LOG_CURSOR_EXPIRED" }));
    const version = f.environments.getExecution(f.scope, task.id).version;
    f.environments.appendLogs(f.scope, task.id, [rows[0]!]);
    expect(f.environments.getExecution(f.scope, task.id).version).toBe(version);
  });

  it("keeps ports attached to the correct background task and marks them stopped with the real terminal state", () => {
    const f = fixture();
    const background = createTask(f, "background").execution;
    const running = f.environments.updateExecution(f.scope, background.id, background.version, { state: "running", pid: 5555 });
    const registered = f.environments.upsertPort(f.scope, { processId: background.id, port: 8088, label: "Dev server", state: "listening", checkedAt: new Date().toISOString() });
    expect(registered).toMatchObject({ processId: background.id, port: 8088, state: "listening" });
    expect(f.environments.upsertPort(f.scope, { processId: background.id, port: 8088, label: "Renamed", state: "listening" }).id).toBe(registered.id);
    const foreground = createTask(f).execution;
    expect(() => f.environments.upsertPort(f.scope, { processId: foreground.id, port: 3000 })).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_SCOPE_INVALID" }));
    f.environments.updateExecution(f.scope, background.id, running.version, { state: "cancelled", signal: "SIGTERM" });
    expect(f.environments.listPorts(f.scope)[0]?.state).toBe("stopped");
  });

  it("persists unknown tasks and encrypted private connection state through SQLite restart without spawning anything", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-environment-repository-"));
    directories.push(directory);
    const filename = join(directory, "app.sqlite");
    const f = fixture(filename);
    const task = createTask(f).execution;
    const env = f.environments.get(f.scope)!;
    f.environments.update(f.scope, env.version, { encryptedToken: "ciphertext", state: "unknown" });
    f.repository.close(); repositories.splice(repositories.indexOf(f.repository), 1);
    const reopened = new AppRepository(filename); repositories.push(reopened);
    expect(reopened.environments.getExecution(f.scope, task.id)).toEqual(task);
    expect(reopened.environments.getInternal(f.scope)?.encryptedToken).toBe("ciphertext");
    expect(reopened.environments.listExecutions(f.scope)).toHaveLength(1);
  });

  it("clears conversation history without deleting background ownership or changing its historical Runtime id", () => {
    const f = fixture();
    f.environments.ensure(f.scope, configuration);
    const runtime = sourceRuntime(f);
    const session = f.environments.createSession(f.scope, runtime.id);
    const task = f.environments.createExecution(f.scope, { executionSessionId: session.id, clientNonce: randomUUID(), kind: "background", command: "background service" }).execution;
    const running = f.environments.updateExecution(f.scope, task.id, task.version, { state: "running", pid: 5432, startedAt: new Date().toISOString() });
    f.repository.transitionRuntimeRun(runtime.id, "failed");
    const cleared = f.repository.clearConversation(f.scope.sessionId);
    expect(cleared.generation).toBe(2);
    expect(f.repository.listTranscript(f.scope.sessionId)).toEqual([]);
    expect(f.repository.listRuntimeRuns(f.scope.sessionId)).toEqual([]);
    expect(f.environments.getExecution(f.scope, task.id)).toEqual(running);
    expect(f.environments.getExecution(f.scope, task.id).runtimeRunId).toBe(runtime.id);
    expect(f.environments.listRuntimeExecutions(runtime.id)).toEqual([running]);
    expect(() => f.environments.createSession(f.scope, runtime.id)).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_SCOPE_INVALID" }));
  });

  it("hard-delete hooks remove only the chosen session's environments, child records and private connection data", () => {
    const f = fixture();
    const own = createTask(f, "background").execution;
    const running = f.environments.updateExecution(f.scope, own.id, own.version, { state: "running", pid: 8765 });
    f.environments.appendLogs(f.scope, own.id, [{ executionId: own.id, seq: 1, stream: "stdout", text: "owned log", at: new Date().toISOString() }]);
    f.environments.upsertPort(f.scope, { processId: own.id, port: 8000, state: "listening" });
    const sibling = f.repository.createBot();
    const siblingScope = { sessionId: sibling.session.id, executorBotId: sibling.bot.id };
    const siblingEnv = f.environments.ensure(siblingScope, configuration);
    const siblingSession = f.environments.createSession(siblingScope, null);
    const siblingTask = f.environments.createExecution(siblingScope, { executionSessionId: siblingSession.id, clientNonce: randomUUID(), kind: "background", command: "another service" }).execution;
    expect(running.environmentId).not.toBe(siblingEnv.id);
    expect(f.environments.deleteSession(f.scope.sessionId)).toBe(1);
    expect(f.environments.get(f.scope)).toBeNull();
    expect(f.environments.listInternal()).toHaveLength(1);
    expect(f.environments.getExecution(siblingScope, siblingTask.id)).toEqual(siblingTask);
    expect(() => f.environments.getExecution(f.scope, own.id)).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_NOT_FOUND" }));
    expect(f.environments.deleteSession(f.scope.sessionId)).toBe(0);
  });

  it("deletes one executor's private and group environments while retaining the group peer's state", () => {
    const f = fixture();
    createTask(f);
    const peer = f.repository.createBot();
    const room = f.repository.createRoom({ memberBotIds: [f.actor.bot.id, peer.bot.id] });
    const ownGroupScope = { sessionId: room.session.id, executorBotId: f.actor.bot.id };
    const peerGroupScope = { sessionId: room.session.id, executorBotId: peer.bot.id };
    f.environments.ensure(ownGroupScope, configuration);
    const peerEnv = f.environments.ensure(peerGroupScope, configuration);
    const peerSession = f.environments.createSession(peerGroupScope, null);
    const peerTask = f.environments.createExecution(peerGroupScope, { executionSessionId: peerSession.id, clientNonce: randomUUID(), kind: "background", command: "peer service" }).execution;
    expect(f.environments.deleteExecutor(f.actor.bot.id)).toBe(2);
    expect(f.environments.get(f.scope)).toBeNull();
    expect(f.environments.get(ownGroupScope)).toBeNull();
    expect(f.environments.get(peerGroupScope)).toEqual(peerEnv);
    expect(f.environments.getExecution(peerGroupScope, peerTask.id)).toEqual(peerTask);
    expect(f.environments.deleteExecutor(f.actor.bot.id)).toBe(0);
  });

  it("deletes exactly one live scope and refuses a revoked actor's cleanup request", () => {
    const f = fixture();
    const privateEnv = f.environments.ensure(f.scope, configuration);
    const peers = Array.from({ length: 2 }, () => f.repository.createBot());
    const room = f.repository.createRoom({ memberBotIds: [f.actor.bot.id, ...peers.map(peer => peer.bot.id)] });
    const ownScope = { sessionId: room.session.id, executorBotId: f.actor.bot.id };
    const peerScope = { sessionId: room.session.id, executorBotId: peers[0]!.bot.id };
    const ownEnv = f.environments.ensure(ownScope, configuration);
    const peerEnv = f.environments.ensure(peerScope, configuration);
    const session = f.environments.createSession(ownScope, null);
    const task = f.environments.createExecution(ownScope, { executionSessionId: session.id, clientNonce: randomUUID(), kind: "background", command: "owned group service" }).execution;
    f.environments.appendLogs(ownScope, task.id, [{ executionId: task.id, seq: 1, stream: "stdout", text: "group owned bytes", at: new Date().toISOString() }]);
    f.environments.upsertPort(ownScope, { processId: task.id, port: 8123 });
    expect(f.environments.deleteScope(ownScope)).toBe(1);
    expect(f.environments.deleteScope(ownScope)).toBe(0);
    expect(f.environments.listInternal().map(environment => environment.id)).not.toContain(ownEnv.id);
    expect(f.environments.get(f.scope)).toEqual(privateEnv);
    expect(f.environments.get(peerScope)).toEqual(peerEnv);
    f.repository.removeRoomMember(room.room.id, f.actor.bot.id, room.room.membershipVersion);
    expect(() => f.environments.deleteScope(ownScope)).toThrow();
    expect(f.environments.get(peerScope)).toEqual(peerEnv);
  });

  it("member removal leaves no orphan environment and preserves private, peer and other-group records", () => {
    const f = fixture();
    const privateEnv = f.environments.ensure(f.scope, configuration);
    const peers = Array.from({ length: 2 }, () => f.repository.createBot());
    const room = f.repository.createRoom({ memberBotIds: [f.actor.bot.id, ...peers.map(peer => peer.bot.id)] });
    const otherRoom = f.repository.createRoom({ memberBotIds: [f.actor.bot.id, peers[0]!.bot.id] });
    const ownScope = { sessionId: room.session.id, executorBotId: f.actor.bot.id };
    const peerScope = { sessionId: room.session.id, executorBotId: peers[0]!.bot.id };
    const otherScope = { sessionId: otherRoom.session.id, executorBotId: f.actor.bot.id };
    const ownEnv = f.environments.ensure(ownScope, configuration);
    const peerEnv = f.environments.ensure(peerScope, configuration);
    const otherEnv = f.environments.ensure(otherScope, configuration);
    const session = f.environments.createSession(ownScope, null);
    const task = f.environments.createExecution(ownScope, { executionSessionId: session.id, clientNonce: randomUUID(), kind: "foreground", command: "departed member task" }).execution;
    f.environments.appendLogs(ownScope, task.id, [{ executionId: task.id, seq: 1, stream: "stdout", text: "only this scope", at: new Date().toISOString() }]);
    f.repository.removeRoomMember(room.room.id, f.actor.bot.id, room.room.membershipVersion);
    expect(f.environments.listInternal().map(environment => environment.id)).not.toContain(ownEnv.id);
    expect(f.environments.get(f.scope)).toEqual(privateEnv);
    expect(f.environments.get(peerScope)).toEqual(peerEnv);
    expect(f.environments.get(otherScope)).toEqual(otherEnv);
    for (const record of f.environments.listInternal()) expect(() => f.environments.listExecutions(record)).not.toThrow();
  });
});

describe("environment public transport validation", () => {
  it("canonicalizes foreground and background defaults before intent hashing", () => {
    const scope = { sessionId: randomUUID(), executorBotId: randomUUID(), clientNonce: randomUUID() };
    const foreground = { command: "echo once" };
    const explicitForeground = { ...foreground, cwd: ".", timeoutMs: ENV_FOREGROUND_TIMEOUT_MS };
    expect(executionRunSchema.parse({ ...scope, ...foreground })).toEqual(executionRunSchema.parse({ ...scope, ...explicitForeground }));
    expect(JSON.stringify(ENVIRONMENT_OPERATION_SCHEMAS["execution.run"]!.parse(foreground))).toBe(JSON.stringify(ENVIRONMENT_OPERATION_SCHEMAS["execution.run"]!.parse(explicitForeground)));
    expect(processStartSchema.parse({ ...scope, ...foreground })).toEqual(processStartSchema.parse({ ...scope, ...foreground, cwd: "." }));
    expect(JSON.stringify(ENVIRONMENT_OPERATION_SCHEMAS["processes.start"]!.parse(foreground))).toBe(JSON.stringify(ENVIRONMENT_OPERATION_SCHEMAS["processes.start"]!.parse({ ...foreground, cwd: "." })));
    const wire = { id: randomUUID(), sessionId: randomUUID(), runtimeRunId: null, command: "echo once" };
    expect(workerExecutionRequestSchema.parse({ ...wire, kind: "foreground" })).toEqual(workerExecutionRequestSchema.parse({ ...wire, kind: "foreground", cwd: ".", timeoutMs: ENV_FOREGROUND_TIMEOUT_MS }));
    expect(workerExecutionRequestSchema.parse({ ...wire, kind: "background" })).toMatchObject({ kind: "background", cwd: "." });
    expect(workerExecutionRequestSchema.parse({ ...wire, kind: "background" })).not.toHaveProperty("timeoutMs");
  });

  it("requires UI nonces and rejects model-supplied nonces or Runtime identity", () => {
    expect(ENVIRONMENT_OPERATION_SCHEMAS["execution.run"]!.safeParse({ command: "echo once", clientNonce: randomUUID() }).success).toBe(false);
    expect(ENVIRONMENT_OPERATION_SCHEMAS["processes.start"]!.safeParse({ command: "server", runtimeRunId: randomUUID() }).success).toBe(false);
    expect(ENVIRONMENT_PRODUCT_OPERATIONS.find((operation) => operation.name === "execution.run")?.effectClass).toBe("irreversible");
    expect(new Set(ENVIRONMENT_PRODUCT_OPERATIONS.map((operation) => operation.channel)).size).toBe(ENVIRONMENT_PRODUCT_OPERATIONS.length);
  });
  it("permits a directory root only where requested and rejects escaping paths", () => {
    expect(environmentDirectoryPathSchema.safeParse(".").success).toBe(true);
    for (const path of [".", "..", "../etc", "/etc", "a/../b", "a\\b", "C:/data"]) expect(environmentFilePathSchema.safeParse(path).success).toBe(false);
    expect(executionCommandSchema.parse("cat <<'END'\nbody\nEND\n")).toBe("cat <<'END'\nbody\nEND\n");
  });
  it("enforces decoded file byte limits and requires a bounded replacement hash", () => {
    const scope = { sessionId: randomUUID(), executorBotId: randomUUID() };
    expect(environmentFileWriteSchema.safeParse({ ...scope, path: "file.txt", content: "字".repeat(350_000) }).success).toBe(false);
    expect(environmentFileWriteSchema.safeParse({ ...scope, path: "file.bin", content: "%%%", encoding: "base64" }).success).toBe(false);
    expect(environmentFileWriteSchema.safeParse({ ...scope, path: "file.txt", content: "ok", expectedSha256: "short" }).success).toBe(false);
    expect(workerHealthSchema.safeParse({ environmentId: randomUUID(), bootId: randomUUID(), protocolVersion: 1, workerVersion: "1.1.0", capabilities: ["execution"] }).success).toBe(true);
  });
});
