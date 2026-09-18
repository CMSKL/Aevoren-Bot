import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function harness(resolution: "allow-once" | "deny") {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  const root = directory();
  writeFileSync(join(root, "brief.txt"), "PRIVATE_WORKSPACE_RESULT", "utf8");
  const workspaceService = new WorkspaceService(repository);
  const registered = await workspaceService.registerRoot(root);
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
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "CLI 查询时间" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(hostResult).toContain("2026-09-17T08:00:00.000Z");
    expect(repository.listTranscript(created.session.id).at(-1)?.body).toContain("CLI_RESULT");
    expect(repository.listToolInvocations(created.session.id)[0]).toMatchObject({ state: "succeeded", toolKind: "time-now" });
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
    const value = await harness("allow-once");
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

  it("stops a model that exceeds four consecutive workspace tool rounds", async () => {
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
    expect(repository.listToolInvocations(created.session.id)).toHaveLength(4);
    expect(repository.listToolInvocations(created.session.id).every((invocation) => invocation.state === "succeeded")).toBe(true);
    expect(calls).toBe(5);
  });
});
