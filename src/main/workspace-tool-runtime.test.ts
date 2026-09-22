import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelProvider } from "./model";
import { AppRepository } from "./database";
import { SendWorker } from "./send-worker";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { NetworkToolExecutor } from "./network-tool-executor";
import { DecisionService, FakeDecisionProvider } from "./decision-service";

const repositories: AppRepository[] = [];
const directories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "aevoren-tool-runtime-"));
  directories.push(value);
  return value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (repositories.length > 0) repositories.pop()?.close();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

async function harness(
  resolution: "allow-once" | "deny",
  decisionFactory?: (repository: AppRepository) => DecisionService,
) {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  const root = directory();
  writeFileSync(join(root, "brief.txt"), "PRIVATE_WORKSPACE_RESULT", "utf8");
  const workspaceService = new WorkspaceService(repository);
  const registered = await workspaceService.registerRoot(root);
  const decisions = decisionFactory?.(repository);
  const created = repository.createBot();
  const calls: ChatMessage[][] = [];
  const provider: ModelProvider = {
    async *run(messages, _signal, context) {
      calls.push(messages.map((message) => ({ ...message })));
      const toolResult = messages.findLast((message) => message.role === "tool");
      yield { type: "started", requestId: `request-${calls.length}` };
      if (!toolResult) {
        yield {
          type: "workspace-tool",
          toolCallId: "read-brief",
          tool: { kind: "workspace-read", workspaceId: context!.workspaces![0]!.id, path: "brief.txt", maxBytes: 4096 },
        };
        yield { type: "completed", finishReason: "tool_calls" };
        return;
      }
      yield { type: "delta", text: `MODEL_USED:${toolResult.content}` };
      yield { type: "completed", finishReason: "stop" };
    },
    testConnection: async () => {},
  };
  const toolEvents: Array<Parameters<ConstructorParameters<typeof WorkspaceToolCoordinator>[2]>[0]> = [];
  const coordinator = new WorkspaceToolCoordinator(
    repository,
    new WorkspaceToolExecutor(repository, workspaceService),
    (event) => {
      toolEvents.push(event);
      if (event.approval.state === "pending") {
        queueMicrotask(() => void coordinator.resolve(event.sessionId, event.approval.id, event.approval.version, resolution));
      }
    },
    decisions,
  );
  const worker = new SendWorker(
    repository,
    null,
    { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() },
    false,
    provider,
    undefined,
    coordinator,
  );
  return { repository, registered, created, calls, toolEvents, worker, workspaceService };
}

