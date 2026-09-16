import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptManifest } from "@shared/contracts";
import { AppRepository, MIGRATIONS } from "./database";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];

function logicalV2Hash(database: DatabaseSync): string {
  const snapshot = {
    bots: database.prepare("SELECT id,name,label,description,instructions,version,created_at,updated_at FROM bots ORDER BY id").all(),
    sessions: database.prepare("SELECT id,bot_id,kind,generation,transcript_cursor,created_at,updated_at FROM sessions ORDER BY id").all(),
    transcript: database.prepare("SELECT id,session_id,generation,seq,client_nonce,role,body,status,updated_seq,created_at,updated_at FROM transcript_entries ORDER BY id").all(),
    journal: database.prepare("SELECT client_nonce,session_id,body_digest,state,attempt_count,provider_request_id,last_error_code,created_at,updated_at FROM send_journal ORDER BY client_nonce").all(),
    runs: database.prepare("SELECT id,session_id,client_nonce,attempt_no,state,route,input_generation,input_seq,assistant_entry_id,provider_request_id,prompt_manifest_json,version,last_error_code,created_at,accepted_at,last_activity_at,finished_at FROM runtime_runs ORDER BY id").all(),
    settings: database.prepare("SELECT key,value,encrypted,updated_at FROM app_settings ORDER BY key").all(),
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function manifest(sessionId: string, botId: string, inputSeq = 1): PromptManifest {
  return {
    schemaVersion: 1,
    botId,
    profileVersion: 1,
    sessionId,
    generation: 1,
    inputSeq,
    blocks: [],
    digest: "digest",
  };
}

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("P0-B repository and migration", () => {
  function createV2Database(filename: string): DatabaseSync {
    const database = new DatabaseSync(filename);
    database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    database.exec(MIGRATIONS[0].sql);
    database.prepare("INSERT INTO schema_migrations VALUES(1, 't')").run();
    database.exec([
      "INSERT INTO bots VALUES('b','Bot','Label','Description','Instructions',1,'t','t');",
      "INSERT INTO sessions VALUES('s','b','MAIN',1,'t','t');",
      "INSERT INTO transcript_entries VALUES('e','s',1,1,'n','user','runtime-body','completed','t','t');",
      "INSERT INTO send_journal VALUES('n','s','digest','acked',0,'provider',NULL,'t','t');",
      "INSERT INTO app_settings VALUES('model.apiKey','ciphertext',1,'t');",
    ].join("\n"));
    database.exec(MIGRATIONS[1].sql);
    database.prepare("INSERT INTO schema_migrations VALUES(2, 't')").run();
    database
      .prepare(
        `INSERT INTO runtime_runs(
          id,session_id,client_nonce,attempt_no,state,route,input_generation,input_seq,
          assistant_entry_id,provider_request_id,prompt_manifest_json,version,last_error_code,
          created_at,accepted_at,last_activity_at,finished_at
        ) VALUES('run','s','n',1,'completed','fake',1,1,NULL,'provider',?,4,NULL,'t','t','t','t')`,
      )
      .run(JSON.stringify(manifest("s", "b")));
    return database;
  }

  it("migrates a v1 database without changing existing logical records", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-v1-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const legacy = new DatabaseSync(filename);
    legacy.exec([
      "PRAGMA foreign_keys = ON;",
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
      "INSERT INTO schema_migrations VALUES(1, '2026-01-01T00:00:00.000Z');",
      "CREATE TABLE bots(id TEXT PRIMARY KEY,name TEXT NOT NULL,label TEXT NOT NULL,description TEXT NOT NULL,instructions TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);",
      "CREATE TABLE sessions(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),kind TEXT NOT NULL,generation INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(bot_id,kind));",
      "CREATE TABLE transcript_entries(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),generation INTEGER NOT NULL,seq INTEGER NOT NULL,client_nonce TEXT,role TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(session_id,generation,seq));",
      "CREATE TABLE send_journal(client_nonce TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),body_digest TEXT NOT NULL,state TEXT NOT NULL,attempt_count INTEGER NOT NULL,provider_request_id TEXT,last_error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);",
      "CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,encrypted INTEGER NOT NULL,updated_at TEXT NOT NULL);",
      "INSERT INTO bots VALUES('b','Bot','Label','Description','Instructions',1,'t','t');",
      "INSERT INTO sessions VALUES('s','b','MAIN',1,'t','t');",
      "INSERT INTO transcript_entries VALUES('e','s',1,1,'n','user','original-body','completed','t','t');",
      "INSERT INTO send_journal VALUES('n','s','digest','acked',0,'provider',NULL,'t','t');",
      "INSERT INTO app_settings VALUES('model.apiKey','encrypted-value',1,'t');",
    ].join("\n"));
    legacy.close();

    const repository = new AppRepository(filename);
    repositories.push(repository);
    expect(repository.listTranscript("s")[0]).toMatchObject({ id: "e", body: "original-body", updatedSeq: 1 });
    expect(repository.getTranscriptCursor("s")).toBe(1);
    expect(repository.getSetting("model.apiKey")).toEqual({ value: "encrypted-value", encrypted: true });
    repository.close();
    repositories.pop();

    for (let restart = 0; restart < 3; restart += 1) {
      const reopened = new AppRepository(filename);
      expect(reopened.listTranscript("s")[0]).toMatchObject({ id: "e", body: "original-body", updatedSeq: 1 });
      expect(reopened.getTranscriptCursor("s")).toBe(1);
      reopened.close();
    }

    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      MIGRATIONS.map((migration) => ({ version: migration.version })),
    );
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()).toEqual({ count: 0 });
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(inspected.prepare("SELECT bot_id, room_id FROM sessions WHERE id='s'").get()).toEqual({ bot_id: "b", room_id: null });
    inspected.close();
  });

  it("rolls back the v2 migration when its first schema change conflicts", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-v2-failure-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const legacy = new DatabaseSync(filename);
    legacy.exec([
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
      "INSERT INTO schema_migrations VALUES(1, 't');",
      "CREATE TABLE sessions(id TEXT PRIMARY KEY, transcript_cursor INTEGER NOT NULL DEFAULT 0);",
      "CREATE TABLE transcript_entries(id TEXT PRIMARY KEY, seq INTEGER NOT NULL);",
    ].join("\n"));
    legacy.close();
    expect(() => new AppRepository(filename)).toThrow();
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=2").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='runtime_runs'").get()).toEqual({ count: 0 });
    inspected.close();
  });

  it("migrates a populated v2 runtime to v3 without changing logical data", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-v2-room-migration-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const legacy = createV2Database(filename);
    const beforeHash = logicalV2Hash(legacy);
    legacy.close();

    const repository = new AppRepository(filename);
    repositories.push(repository);
    expect(repository.getSession("s")).toMatchObject({ botId: "b", roomId: null, generation: 1 });
    expect(repository.listTranscript("s")[0]).toMatchObject({ id: "e", body: "runtime-body", speakerBotId: null });
    expect(repository.getRuntimeRun("run")).toMatchObject({
      executorBotId: "b",
      executionKey: "n",
      attemptNo: 1,
      promptCutoffSeq: 1,
      state: "completed",
    });
    expect(repository.getSetting("model.apiKey")).toEqual({ value: "ciphertext", encrypted: true });
    repository.close();
    repositories.pop();
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(logicalV2Hash(inspected)).toBe(beforeHash);
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(inspected.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      MIGRATIONS.map((migration) => ({ version: migration.version })),
    );
    inspected.close();
  });

  it("rolls back every v3 shadow table when migration fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-v3-failure-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const legacy = createV2Database(filename);
    legacy.exec("CREATE TABLE rooms(id TEXT PRIMARY KEY);");
    legacy.close();
    expect(() => new AppRepository(filename)).toThrow();
    const inspected = new DatabaseSync(filename, { readOnly: true });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=3").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE '%_v3'").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT body FROM transcript_entries WHERE id='e'").get()).toEqual({ body: "runtime-body" });
    expect(inspected.prepare("SELECT state FROM runtime_runs WHERE id='run'").get()).toEqual({ state: "completed" });
    inspected.close();
  });

  it("enforces runtime transitions, one active run and monotonic transcript updates", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const { bot, session } = repository.createBot();
    const nonce = crypto.randomUUID();
    repository.prepareMessage({ sessionId: session.id, clientNonce: nonce, text: "runtime" });
    const run = repository.createRuntimeRun(nonce, "fake", manifest(session.id, bot.id));
    expect(() => repository.createRuntimeRun(nonce, "fake", manifest(session.id, bot.id))).toThrowError(
      expect.objectContaining({ code: "SESSION_BUSY" }),
    );
    repository.transitionRuntimeRun(run.id, "dispatching");
    repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "request" });
    const assistant = repository.createAssistantEntry(session.id);
    repository.attachAssistantEntry(run.id, assistant.id);
    const updated = repository.updateTranscriptEntry(assistant.id, "A", "streaming");
    expect(updated.updatedSeq).toBeGreaterThan(assistant.updatedSeq);
    repository.transitionRuntimeRun(run.id, "streaming");
    repository.transitionRuntimeRun(run.id, "completed");
    expect(() => repository.transitionRuntimeRun(run.id, "running")).toThrowError(
      expect.objectContaining({ code: "RUNTIME_STATE_INVALID" }),
    );
  });

  it("recovers every non-terminal runtime run without creating another attempt", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const { bot, session } = repository.createBot();
    const nonce = crypto.randomUUID();
    repository.prepareMessage({ sessionId: session.id, clientNonce: nonce, text: "recover runtime" });
    const run = repository.createRuntimeRun(nonce, "fake", manifest(session.id, bot.id));
    repository.transitionRuntimeRun(run.id, "dispatching");
    repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "request" });
    const assistant = repository.createAssistantEntry(session.id);
    repository.attachAssistantEntry(run.id, assistant.id);
    repository.updateTranscriptEntry(assistant.id, "partial", "streaming");

    expect(repository.recoverInterruptedRuntimeRuns()).toBe(1);
    expect(repository.getRuntimeRun(run.id)).toMatchObject({ state: "interrupted", lastErrorCode: "APP_INTERRUPTED" });
    expect(repository.getTranscriptEntry(assistant.id)).toMatchObject({ body: "partial", status: "failed" });
    expect(repository.listRuntimeRuns(session.id)).toHaveLength(1);
  });
});
import { createHash } from "node:crypto";
