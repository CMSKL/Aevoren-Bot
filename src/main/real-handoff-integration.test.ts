import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { OpenAiCompatibleProvider } from "./model";
import { RoomCoordinator } from "./room-coordinator";
import { RuntimeExecutor } from "./runtime-executor";
import { ModelSettingsService, type SecretCodec } from "./settings";

const repositories: AppRepository[] = [];
const codec: SecretCodec = { isAvailable: () => true, encrypt: (value) => value, decrypt: (value) => value };

afterEach(() => {
  vi.unstubAllGlobals();
  while (repositories.length > 0) repositories.pop()?.close();
});

function response(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  }), { status: 200 });
}

describe("real Provider handoff integration", () => {
  it("routes one parsed A-to-B tool call through the central coordinator without persisting tool payload", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const createdA = repository.createBot();
    const botA = repository.updateBot(createdA.bot.id, createdA.bot.version, { name: "策划师", instructions: "PLAN_SECRET" });
    const createdB = repository.createBot();
    const botB = repository.updateBot(createdB.bot.id, createdB.bot.version, {
      name: "评审员",
      label: "评审角色",
      description: "负责复核方案",
      instructions: "REVIEW_SECRET",
    });
    const createdC = repository.createBot();
    const botC = repository.updateBot(createdC.bot.id, createdC.bot.version, {
      name: "运营员",
      label: "运营角色",
      description: "负责落地",
      instructions: "OPERATIONS_SECRET",
    });
    const detail = repository.createRoom({ memberBotIds: [botA.id, botB.id, botC.id], name: "协作验收" });
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        const argumentsValue = JSON.stringify({
          toAgentId: botB.id,
          task: "复核当前方案",
          contextRefs: [],
          visibility: "room",
        });
        return Promise.resolve(response([
          { choices: [{ index: 0, delta: { content: "A 已完成初稿。" } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "tool-a-b", type: "function", function: { name: "handoff_to_agent", arguments: argumentsValue } }] }, finish_reason: "tool_calls" }] },
        ]));
      }
      return Promise.resolve(response([
        { choices: [{ index: 0, delta: { content: "B 已完成复核。" }, finish_reason: "stop" }] },
      ]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "test-model", "test-key");
    const settings = new ModelSettingsService(repository, codec);
    const executor = new RuntimeExecutor(repository, settings, { transcript: vi.fn(), runtime: vi.fn() }, false, provider);
    const coordinator = new RoomCoordinator(repository, executor, { transcript: vi.fn(), roomRuntime: vi.fn() });

    const sent = coordinator.sendCoordinated({
      roomId: detail.room.id,
      sessionId: detail.session.id,
      clientNonce: crypto.randomUUID(),
      text: "请先规划，再交给评审员。",
      targetBotIds: [botA.id],
      routingMode: "explicit",
    });
    await vi.waitFor(() => expect(repository.getRoomRun(sent.batchId).state).toBe("completed"));

    expect(callCount).toBe(2);
    expect(repository.listAgentTurns(sent.batchId).map((turn) => [turn.agentId, turn.origin, turn.state])).toEqual([
      [botA.id, "initial", "completed"],
      [botB.id, "handoff", "completed"],
    ]);
    expect(repository.listHandoffs(sent.batchId)).toMatchObject([
      { toAgentId: botB.id, task: "复核当前方案", state: "accepted", visibility: "room" },
    ]);
    const snapshot = coordinator.getSnapshot(detail.room.id);
    expect(snapshot.handoffs).toHaveLength(1);
    expect(snapshot.handoffs[0]?.version).toBeGreaterThan(1);
    expect(Object.keys(snapshot.handoffs[0]!).toSorted()).toEqual([
      "createdAt",
      "finishedAt",
      "fromTurnId",
      "id",
      "runId",
      "state",
      "targetTurnId",
      "task",
      "toAgentId",
      "updatedAt",
      "version",
    ]);
    const transcript = JSON.stringify(repository.listTranscript(detail.session.id));
    expect(transcript).not.toContain("tool-a-b");
    expect(transcript).not.toContain("复核当前方案");
    const requestBodies = fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies.every((body) => body.tools?.length === 1)).toBe(true);
    expect(JSON.stringify(requestBodies[0]?.tools)).not.toContain("PLAN_SECRET");
    expect(JSON.stringify(requestBodies[0]?.tools)).not.toContain("REVIEW_SECRET");
    expect(JSON.stringify(requestBodies[0]?.tools)).not.toContain("OPERATIONS_SECRET");
    const rosterMessage = (requestBodies[0]?.messages as Array<{ role: string; content: string }>).find((message) =>
      message.role === "system" && message.content.includes("UNTRUSTED_ROOM_PEER_DATA")
    );
    expect(rosterMessage?.content).toContain(`"id":"${botB.id}"`);
    expect(rosterMessage?.content).toContain('"label":"评审角色"');
    expect(rosterMessage?.content).toContain(`"id":"${botC.id}"`);
    expect(rosterMessage?.content).not.toContain("PLAN_SECRET");
    expect(rosterMessage?.content).not.toContain("REVIEW_SECRET");
    expect(rosterMessage?.content).not.toContain("OPERATIONS_SECRET");
  });

  it("never projects a direct-visibility Handoff or its task across the Room UI boundary", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const first = repository.createBot().bot;
    const second = repository.createBot().bot;
    const detail = repository.createRoom({ memberBotIds: [first.id, second.id] });
    const created = repository.createRoomRunWithInitialTurns({
      roomId: detail.room.id,
      sessionId: detail.session.id,
      clientNonce: crypto.randomUUID(),
      text: "private handoff projection check",
      membershipVersion: detail.room.membershipVersion,
      maxTurns: 8,
      maxHops: 6,
      maxTargetsPerTurn: 2,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      initialTurns: [{ agentId: first.id, nonce: "initial-private" }],
    });
    repository.transitionRoomRun(created.run.id, "running");
    const source = repository.transitionAgentTurn(created.turns[0]!.id, "running", {
      promptCutoffSeq: created.turns[0]!.inputSeq,
    });
    repository.createHandoff({
      runId: created.run.id,
      fromTurnId: source.id,
      toAgentId: second.id,
      task: "PRIVATE_TASK_MUST_NOT_CROSS_IPC",
      contextRefs: [],
      visibility: "direct",
      targetTurnNonce: "direct-private",
      inputGeneration: source.inputGeneration,
      inputSeq: source.inputSeq,
    });
    const roomRuntime = vi.fn();
    const executor = new RuntimeExecutor(
      repository,
      new ModelSettingsService(repository, codec),
      { transcript: vi.fn(), runtime: vi.fn() },
      false,
      { async *run() {}, testConnection: async () => {} },
    );
    const coordinator = new RoomCoordinator(repository, executor, { transcript: vi.fn(), roomRuntime });

    const snapshot = coordinator.getSnapshot(detail.room.id);
    expect(snapshot.handoffs).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_TASK_MUST_NOT_CROSS_IPC");
    coordinator.cancel(created.run.id);
    expect(JSON.stringify(roomRuntime.mock.calls)).not.toContain("PRIVATE_TASK_MUST_NOT_CROSS_IPC");
    expect(roomRuntime.mock.calls.at(-1)?.[0].handoffs).toEqual([]);
  });
});
