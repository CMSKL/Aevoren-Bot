import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AppRepository, MIGRATIONS } from "./database";

const SCRIPT = join(process.cwd(), "scripts/room-diagnostics.ts");
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const BOT_A = "44444444-4444-4444-8444-444444444444";
const BOT_B = "55555555-5555-4555-8555-555555555555";
const SECRET_MARKERS = [
  "SECRET_TRANSCRIPT_BODY",
  "SECRET_BOT_PROFILE",
  "SECRET_HANDOFF_TASK",
  "SECRET_CONTEXT_REF",
  "SECRET_API_KEY",
  "SECRET_PROVIDER_REQUEST_ID",
  "SECRET_PROVIDER_RESPONSE",
  "SECRET_ROUTING_REASON",
];
const directories: string[] = [];

function sha256(filename: string): string {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function createV6Fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-room-diagnostics-"));
  directories.push(directory);
  const filename = join(directory, "app.sqlite");
  const repository = new AppRepository(filename);
  repository.close();
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON;");
  const timestamp = "2026-01-01T00:00:00.000Z";
  database.exec(`
    INSERT INTO bots(id, name, label, description, instructions, version, created_at, updated_at) VALUES
      ('${BOT_A}', 'SECRET_BOT_PROFILE', 'SECRET_BOT_PROFILE', 'SECRET_BOT_PROFILE', 'SECRET_BOT_PROFILE', 1, '${timestamp}', '${timestamp}'),
      ('${BOT_B}', 'Agent B', '', '', '', 1, '${timestamp}', '${timestamp}');
    INSERT INTO rooms VALUES('${ROOM_ID}', 'Room', '', 1, 1, NULL, '${timestamp}', '${timestamp}');
    INSERT INTO room_members VALUES('${ROOM_ID}', '${BOT_A}', 0, '${timestamp}');
    INSERT INTO room_members VALUES('${ROOM_ID}', '${BOT_B}', 1, '${timestamp}');
    INSERT INTO sessions VALUES('${SESSION_ID}', NULL, '${ROOM_ID}', 'MAIN', 1, 1, '${timestamp}', '${timestamp}');
    INSERT INTO send_journal VALUES('nonce', '${SESSION_ID}', 'digest', 'acked', 0, NULL, NULL, '${timestamp}', '${timestamp}');
    INSERT INTO transcript_entries VALUES(
      'entry', '${SESSION_ID}', 1, 1, 'nonce', 'user', 'SECRET_TRANSCRIPT_BODY', 'completed', 1,
      NULL, NULL, NULL, '${timestamp}', '${timestamp}'
    );
    INSERT INTO room_batches VALUES(
      '${RUN_ID}', '${ROOM_ID}', '${SESSION_ID}', 'nonce', 'entry', 'targets', 'automatic',
      'SECRET_ROUTING_REASON', 'completed', 1, 8, 3, 2, '2026-01-02T00:00:00.000Z', 0, 1,
      '${timestamp}', '${timestamp}', '2026-01-01T00:00:06.000Z'
    );
    INSERT INTO runtime_runs VALUES(
      'runtime-a', '${SESSION_ID}', 'nonce', '${RUN_ID}:turn-a', '${BOT_A}', 1, 'completed', 'openai-compatible',
      1, 1, 1, NULL, 'SECRET_PROVIDER_REQUEST_ID', '{"private":"SECRET_PROVIDER_RESPONSE"}', 1, NULL,
      '${timestamp}', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'
    );
    INSERT INTO runtime_runs VALUES(
      'runtime-b', '${SESSION_ID}', 'nonce', '${RUN_ID}:turn-b', '${BOT_B}', 1, 'failed', 'openai-compatible',
      1, 1, 1, NULL, 'SECRET_PROVIDER_REQUEST_ID', '{"private":"SECRET_PROVIDER_RESPONSE"}', 1, 'PROVIDER_ERROR',
      '${timestamp}', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:05.000Z'
    );
    INSERT INTO room_turns VALUES(
      'turn-a', '${RUN_ID}', '${BOT_A}', 'SECRET_BOT_PROFILE', 'turn-a', NULL, 'turn-a-nonce',
      0, 'initial', 1, 1, 0, 1, 1, 'completed', '{"kind":"sent"}', 'runtime-a', 1, NULL,
      '${timestamp}', '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'
    );
    INSERT INTO room_turns VALUES(
      'turn-b', '${RUN_ID}', '${BOT_B}', 'Agent B', 'turn-b', 'turn-a', 'turn-b-nonce',
      1, 'handoff', 1, 1, 1, 1, 1, 'failed', '{"kind":"error"}', 'runtime-b', 1, 'PROVIDER_ERROR',
      '${timestamp}', '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:05.000Z'
    );
    INSERT INTO agent_handoffs VALUES(
      'handoff', '${RUN_ID}', 'turn-a', 'turn-a', '${BOT_B}', 'turn-b', 'SECRET_HANDOFF_TASK',
      '["SECRET_CONTEXT_REF"]', 'handoff-digest', 'room', 'accepted', 1,
      '${timestamp}', '${timestamp}', '${timestamp}'
    );
    INSERT INTO handoff_rejections VALUES(
      'rejection', '${RUN_ID}', 'turn-a', '${BOT_B}', '${"a".repeat(64)}', 'HANDOFF_CYCLE', '${timestamp}'
    );
    INSERT INTO app_settings VALUES('model.apiKey', 'SECRET_API_KEY', 1, '${timestamp}');
  `);
  database.close();
  return filename;
}

