import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AppRepository, MIGRATIONS } from "./database";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];

function repository(filename = ":memory:"): AppRepository {
  const value = new AppRepository(filename);
  repositories.push(value);
  return value;
}

function migrateThrough(filename: string, count: number): void {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  for (const migration of MIGRATIONS.slice(0, count)) {
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

function migrateThroughV7(filename: string): void {
  migrateThrough(filename, 7);
}

function logicalV7Hash(database: DatabaseSync): string {
  const tables = [
    "bots", "sessions", "transcript_entries", "send_journal", "app_settings", "runtime_runs",
    "rooms", "room_members", "room_batches", "room_turns", "agent_handoffs", "handoff_rejections",
  ];
  const snapshot = Object.fromEntries(tables.map((table) => {
    const query = table === "bots"
      ? "SELECT id,name,label,description,instructions,pinned_at,hidden_at,has_unread,deleted_at,version,created_at,updated_at FROM bots ORDER BY rowid"
      : table === "runtime_runs"
        ? "SELECT id,session_id,client_nonce,execution_key,executor_bot_id,attempt_no,state,route,input_generation,input_seq,prompt_cutoff_seq,assistant_entry_id,provider_request_id,prompt_manifest_json,version,last_error_code,created_at,accepted_at,last_activity_at,finished_at FROM runtime_runs ORDER BY rowid"
        : table === "app_settings"
          ? "SELECT * FROM app_settings WHERE key NOT LIKE 'provider.%' ORDER BY rowid"
          : `SELECT * FROM ${table} ORDER BY rowid`;
    return [table, database.prepare(query).all()];
  }));
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("explicit Memory repository", () => {
  it("isolates user, Bot, and explicitly bound Workspace Memory scopes", () => {
    const value = repository();
    const firstCreated = value.createBot();
    const second = value.createBot().bot;
    const workspace = value.registerWorkspaceRoot("/private/tmp/memory-project-a", "Project A").workspace;
    const otherWorkspace = value.registerWorkspaceRoot("/private/tmp/memory-project-b", "Project B").workspace;
    const first = value.updateBot(firstCreated.bot.id, firstCreated.bot.version, { memoryWorkspaceIds: [workspace.id] });

    const userMemory = value.createScopedMemory({ scope: "user", scopeKey: "user" }, "USER_PREFERENCE");
    const projectMemory = value.createScopedMemory({ scope: "workspace", scopeKey: workspace.id }, "PROJECT_A_STATE");
    value.createScopedMemory({ scope: "workspace", scopeKey: otherWorkspace.id }, "PROJECT_B_STATE");
    value.createMemory(first.id, "BOT_A_MEMORY");
    value.createMemory(second.id, "BOT_B_MEMORY");

    expect(value.listRuntimeMemories(first.id).map((memory) => memory.content).toSorted()).toEqual([
      "USER_PREFERENCE", "PROJECT_A_STATE", "BOT_A_MEMORY",
    ].toSorted());
    expect(value.listRuntimeMemories(second.id).map((memory) => memory.content).toSorted()).toEqual([
      "USER_PREFERENCE", "BOT_B_MEMORY",
    ].toSorted());
    expect(userMemory).toMatchObject({ scope: "user", scopeKey: "user", botId: null, workspaceId: null });
    expect(projectMemory).toMatchObject({ scope: "workspace", scopeKey: workspace.id, botId: null, workspaceId: workspace.id });

    const updated = value.updateBot(first.id, first.version, { memoryWorkspaceIds: [] });
    expect(updated.memoryWorkspaceIds).toEqual([]);
    expect(value.listRuntimeMemories(first.id).map((memory) => memory.content).toSorted()).toEqual([
      "USER_PREFERENCE", "BOT_A_MEMORY",
    ].toSorted());
  });

  it("allows identical content in different scopes but rejects duplicates inside one scope", () => {
    const value = repository();
    const bot = value.createBot().bot;
    value.createScopedMemory({ scope: "user", scopeKey: "user" }, "SHARED_VALUE");
    value.createMemory(bot.id, "SHARED_VALUE");
    expect(() => value.createScopedMemory({ scope: "user", scopeKey: "user" }, "SHARED_VALUE"))
      .toThrowError(expect.objectContaining({ code: "MEMORY_DUPLICATE" }));
  });

  it("bounds prompt Memory while preserving representation from each active scope", () => {
    const value = repository();
    const bot = value.createBot().bot;
    for (let index = 0; index < 5; index += 1) {
      value.createScopedMemory({ scope: "user", scopeKey: "user" }, `U${index}-${"u".repeat(3_900)}`);
      value.createMemory(bot.id, `B${index}-${"b".repeat(3_900)}`);
    }
    const runtime = value.listRuntimeMemories(bot.id);
    expect(Buffer.byteLength(runtime.map((item) => item.content).join(""), "utf8")).toBeLessThanOrEqual(24_000);
    expect(runtime.some((item) => item.scope === "user")).toBe(true);
    expect(runtime.some((item) => item.scope === "bot")).toBe(true);
  });

  it("migrates existing manual Memory to typed records without changing its content", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-memory-v22-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    migrateThrough(filename, 21);
    const legacy = new DatabaseSync(filename);
    legacy.prepare(
      `INSERT INTO bots(
        id,name,label,description,instructions,provider_instance_id,model_id,mcp_server_ids_json,memory_workspace_ids_json,
        pinned_at,hidden_at,has_unread,deleted_at,version,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,0,NULL,1,'t','t')`,
    ).run(
      "00000000-0000-4000-8000-000000000501", "Legacy Memory", "", "", "",
      "openai-compatible.default", "legacy-model", "[]", "[]",
    );
    legacy.prepare(
      `INSERT INTO memory_items(
        id,scope,scope_key,bot_id,workspace_id,content,content_digest,source,version,deleted_at,created_at,updated_at
      ) VALUES(?,?,?,?,NULL,?,?, 'manual-user',1,NULL,'t','t')`,
    ).run(
      "00000000-0000-4000-8000-000000000502", "bot", "00000000-0000-4000-8000-000000000501",
      "00000000-0000-4000-8000-000000000501", "保留原有内容", createHash("sha256").update("保留原有内容").digest("hex"),
    );
    legacy.close();

    const migrated = repository(filename);
    expect(migrated.listMemories("00000000-0000-4000-8000-000000000501")).toEqual([
      expect.objectContaining({ content: "保留原有内容", kind: "fact", source: "manual-user", sourceEntryId: null, expiresAt: null }),
    ]);
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
  });

  it("refuses likely credentials before they reach long-term Memory", () => {
    const value = repository();
    const bot = value.createBot().bot;
    expect(() => value.createMemory(bot.id, "API_KEY=sk-example-secret-1234567890"))
      .toThrowError(expect.objectContaining({ code: "MEMORY_SENSITIVE_CONTENT" }));
    expect(value.listMemories(bot.id)).toEqual([]);
  });

  it("migrates v7 to v8 without changing existing logical data and only applies once", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-memory-v8-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    migrateThroughV7(filename);
    const seed = new DatabaseSync(filename);
    seed.prepare(
      `INSERT INTO bots(id,name,label,description,instructions,pinned_at,hidden_at,has_unread,deleted_at,version,created_at,updated_at)
       VALUES('00000000-0000-4000-8000-000000000001','Legacy','','','',NULL,NULL,0,NULL,1,'t','t')`,
    ).run();
    const beforeHash = logicalV7Hash(seed);
    seed.close();

    const first = repository(filename);
    first.close();
    repositories.pop();
    const reopened = repository(filename);
    expect(reopened.listMemories("00000000-0000-4000-8000-000000000001")).toEqual([]);

    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(logicalV7Hash(inspected)).toBe(beforeHash);
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      MIGRATIONS.map((migration) => ({ version: migration.version })),
    );
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(inspected.prepare("PRAGMA table_info(memory_items)").all().map((column) => (
      column as { name: string }
    ).name)).toEqual([
      "id", "scope", "scope_key", "bot_id", "workspace_id", "content", "content_digest", "kind", "source", "source_entry_id", "expires_at", "version", "deleted_at", "created_at", "updated_at",
    ]);
    inspected.close();
  });

  it("rolls back v8 atomically when the target table already exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-memory-v8-rollback-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    migrateThroughV7(filename);
    const blocker = new DatabaseSync(filename);
    blocker.exec("CREATE TABLE memory_items(id TEXT PRIMARY KEY);");
    const beforeHash = logicalV7Hash(blocker);
    blocker.close();

    expect(() => new AppRepository(filename)).toThrow();
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(logicalV7Hash(inspected)).toBe(beforeHash);
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      Array.from({ length: 7 }, (_, index) => ({ version: index + 1 })),
    );
    expect(inspected.prepare("PRAGMA table_info(memory_items)").all().map((column) => (
      column as { name: string }
    ).name)).toEqual(["id"]);
    inspected.close();
  });

  it("creates, persists, updates, deletes and restores one versioned Memory", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-memory-restart-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const first = repository(filename);
    const { bot } = first.createBot();
    const created = first.createMemory(bot.id, "  用户偏好中文输出  ");
    expect(created).toMatchObject({ botId: bot.id, content: "用户偏好中文输出", source: "manual-user", version: 1, deletedAt: null });
    const updated = first.updateMemory(created.id, created.version, "使用简体中文输出");
    expect(updated).toMatchObject({ content: "使用简体中文输出", version: 2 });
    const deleted = first.deleteMemory(updated.id, updated.version);
    expect(deleted).toMatchObject({ version: 3, deletedAt: expect.any(String) });
    expect(first.listMemories(bot.id)).toEqual([]);
    expect(first.listMemories(bot.id, true)).toHaveLength(1);
    const restored = first.restoreMemory(deleted.id, deleted.version);
    expect(restored).toMatchObject({ version: 4, deletedAt: null });
    first.close();
    repositories.pop();

    const reopened = repository(filename);
    expect(reopened.listMemories(bot.id)).toEqual([restored]);
  });

  it("rejects stale versions without overwriting the current Memory", () => {
    const value = repository();
    const { bot } = value.createBot();
    const created = value.createMemory(bot.id, "初始事实");
    const current = value.updateMemory(created.id, created.version, "新事实");

    expect(() => value.updateMemory(created.id, created.version, "迟到的旧事实")).toThrowError(
      expect.objectContaining({ code: "MEMORY_VERSION_CONFLICT", details: { currentVersion: 2 } }),
    );
    expect(value.getMemory(created.id)).toEqual(current);
  });

  it("deduplicates active content per Bot but permits the same content across Bots", () => {
    const value = repository();
    const first = value.createBot().bot;
    const second = value.createBot().bot;
    const firstMemory = value.createMemory(first.id, "  同一个   事实  ");

    expect(() => value.createMemory(first.id, "同一个 事实")).toThrowError(expect.objectContaining({ code: "MEMORY_DUPLICATE" }));
    expect(value.createMemory(second.id, "同一个 事实").botId).toBe(second.id);
    const deleted = value.deleteMemory(firstMemory.id, firstMemory.version);
    const replacement = value.createMemory(first.id, "同一个 事实");
    expect(() => value.restoreMemory(deleted.id, deleted.version)).toThrowError(expect.objectContaining({ code: "MEMORY_DUPLICATE" }));
    expect(value.getMemory(replacement.id).deletedAt).toBeNull();
    expect(value.getMemory(deleted.id).deletedAt).not.toBeNull();
  });

  it("enforces item and aggregate capacity for create, update and restore", () => {
    const value = repository();
    const bot = value.createBot().bot;
    const memories = Array.from({ length: 100 }, (_, index) => value.createMemory(bot.id, `${index}:` + "x".repeat(197)));
    expect(() => value.createMemory(bot.id, "第 101 条")).toThrowError(expect.objectContaining({ code: "MEMORY_LIMIT_EXCEEDED" }));

    const deleted = value.deleteMemory(memories[0]!.id, memories[0]!.version);
    const fill = value.createMemory(bot.id, "y".repeat(199));
    expect(() => value.restoreMemory(deleted.id, deleted.version)).toThrowError(expect.objectContaining({ code: "MEMORY_LIMIT_EXCEEDED" }));
    expect(() => value.updateMemory(fill.id, fill.version, "z".repeat(4000))).toThrowError(expect.objectContaining({ code: "MEMORY_LIMIT_EXCEEDED" }));
    expect(value.getMemory(fill.id).content).toBe("y".repeat(199));
  });

  it("isolates Memories, cascades Bot deletion and does not copy them with a Bot", () => {
    const value = repository();
    const first = value.createBot();
    const second = value.createBot();
    const firstMemory = value.createMemory(first.bot.id, "只属于 A");
    value.createMemory(second.bot.id, "只属于 B");
    const duplicate = value.duplicateBot(first.bot.id);
    expect(value.listMemories(duplicate.bot.id)).toEqual([]);
    expect(value.listMemories(first.bot.id).map((item) => item.content)).toEqual(["只属于 A"]);
    expect(value.listMemories(second.bot.id).map((item) => item.content)).toEqual(["只属于 B"]);

    value.deleteBot(first.bot.id);
    expect(() => value.getMemory(firstMemory.id)).toThrowError(expect.objectContaining({ code: "MEMORY_NOT_FOUND" }));
    expect(value.listMemories(second.bot.id)).toHaveLength(1);
  });
});
