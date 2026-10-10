import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { AppRepository, MIGRATIONS } from "./database";

// Opt-in: SQLite's online backup reads the running installation without touching
// its profile. Only the isolated copy is migrated; private row contents never log.
it.skipIf(!process.env.AEVOREN_REAL_MIGRATION_DB)("preserves real installed data through the conversation migration and reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-real-conversation-migration-"));
  const copy = join(directory, "snapshot.sqlite");
  let source: DatabaseSync | undefined;
  let db: DatabaseSync | undefined;
  let repository: AppRepository | undefined;
  try {
    source = new DatabaseSync(process.env.AEVOREN_REAL_MIGRATION_DB!, { readOnly: true });
    await backup(source, copy);
    source.close(); source = undefined;
    db = new DatabaseSync(copy, { readOnly: true });
    const originalVersion = Number((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name").all() as Array<{ name: string }>);
    const fingerprints = tables.map(({ name }) => {
      const columns = (db!.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map(row => row.name);
      return { name, columns, fingerprint: fingerprint(db!, name, columns) };
    });
    const sessionCount = Number((db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count);
    const messageCount = Number((db.prepare("SELECT COUNT(*) AS count FROM transcript_entries").get() as { count: number }).count);
    db.close(); db = undefined;
    repository = new AppRepository(copy);
    expect(repository.listConversations()).toHaveLength(sessionCount);
    repository.close(); repository = undefined;
    db = new DatabaseSync(copy, { readOnly: true });
    for (const table of fingerprints) expect(fingerprint(db, table.name, table.columns), `preserve ${table.name}`).toEqual(table.fingerprint);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close(); db = undefined;
    const listBackups = (): string[] => existsSync(join(directory, "Backups")) ? readdirSync(join(directory, "Backups")).filter(name => name.endsWith(".sqlite")) : [];
    const backups = listBackups();
    expect(backups).toHaveLength(originalVersion < MIGRATIONS.at(-1)!.version ? 1 : 0);
    repository = new AppRepository(copy);
    expect(repository.listConversations()).toHaveLength(sessionCount);
    repository.close(); repository = undefined;
    expect(listBackups()).toEqual(backups);
    console.info(JSON.stringify({ realMigration: true, originalVersion, targetVersion: MIGRATIONS.at(-1)!.version, preservedTables: fingerprints.length, sessions: sessionCount, messages: messageCount, integrity: "ok" }));
  } finally {
    repository?.close(); db?.close(); source?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

function quote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function fingerprint(db: DatabaseSync, table: string, columns: string[]): string {
  const rows = db.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)}`).all();
  const digests = rows.map(row => createHash("sha256").update(JSON.stringify(row)).digest("hex")).sort();
  return createHash("sha256").update(digests.join("\n")).digest("hex");
}