function run(filename: string, runId = RUN_ID) {
  return spawnSync(process.execPath, [SCRIPT, "--db", filename, "--run", runId], {
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("room diagnostics CLI", () => {
  it("returns only aggregate allowlisted diagnostics without changing the database", () => {
    const filename = createV6Fixture();
    const before = sha256(filename);
    const result = run(filename);
    const after = sha256(filename);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(after).toBe(before);
    for (const marker of SECRET_MARKERS) expect(result.stdout).not.toContain(marker);
    expect(result.stdout).not.toContain("providerRequestId");
    expect(result.stdout).not.toContain("contextRefs");
    expect(result.stdout).not.toContain("instructions");

    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 8,
      runId: RUN_ID,
      roomId: ROOM_ID,
      sessionId: SESSION_ID,
      state: "completed",
      routingMode: "automatic",
      routingReason: { present: true, length: "SECRET_ROUTING_REASON".length },
      initialOwnerIds: [BOT_A],
      budget: {
        turns: { max: 8, used: 2 },
        hops: { max: 3, used: 1 },
        maxTargetsPerTurn: 2,
      },
      stateCounts: {
        turns: { queued: 0, running: 0, completed: 1, failed: 1, cancelled: 0, interrupted: 0 },
        runtimes: {
          created: 0,
          dispatching: 0,
          running: 0,
          streaming: 0,
          "cancel-requested": 0,
          completed: 1,
          failed: 1,
          cancelled: 0,
          interrupted: 0,
        },
        handoffs: { queued: 0, dispatching: 0, accepted: 1, failed: 0, cancelled: 0 },
      },
      rejectionErrorCodeCounts: { HANDOFF_CYCLE: 1 },
      providerTimingMs: { count: 2, min: 2000, max: 4000, avg: 3000 },
    });
  });

  it("fails safely for invalid arguments, missing runs, unavailable files, and old schemas", () => {
    const filename = createV6Fixture();
    const invalidRun = run(filename, "not-a-uuid");
    expect(invalidRun.status).not.toBe(0);
    expect(JSON.parse(invalidRun.stderr).error.code).toBe("INVALID_ARGUMENTS");

    const missingRun = run(filename, "99999999-9999-4999-8999-999999999999");
    expect(missingRun.status).not.toBe(0);
    expect(JSON.parse(missingRun.stderr).error.code).toBe("RUN_NOT_FOUND");

    const unavailablePath = join(tmpdir(), "SECRET_MISSING_DATABASE.sqlite");
    const unavailable = run(unavailablePath);
    expect(unavailable.status).not.toBe(0);
    expect(JSON.parse(unavailable.stderr).error.code).toBe("DATABASE_UNAVAILABLE");
    expect(unavailable.stderr).not.toContain(unavailablePath);

    const oldDirectory = mkdtempSync(join(tmpdir(), "aevoren-bot-room-diagnostics-old-"));
    directories.push(oldDirectory);
    const oldFilename = join(oldDirectory, "old.sqlite");
    const oldDatabase = new DatabaseSync(oldFilename);
    oldDatabase.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    for (const migration of MIGRATIONS.slice(0, 5)) {
      if ("foreignKeysOff" in migration && migration.foreignKeysOff) oldDatabase.exec("PRAGMA foreign_keys = OFF;");
      oldDatabase.exec(migration.sql);
      oldDatabase.prepare("INSERT INTO schema_migrations VALUES(?, 't')").run(migration.version);
      oldDatabase.exec("PRAGMA foreign_keys = ON;");
    }
    oldDatabase.close();
    const oldSchema = run(oldFilename);
    expect(oldSchema.status).not.toBe(0);
    expect(JSON.parse(oldSchema.stderr).error.code).toBe("UNSUPPORTED_SCHEMA");
    expect(oldSchema.stderr).not.toContain(oldFilename);

    const incompleteDirectory = mkdtempSync(join(tmpdir(), "aevoren-bot-room-diagnostics-incomplete-"));
    directories.push(incompleteDirectory);
    const incompleteFilename = join(incompleteDirectory, "incomplete.sqlite");
    const incomplete = new DatabaseSync(incompleteFilename);
    incomplete.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(1, 't'), (2, 't'), (3, 't'), (4, 't'), (5, 't'), (6, 't');
      CREATE TABLE room_batches(
        id, room_id, session_id, state, routing_mode, routing_reason,
        max_turns, max_hops, max_targets_per_turn
      );
      CREATE TABLE room_turns(batch_id, member_bot_id, logical_turn_id, hop, origin, state);
      CREATE TABLE runtime_runs(execution_key, state, route, accepted_at, finished_at);
      CREATE TABLE agent_handoffs(run_id, state);
      CREATE TABLE handoff_rejections(run_id, error_code);
    `);
    incomplete.close();
    const incompleteSchema = run(incompleteFilename);
    expect(incompleteSchema.status).not.toBe(0);
    expect(JSON.parse(incompleteSchema.stderr).error.code).toBe("UNSUPPORTED_SCHEMA");
  });

  it("is exposed through the package command", () => {
    const filename = createV6Fixture();
    const stdout = execFileSync("pnpm", ["--silent", "diagnostics:room", "--", "--db", filename, "--run", RUN_ID], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(JSON.parse(stdout).runId).toBe(RUN_ID);
    for (const marker of SECRET_MARKERS) expect(stdout).not.toContain(marker);
  });
});
