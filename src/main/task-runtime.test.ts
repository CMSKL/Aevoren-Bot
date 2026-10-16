import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskExecutorSelection } from "@shared/task-session-contracts";
import { AppRepository, digestMessage } from "./database";
import { AevorenBotError } from "./errors";
import type { ChatMessage, ModelProvider, ModelRunContext } from "./model";
import { SendWorker } from "./send-worker";
import { RoomCoordinator } from "./room-coordinator";
import { TaskSessionService } from "./task-session-service";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function selected(executorBotId: string, patch: Partial<TaskExecutorSelection> = {}): TaskExecutorSelection {
  return { executorBotId, memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: [], network: false, clipboard: false, ...patch };
}
function fixture(run: ModelProvider["run"]) {
  const root = mkdtempSync(join(tmpdir(), "aevoren-task-runtime-")), repository = new AppRepository(join(root, "app.sqlite"));
  const executor = new WorkspaceToolExecutor(repository, new WorkspaceService(repository));
  const tools = new WorkspaceToolCoordinator(repository, executor, () => {});
  const worker = new SendWorker(repository, null, { transcript: () => {}, sendState: () => {}, runtime: () => {} }, false, { run, testConnection: async () => {} }, undefined, tools);
  const rooms = new RoomCoordinator(repository, worker.executor, { transcript: () => {}, roomRuntime: () => {} });
  cleanup.push(async () => { await worker.shutdown(); await rooms.shutdown(); repository.close(); rmSync(root, { recursive: true, force: true }); });
  return { repository, worker, rooms, tools, owner: repository.createBot() };
}
function task(f: ReturnType<typeof fixture>, patch: Partial<TaskExecutorSelection> = {}) {
  return f.repository.tasks.create({ parentSessionId: f.owner.session.id, expectedScopeVersion: f.repository.tasks.scopeVersion(f.owner.session.id), clientNonce: randomUUID(), title: "Independent runtime", selections: [selected(f.owner.bot.id, patch)] });
}
const body = (messages: ChatMessage[]) => JSON.stringify(messages);
const terminal = (state: string) => ["completed", "failed", "cancelled", "interrupted"].includes(state);
async function settled(f: ReturnType<typeof fixture>, runId: string) { await vi.waitFor(() => expect(terminal(f.repository.getRuntimeRun(runId).state)).toBe(true), { timeout: 5_000 }); return f.repository.getRuntimeRun(runId); }

