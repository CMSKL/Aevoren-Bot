import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { AevorenBotApi, PromptManifest } from "@shared/contracts";
import { AppRepository } from "../../src/main/database";

function createRunningRuntime(repository: AppRepository, name: string) {
  const created = repository.createBot();
  const bot = repository.updateBot(created.bot.id, created.bot.version, { name });
  const clientNonce = crypto.randomUUID();
  repository.prepareMessage({ sessionId: created.session.id, clientNonce, text: "审批安全测试" });
  const manifest: PromptManifest = {
    schemaVersion: 1,
    botId: bot.id,
    profileVersion: bot.version,
    sessionId: created.session.id,
    generation: created.session.generation,
    inputSeq: 1,
    blocks: [],
    digest: "tool-ipc-smoke",
  };
  const createdRuntime = repository.createRuntimeRun(clientNonce, "fake", manifest);
  repository.transitionRuntimeRun(createdRuntime.id, "dispatching");
  const runtime = repository.transitionRuntimeRun(createdRuntime.id, "running", {
    providerRequestId: "tool-ipc",
  });
  return { bot, session: created.session, runtime };
}

test("scopes Approval IPC to one Session and never dispatches an approved foundation call", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-tool-ipc-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  const first = createRunningRuntime(repository, "审批 Bot A");
  const second = createRunningRuntime(repository, "审批 Bot B");
  const prepared = repository.prepareToolInvocation({
    runtimeRunId: first.runtime.id,
    toolCallId: "ipc-tool-call",
    idempotencyKey: crypto.randomUUID(),
    tool: {
      kind: "workspace-list",
      workspaceId: crypto.randomUUID(),
      path: "docs",
      maxEntries: 20,
    },
  });
  repository.close();

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      env: {
        ...process.env,
        AEVOREN_BOT_USER_DATA_DIR: userDataDir,
        AEVOREN_BOT_FAKE_PROVIDER: "1",
      },
    });
    const page = await application.firstWindow();
    const snapshot = await page.evaluate(
      async ({ firstSessionId, secondSessionId, approvalId }) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        const firstTools = await api.tools.list({ sessionId: firstSessionId });
        const secondTools = await api.tools.list({ sessionId: secondSessionId });
        const firstApprovals = await api.approvals.listPending({ sessionId: firstSessionId });
        const crossSession = await api.approvals.resolve({
          sessionId: secondSessionId,
          id: approvalId,
          expectedVersion: 1,
          resolution: "allow-once",
        });
        const pendingAfterRejection = await api.approvals.listPending({ sessionId: firstSessionId });
        const allowed = await api.approvals.resolve({
          sessionId: firstSessionId,
          id: approvalId,
          expectedVersion: 1,
          resolution: "allow-once",
        });
        const stale = await api.approvals.resolve({
          sessionId: firstSessionId,
          id: approvalId,
          expectedVersion: 1,
          resolution: "deny",
        });
        return { firstTools, secondTools, firstApprovals, crossSession, pendingAfterRejection, allowed, stale };
      },
      {
        firstSessionId: first.session.id,
        secondSessionId: second.session.id,
        approvalId: prepared.approval.id,
      },
    );

    expect(snapshot.firstTools).toMatchObject({
      ok: true,
      data: [{ id: prepared.invocation.id, sessionId: first.session.id, state: "awaiting-approval" }],
    });
    expect(snapshot.secondTools).toEqual({ ok: true, data: [] });
    expect(snapshot.firstApprovals).toMatchObject({
      ok: true,
      data: [{ id: prepared.approval.id, sessionId: first.session.id, state: "pending" }],
    });
    expect(snapshot.crossSession).toMatchObject({
      ok: false,
      error: { code: "APPROVAL_SCOPE_INVALID", domain: "approval" },
    });
    expect(snapshot.pendingAfterRejection).toMatchObject({
      ok: true,
      data: [{ id: prepared.approval.id, state: "pending", version: 1 }],
    });
    expect(snapshot.allowed).toMatchObject({
      ok: true,
      data: {
        invocation: { state: "approved", attemptCount: 0 },
        approval: { state: "allowed", resolution: "allow-once", version: 2 },
      },
    });
    expect(snapshot.stale).toMatchObject({
      ok: false,
      error: { code: "APPROVAL_VERSION_CONFLICT", details: { currentVersion: 2 } },
    });
    await application.close();
    application = undefined;

    application = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      env: {
        ...process.env,
        AEVOREN_BOT_USER_DATA_DIR: userDataDir,
        AEVOREN_BOT_FAKE_PROVIDER: "1",
      },
    });
    await application.firstWindow();
    await application.close();
    application = undefined;

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      database.prepare("SELECT state,attempt_count,result_digest FROM tool_invocations WHERE id = ?").get(prepared.invocation.id),
    ).toEqual({ state: "expired", attempt_count: 0, result_digest: null });
    expect(
      database.prepare("SELECT state,resolution FROM approval_requests WHERE id = ?").get(prepared.approval.id),
    ).toEqual({ state: "expired", resolution: "allow-once" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM tool_invocations").get()).toEqual({ count: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
