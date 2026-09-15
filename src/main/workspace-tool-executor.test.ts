import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptManifest, WorkspaceToolRequest } from "@shared/contracts";
import { AppRepository } from "./database";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];
type UnboundWorkspaceToolRequest = WorkspaceToolRequest extends infer Tool
  ? Tool extends WorkspaceToolRequest
    ? Omit<Tool, "workspaceId">
    : never
  : never;

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function repository(): AppRepository {
  const value = new AppRepository(":memory:");
  repositories.push(value);
  return value;
}

async function preparedInvocation(
  value: AppRepository,
  root: string,
  tool: UnboundWorkspaceToolRequest,
  expiresAt?: string,
) {
  const service = new WorkspaceService(value);
  const { workspace } = await service.registerRoot(root);
  const created = value.createBot();
  const clientNonce = crypto.randomUUID();
  value.prepareMessage({ sessionId: created.session.id, clientNonce, text: "检查工作区" });
  const manifest: PromptManifest = {
    schemaVersion: 1,
    botId: created.bot.id,
    profileVersion: 1,
    sessionId: created.session.id,
    generation: 1,
    inputSeq: 1,
    blocks: [],
    digest: "workspace-tool-test",
  };
  let runtime = value.createRuntimeRun(clientNonce, "fake", manifest);
  runtime = value.transitionRuntimeRun(runtime.id, "dispatching");
  runtime = value.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "provider" });
  const command = {
    runtimeRunId: runtime.id,
    toolCallId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    tool: { ...tool, workspaceId: workspace.id } as WorkspaceToolRequest,
  };
  const prepared = expiresAt
    ? value.prepareToolInvocation(command, expiresAt)
    : value.prepareToolInvocation(command);
  return { service, workspace, runtime, ...prepared };
}

