import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceToolRequest } from "@shared/contracts";
import type { ModelProvider } from "./model";
import { AppRepository } from "./database";
import { SendWorker } from "./send-worker";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";

const cleanup: Array<{ repository: AppRepository; root: string }> = [];

async function fixture(provider: ModelProvider) {
  const repository = new AppRepository(":memory:");
  const root = mkdtempSync(join(tmpdir(), "aevoren-source-read-"));
  cleanup.push({ repository, root });
  writeFileSync(join(root, "license-note.md"), "LICENSE_SOURCE: Apache-2.0");
  writeFileSync(join(root, "USER_GUIDE.md"), "GUIDE_SOURCE: persistent assistants and shared conversations");
  const service = new WorkspaceService(repository);
  const registered = await service.registerRoot(root);
  repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: true });
  const created = repository.createBot(registered.project.id);
  const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), vi.fn());
  const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
  return { repository, root, created, worker };
}

afterEach(() => {
  for (const item of cleanup.splice(0)) {
    item.repository.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

describe("source reads before workspace writes", () => {
  it.each([
    { native: false, path: "license-summary.md" },
    { native: true, path: "报告 说明.md" },
  ])("rejects control characters and wrong output names before writing $path (native $native)", async ({ native, path }) => {
    let stage = 0;
    const attempts = ["\n   .md", "other.md", path];
    const consume = (content: string, action: number): void => {
      if (action === 2) return;
      const result = JSON.parse(content) as { code: string; expectedPaths: string[] };
      expect(result.code).toBe(action === 0 ? "WORKSPACE_TOOL_ARGUMENTS_INVALID" : "WORKSPACE_WRITE_PATH_REQUIRED");
      expect(result.expectedPaths).toEqual([path]);
      expect(readdirSync(f.root).sort()).toEqual(["USER_GUIDE.md", "license-note.md"]);
      expect(f.repository.listToolInvocations(f.created.session.id)).toEqual([]);
    };
    const provider: ModelProvider = {
      async *run(messages, signal, context) {
        expect(context?.requestedWritePaths).toEqual([path]);
        yield { type: "started", requestId: `path-${stage}` };
        const workspaceId = context!.workspaces![0]!.id;
        if (native) {
          for (; stage < attempts.length; stage += 1) {
            const action = stage;
            yield { type: "workspace-tool", toolCallId: `path-${action}`, toolSignal: signal,
              tool: { kind: "workspace-write", workspaceId, path: attempts[action]!, content: "Correctly named output." },
              respond: async (content) => consume(content, action) };
          }
        } else {
          const latest = messages.findLast((message) => message.role === "tool");
          if (latest) consume(latest.content, stage - 1);
          if (stage < attempts.length) {
            const action = stage++;
            yield { type: "workspace-tool", toolCallId: `path-${action}`, tool: { kind: "workspace-write", workspaceId, path: attempts[action]!, content: "Correctly named output." } };
            yield { type: "completed", finishReason: "tool_calls" };
            return;
          }
        }
        yield { type: "delta", text: `文件已写入 ${path}。` };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const f = await fixture(provider);
    const sent = f.worker.send({ sessionId: f.created.session.id, clientNonce: crypto.randomUUID(), text: `请新建文件 \`${path}\` 并写入一段原创说明。` });
    await vi.waitFor(() => expect(f.repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(readFileSync(join(f.root, path), "utf8")).toBe("Correctly named output.");
    expect(existsSync(join(f.root, "\n   .md"))).toBe(false);
    expect(existsSync(join(f.root, "other.md"))).toBe(false);
    expect(f.repository.listToolInvocations(f.created.session.id)).toMatchObject([{ toolKind: "workspace-write", state: "succeeded", targetPath: path }]);
  });

  it("does not mark the requested basename complete after a rejected write and a false success claim", async () => {
    const provider: ModelProvider = {
      async *run(messages, _signal, context) {
        yield { type: "started", requestId: "wrong-name-claim" };
        if (!messages.some((message) => message.role === "tool")) {
          yield { type: "workspace-tool", toolCallId: "wrong-name", tool: { kind: "workspace-write", workspaceId: context!.workspaces![0]!.id, path: "wrong.md", content: "Must not exist." } };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "delta", text: "required.md 已创建成功。" };
        yield { type: "completed", finishReason: "stop" };
      }, testConnection: async () => {},
    };
    const f = await fixture(provider);
    const sent = f.worker.send({ sessionId: f.created.session.id, clientNonce: crypto.randomUUID(), text: "请新建文件 required.md 并写入一段说明。" });
    await vi.waitFor(() => expect(f.repository.getRuntimeRun(sent.runId).state).toBe("failed"));
    expect(f.repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("TASK_REQUIREMENTS_UNMET");
    expect(f.repository.listToolInvocations(f.created.session.id)).toEqual([]);
    expect(existsSync(join(f.root, "wrong.md"))).toBe(false);
    expect(existsSync(join(f.root, "required.md"))).toBe(false);
  });

  it.each([false, true])("corrects premature writes only after both real source reads (native responder %s)", async (native) => {
    let stage = 0;
    const sourceTexts: string[] = [];
    const rejections: Array<Array<{ path: string }>> = [];
    const consume = (content: string, action: number): void => {
      const result = JSON.parse(content) as { code?: string; text?: string; missingSources?: Array<{ path: string }> };
      if (action === 0 || action === 2) {
        expect(result.code).toBe("WORKSPACE_SOURCE_READ_REQUIRED");
        rejections.push(result.missingSources!);
        expect(existsSync(join(f.root, "guide-note.md"))).toBe(false);
        expect(f.repository.listToolInvocations(f.created.session.id).some((tool) => tool.toolKind === "workspace-write")).toBe(false);
      } else if (action === 1 || action === 3) {
        expect(result.text).toBe(readFileSync(join(f.root, action === 1 ? "license-note.md" : "USER_GUIDE.md"), "utf8"));
        sourceTexts.push(result.text!);
      }
    };
    const request = (action: number, workspaceId: string): WorkspaceToolRequest => action === 1 || action === 3
      ? { kind: "workspace-read", workspaceId, path: action === 1 ? "license-note.md" : "USER_GUIDE.md", maxBytes: 4096 }
      : { kind: "workspace-write", workspaceId, path: "guide-note.md", content: action < 4 ? "UNSUPPORTED_CONTENT" : sourceTexts.join("\n") };
    const provider: ModelProvider = {
      async *run(messages, signal, context) {
        yield { type: "started", requestId: `source-round-${stage}` };
        if (native) {
          for (; stage < 5; stage += 1) {
            const action = stage;
            yield { type: "workspace-tool", toolCallId: `source-${action}`, tool: request(action, context!.workspaces![0]!.id), toolSignal: signal,
              respond: async (content) => consume(content, action) };
          }
        } else {
          const latest = messages.findLast((message) => message.role === "tool");
          if (latest) consume(latest.content, stage - 1);
          if (stage < 5) {
            const action = stage++;
            yield { type: "workspace-tool", toolCallId: `source-${action}`, tool: request(action, context!.workspaces![0]!.id) };
            yield { type: "completed", finishReason: "tool_calls" };
            return;
          }
        }
        yield { type: "delta", text: "两份来源已读取，guide-note.md 已写入。" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const f = await fixture(provider);
    const sent = f.worker.send({ sessionId: f.created.session.id, clientNonce: crypto.randomUUID(),
      text: "请读取license-note.md和USER_GUIDE.md→guide-note.md，将两段来源内容写入guide-note.md。" });
    await vi.waitFor(() => expect(f.repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(rejections.map((sources) => sources.map((source) => source.path))).toEqual([
      ["license-note.md", "USER_GUIDE.md"], ["USER_GUIDE.md"],
    ]);
    expect(readFileSync(join(f.root, "guide-note.md"), "utf8")).toBe(sourceTexts.join("\n"));
    expect(f.repository.listToolInvocations(f.created.session.id).map((tool) => [tool.toolKind, tool.state])).toEqual([
      ["workspace-read", "succeeded"], ["workspace-read", "succeeded"], ["workspace-write", "succeeded"],
    ]);
  });

  it("still permits an original creative write that has no requested source files", async () => {
    const provider: ModelProvider = {
      async *run(messages, _signal, context) {
        yield { type: "started", requestId: "original-story" };
        if (!messages.some((message) => message.role === "tool")) {
          yield { type: "workspace-tool", toolCallId: "story-write", tool: { kind: "workspace-write", workspaceId: context!.workspaces![0]!.id, path: "story.md", content: "An original short story." } };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "delta", text: "原创故事已写入 story.md。" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const f = await fixture(provider);
    const sent = f.worker.send({ sessionId: f.created.session.id, clientNonce: crypto.randomUUID(), text: "不要读取 secret.md。请原创一个简短故事，保存为 story.md，无需读取任何资料。" });
    await vi.waitFor(() => expect(f.repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(readFileSync(join(f.root, "story.md"), "utf8")).toBe("An original short story.");
    expect(f.repository.listToolInvocations(f.created.session.id)).toMatchObject([{ toolKind: "workspace-write", state: "succeeded" }]);
  });
});