describe("TASK context through the actual send and Runtime chain", () => {
  it("starts an empty task without MAIN transcript, user/Bot memory or implicit tools", async () => {
    const captured: Array<{ messages: ChatMessage[]; context?: ModelRunContext }> = [];
    const f = fixture(async function* (messages, _signal, context) { captured.push({ messages, context }); yield { type: "started", requestId: "empty-task" }; yield { type: "delta", text: "Task reply" }; yield { type: "completed", finishReason: "stop" }; });
    f.repository.createMemory(f.owner.bot.id, "PRIVATE_MAIN_MEMORY");
    f.repository.createScopedMemory({ scope: "user", scopeKey: "user" }, "GLOBAL_USER_MEMORY");
    const mainNonce = randomUUID(); f.repository.prepareMessage({ sessionId: f.owner.session.id, clientNonce: mainNonce, text: "PRIVATE_MAIN_HISTORY" });
    const child = task(f), sent = f.worker.send({ sessionId: child.session.id, clientNonce: randomUUID(), text: "Only this task" });
    expect((await settled(f, sent.runId)).state).toBe("completed");
    expect(body(captured[0]!.messages)).not.toMatch(/PRIVATE_MAIN_MEMORY|GLOBAL_USER_MEMORY|PRIVATE_MAIN_HISTORY/);
    expect(captured[0]!.context).toMatchObject({ taskScoped: true, networkTools: false, deviceTools: false, mcpTools: [], workspaces: [], assertAuthority: expect.any(Function) });
    expect(f.repository.listTranscript(f.owner.session.id).map(entry => entry.body)).toEqual(["PRIVATE_MAIN_HISTORY"]);
    expect(f.repository.listTranscript(child.session.id).map(entry => entry.body)).toEqual(["Only this task", "Task reply"]);
  });

  it("uses immutable selected memory and quoted history while executing only the new task message", async () => {
    const captured: ChatMessage[][] = [];
    const f = fixture(async function* (messages) { captured.push(messages); yield { type: "started", requestId: "selected-task" }; yield { type: "delta", text: "Reply" }; yield { type: "completed", finishReason: "stop" }; });
    const memory = f.repository.createMemory(f.owner.bot.id, "SELECTED_MEMORY_V1"), nonce = randomUUID();
    f.repository.prepareMessage({ sessionId: f.owner.session.id, clientNonce: nonce, text: "HISTORICAL_QUOTE_NOT_NEW_AUTHORIZATION" });
    const entry = f.repository.getUserMessage(nonce);
    const child = task(f, { memories: [{ id: memory.id, version: memory.version, digest: memory.contentDigest }], history: [{ entryId: entry.id, generation: entry.generation, digest: digestMessage(entry.body) }] });
    f.repository.updateMemory(memory.id, memory.version, "UNSELECTED_MEMORY_V2");
    const extra = randomUUID(); f.repository.prepareMessage({ sessionId: f.owner.session.id, clientNonce: extra, text: "LATER_MAIN_HISTORY" });
    const sent = f.worker.send({ sessionId: child.session.id, clientNonce: randomUUID(), text: "CURRENT_TASK_REQUEST" });
    expect((await settled(f, sent.runId)).state).toBe("completed");
    expect(body(captured[0]!)).toContain("SELECTED_MEMORY_V1"); expect(body(captured[0]!)).not.toMatch(/UNSELECTED_MEMORY_V2|LATER_MAIN_HISTORY/);
    const quote = captured[0]!.find(message => message.content.includes("UNTRUSTED_SELECTED_PARENT_HISTORY"))!;
    expect(quote.role).toBe("user"); expect(quote.content).toContain("HISTORICAL_QUOTE_NOT_NEW_AUTHORIZATION");
    expect(captured[0]!.at(-1)?.content).toBe("CURRENT_TASK_REQUEST");
    expect(f.repository.getRuntimeRun(sent.runId).promptManifest.schemaVersion).toBe(7);
    expect(JSON.stringify(f.repository.getRuntimeRun(sent.runId).promptManifest)).not.toContain("SELECTED_MEMORY_V1");
  });

  it("keeps the first Runtime selection on retry after the user selects a different memory snapshot", async () => {
    const captured: ChatMessage[][] = []; let attempts = 0;
    const f = fixture(async function* (messages) { captured.push(messages); attempts++; if (attempts === 1) throw new AevorenBotError("MODEL_NOT_CONFIGURED"); yield { type: "started", requestId: "retried-task" }; yield { type: "delta", text: "Recovered" }; yield { type: "completed", finishReason: "stop" }; });
    const first = f.repository.createMemory(f.owner.bot.id, "FIRST_SELECTED_CONTEXT"), second = f.repository.createMemory(f.owner.bot.id, "LATER_SELECTED_CONTEXT");
    const child = task(f, { memories: [{ id: first.id, version: first.version, digest: first.contentDigest }] }), nonce = randomUUID();
    const sent = f.worker.send({ sessionId: child.session.id, clientNonce: nonce, text: "Same logical task" });
    expect((await settled(f, sent.runId)).state).toBe("failed");
    f.repository.tasks.reviseSelection({ sessionId: child.session.id, expectedVersion: child.version, selections: [selected(f.owner.bot.id, { memories: [{ id: second.id, version: second.version, digest: second.contentDigest }] })] });
    const retried = f.worker.retry(nonce); expect((await settled(f, retried.runId)).state).toBe("completed");
    expect(captured).toHaveLength(2);
    for (const messages of captured) { expect(body(messages)).toContain("FIRST_SELECTED_CONTEXT"); expect(body(messages)).not.toContain("LATER_SELECTED_CONTEXT"); }
    expect(f.repository.tasks.runtimeTaskPolicy(retried.runId)!.selectionVersion).toBe(1);
  });

  it("starts both group task members before completion and sends each only its selected document", async () => {
    const captured = new Map<string, ChatMessage[]>(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async function* (messages, _signal, context) { captured.set(context!.executorBotId, messages); await gate; yield { type: "started", requestId: randomUUID() }; yield { type: "delta", text: "Member reply" }; yield { type: "completed", finishReason: "stop" }; });
    const other = f.repository.createBot(), room = f.repository.createRoom({ memberBotIds: [f.owner.bot.id, other.bot.id], leadBotId: null });
    const a = f.repository.library.create({ sessionId: room.session.id, kind: "document", name: "A context", body: "PRIVATE_MEMBER_A_DOCUMENT" });
    const b = f.repository.library.create({ sessionId: room.session.id, kind: "document", name: "B context", body: "PRIVATE_MEMBER_B_DOCUMENT" });
    const child = f.repository.tasks.create({ parentSessionId: room.session.id, expectedScopeVersion: f.repository.tasks.scopeVersion(room.session.id), clientNonce: randomUUID(), title: "Parallel private contexts", selections: [selected(f.owner.bot.id, { resourceRefs: [a.reference] }), selected(other.bot.id, { resourceRefs: [b.reference] })] });
    try {
      const sent = await f.rooms.routeAndSend({ routingMode: "everyone", roomId: room.room.id, sessionId: child.session.id, clientNonce: randomUUID(), text: "Each member replies once", targetBotIds: [f.owner.bot.id, other.bot.id], resourceRefs: [a.reference, b.reference] });
      await vi.waitFor(() => expect(captured.size).toBe(2));
      expect(f.repository.getRoomBatch(sent.batchId).state).toBe("running");
      expect(body(captured.get(f.owner.bot.id)!)).toContain("PRIVATE_MEMBER_A_DOCUMENT"); expect(body(captured.get(f.owner.bot.id)!)).not.toContain("PRIVATE_MEMBER_B_DOCUMENT");
      expect(body(captured.get(other.bot.id)!)).toContain("PRIVATE_MEMBER_B_DOCUMENT"); expect(body(captured.get(other.bot.id)!)).not.toContain("PRIVATE_MEMBER_A_DOCUMENT");
      release(); await vi.waitFor(() => expect(f.repository.getRoomBatch(sent.batchId).state).toBe("completed"));
      expect(f.repository.listTranscript(room.session.id)).toEqual([]);
    } finally { release(); }
  });

  it("blocks late provider delivery after a selected source is deleted and restored", async () => {
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(async function* (_messages, _signal, context) { entered = true; yield { type: "started", requestId: "revoked-task" }; await gate; context?.assertAuthority?.(); yield { type: "delta", text: "REVOKED_LATE_CONTENT" }; yield { type: "completed", finishReason: "stop" }; });
    const memory = f.repository.createMemory(f.owner.bot.id, "REVOCABLE_SOURCE"), child = task(f, { memories: [{ id: memory.id, version: memory.version, digest: memory.contentDigest }] });
    try {
      const sent = f.worker.send({ sessionId: child.session.id, clientNonce: randomUUID(), text: "Wait for a reply" }); await vi.waitFor(() => expect(entered).toBe(true));
      const deleted = f.repository.deleteMemory(memory.id, memory.version); f.repository.restoreMemory(memory.id, deleted.version);
      release(); expect((await settled(f, sent.runId)).state).not.toBe("completed");
      expect(f.repository.listTranscript(child.session.id).some(entry => entry.body.includes("REVOKED_LATE_CONTENT"))).toBe(false);
    } finally { release(); }
  });

  it("rejects an invented network tool before approval despite global automatic public-read approval", async () => {
    let toolResponse = "";
    const f = fixture(async function* (_messages, signal) {
      yield { type: "started", requestId: "task-tool-ceiling" };
      yield { type: "network-tool", toolCallId: "invented-search", toolSignal: signal, tool: { kind: "web-search", query: "must never be dispatched", maxResults: 1 }, respond: async content => { toolResponse = content; } };
      yield { type: "delta", text: "The tool was not executed" }; yield { type: "completed", finishReason: "stop" };
    });
    f.repository.setSetting("tools.autoApprovePublicRead", "true", false);
    const child = task(f), sent = f.worker.send({ sessionId: child.session.id, clientNonce: randomUUID(), text: "Please reply briefly" });
    await settled(f, sent.runId);
    expect(toolResponse).toContain("APPROVAL_SCOPE_INVALID");
    expect(f.repository.listToolInvocations(child.session.id)).toEqual([]); expect(f.repository.listPendingApprovalRequests(child.session.id)).toEqual([]);
  });

  it("returns actor Task options without another member's selected resource metadata", () => {
    const f = fixture(async function* () { yield { type: "completed", finishReason: "stop" }; });
    const other = f.repository.createBot(), room = f.repository.createRoom({ memberBotIds: [f.owner.bot.id, other.bot.id] });
    const a = f.repository.library.create({ sessionId: room.session.id, kind: "document", name: "ACTOR_A_SELECTED_NAME", body: "A" }), b = f.repository.library.create({ sessionId: room.session.id, kind: "document", name: "PRIVATE_B_SELECTED_NAME", body: "B" });
    const child = f.repository.tasks.create({ parentSessionId: room.session.id, expectedScopeVersion: f.repository.tasks.scopeVersion(room.session.id), clientNonce: randomUUID(), title: "Actor options", selections: [selected(f.owner.bot.id, { resourceRefs: [a.reference] }), selected(other.bot.id, { resourceRefs: [b.reference] })] });
    const service = new TaskSessionService(f.repository, f.worker, f.rooms, { availableTools: () => [] });
    const options = service.options({ sessionId: child.session.id }, f.owner.bot.id);
    expect(options.executors.map(item => item.id)).toEqual([f.owner.bot.id]);
    expect(options.resources.map(item => item.reference.resourceId)).toEqual([a.resource.id]);
    expect(JSON.stringify(options)).not.toContain("PRIVATE_B_SELECTED_NAME");
    expect(options.currentSelections?.map(item => item.executorBotId)).toEqual([f.owner.bot.id]);
  });
});