describe("Workspace tool Runtime wiring", () => {
  it("continues one in-process CLI dynamic tool turn after the approved host response", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    let hostResult = "";
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: "cli-dynamic" };
        yield {
          type: "network-tool",
          toolCallId: "cli-time",
          tool: { kind: "time-now", timezone: "Asia/Shanghai" },
          respond: async (content: string) => { hostResult = content; },
        };
        yield { type: "delta", text: `CLI_RESULT:${hostResult}` };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const service = new WorkspaceService(repository);
    const decisions = new DecisionService(repository, new FakeDecisionProvider(() => ({
      answers: {
        riskLevel: { value: 0, confidence: 0.98 },
        needsHumanApproval: { value: true, confidence: 0.99 },
      },
      modelVersion: "fake-decision-1",
      requestId: "tool-shadow",
    })), true);
    const coordinator = new WorkspaceToolCoordinator(
      repository,
      new WorkspaceToolExecutor(repository, service, new NetworkToolExecutor(() => new Date("2026-09-17T08:00:00.000Z"))),
      (event) => {
        if (event.approval.state === "pending") {
          queueMicrotask(() => void coordinator.resolve(event.sessionId, event.approval.id, event.approval.version, "allow-once"));
        }
      },
      decisions,
    );
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "CLI 查询时间" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(hostResult).toContain("2026-09-17T08:00:00.000Z");
    expect(repository.listTranscript(created.session.id).at(-1)?.body).toContain("CLI_RESULT");
    expect(repository.listToolInvocations(created.session.id)[0]).toMatchObject({ state: "succeeded", toolKind: "time-now" });
    await vi.waitFor(() => expect(repository.listDecisionJournals()).toHaveLength(2));
    expect(repository.listDecisionJournals().map((entry) => entry.policyId)).toEqual(expect.arrayContaining([
      "tool-risk-shadow",
      "tool-result-quality-shadow",
    ]));
    expect(repository.listDecisionJournals().every((entry) => entry.state === "completed")).toBe(true);
    const riskJournal = repository.listDecisionJournals().find((entry) => entry.policyId === "tool-risk-shadow")!;
    const qualityJournal = repository.listDecisionJournals().find((entry) => entry.policyId === "tool-result-quality-shadow")!;
    expect(riskJournal.answers.existingApproval?.value).toMatchObject({ state: "pending" });
    expect(qualityJournal.answers.existingResult?.value).toMatchObject({ resultCharacters: expect.any(Number) });
  });

  it("keeps fetched page text out of the journal while returning it to the same approved model run", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    const calls: ChatMessage[][] = [];
    const provider: ModelProvider = {
      async *run(messages) {
        calls.push(messages.map((message) => ({ ...message })));
        const toolResult = messages.findLast((message) => message.role === "tool");
        yield { type: "started", requestId: `fetch-${calls.length}` };
        if (!toolResult) {
          yield { type: "network-tool", toolCallId: "fetch-1", tool: { kind: "web-fetch", url: "https://example.com/brief", maxCharacters: 5_000 } };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "delta", text: `FETCH_USED:${toolResult.content}` };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const service = new WorkspaceService(repository);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html><head><title>Brief</title></head><body>PRIVATE_FETCHED_PAGE</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));
    const network = new NetworkToolExecutor(
      () => new Date("2026-09-17T08:00:00.000Z"),
      async (value) => ({ url: new URL(value), addresses: [{ address: "93.184.216.34", family: 4 }] }),
      async (target, signal) => {
        const response = await fetch(target.url, { signal });
        return {
          status: response.status,
          headers: {
            "content-type": response.headers.get("content-type") ?? undefined,
            "content-length": response.headers.get("content-length") ?? undefined,
          },
          body: response.body!,
        };
      },
    );
    const coordinator = new WorkspaceToolCoordinator(
      repository,
      new WorkspaceToolExecutor(repository, service, network),
      (event) => {
        if (event.approval.state === "pending") {
          queueMicrotask(() => void coordinator.resolve(event.sessionId, event.approval.id, event.approval.version, "allow-once"));
        }
      },
    );
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "读取来源页面" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));

    expect(calls).toHaveLength(2);
    expect(calls[1]?.find((message) => message.role === "tool")?.content).toContain("PRIVATE_FETCHED_PAGE");
    const invocation = repository.listToolInvocations(created.session.id)[0]!;
    expect(invocation).toMatchObject({
      toolKind: "web-fetch",
      effectClass: "read-remote",
      targetPath: "https://example.com/brief",
      state: "succeeded",
      resultMetadata: { provider: "example.com", retrievedAt: "2026-09-17T08:00:00.000Z", title: "Brief" },
    });
    expect(JSON.stringify(invocation)).not.toContain("PRIVATE_FETCHED_PAGE");
  });

  it("executes an approved read-only network query, returns sourced data, and stores only a result digest", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    const calls: ChatMessage[][] = [];
    const provider: ModelProvider = {
      async *run(messages, _signal, _context) {
        calls.push(messages.map((message) => ({ ...message })));
        const toolResult = messages.findLast((message) => message.role === "tool");
        yield { type: "started", requestId: `network-${calls.length}` };
        if (!toolResult) {
          yield { type: "network-tool", toolCallId: "time-1", tool: { kind: "time-now", timezone: "Asia/Shanghai" }, providerToolName: "time_now" };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "delta", text: `TIME_RESULT:${toolResult.content}` };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const service = new WorkspaceService(repository);
    const coordinator = new WorkspaceToolCoordinator(
      repository,
      new WorkspaceToolExecutor(repository, service, new NetworkToolExecutor(() => new Date("2026-09-17T08:00:00.000Z"))),
      (event) => {
        if (event.approval.state === "pending") {
          queueMicrotask(() => void coordinator.resolve(event.sessionId, event.approval.id, event.approval.version, "allow-once"));
        }
      },
    );
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "现在几点" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));

    expect(calls).toHaveLength(2);
    expect(calls[1]?.find((message) => message.role === "assistant" && "tool_calls" in message)).toMatchObject({
      tool_calls: [{ function: { name: "time_now" } }],
    });
    expect(calls[1]?.find((message) => message.role === "tool")?.content).toContain("2026-09-17T08:00:00.000Z");
    const invocation = repository.listToolInvocations(created.session.id)[0]!;
    expect(invocation).toMatchObject({
      toolKind: "time-now",
      effectClass: "pure",
      workspaceId: null,
      targetPath: "Asia/Shanghai",
      state: "succeeded",
      resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(invocation)).not.toContain("localDateTime");
    expect(JSON.stringify(invocation)).not.toContain("\"untrusted\":false");
  });

  it("executes only after allow-once, returns the result to the same model run, and persists only a digest", async () => {
    const capturedStates: Array<Record<string, unknown>> = [];
    const value = await harness("allow-once", (repository) => new DecisionService(repository, new FakeDecisionProvider((request) => {
      capturedStates.push(request.state);
      return {
        answers: { evidenceSufficiency: { value: true, confidence: 0.8 } },
        modelVersion: "fake-decision-1",
        requestId: "quality-shadow",
      };
    }), true));
    const sent = value.worker.send({ sessionId: value.created.session.id, clientNonce: crypto.randomUUID(), text: "读取 brief" });
    await vi.waitFor(() => expect(value.repository.getRuntimeRun(sent.runId).state).toBe("completed"));

    expect(value.calls).toHaveLength(2);
    expect(value.calls[1]?.find((message) => message.role === "tool")?.content).toContain("PRIVATE_WORKSPACE_RESULT");
    const transcript = value.repository.listTranscript(value.created.session.id);
    expect(transcript.filter((entry) => entry.role === "assistant")).toHaveLength(1);
    expect(transcript.at(-1)).toMatchObject({ role: "assistant", status: "completed" });
    expect(transcript.at(-1)?.body).toContain("PRIVATE_WORKSPACE_RESULT");
    const invocation = value.repository.listToolInvocations(value.created.session.id)[0]!;
    expect(invocation).toMatchObject({ state: "succeeded", attemptCount: 1, resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(invocation)).not.toContain("PRIVATE_WORKSPACE_RESULT");
    expect(JSON.stringify(value.toolEvents)).not.toContain("PRIVATE_WORKSPACE_RESULT");
    expect(value.toolEvents.map((event) => event.invocation.state)).toEqual(expect.arrayContaining(["awaiting-approval", "approved", "succeeded"]));
    await vi.waitFor(() => expect(value.repository.listDecisionJournals()).toHaveLength(2));
    const qualityState = capturedStates.find((state) => state.privateContentOmitted === true);
    expect(qualityState).toBeDefined();
    expect(JSON.stringify(qualityState)).not.toContain("PRIVATE_WORKSPACE_RESULT");
  });

  it("executes multiple validated workspace reads from one Provider tool batch and returns one complete protocol turn", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const root = directory();
    writeFileSync(join(root, "one.md"), "FIRST_REAL_FILE", "utf8");
    writeFileSync(join(root, "two.md"), "SECOND_REAL_FILE", "utf8");
    const service = new WorkspaceService(repository);
    await service.registerRoot(root);
    const created = repository.createBot();
    const calls: ChatMessage[][] = [];
    const provider: ModelProvider = {
      async *run(messages, _signal, context) {
        calls.push(messages.map((message) => ({ ...message })));
        const results = messages.filter((message) => message.role === "tool");
        yield { type: "started", requestId: `multi-${calls.length}` };
        if (results.length === 0) {
          yield { type: "workspace-tool", toolCallId: "read-one", tool: { kind: "workspace-read", workspaceId: context!.workspaces![0]!.id, path: "one.md", maxBytes: 4096 }, providerToolName: "workspace_read" };
          yield { type: "workspace-tool", toolCallId: "read-two", tool: { kind: "workspace-read", workspaceId: context!.workspaces![0]!.id, path: "two.md", maxBytes: 4096 }, providerToolName: "workspace_read" };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "delta", text: results.map((message) => message.content).join("|") };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), (event) => {
      if (event.approval.state === "pending") {
        queueMicrotask(() => void coordinator.resolve(event.sessionId, event.approval.id, event.approval.version, "allow-once"));
      }
    });
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "同时读取两份文件" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));

    expect(calls).toHaveLength(2);
    expect(calls[1]?.find((message) => message.role === "assistant" && "tool_calls" in message)).toMatchObject({
      tool_calls: [
        { id: "read-one", function: { name: "workspace_read" } },
        { id: "read-two", function: { name: "workspace_read" } },
      ],
    });
    expect(calls[1]?.filter((message) => message.role === "tool")).toHaveLength(2);
    expect(repository.listToolInvocations(created.session.id)).toMatchObject([
      { toolCallId: "read-one", state: "succeeded", targetPath: "one.md" },
      { toolCallId: "read-two", state: "succeeded", targetPath: "two.md" },
    ]);
    expect(repository.listTranscript(created.session.id).at(-1)).toMatchObject({ status: "completed" });
    expect(repository.listTranscript(created.session.id).at(-1)?.body).toContain("FIRST_REAL_FILE");
    expect(repository.listTranscript(created.session.id).at(-1)?.body).toContain("SECOND_REAL_FILE");
  });

  it("auto-approves a trusted Workspace write, rejects extra output beyond the Bot policy, and reads the real file", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const root = directory();
    mkdirSync(join(root, "01-inbox"));
    const service = new WorkspaceService(repository);
    const registered = await service.registerRoot(root);
    repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, {
      writeEnabled: true,
      automationEnabled: true,
    });
    const created = repository.createBot();
    repository.updateBot(created.bot.id, created.bot.version, {
      instructions: "每次任务只创建用户指定的一个正式线索文件，成功后停止额外写入。",
    });
    let providerRound = 0;
    let writeLimitResult = "";
    const provider: ModelProvider = {
      async *run(messages, _signal, context) {
        providerRound += 1;
        yield { type: "started", requestId: `auto-workspace-${providerRound}` };
        if (providerRound === 1) {
          yield {
            type: "workspace-tool",
            toolCallId: "write-leads",
            tool: { kind: "workspace-write", workspaceId: context!.workspaces![0]!.id, path: "01-inbox/leads.md", content: "# REAL_LEAD\n" },
            providerToolName: "workspace_write",
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        if (providerRound === 2) {
          yield {
            type: "workspace-tool",
            toolCallId: "rewrite-leads",
            tool: { kind: "workspace-write", workspaceId: context!.workspaces![0]!.id, path: "01-inbox/leads.md", content: "must not overwrite" },
            providerToolName: "workspace_write",
          };
          yield {
            type: "workspace-tool",
            toolCallId: "write-unwanted",
            tool: { kind: "workspace-write", workspaceId: context!.workspaces![0]!.id, path: "01-inbox/unwanted.md", content: "must not exist" },
            providerToolName: "workspace_write",
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        if (providerRound === 3) {
          writeLimitResult = messages.filter((message) => message.role === "tool").map((message) => message.content).join("\n");
          yield {
            type: "workspace-tool",
            toolCallId: "read-leads",
            tool: { kind: "workspace-read", workspaceId: context!.workspaces![0]!.id, path: "01-inbox/leads.md", maxBytes: 4096 },
            providerToolName: "workspace_read",
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "delta", text: "下游已读取真实共享文件。" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const events: Array<Parameters<ConstructorParameters<typeof WorkspaceToolCoordinator>[2]>[0]> = [];
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), (event) => events.push(event));
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "写入后继续读取" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));

    expect(providerRound).toBe(4);
    expect(readFileSync(join(root, "01-inbox", "leads.md"), "utf8")).toBe("# REAL_LEAD\n");
    expect(existsSync(join(root, "01-inbox", "unwanted.md"))).toBe(false);
    expect(writeLimitResult).toContain("WORKSPACE_ARTIFACT_ALREADY_EXISTS");
    expect(writeLimitResult).toContain("WORKSPACE_WRITE_LIMIT_REACHED");
    expect(repository.listPendingApprovalRequests(created.session.id)).toEqual([]);
    expect(repository.listToolInvocations(created.session.id)).toMatchObject([
      { toolKind: "workspace-write", state: "succeeded", targetPath: "01-inbox/leads.md" },
      { toolKind: "workspace-read", state: "succeeded", targetPath: "01-inbox/leads.md" },
    ]);
    expect(events.some((event) => event.approval.state === "allowed")).toBe(true);
  });

  it("completes a planner turn immediately after the real Brief write when the task enters a human approval gate", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const root = directory();
    mkdirSync(join(root, "02-briefs"));
    const service = new WorkspaceService(repository);
    const registered = await service.registerRoot(root);
    repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: true });
    const created = repository.createBot();
    repository.updateBot(created.bot.id, created.bot.version, {
      name: "选题策划师",
      instructions: "只创建唯一 Brief，写入成功后等待人工批准。",
    });
    let calls = 0;
    const provider: ModelProvider = {
      async *run(_messages, _signal, context) {
        calls += 1;
        yield { type: "started", requestId: "planner-write" };
        yield {
          type: "workspace-tool",
          toolCallId: "write-brief",
          tool: { kind: "workspace-write", workspaceId: context!.workspaces![0]!.id, path: "02-briefs/options.md", content: "# 三个真实候选\n" },
          providerToolName: "workspace_write",
        };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), vi.fn());
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "用 workspace_write 创建 Brief，然后停在等待人工选题批准" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(calls).toBe(1);
    expect(readFileSync(join(root, "02-briefs", "options.md"), "utf8")).toContain("三个真实候选");
    expect(repository.listTranscript(created.session.id).at(-1)).toMatchObject({ status: "completed", body: expect.stringContaining("等待人工选题批准") });
  });

  it("blocks a fact-editor artifact until real text_measure results satisfy every requested range", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const root = directory();
    mkdirSync(join(root, "04-review"));
    const service = new WorkspaceService(repository);
    const registered = await service.registerRoot(root);
    repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: true });
    const created = repository.createBot();
    repository.updateBot(created.bot.id, created.bot.version, { name: "事实编辑" });
    let calls = 0;
    let gateResult = "";
    let measurementGuidance = "";
    const provider: ModelProvider = {
      async *run(messages, _signal, context) {
        calls += 1;
        yield { type: "started", requestId: `editor-gate-${calls}` };
        if (calls === 1 || calls === 3) {
          yield { type: "computation-tool", toolCallId: `measure-${calls}`, tool: { kind: "text-measure", text: calls === 1 ? "展".repeat(333) : "短".repeat(180) }, providerToolName: "text_measure" };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        if (calls === 2 || calls === 4) {
          if (calls === 2) measurementGuidance = messages.findLast((message) => message.role === "tool")?.content ?? "";
          if (calls === 4) gateResult = messages.filter((message) => message.role === "tool").map((message) => message.content).join("\n");
          yield {
            type: "workspace-tool",
            toolCallId: `write-review-${calls}`,
            tool: { kind: "workspace-write", workspaceId: context!.workspaces![0]!.id, path: "04-review/final.md", content: "# 合格审校稿\n" },
            providerToolName: "workspace_write",
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "delta", text: "短帖与展开版均已有真实区间证据，审校稿已写入。" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), vi.fn());
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "短帖 140–220、展开版 280–420；用 text_measure 后 workspace_write 写审校稿" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(calls).toBe(5);
    expect(measurementGuidance).toContain("missingRanges");
    expect(measurementGuidance).toContain('"min":140');
    expect(gateResult).toContain("MEASUREMENT_RANGE_NOT_SATISFIED");
    expect(repository.listToolInvocations(created.session.id).map((item) => item.toolKind)).toEqual(["text-measure", "text-measure", "workspace-write"]);
    expect(readFileSync(join(root, "04-review", "final.md"), "utf8")).toContain("合格审校稿");
  });

  it("fails a completed-looking reply that claims a file read without a succeeded tool record", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: "false-read-claim" };
        yield { type: "delta", text: "已真实调用 workspace_read 并成功读取 CSV 文件。" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "读取 CSV" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("failed"));
    expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("TOOL_EVIDENCE_REQUIRED");
    expect(repository.listToolInvocations(created.session.id)).toEqual([]);
    expect(repository.listTranscript(created.session.id).at(-1)).toMatchObject({ status: "failed" });
  });

  it("rejects CSV metrics and length claims without their exact deterministic evidence tools", async () => {
    for (const fixture of [
      { request: "分析 metrics.csv 的浏览和互动指标", body: "总浏览 7700，总互动 85，最高互动率 4%。", code: "DATA_EVIDENCE_REQUIRED" },
      { request: "计算这段内容的非空白字符数", body: "该内容共有 205 个非空白字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    ]) {
      const repository = new AppRepository(":memory:");
      repositories.push(repository);
      const created = repository.createBot();
      const provider: ModelProvider = {
        async *run() {
          yield { type: "started", requestId: fixture.code };
          yield { type: "delta", text: fixture.body };
          yield { type: "completed", finishReason: "stop" };
        },
        testConnection: async () => {},
      };
      const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider);
      const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: fixture.request });
      await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("failed"));
      expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe(fixture.code);
    }
  });

  it("auto-approves exact text measurement and accepts the resulting length claim", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    let round = 0;
    const provider: ModelProvider = {
      async *run(messages) {
        round += 1;
        yield { type: "started", requestId: `measure-${round}` };
        if (!messages.some((message) => message.role === "tool")) {
          yield { type: "computation-tool", toolCallId: "measure-1", tool: { kind: "text-measure", text: "你好 A" }, providerToolName: "text_measure" };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "delta", text: "确定性结果为 3 个非空白字符。" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const service = new WorkspaceService(repository);
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), vi.fn());
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "计算非空白字符数" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(repository.listToolInvocations(created.session.id)).toMatchObject([
      { toolKind: "text-measure", effectClass: "pure", state: "succeeded" },
    ]);
    expect(repository.listTranscript(created.session.id).at(-1)).toMatchObject({ status: "completed" });
  });

  it("accepts data conclusions only after the exact CSV was successfully read in the same Runtime", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const root = directory();
    writeFileSync(join(root, "metrics.csv"), "id,views,interactions\nA,1000,30\nB,1400,28\n", "utf8");
    const service = new WorkspaceService(repository);
    const registered = await service.registerRoot(root);
    repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: false, automationEnabled: true });
    const created = repository.createBot();
    let round = 0;
    const provider: ModelProvider = {
      async *run(messages, _signal, context) {
        round += 1;
        yield { type: "started", requestId: `csv-${round}` };
        if (!messages.some((message) => message.role === "tool")) {
          yield { type: "workspace-tool", toolCallId: "read-csv", tool: { kind: "workspace-read", workspaceId: context!.workspaces![0]!.id, path: "metrics.csv", maxBytes: 4096 }, providerToolName: "workspace_read" };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "delta", text: "来源 metrics.csv：总浏览 2400，总互动 58。" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), vi.fn());
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "分析 metrics.csv 的浏览和互动指标" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(repository.listToolInvocations(created.session.id)).toMatchObject([
      { toolKind: "workspace-read", targetPath: "metrics.csv", state: "succeeded" },
    ]);
  });

  it("returns a denial to the model without resolving any filesystem target", async () => {
    const value = await harness("deny");
    const resolveTarget = vi.spyOn(value.workspaceService, "resolveExistingTarget");
    const sent = value.worker.send({ sessionId: value.created.session.id, clientNonce: crypto.randomUUID(), text: "不要读取" });
    await vi.waitFor(() => expect(value.repository.getRuntimeRun(sent.runId).state).toBe("completed"));

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(value.calls[1]?.find((message) => message.role === "tool")?.content).toContain("TOOL_DENIED");
    expect(value.repository.listToolInvocations(value.created.session.id)[0]).toMatchObject({ state: "denied", attemptCount: 0 });
  });

  it("cancels a pending approval with its Runtime and never resumes it", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const root = directory();
    writeFileSync(join(root, "brief.txt"), "NEVER_READ", "utf8");
    const service = new WorkspaceService(repository);
    const workspace = (await service.registerRoot(root)).workspace;
    const created = repository.createBot();
    const pending = vi.fn();
    const provider: ModelProvider = {
      async *run(_messages, _signal, context) {
        yield { type: "started", requestId: "cancel-tool" };
        yield { type: "workspace-tool", toolCallId: "cancel-read", tool: { kind: "workspace-read", workspaceId: context!.workspaces![0]!.id, path: "brief.txt", maxBytes: 10 } };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), pending);
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "取消" });
    await vi.waitFor(() => expect(repository.listPendingApprovalRequests(created.session.id)).toHaveLength(1));
    worker.cancelRun(sent.runId);
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("cancelled"));
    expect(repository.listToolInvocations(created.session.id)[0]).toMatchObject({ state: "cancelled", attemptCount: 0, workspaceId: workspace.id });
    expect(repository.listPendingApprovalRequests(created.session.id)).toEqual([]);
  });

  it("stops a model that exceeds sixteen consecutive workspace tool rounds", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const root = directory();
    const service = new WorkspaceService(repository);
    await service.registerRoot(root);
    const created = repository.createBot();
    let calls = 0;
    const provider: ModelProvider = {
      async *run(_messages, _signal, context) {
        calls += 1;
        yield { type: "started", requestId: `loop-${calls}` };
        yield { type: "workspace-tool", toolCallId: `loop-tool-${calls}`, tool: { kind: "workspace-list", workspaceId: context!.workspaces![0]!.id, path: "", maxEntries: 10 } };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), (event) => {
      if (event.approval.state === "pending") {
        queueMicrotask(() => void coordinator.resolve(event.sessionId, event.approval.id, event.approval.version, "allow-once"));
      }
    });
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "循环保护" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("failed"));
    expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("TOOL_ROUND_LIMIT_EXCEEDED");
    expect(repository.listToolInvocations(created.session.id)).toHaveLength(16);
    expect(repository.listToolInvocations(created.session.id).every((invocation) => invocation.state === "succeeded")).toBe(true);
    expect(calls).toBe(17);
  });

  it("allows up to thirty-two bounded rounds for an explicit deterministic length-convergence task", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new WorkspaceService(repository);
    const created = repository.createBot();
    let calls = 0;
    const provider: ModelProvider = {
      async *run() {
        calls += 1;
        yield { type: "started", requestId: `measure-loop-${calls}` };
        yield { type: "computation-tool", toolCallId: `measure-${calls}`, tool: { kind: "text-measure", text: "仍需继续收敛" }, providerToolName: "text_measure" };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), vi.fn());
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "用 text_measure 精确计算字符数并持续修订长度" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("failed"));
    expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("TOOL_ROUND_LIMIT_EXCEEDED");
    expect(repository.listToolInvocations(created.session.id)).toHaveLength(32);
    expect(calls).toBe(33);
  });

  it("bounds draft-stage measurement retries and returns control to the writer without weakening final measurement evidence", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new WorkspaceService(repository);
    const created = repository.createBot();
    repository.updateBot(created.bot.id, created.bot.version, { name: "内容主笔" });
    let calls = 0;
    const provider: ModelProvider = {
      async *run(messages) {
        calls += 1;
        yield { type: "started", requestId: `draft-measure-${calls}` };
        const lastTool = messages.findLast((message) => message.role === "tool");
        if (lastTool?.content.includes("TEXT_MEASURE_DRAFT_LIMIT_REACHED")) {
          yield { type: "delta", text: "初稿阶段已停止循环测量，交由事实编辑完成最终收敛。" };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        yield { type: "computation-tool", toolCallId: `draft-measure-tool-${calls}`, tool: { kind: "text-measure", text: "仍在修订的真实初稿" }, providerToolName: "text_measure" };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), vi.fn());
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "用 text_measure 精确记录初稿长度" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(repository.listToolInvocations(created.session.id)).toHaveLength(6);
    expect(calls).toBe(8);
    expect(repository.listTranscript(created.session.id).at(-1)?.body).toContain("事实编辑");
  });
});
