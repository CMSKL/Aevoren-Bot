import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AppRepository, MIGRATIONS } from "./database";
import { WorkspaceService } from "./workspace-service";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];

function repository(filename = ":memory:"): AppRepository {
  const value = new AppRepository(filename);
  repositories.push(value);
  return value;
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function migrateThroughV9(filename: string): void {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  for (const migration of MIGRATIONS.slice(0, 9)) {
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

function logicalV9Hash(database: DatabaseSync): string {
  const tables = [
    "bots", "sessions", "transcript_entries", "send_journal", "app_settings", "runtime_runs",
    "rooms", "room_members", "room_batches", "room_turns", "agent_handoffs", "handoff_rejections",
    "memory_items", "tool_invocations", "approval_requests",
  ];
  const snapshot = Object.fromEntries(tables.map((table) => [
    table,
    database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("Workspace Registry", () => {
  it("migrates v9 to v10 atomically without changing existing logical data", () => {
    const directory = temporaryDirectory("aevoren-workspace-v10-");
    const filename = join(directory, "app.sqlite");
    migrateThroughV9(filename);
    const before = new DatabaseSync(filename);
    const beforeHash = logicalV9Hash(before);
    before.close();

    const first = repository(filename);
    first.close();
    repositories.pop();
    repository(filename);

    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(logicalV9Hash(inspected)).toBe(beforeHash);
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      Array.from({ length: 10 }, (_, index) => ({ version: index + 1 })),
    );
    expect(inspected.prepare("PRAGMA table_info(workspaces)").all()).not.toEqual([]);
    inspected.close();
  });

  it("rolls back the complete v10 migration when the target table conflicts", () => {
    const directory = temporaryDirectory("aevoren-workspace-v10-rollback-");
    const filename = join(directory, "app.sqlite");
    migrateThroughV9(filename);
    const blocker = new DatabaseSync(filename);
    blocker.exec("CREATE TABLE workspaces(id TEXT PRIMARY KEY);");
    const beforeHash = logicalV9Hash(blocker);
    blocker.close();

    expect(() => new AppRepository(filename)).toThrow();
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(logicalV9Hash(inspected)).toBe(beforeHash);
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      Array.from({ length: 9 }, (_, index) => ({ version: index + 1 })),
    );
    expect(inspected.prepare("PRAGMA table_info(workspaces)").all()).toHaveLength(1);
    inspected.close();
  });

  it("registers one canonical directory, hides its path and deduplicates a symlink alias", async () => {
    const root = temporaryDirectory("aevoren-workspace-root-");
    const aliasParent = temporaryDirectory("aevoren-workspace-alias-");
    const alias = join(aliasParent, "project-link");
    symlinkSync(root, alias);
    const value = repository();
    const service = new WorkspaceService(value);

    const first = await service.registerRoot(root);
    const duplicate = await service.registerRoot(alias);

    expect(first.disposition).toBe("registered");
    expect(duplicate).toMatchObject({ disposition: "duplicate", workspace: { id: first.workspace.id } });
    expect(value.listWorkspaces()).toEqual([first.workspace]);
    expect(first.workspace).toEqual(expect.objectContaining({ name: expect.any(String), version: 1 }));
    expect(first.workspace).not.toHaveProperty("rootPath");
    expect(JSON.stringify(first.workspace)).not.toContain(root);
  });

  it("rejects missing roots, files and the filesystem root", async () => {
    const directory = temporaryDirectory("aevoren-workspace-invalid-");
    const file = join(directory, "file.txt");
    writeFileSync(file, "not a directory");
    const service = new WorkspaceService(repository());

    await expect(service.registerRoot(join(directory, "missing"))).rejects.toMatchObject({ code: "WORKSPACE_INVALID_ROOT" });
    await expect(service.registerRoot(file)).rejects.toMatchObject({ code: "WORKSPACE_INVALID_ROOT" });
    await expect(service.registerRoot("/")).rejects.toMatchObject({ code: "WORKSPACE_SCOPE_TOO_BROAD" });
  });

  it("removes access with expectedVersion and restores the same canonical root deliberately", async () => {
    const root = temporaryDirectory("aevoren-workspace-remove-");
    const value = repository();
    const service = new WorkspaceService(value);
    const registered = await service.registerRoot(root);

    const removed = value.removeWorkspace(registered.workspace.id, registered.workspace.version);
    expect(removed).toMatchObject({ id: registered.workspace.id, version: 2, removedAt: expect.any(String) });
    expect(value.listWorkspaces()).toEqual([]);
    expect(() => value.removeWorkspace(registered.workspace.id, registered.workspace.version)).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_VERSION_CONFLICT" }),
    );

    const restored = await service.registerRoot(root);
    expect(restored).toMatchObject({ disposition: "restored", workspace: { id: registered.workspace.id, version: 3, removedAt: null } });
  });

  it("resolves only existing targets whose canonical path remains inside the registered root", async () => {
    const root = temporaryDirectory("aevoren-workspace-containment-");
    const outside = temporaryDirectory("aevoren-workspace-outside-");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "spec.md"), "safe");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "docs", "outside-link"));
    const service = new WorkspaceService(repository());
    const { workspace } = await service.registerRoot(root);

    await expect(service.resolveExistingTarget(workspace.id, "docs/spec.md", "file")).resolves.toMatchObject({
      workspaceId: workspace.id,
      relativePath: "docs/spec.md",
      canonicalPath: realpathSync(join(root, "docs", "spec.md")),
    });
    await expect(service.resolveExistingTarget(workspace.id, "docs", "directory")).resolves.toMatchObject({
      workspaceId: workspace.id,
      relativePath: "docs",
    });
    await expect(service.resolveExistingTarget(workspace.id, "docs/outside-link", "file")).rejects.toMatchObject({
      code: "WORKSPACE_PATH_OUTSIDE_ROOT",
    });
    await expect(service.resolveExistingTarget(workspace.id, "docs/missing.md", "file")).rejects.toMatchObject({
      code: "WORKSPACE_TARGET_NOT_FOUND",
    });
    await expect(service.resolveExistingTarget(workspace.id, "docs/spec.md", "directory")).rejects.toMatchObject({
      code: "WORKSPACE_TARGET_TYPE_INVALID",
    });
  });
});
