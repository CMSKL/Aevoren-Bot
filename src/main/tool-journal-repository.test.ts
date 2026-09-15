import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptManifest, ToolInvocationCommand } from "@shared/contracts";
import { AppRepository, MIGRATIONS } from "./database";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];

function repository(filename = ":memory:"): AppRepository {
  const value = new AppRepository(filename);
  repositories.push(value);
  return value;
}

function migrateThroughV8(filename: string): void {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  for (const migration of MIGRATIONS.slice(0, 8)) {
    const foreignKeysOff = "foreignKeysOff" in migration && migration.foreignKeysOff;
    if (foreignKeysOff) database.exec("PRAGMA foreign_keys = OFF;");
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations VALUES(?, 't')").run(migration.version);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    } finally {
      if (foreignKeysOff) database.exec("PRAGMA foreign_keys = ON;");
    }
  }
  database.close();
}

function logicalV8Hash(database: DatabaseSync): string {
  const tables = [
    "bots",
    "sessions",
    "transcript_entries",
    "send_journal",
    "app_settings",
    "runtime_runs",
    "rooms",
    "room_members",
    "room_batches",
    "room_turns",
    "agent_handoffs",
    "handoff_rejections",
    "memory_items",
  ];
  const snapshot = Object.fromEntries(
    tables.map((table) => [table, database.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()]),
  );
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function createRunningRuntime(value: AppRepository) {
  const created = value.createBot();
  const clientNonce = crypto.randomUUID();
  value.prepareMessage({ sessionId: created.session.id, clientNonce, text: "需要读取项目资料" });
  const manifest: PromptManifest = {
    schemaVersion: 1,
    botId: created.bot.id,
    profileVersion: created.bot.version,
    sessionId: created.session.id,
    generation: created.session.generation,
    inputSeq: 1,
    blocks: [],
    digest: "tool-journal-test",
  };
  const runtime = value.createRuntimeRun(clientNonce, "fake", manifest);
  value.transitionRuntimeRun(runtime.id, "dispatching");
  return {
    bot: created.bot,
    session: created.session,
    runtime: value.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "tool-provider" }),
  };
}

