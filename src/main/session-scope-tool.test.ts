import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, ToolRequest } from "@shared/contracts";
import { AppRepository } from "./database";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";

const repositories: AppRepository[] = [];
const directories: string[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "aevoren-session-tools-"));
  directories.push(path);
  return path;
}

function running(repository: AppRepository, session: Session, botId: string) {
  const clientNonce = randomUUID();
  const command = { sessionId: session.id, clientNonce, text: "检查当前会话文件" };
  if (session.roomId) repository.prepareRoomMessage({ ...command, roomId: session.roomId, targetBotIds: [botId] });
  else repository.prepareMessage(command);
  const run = repository.createRuntimeRun(clientNonce, "fake", {
    schemaVersion: 1, botId, profileVersion: 1, sessionId: session.id,
    generation: session.generation, inputSeq: 1, blocks: [], digest: "session-scope-tool-test",
  }, { executorBotId: botId });
  repository.transitionRuntimeRun(run.id, "dispatching");
  return repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "session-scope-test" });
}

async function fixture(options: { writeEnabled?: boolean; automationEnabled?: boolean } = {}) {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  const service = new WorkspaceService(repository);
  const root = directory();
  writeFileSync(join(root, "private.md"), "SESSION_PRIVATE_CONTENT", "utf8");
  const registered = await service.registerRoot(root);
  const workspace = repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, {
    writeEnabled: options.writeEnabled ?? false,
    automationEnabled: options.automationEnabled ?? false,
  });
  const created = repository.createBot(registered.project.id);
  const runtime = running(repository, created.session, created.bot.id);
  const executor = new WorkspaceToolExecutor(repository, service);
  const coordinator = new WorkspaceToolCoordinator(repository, executor, vi.fn());
  const tool = { kind: "workspace-read" as const, workspaceId: workspace.id, path: "private.md", maxBytes: 4096 };
  const approve = (request: ToolRequest = tool) => {
    const prepared = repository.prepareToolInvocation({
      runtimeRunId: runtime.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool: request,
    });
    return repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
  };
  return { repository, service, root, project: registered.project, workspace, created, runtime, executor, coordinator, tool, approve };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0)) repository.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("session-scoped workspace execution", () => {
  it("does not inherit a registered automated folder in a new ordinary direct chat", async () => {
    const f = await fixture({ automationEnabled: true });
    const ordinary = f.repository.createBot();
    const runtime = running(f.repository, ordinary.session, ordinary.bot.id);
    expect(f.repository.listSessionWorkspaces(ordinary.session.id, ordinary.bot.id)).toEqual([]);
    expect(() => f.coordinator.requestAndWait(runtime.id, "ordinary-read", f.tool, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: "WORKSPACE_PATH_OUTSIDE_ROOT" }));
    expect(f.repository.listToolInvocations(ordinary.session.id)).toEqual([]);
  });

  it("uses the room folder for a cross-project Bot without importing its personal folder", async () => {
    const f = await fixture({ automationEnabled: true });
    const otherRoot = directory();
    writeFileSync(join(otherRoot, "room.md"), "ROOM_FOLDER_CONTENT", "utf8");
    const other = await f.service.registerRoot(otherRoot);
    f.repository.updateWorkspacePermissions(other.workspace.id, other.workspace.version, { writeEnabled: false, automationEnabled: true });
    const peer = f.repository.createBot(other.project.id);
    const room = f.repository.createRoom({ projectId: other.project.id, memberBotIds: [f.created.bot.id, peer.bot.id] });
    const runtime = running(f.repository, room.session, f.created.bot.id);
    expect(f.repository.listSessionWorkspaces(room.session.id, f.created.bot.id).map(({ id }) => id)).toEqual([other.workspace.id]);
    expect(() => f.coordinator.requestAndWait(runtime.id, "personal-folder", f.tool, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: "WORKSPACE_PATH_OUTSIDE_ROOT" }));
    const result = await f.coordinator.requestAndWait(runtime.id, "room-folder", {
      ...f.tool, workspaceId: other.workspace.id, path: "room.md",
    }, new AbortController().signal);
    expect(JSON.parse(result.content)).toMatchObject({ text: "ROOM_FOLDER_CONTENT" });
    expect(f.repository.listToolInvocations(room.session.id)).toMatchObject([{ state: "succeeded", workspaceId: other.workspace.id }]);
    expect(f.repository.listPendingApprovalRequests(room.session.id)).toEqual([]);
  });

  it("settles the waiting model when a folder is revoked before approval", async () => {
    const f = await fixture();
    const resolveTarget = vi.spyOn(f.service, "resolveExistingTarget");
    const pending = f.coordinator.requestAndWait(f.runtime.id, "revoked-pending", f.tool, new AbortController().signal);
    const approval = f.repository.listPendingApprovalRequests(f.created.session.id)[0]!;
    f.repository.removeWorkspace(f.workspace.id, f.workspace.version);
    await expect(f.coordinator.resolve(f.created.session.id, approval.id, approval.version, "allow-once"))
      .rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    await expect(pending).resolves.toMatchObject({ content: JSON.stringify({ ok: false, error: { code: "WORKSPACE_NOT_FOUND" } }) });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(f.repository.listPendingApprovalRequests(f.created.session.id)).toEqual([]);
    expect(f.repository.getToolInvocation(approval.toolInvocationId)).toMatchObject({ state: "cancelled", resultDigest: null, attemptCount: 0 });
  });

  it("rechecks the automation switch before committing an automatic approval", async () => {
    const f = await fixture({ automationEnabled: true });
    const resolveTarget = vi.spyOn(f.service, "resolveExistingTarget");
    const coordinator = new WorkspaceToolCoordinator(f.repository, f.executor, (event) => {
      if (event.approval.state === "pending") {
        f.repository.updateWorkspacePermissions(f.workspace.id, f.workspace.version, { writeEnabled: false, automationEnabled: false });
      }
    });
    const result = await coordinator.requestAndWait(f.runtime.id, "automation-revoked", f.tool, new AbortController().signal);
    expect(result.content).toContain("WORKSPACE_PATH_OUTSIDE_ROOT");
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(f.repository.listPendingApprovalRequests(f.created.session.id)).toEqual([]);
    expect(f.repository.listToolInvocations(f.created.session.id)).toMatchObject([{ state: "cancelled", attemptCount: 0, resultDigest: null }]);
  });

  it("can deny a revoked folder without performing any filesystem access", async () => {
    const f = await fixture();
    const resolveTarget = vi.spyOn(f.service, "resolveExistingTarget");
    const pending = f.coordinator.requestAndWait(f.runtime.id, "revoked-deny", f.tool, new AbortController().signal);
    const approval = f.repository.listPendingApprovalRequests(f.created.session.id)[0]!;
    f.repository.removeWorkspace(f.workspace.id, f.workspace.version);
    await f.coordinator.resolve(f.created.session.id, approval.id, approval.version, "deny");
    expect((await pending).content).toContain("TOOL_DENIED");
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(f.repository.getToolInvocation(approval.toolInvocationId).state).toBe("denied");
  });

  it("discards real file contents when the folder is revoked during the read", async () => {
    const f = await fixture();
    const approved = f.approve();
    const resolve = f.service.resolveExistingTarget.bind(f.service);
    let checks = 0;
    vi.spyOn(f.service, "resolveExistingTarget").mockImplementation(async (...args) => {
      const target = await resolve(...args);
      if (++checks === 3) f.repository.removeWorkspace(f.workspace.id, f.workspace.version);
      return target;
    });
    await expect(f.executor.execute(approved.invocation.id)).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    expect(checks).toBe(3);
    const invocation = f.repository.getToolInvocation(approved.invocation.id);
    expect(invocation).toMatchObject({ state: "failed", resultDigest: null, resultMetadata: null });
    expect(JSON.stringify(invocation)).not.toContain("SESSION_PRIVATE_CONTENT");
  });

  it.each(["folder", "write-permission"] as const)("does not publish a staged write when %s is revoked", async (revocation) => {
    const f = await fixture({ writeEnabled: true });
    const approved = f.approve({ kind: "workspace-write", workspaceId: f.workspace.id, path: "result.md", content: "STAGED_PRIVATE_OUTPUT" });
    const resolve = f.service.resolveNewTextTarget.bind(f.service);
    let checks = 0;
    vi.spyOn(f.service, "resolveNewTextTarget").mockImplementation(async (...args) => {
      const target = await resolve(...args);
      if (++checks === 2) {
        const temporary = readdirSync(f.root).find((name) => name.startsWith(".aevoren-"));
        expect(temporary).toBeDefined();
        expect(readFileSync(join(f.root, temporary!), "utf8")).toBe("STAGED_PRIVATE_OUTPUT");
        if (revocation === "folder") f.repository.removeWorkspace(f.workspace.id, f.workspace.version);
        else f.repository.updateWorkspacePermissions(f.workspace.id, f.workspace.version, { writeEnabled: false, automationEnabled: false });
      }
      return target;
    });
    await expect(f.executor.execute(approved.invocation.id)).rejects.toMatchObject({
      code: revocation === "folder" ? "WORKSPACE_NOT_FOUND" : "WORKSPACE_WRITE_NOT_ENABLED",
    });
    expect(checks).toBe(2);
    expect(existsSync(join(f.root, "result.md"))).toBe(false);
    expect(readdirSync(f.root)).toEqual(["private.md"]);
    expect(f.repository.getToolInvocation(approved.invocation.id)).toMatchObject({ state: "failed", resultDigest: null, resultMetadata: null });
  });

  it("keeps the original waiter through duplicate requests and approval conflicts", async () => {
    const f = await fixture();
    const pending = f.coordinator.requestAndWait(f.runtime.id, "same-call", f.tool, new AbortController().signal);
    const approval = f.repository.listPendingApprovalRequests(f.created.session.id)[0]!;
    expect(() => f.coordinator.requestAndWait(f.runtime.id, "same-call", f.tool, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: "TOOL_IDEMPOTENCY_CONFLICT" }));
    await expect(f.coordinator.resolve(f.created.session.id, approval.id, approval.version + 1, "allow-once"))
      .rejects.toMatchObject({ code: "APPROVAL_VERSION_CONFLICT" });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resolve = f.service.resolveExistingTarget.bind(f.service);
    let paused = false;
    vi.spyOn(f.service, "resolveExistingTarget").mockImplementation(async (...args) => {
      const target = await resolve(...args);
      if (!paused) { paused = true; await gate; }
      return target;
    });
    const executing = f.coordinator.resolve(f.created.session.id, approval.id, approval.version, "allow-once");
    await vi.waitFor(() => expect(paused).toBe(true));
    const currentApproval = f.repository.getApprovalRequest(approval.id);
    await expect(f.coordinator.resolve(f.created.session.id, approval.id, currentApproval.version, "allow-once"))
      .rejects.toMatchObject({ code: "APPROVAL_ALREADY_RESOLVED" });
    release();
    await executing;
    expect(JSON.parse((await pending).content)).toMatchObject({ text: "SESSION_PRIVATE_CONTENT" });
    expect(f.repository.listToolInvocations(f.created.session.id)).toMatchObject([{ state: "succeeded", attemptCount: 1 }]);
  });

  it("cancels a waiting approval and prevents a later allow from restarting it", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const pending = f.coordinator.requestAndWait(f.runtime.id, "cancel-wait", f.tool, controller.signal);
    const approval = f.repository.listPendingApprovalRequests(f.created.session.id)[0]!;
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    await expect(f.coordinator.resolve(f.created.session.id, approval.id, approval.version, "allow-once"))
      .rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    expect(f.repository.getToolInvocation(approval.toolInvocationId)).toMatchObject({ state: "cancelled", attemptCount: 0, resultDigest: null });
  });
});