async function approvedInvocation(value: AppRepository, root: string, tool: UnboundWorkspaceToolRequest) {
  const prepared = await preparedInvocation(value, root, tool);
  const approved = value.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
  return { service: prepared.service, workspace: prepared.workspace, runtime: prepared.runtime, ...approved };
}

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("WorkspaceToolExecutor", () => {
  it("never resolves a filesystem target before a one-time approval is active", async () => {
    const root = temporaryDirectory("aevoren-tool-approval-guard-");
    writeFileSync(join(root, "safe.txt"), "safe");
    const value = repository();
    const pending = await preparedInvocation(value, root, { kind: "workspace-read", path: "safe.txt", maxBytes: 32 });
    const pendingResolve = vi.spyOn(pending.service, "resolveExistingTarget");

    await expect(new WorkspaceToolExecutor(value, pending.service).execute(pending.invocation.id)).rejects.toMatchObject({
      code: "TOOL_STATE_INVALID",
    });
    expect(pendingResolve).not.toHaveBeenCalled();
    expect(value.getToolInvocation(pending.invocation.id)).toMatchObject({ state: "awaiting-approval", attemptCount: 0 });

    value.resolveToolApproval(pending.approval.id, pending.approval.version, "deny");
    await expect(new WorkspaceToolExecutor(value, pending.service).execute(pending.invocation.id)).rejects.toMatchObject({
      code: "TOOL_STATE_INVALID",
    });
    expect(pendingResolve).not.toHaveBeenCalled();
    expect(value.getToolInvocation(pending.invocation.id)).toMatchObject({ state: "denied", attemptCount: 0 });

    const expiredValue = repository();
    const expired = await preparedInvocation(
      expiredValue,
      root,
      { kind: "workspace-read", path: "safe.txt", maxBytes: 32 },
      "2000-01-01T00:00:00.000Z",
    );
    expect(() => expiredValue.resolveToolApproval(expired.approval.id, expired.approval.version, "allow-once")).toThrowError(
      expect.objectContaining({ code: "APPROVAL_EXPIRED" }),
    );
    const expiredResolve = vi.spyOn(expired.service, "resolveExistingTarget");
    await expect(new WorkspaceToolExecutor(expiredValue, expired.service).execute(expired.invocation.id)).rejects.toMatchObject({
      code: "TOOL_STATE_INVALID",
    });
    expect(expiredResolve).not.toHaveBeenCalled();
    expect(expiredValue.getToolInvocation(expired.invocation.id)).toMatchObject({ state: "expired", attemptCount: 0 });
  });

  it("lists one directory deterministically and respects maxEntries", async () => {
    const root = temporaryDirectory("aevoren-tool-list-");
    mkdirSync(join(root, "folder"));
    writeFileSync(join(root, "b.txt"), "b");
    writeFileSync(join(root, "a.txt"), "a");
    const value = repository();
    const fixture = await approvedInvocation(value, root, { kind: "workspace-list", path: "", maxEntries: 2 });

    const executor = new WorkspaceToolExecutor(value, fixture.service);
    const result = await executor.execute(fixture.invocation.id);
    const parsed = JSON.parse(result.content) as { entries: Array<{ name: string; type: string }>; truncated: boolean };

    expect(parsed).toEqual({
      entries: [{ name: "a.txt", type: "file" }, { name: "b.txt", type: "file" }],
      truncated: true,
    });
    expect(result.invocation).toMatchObject({ state: "succeeded", attemptCount: 1, resultDigest: expect.any(String) });
    expect(result.invocation.resultMetadata).toEqual({ kind: "workspace-list", entries: 2, truncated: true });
    await expect(executor.execute(fixture.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    expect(value.getToolInvocation(fixture.invocation.id)).toMatchObject({ state: "succeeded", attemptCount: 1 });
  });

  it("reads bounded UTF-8 text without persisting its body", async () => {
    const root = temporaryDirectory("aevoren-tool-read-");
    writeFileSync(join(root, "notes.txt"), "你好，Aevoren Bot");
    const value = repository();
    const fixture = await approvedInvocation(value, root, { kind: "workspace-read", path: "notes.txt", maxBytes: 9 });

    const result = await new WorkspaceToolExecutor(value, fixture.service).execute(fixture.invocation.id);
    const parsed = JSON.parse(result.content) as { text: string; truncated: boolean };

    expect(parsed).toEqual({ text: "你好，", truncated: true });
    expect(JSON.stringify(value.getToolInvocation(fixture.invocation.id))).not.toContain("你好");
    expect(result.invocation.resultMetadata).toEqual({ kind: "workspace-read", bytes: 9, truncated: true });
  });

  it("rejects binary files with a stable terminal failure and no result content", async () => {
    const root = temporaryDirectory("aevoren-tool-binary-");
    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    const value = repository();
    const fixture = await approvedInvocation(value, root, { kind: "workspace-read", path: "binary.bin", maxBytes: 32 });

    await expect(new WorkspaceToolExecutor(value, fixture.service).execute(fixture.invocation.id)).rejects.toMatchObject({
      code: "WORKSPACE_BINARY_UNSUPPORTED",
    });
    expect(value.getToolInvocation(fixture.invocation.id)).toMatchObject({
      state: "failed",
      resultDigest: null,
      resultMetadata: null,
      lastErrorCode: "WORKSPACE_BINARY_UNSUPPORTED",
    });
  });

  it("discards a read result when the canonical target changes during execution", async () => {
    const root = temporaryDirectory("aevoren-tool-target-change-");
    writeFileSync(join(root, "notes.txt"), "private result");
    const value = repository();
    const fixture = await approvedInvocation(value, root, { kind: "workspace-read", path: "notes.txt", maxBytes: 32 });
    const resolve = fixture.service.resolveExistingTarget.bind(fixture.service);
    let fileResolutions = 0;
    vi.spyOn(fixture.service, "resolveExistingTarget").mockImplementation(async (...arguments_) => {
      const resolved = await resolve(...arguments_);
      if (arguments_[2] === "file" && (fileResolutions += 1) === 3) {
        return { ...resolved, canonicalPath: `${resolved.canonicalPath}.replaced` };
      }
      return resolved;
    });

    await expect(new WorkspaceToolExecutor(value, fixture.service).execute(fixture.invocation.id)).rejects.toMatchObject({
      code: "WORKSPACE_TARGET_CHANGED",
    });
    expect(value.getToolInvocation(fixture.invocation.id)).toMatchObject({
      state: "failed",
      resultDigest: null,
      resultMetadata: null,
      lastErrorCode: "WORKSPACE_TARGET_CHANGED",
    });
  });

  it("searches literal text recursively, skips symlinks and stops at maxMatches", async () => {
    const root = temporaryDirectory("aevoren-tool-search-");
    const outside = temporaryDirectory("aevoren-tool-search-outside-");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "alpha\nNeedle first\nNeedle second\n");
    writeFileSync(join(root, "src", "b.ts"), "Needle third\n");
    writeFileSync(join(outside, "secret.txt"), "Needle secret\n");
    symlinkSync(outside, join(root, "src", "outside"));
    const value = repository();
    const fixture = await approvedInvocation(value, root, {
      kind: "workspace-search",
      path: "src",
      query: "Needle",
      maxMatches: 2,
    });

    const result = await new WorkspaceToolExecutor(value, fixture.service).execute(fixture.invocation.id);
    const parsed = JSON.parse(result.content) as { matches: Array<{ path: string; line: number; preview: string }>; truncated: boolean };

    expect(parsed.matches).toEqual([
      { path: "src/a.ts", line: 2, preview: "Needle first" },
      { path: "src/a.ts", line: 3, preview: "Needle second" },
    ]);
    expect(parsed.truncated).toBe(true);
    expect(result.content).not.toContain("secret");
    expect(result.invocation.resultMetadata).toEqual({
      kind: "workspace-search",
      files: 1,
      matches: 2,
      truncated: true,
    });
  });

  it("does not execute before approval and fails closed when access was removed", async () => {
    const root = temporaryDirectory("aevoren-tool-revoked-");
    writeFileSync(join(root, "safe.txt"), "safe");
    const value = repository();
    const fixture = await approvedInvocation(value, root, { kind: "workspace-read", path: "safe.txt", maxBytes: 32 });
    value.removeWorkspace(fixture.workspace.id, fixture.workspace.version);

    await expect(new WorkspaceToolExecutor(value, fixture.service).execute(fixture.invocation.id)).rejects.toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
    });
    expect(value.getToolInvocation(fixture.invocation.id)).toMatchObject({
      state: "failed-before-execution",
      attemptCount: 1,
      lastErrorCode: "WORKSPACE_NOT_FOUND",
    });
  });

  it("cancels an approved invocation before dispatch when its signal is already aborted", async () => {
    const root = temporaryDirectory("aevoren-tool-cancel-");
    writeFileSync(join(root, "safe.txt"), "safe");
    const value = repository();
    const fixture = await approvedInvocation(value, root, { kind: "workspace-read", path: "safe.txt", maxBytes: 32 });
    const controller = new AbortController();
    controller.abort();

    await expect(new WorkspaceToolExecutor(value, fixture.service).execute(fixture.invocation.id, controller.signal)).rejects.toMatchObject({
      code: "TOOL_EXECUTION_CANCELLED",
    });
    expect(value.getToolInvocation(fixture.invocation.id)).toMatchObject({ state: "cancelled", attemptCount: 0 });
    expect(value.getApprovalRequest(fixture.approval.id)).toMatchObject({ state: "cancelled" });
  });

  it("cancels an invocation that aborts after dispatch without publishing a result", async () => {
    const root = temporaryDirectory("aevoren-tool-active-cancel-");
    writeFileSync(join(root, "safe.txt"), "must not be returned");
    const value = repository();
    const fixture = await approvedInvocation(value, root, { kind: "workspace-read", path: "safe.txt", maxBytes: 32 });
    const controller = new AbortController();
    const resolve = fixture.service.resolveExistingTarget.bind(fixture.service);
    let resolutions = 0;
    vi.spyOn(fixture.service, "resolveExistingTarget").mockImplementation(async (...arguments_) => {
      const result = await resolve(...arguments_);
      if ((resolutions += 1) === 2) controller.abort();
      return result;
    });

    await expect(new WorkspaceToolExecutor(value, fixture.service).execute(fixture.invocation.id, controller.signal)).rejects.toMatchObject({
      code: "TOOL_EXECUTION_CANCELLED",
    });
    expect(value.getToolInvocation(fixture.invocation.id)).toMatchObject({
      state: "cancelled",
      attemptCount: 1,
      resultDigest: null,
      resultMetadata: null,
      lastErrorCode: "TOOL_EXECUTION_CANCELLED",
    });
    expect(value.getApprovalRequest(fixture.approval.id)).toMatchObject({ state: "cancelled" });
  });
});