function command(
  runtimeRunId: string,
  overrides: Partial<ToolInvocationCommand> = {},
): ToolInvocationCommand {
  return {
    runtimeRunId,
    toolCallId: "tool-call-1",
    idempotencyKey: crypto.randomUUID(),
    tool: {
      kind: "workspace-read",
      workspaceId: crypto.randomUUID(),
      path: "docs/spec.md",
      maxBytes: 4096,
    },
    ...overrides,
  };
}

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("Approval and Tool Journal repository", () => {
  it("migrates v8 to v9 without changing existing data and applies once", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-tool-v9-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    migrateThroughV8(filename);
    const seed = new DatabaseSync(filename);
    const beforeHash = logicalV8Hash(seed);
    seed.close();

    const first = repository(filename);
    first.close();
    repositories.pop();
    repository(filename);

    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(logicalV8Hash(inspected)).toBe(beforeHash);
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      Array.from({ length: 9 }, (_, index) => ({ version: index + 1 })),
    );
    expect(inspected.prepare("PRAGMA table_info(tool_invocations)").all()).not.toEqual([]);
    expect(inspected.prepare("PRAGMA table_info(approval_requests)").all()).not.toEqual([]);
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
  });

  it("rolls back the complete v9 migration when a target table conflicts", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-tool-v9-rollback-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    migrateThroughV8(filename);
    const blocker = new DatabaseSync(filename);
    blocker.exec("CREATE TABLE tool_invocations(id TEXT PRIMARY KEY);");
    const beforeHash = logicalV8Hash(blocker);
    blocker.close();

    expect(() => new AppRepository(filename)).toThrow();
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(logicalV8Hash(inspected)).toBe(beforeHash);
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      Array.from({ length: 8 }, (_, index) => ({ version: index + 1 })),
    );
    expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approval_requests'").get()).toBeUndefined();
    expect(inspected.prepare("PRAGMA table_info(tool_invocations)").all()).toHaveLength(1);
    inspected.close();
  });

  it("creates one invocation and one bound approval atomically and deduplicates retries", () => {
    const value = repository();
    const fixture = createRunningRuntime(value);
    const input = command(fixture.runtime.id);
    const first = value.prepareToolInvocation(input);
    const duplicate = value.prepareToolInvocation(input);

    expect(first.disposition).toBe("prepared");
    expect(duplicate).toEqual({ ...first, disposition: "duplicate" });
    expect(first.invocation).toMatchObject({
      runtimeRunId: fixture.runtime.id,
      sessionId: fixture.session.id,
      executorBotId: fixture.bot.id,
      toolCallId: input.toolCallId,
      idempotencyKey: input.idempotencyKey,
      toolKind: "workspace-read",
      targetPath: "docs/spec.md",
      state: "awaiting-approval",
      attemptCount: 0,
      version: 1,
    });
    expect(first.approval).toMatchObject({
      id: first.invocation.approvalRequestId,
      toolInvocationId: first.invocation.id,
      runtimeRunId: fixture.runtime.id,
      sessionId: fixture.session.id,
      executorBotId: fixture.bot.id,
      actionKind: "workspace-read",
      workspaceId: input.tool.workspaceId,
      targetPath: "docs/spec.md",
      requestedScope: "once",
      state: "pending",
      policyVersion: 1,
      version: 1,
    });
    expect(first.approval.targetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.approval.argumentsDigest).toBe(first.invocation.commandDigest);
    expect(() =>
      value.prepareToolInvocation({
        ...input,
        tool: { ...input.tool, path: "docs/other.md" },
      }),
    ).toThrowError(expect.objectContaining({ code: "TOOL_IDEMPOTENCY_CONFLICT" }));
    expect(value.listToolInvocations(fixture.session.id)).toHaveLength(1);
  });

  it("rolls back the invocation when approval insertion fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-tool-atomic-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const value = repository(filename);
    const fixture = createRunningRuntime(value);
    const injector = new DatabaseSync(filename);
    injector.exec(
      "CREATE TRIGGER reject_approval_insert BEFORE INSERT ON approval_requests BEGIN SELECT RAISE(ABORT, 'reject approval'); END;",
    );
    injector.close();

    expect(() => value.prepareToolInvocation(command(fixture.runtime.id))).toThrow();
    expect(value.listToolInvocations(fixture.session.id)).toEqual([]);
  });

  it("settles allow-once and deny exactly once with CAS", () => {
    const value = repository();
    const allowedFixture = createRunningRuntime(value);
    const allowed = value.prepareToolInvocation(command(allowedFixture.runtime.id));
    const allowedResult = value.resolveToolApproval(allowed.approval.id, 1, "allow-once");
    expect(allowedResult.approval).toMatchObject({ state: "allowed", resolution: "allow-once", version: 2 });
    expect(allowedResult.invocation).toMatchObject({ state: "approved", version: 2 });
    expect(() => value.resolveToolApproval(allowed.approval.id, 1, "deny")).toThrowError(
      expect.objectContaining({ code: "APPROVAL_VERSION_CONFLICT", details: { currentVersion: 2 } }),
    );
    expect(() => value.resolveToolApproval(allowed.approval.id, 2, "deny")).toThrowError(
      expect.objectContaining({ code: "APPROVAL_ALREADY_RESOLVED" }),
    );

    value.transitionRuntimeRun(allowedFixture.runtime.id, "completed");
    const deniedFixture = createRunningRuntime(value);
    const denied = value.prepareToolInvocation(command(deniedFixture.runtime.id));
    const deniedResult = value.resolveToolApproval(denied.approval.id, 1, "deny");
    expect(deniedResult.approval).toMatchObject({ state: "denied", resolution: "deny", version: 2 });
    expect(deniedResult.invocation).toMatchObject({ state: "denied", version: 2 });
    expect(() => value.transitionToolInvocation(denied.invocation.id, "dispatching")).toThrowError(
      expect.objectContaining({ code: "TOOL_STATE_INVALID" }),
    );
  });

  it("expires pending approvals and expires approved-but-undispatched calls during recovery", () => {
    const value = repository();
    const expiredFixture = createRunningRuntime(value);
    const expired = value.prepareToolInvocation(
      command(expiredFixture.runtime.id),
      "2000-01-01T00:00:00.000Z",
    );
    expect(() => value.resolveToolApproval(expired.approval.id, 1, "allow-once")).toThrowError(
      expect.objectContaining({ code: "APPROVAL_EXPIRED" }),
    );
    expect(value.getApprovalRequest(expired.approval.id)).toMatchObject({ state: "expired", version: 2 });
    expect(value.getToolInvocation(expired.invocation.id)).toMatchObject({ state: "expired", version: 2 });

    value.transitionRuntimeRun(expiredFixture.runtime.id, "completed");
    const approvedFixture = createRunningRuntime(value);
    const approved = value.prepareToolInvocation(command(approvedFixture.runtime.id));
    value.resolveToolApproval(approved.approval.id, 1, "allow-once");
    expect(value.recoverToolInvocations()).toMatchObject({ expired: 1, interrupted: 0 });
    expect(value.getToolInvocation(approved.invocation.id)).toMatchObject({ state: "expired", version: 3 });
  });

  it("guards dispatch and recovers dispatching or running calls as unknown without replay", () => {
    const value = repository();
    const fixture = createRunningRuntime(value);
    const first = value.prepareToolInvocation(command(fixture.runtime.id));
    expect(() => value.transitionToolInvocation(first.invocation.id, "dispatching")).toThrowError(
      expect.objectContaining({ code: "TOOL_STATE_INVALID" }),
    );
    value.resolveToolApproval(first.approval.id, 1, "allow-once");
    value.transitionToolInvocation(first.invocation.id, "dispatching");
    value.transitionToolInvocation(first.invocation.id, "running");

    value.transitionRuntimeRun(fixture.runtime.id, "completed");
    const secondFixture = createRunningRuntime(value);
    const second = value.prepareToolInvocation(command(secondFixture.runtime.id, { toolCallId: "tool-call-2" }));
    value.resolveToolApproval(second.approval.id, 1, "allow-once");
    value.transitionToolInvocation(second.invocation.id, "dispatching");

    expect(value.recoverToolInvocations()).toEqual({ expired: 0, interrupted: 2 });
    expect(value.getToolInvocation(first.invocation.id)).toMatchObject({ state: "interrupted-unknown", attemptCount: 1 });
    expect(value.getToolInvocation(second.invocation.id)).toMatchObject({ state: "interrupted-unknown", attemptCount: 1 });
    expect(value.listToolInvocations(fixture.session.id)).toHaveLength(1);
    expect(value.listToolInvocations(secondFixture.session.id)).toHaveLength(1);
  });
});
