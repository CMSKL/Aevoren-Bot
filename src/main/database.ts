import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Bot,
  BotPatch,
  PromptManifest,
  Room,
  RoomBatch,
  RoomBatchState,
  RoomDetail,
  RoomMember,
  RoomPatch,
  RoomSendCommand,
  RoomTurn,
  RoomTurnState,
  RuntimeRoute,
  RuntimeRun,
  RuntimeState,
  SendCommand,
  SendJournalEntry,
  SendState,
  Session,
  TranscriptEntry,
  TranscriptRole,
  TranscriptStatus,
} from "@shared/contracts";
import { MsBotError } from "./errors";

const ACTIVE_RUNTIME_STATES: readonly RuntimeState[] = [
  "created",
  "dispatching",
  "running",
  "streaming",
  "cancel-requested",
];
const TERMINAL_RUNTIME_STATES: readonly RuntimeState[] = ["completed", "failed", "cancelled", "interrupted"];

const RUNTIME_TRANSITIONS: Record<RuntimeState, readonly RuntimeState[]> = {
  created: ["dispatching", "cancel-requested", "failed", "interrupted"],
  dispatching: ["running", "cancel-requested", "failed", "interrupted"],
  running: ["streaming", "completed", "cancel-requested", "failed", "interrupted"],
  streaming: ["completed", "cancel-requested", "failed", "interrupted"],
  "cancel-requested": ["cancelled", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

const ROOM_BATCH_TRANSITIONS: Record<RoomBatchState, readonly RoomBatchState[]> = {
  queued: ["running", "cancelled", "interrupted"],
  running: ["completed", "partial", "cancelled", "interrupted"],
  completed: [],
  partial: ["running"],
  cancelled: ["running"],
  interrupted: ["running"],
};

const ROOM_TURN_TRANSITIONS: Record<RoomTurnState, readonly RoomTurnState[]> = {
  queued: ["running", "cancelled", "interrupted"],
  running: ["completed", "failed", "cancelled", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind = 'MAIN'),
        generation INTEGER NOT NULL CHECK (generation > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (bot_id, kind)
      );

      CREATE TABLE IF NOT EXISTS transcript_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        client_nonce TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, generation, seq)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS transcript_client_nonce
        ON transcript_entries(client_nonce)
        WHERE client_nonce IS NOT NULL;

      CREATE TABLE IF NOT EXISTS send_journal (
        client_nonce TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        body_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        provider_request_id TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1)),
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE sessions ADD COLUMN transcript_cursor INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE transcript_entries ADD COLUMN updated_seq INTEGER NOT NULL DEFAULT 0;

      UPDATE transcript_entries SET updated_seq = seq;
      UPDATE sessions
      SET transcript_cursor = COALESCE(
        (SELECT MAX(updated_seq) FROM transcript_entries WHERE transcript_entries.session_id = sessions.id),
        0
      );

      CREATE TABLE runtime_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL REFERENCES send_journal(client_nonce) ON DELETE CASCADE,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        state TEXT NOT NULL CHECK (state IN (
          'created', 'dispatching', 'running', 'streaming', 'cancel-requested',
          'completed', 'failed', 'cancelled', 'interrupted'
        )),
        route TEXT NOT NULL CHECK (route IN ('fake', 'openai-compatible')),
        input_generation INTEGER NOT NULL,
        input_seq INTEGER NOT NULL,
        assistant_entry_id TEXT REFERENCES transcript_entries(id) ON DELETE SET NULL,
        provider_request_id TEXT,
        prompt_manifest_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        last_activity_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (client_nonce, attempt_no)
      );

      CREATE UNIQUE INDEX runtime_one_active_per_session
        ON runtime_runs(session_id)
        WHERE state IN ('created', 'dispatching', 'running', 'streaming', 'cancel-requested');
    `,
  },
  {
    version: 3,
    foreignKeysOff: true,
    sql: `
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        membership_version INTEGER NOT NULL CHECK (membership_version > 0),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE room_members (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (room_id, bot_id),
        UNIQUE (room_id, position)
      );

      CREATE TABLE sessions_v3 (
        id TEXT PRIMARY KEY,
        bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
        room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind = 'MAIN'),
        generation INTEGER NOT NULL CHECK (generation > 0),
        transcript_cursor INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((bot_id IS NOT NULL AND room_id IS NULL) OR (bot_id IS NULL AND room_id IS NOT NULL))
      );
      INSERT INTO sessions_v3(id, bot_id, room_id, kind, generation, transcript_cursor, created_at, updated_at)
      SELECT id, bot_id, NULL, kind, generation, transcript_cursor, created_at, updated_at FROM sessions;

      CREATE TABLE transcript_entries_v3 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions_v3(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        client_nonce TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'cancelled')),
        updated_seq INTEGER NOT NULL DEFAULT 0,
        speaker_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
        speaker_name_snapshot TEXT,
        source_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, generation, seq)
      );
      INSERT INTO transcript_entries_v3(
        id, session_id, generation, seq, client_nonce, role, body, status, updated_seq,
        speaker_bot_id, speaker_name_snapshot, source_turn_id, created_at, updated_at
      )
      SELECT id, session_id, generation, seq, client_nonce, role, body, status, updated_seq,
             NULL, NULL, NULL, created_at, updated_at FROM transcript_entries;

      CREATE TABLE send_journal_v3 (
        client_nonce TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions_v3(id) ON DELETE CASCADE,
        body_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        provider_request_id TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO send_journal_v3
      SELECT client_nonce, session_id, body_digest, state, attempt_count, provider_request_id,
             last_error_code, created_at, updated_at FROM send_journal;

      CREATE TABLE runtime_runs_v3 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions_v3(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL REFERENCES send_journal_v3(client_nonce) ON DELETE CASCADE,
        execution_key TEXT NOT NULL,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        state TEXT NOT NULL CHECK (state IN (
          'created', 'dispatching', 'running', 'streaming', 'cancel-requested',
          'completed', 'failed', 'cancelled', 'interrupted'
        )),
        route TEXT NOT NULL CHECK (route IN ('fake', 'openai-compatible')),
        input_generation INTEGER NOT NULL,
        input_seq INTEGER NOT NULL,
        prompt_cutoff_seq INTEGER NOT NULL,
        assistant_entry_id TEXT REFERENCES transcript_entries_v3(id) ON DELETE SET NULL,
        provider_request_id TEXT,
        prompt_manifest_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        last_activity_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (execution_key, attempt_no)
      );
      INSERT INTO runtime_runs_v3(
        id, session_id, client_nonce, execution_key, executor_bot_id, attempt_no, state, route,
        input_generation, input_seq, prompt_cutoff_seq, assistant_entry_id, provider_request_id,
        prompt_manifest_json, version, last_error_code, created_at, accepted_at, last_activity_at, finished_at
      )
      SELECT runtime_runs.id, runtime_runs.session_id, runtime_runs.client_nonce, runtime_runs.client_nonce,
             sessions.bot_id, runtime_runs.attempt_no, runtime_runs.state, runtime_runs.route,
             runtime_runs.input_generation, runtime_runs.input_seq, runtime_runs.input_seq,
             runtime_runs.assistant_entry_id, runtime_runs.provider_request_id, runtime_runs.prompt_manifest_json,
             runtime_runs.version, runtime_runs.last_error_code, runtime_runs.created_at,
             runtime_runs.accepted_at, runtime_runs.last_activity_at, runtime_runs.finished_at
      FROM runtime_runs INNER JOIN sessions ON sessions.id = runtime_runs.session_id;

      DROP TABLE runtime_runs;
      DROP TABLE transcript_entries;
      DROP TABLE send_journal;
      DROP TABLE sessions;
      ALTER TABLE sessions_v3 RENAME TO sessions;
      ALTER TABLE transcript_entries_v3 RENAME TO transcript_entries;
      ALTER TABLE send_journal_v3 RENAME TO send_journal;
      ALTER TABLE runtime_runs_v3 RENAME TO runtime_runs;

      CREATE UNIQUE INDEX sessions_one_main_per_bot ON sessions(bot_id, kind) WHERE bot_id IS NOT NULL;
      CREATE UNIQUE INDEX sessions_one_main_per_room ON sessions(room_id, kind) WHERE room_id IS NOT NULL;
      CREATE UNIQUE INDEX transcript_client_nonce
        ON transcript_entries(client_nonce) WHERE client_nonce IS NOT NULL;
      CREATE UNIQUE INDEX runtime_one_active_per_session
        ON runtime_runs(session_id)
        WHERE state IN ('created', 'dispatching', 'running', 'streaming', 'cancel-requested');

      CREATE TABLE room_batches (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL REFERENCES send_journal(client_nonce) ON DELETE CASCADE,
        target_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'partial', 'cancelled', 'interrupted')),
        membership_version INTEGER NOT NULL CHECK (membership_version > 0),
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (client_nonce)
      );
      CREATE UNIQUE INDEX room_one_active_batch_per_session
        ON room_batches(session_id)
        WHERE state IN ('queued', 'running');

      CREATE TABLE room_turns (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES room_batches(id) ON DELETE CASCADE,
        member_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        member_name_snapshot TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        version INTEGER NOT NULL CHECK (version > 0),
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
        runtime_run_id TEXT REFERENCES runtime_runs(id) ON DELETE SET NULL,
        prompt_cutoff_seq INTEGER,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (batch_id, member_bot_id, attempt_no)
      );
    `,
  },
] as const;

type BotRow = {
  id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  bot_id: string | null;
  room_id: string | null;
  kind: "MAIN";
  generation: number;
  transcript_cursor: number;
  created_at: string;
  updated_at: string;
};

type TranscriptRow = {
  id: string;
  session_id: string;
  generation: number;
  seq: number;
  client_nonce: string | null;
  role: TranscriptRole;
  body: string;
  status: TranscriptStatus;
  send_state?: SendState | null;
  speaker_bot_id: string | null;
  speaker_name_snapshot: string | null;
  source_turn_id: string | null;
  updated_seq: number;
  created_at: string;
  updated_at: string;
};

type SendRow = {
  client_nonce: string;
  session_id: string;
  body_digest: string;
  state: SendState;
  attempt_count: number;
  provider_request_id: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
};

type RuntimeRow = {
  id: string;
  session_id: string;
  client_nonce: string;
  executor_bot_id: string;
  execution_key: string;
  attempt_no: number;
  state: RuntimeState;
  route: RuntimeRoute;
  input_generation: number;
  input_seq: number;
  prompt_cutoff_seq: number;
  assistant_entry_id: string | null;
  provider_request_id: string | null;
  prompt_manifest_json: string;
  version: number;
  last_error_code: string | null;
  created_at: string;
  accepted_at: string | null;
  last_activity_at: string;
  finished_at: string | null;
};

type RoomRow = {
  id: string;
  name: string;
  description: string;
  version: number;
  membership_version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type RoomMemberRow = {
  room_id: string;
  bot_id: string;
  position: number;
  id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type RoomBatchRow = {
  id: string;
  room_id: string;
  session_id: string;
  client_nonce: string;
  target_digest: string;
  state: RoomBatchState;
  membership_version: number;
  version: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type RoomTurnRow = {
  id: string;
  batch_id: string;
  member_bot_id: string;
  member_name_snapshot: string;
  position: number;
  attempt_no: number;
  version: number;
  state: RoomTurnState;
  runtime_run_id: string | null;
  prompt_cutoff_seq: number | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

function now(): string {
  return new Date().toISOString();
}

function toBot(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    description: row.description,
    instructions: row.instructions,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    botId: row.bot_id,
    roomId: row.room_id,
    kind: row.kind,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTranscript(row: TranscriptRow): TranscriptEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    generation: row.generation,
    seq: row.seq,
    clientNonce: row.client_nonce,
    role: row.role,
    body: row.body,
    status: row.status,
    sendState: row.send_state ?? null,
    speakerBotId: row.speaker_bot_id,
    speakerNameSnapshot: row.speaker_name_snapshot,
    sourceTurnId: row.source_turn_id,
    updatedSeq: row.updated_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSend(row: SendRow): SendJournalEntry {
  return {
    clientNonce: row.client_nonce,
    sessionId: row.session_id,
    bodyDigest: row.body_digest,
    state: row.state,
    attemptCount: row.attempt_count,
    providerRequestId: row.provider_request_id,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    membershipVersion: row.membership_version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRoomBatch(row: RoomBatchRow): RoomBatch {
  return {
    id: row.id,
    roomId: row.room_id,
    sessionId: row.session_id,
    clientNonce: row.client_nonce,
    targetDigest: row.target_digest,
    state: row.state,
    membershipVersion: row.membership_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function toRoomTurn(row: RoomTurnRow): RoomTurn {
  return {
    id: row.id,
    batchId: row.batch_id,
    memberBotId: row.member_bot_id,
    memberNameSnapshot: row.member_name_snapshot,
    position: row.position,
    attemptNo: row.attempt_no,
    version: row.version,
    state: row.state,
    runtimeRunId: row.runtime_run_id,
    promptCutoffSeq: row.prompt_cutoff_seq,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function toRuntime(row: RuntimeRow): RuntimeRun {
  let promptManifest: PromptManifest;
  try {
    promptManifest = JSON.parse(row.prompt_manifest_json) as PromptManifest;
  } catch {
    throw new MsBotError("INTERNAL_ERROR");
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    clientNonce: row.client_nonce,
    executorBotId: row.executor_bot_id,
    executionKey: row.execution_key,
    attemptNo: row.attempt_no,
    state: row.state,
    route: row.route,
    inputGeneration: row.input_generation,
    inputSeq: row.input_seq,
    promptCutoffSeq: row.prompt_cutoff_seq,
    assistantEntryId: row.assistant_entry_id,
    providerRequestId: row.provider_request_id,
    promptManifest,
    version: row.version,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    lastActivityAt: row.last_activity_at,
    finishedAt: row.finished_at,
  };
}

export function digestMessage(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function digestRoomCommand(roomId: string, sessionId: string, text: string, targetBotIds: string[]): string {
  return digestMessage(JSON.stringify({ roomId, sessionId, text, targetBotIds: targetBotIds.toSorted() }));
}

export function isRuntimeTerminal(state: RuntimeState): boolean {
  return TERMINAL_RUNTIME_STATES.includes(state);
}

export class AppRepository {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON;");
    if (filename !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      (this.database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
        (row) => row.version,
      ),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      const foreignKeysOff = "foreignKeysOff" in migration && migration.foreignKeysOff;
      if (foreignKeysOff) this.database.exec("PRAGMA foreign_keys = OFF;");
      try {
        this.transaction(() => {
          this.database.exec(migration.sql);
          if (foreignKeysOff) {
            const violations = this.database.prepare("PRAGMA foreign_key_check").all();
            if (violations.length > 0) throw new Error("Migration produced foreign-key violations");
          }
          this.database
            .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
            .run(migration.version, now());
        });
      } finally {
        if (foreignKeysOff) {
          this.database.exec("PRAGMA legacy_alter_table = OFF;");
          this.database.exec("PRAGMA foreign_keys = ON;");
        }
      }
    }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  private nextTranscriptUpdateSeq(sessionId: string): number {
    const row = this.database
      .prepare("UPDATE sessions SET transcript_cursor = transcript_cursor + 1 WHERE id = ? RETURNING transcript_cursor")
      .get(sessionId) as { transcript_cursor: number } | undefined;
    if (!row) throw new MsBotError("SESSION_NOT_FOUND");
    return Number(row.transcript_cursor);
  }

  private updateTranscriptRecord(id: string, body: string | undefined, status: TranscriptStatus | undefined): void {
    const row = this.database.prepare("SELECT session_id FROM transcript_entries WHERE id = ?").get(id) as
      | { session_id: string }
      | undefined;
    if (!row) throw new MsBotError("TRANSCRIPT_ENTRY_NOT_FOUND");
    const updatedSeq = this.nextTranscriptUpdateSeq(row.session_id);
    const assignments = ["updated_seq = ?", "updated_at = ?"];
    const values: Array<string | number> = [updatedSeq, now()];
    if (body !== undefined) {
      assignments.push("body = ?");
      values.push(body);
    }
    if (status !== undefined) {
      assignments.push("status = ?");
      values.push(status);
    }
    this.database.prepare(`UPDATE transcript_entries SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
  }

  listBots(): Bot[] {
    return (this.database.prepare("SELECT * FROM bots ORDER BY created_at ASC").all() as BotRow[]).map(toBot);
  }

  getBot(id: string): Bot {
    const row = this.database.prepare("SELECT * FROM bots WHERE id = ?").get(id) as BotRow | undefined;
    if (!row) throw new MsBotError("BOT_NOT_FOUND");
    return toBot(row);
  }

  createBot(): { bot: Bot; session: Session } {
    const timestamp = now();
    const botId = randomUUID();
    const sessionId = randomUUID();
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO bots(id, name, label, description, instructions, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(botId, "新建 Bot", "", "", "", timestamp, timestamp);
      this.database
        .prepare(
          `INSERT INTO sessions(id, bot_id, room_id, kind, generation, transcript_cursor, created_at, updated_at)
           VALUES (?, ?, NULL, 'MAIN', 1, 0, ?, ?)`,
        )
        .run(sessionId, botId, timestamp, timestamp);
    });
    return { bot: this.getBot(botId), session: this.getMainSession(botId) };
  }

  updateBot(id: string, expectedVersion: number, patch: BotPatch): Bot {
    const fields = (Object.keys(patch) as Array<keyof BotPatch>)
      .filter((field) => patch[field] !== undefined)
      .map((field) => [field, patch[field] as string] as const);
    if (fields.length === 0) return this.getBot(id);
    const columns: Record<keyof BotPatch, string> = {
      name: "name",
      label: "label",
      description: "description",
      instructions: "instructions",
    };
    const assignments = fields.map(([field]) => `${columns[field]} = ?`).join(", ");
    const result = this.database
      .prepare(
        `UPDATE bots SET ${assignments}, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(...fields.map(([, value]) => value), now(), id, expectedVersion);
    if (Number(result.changes) === 0) {
      const current = this.getBot(id);
      throw new MsBotError("BOT_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
    }
    return this.getBot(id);
  }

  listRooms(includeArchived = false): Room[] {
    const rows = this.database
      .prepare(`SELECT * FROM rooms ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at ASC`)
      .all() as RoomRow[];
    return rows.map(toRoom);
  }

  getRoom(id: string): Room {
    const row = this.database.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as RoomRow | undefined;
    if (!row) throw new MsBotError("ROOM_NOT_FOUND");
    return toRoom(row);
  }

  getRoomDetail(id: string): RoomDetail {
    return { room: this.getRoom(id), members: this.listRoomMembers(id), session: this.getRoomMainSession(id) };
  }

  listRoomMembers(roomId: string): RoomMember[] {
    this.getRoom(roomId);
    const rows = this.database
      .prepare(
        `SELECT room_members.room_id, room_members.bot_id, room_members.position, bots.*
         FROM room_members INNER JOIN bots ON bots.id = room_members.bot_id
         WHERE room_members.room_id = ? ORDER BY room_members.position ASC`,
      )
      .all(roomId) as RoomMemberRow[];
    return rows.map((row) => ({ roomId: row.room_id, botId: row.bot_id, position: row.position, bot: toBot(row) }));
  }

  createRoom(input: { memberBotIds: string[]; name?: string; description?: string }): RoomDetail {
    if (input.memberBotIds.length < 2 || input.memberBotIds.length > 6 || new Set(input.memberBotIds).size !== input.memberBotIds.length) {
      throw new MsBotError("ROOM_MEMBER_INVALID");
    }
    const roomId = randomUUID();
    const sessionId = randomUUID();
    const timestamp = now();
    this.transaction(() => {
      const bots = input.memberBotIds.map((id) => this.getBot(id));
      const generatedName = bots.map((bot) => bot.name).join("、").replace(/\s+/g, " ").trim().slice(0, 72);
      this.database
        .prepare(
          `INSERT INTO rooms(id, name, description, version, membership_version, archived_at, created_at, updated_at)
           VALUES (?, ?, ?, 1, 1, NULL, ?, ?)`,
        )
        .run(roomId, input.name?.trim() || generatedName || "新群聊", input.description?.trim() ?? "", timestamp, timestamp);
      const insertMember = this.database.prepare(
        "INSERT INTO room_members(room_id, bot_id, position, created_at) VALUES (?, ?, ?, ?)",
      );
      input.memberBotIds.forEach((botId, position) => insertMember.run(roomId, botId, position, timestamp));
      this.database
        .prepare(
          `INSERT INTO sessions(id, bot_id, room_id, kind, generation, transcript_cursor, created_at, updated_at)
           VALUES (?, NULL, ?, 'MAIN', 1, 0, ?, ?)`,
        )
        .run(sessionId, roomId, timestamp, timestamp);
    });
    return this.getRoomDetail(roomId);
  }

  updateRoom(id: string, expectedVersion: number, patch: RoomPatch): Room {
    const fields = (Object.keys(patch) as Array<keyof RoomPatch>)
      .filter((field) => patch[field] !== undefined)
      .map((field) => [field, patch[field] as string] as const);
    if (fields.length === 0) return this.getRoom(id);
    const columns: Record<keyof RoomPatch, string> = { name: "name", description: "description" };
    const result = this.database
      .prepare(
        `UPDATE rooms SET ${fields.map(([field]) => `${columns[field]} = ?`).join(", ")},
         version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      )
      .run(...fields.map(([, value]) => value), now(), id, expectedVersion);
    if (Number(result.changes) === 0) {
      const current = this.getRoom(id);
      throw new MsBotError("ROOM_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
    }
    return this.getRoom(id);
  }

  archiveRoom(id: string, archived: boolean): Room {
    const room = this.getRoom(id);
    const sessionId = this.getRoomMainSession(room.id).id;
    if (this.getActiveRoomBatch(sessionId) || this.getActiveRuntimeRun(sessionId)) throw new MsBotError("ROOM_BUSY");
    const timestamp = now();
    const result = this.database
      .prepare("UPDATE rooms SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(archived ? timestamp : null, timestamp, id);
    if (Number(result.changes) === 0) throw new MsBotError("ROOM_NOT_FOUND");
    return this.getRoom(id);
  }

  addRoomMember(roomId: string, botId: string, expectedMembershipVersion: number): RoomDetail {
    this.transaction(() => {
      const room = this.getRoom(roomId);
      const sessionId = this.getRoomMainSession(roomId).id;
      if (this.getActiveRoomBatch(sessionId) || this.getActiveRuntimeRun(sessionId)) throw new MsBotError("ROOM_BUSY");
      this.getBot(botId);
      if (room.membershipVersion !== expectedMembershipVersion) {
        throw new MsBotError("ROOM_MEMBERSHIP_CONFLICT", undefined, undefined, { currentVersion: room.membershipVersion });
      }
      const members = this.listRoomMembers(roomId);
      if (members.some((member) => member.botId === botId) || members.length >= 6) throw new MsBotError("ROOM_MEMBER_INVALID");
      this.database
        .prepare("INSERT INTO room_members(room_id, bot_id, position, created_at) VALUES (?, ?, ?, ?)")
        .run(roomId, botId, members.length, now());
      this.bumpMembership(roomId, expectedMembershipVersion);
    });
    return this.getRoomDetail(roomId);
  }

  removeRoomMember(roomId: string, botId: string, expectedMembershipVersion: number): RoomDetail {
    this.transaction(() => {
      const room = this.getRoom(roomId);
      const sessionId = this.getRoomMainSession(roomId).id;
      if (this.getActiveRoomBatch(sessionId) || this.getActiveRuntimeRun(sessionId)) throw new MsBotError("ROOM_BUSY");
      if (room.membershipVersion !== expectedMembershipVersion) {
        throw new MsBotError("ROOM_MEMBERSHIP_CONFLICT", undefined, undefined, { currentVersion: room.membershipVersion });
      }
      const members = this.listRoomMembers(roomId);
      if (members.length <= 2) throw new MsBotError("ROOM_MEMBER_INVALID");
      if (!members.some((member) => member.botId === botId)) throw new MsBotError("ROOM_MEMBER_NOT_FOUND");
      this.database.prepare("DELETE FROM room_members WHERE room_id = ? AND bot_id = ?").run(roomId, botId);
      const remaining = this.database
        .prepare("SELECT bot_id FROM room_members WHERE room_id = ? ORDER BY position ASC")
        .all(roomId) as Array<{ bot_id: string }>;
      const updatePosition = this.database.prepare("UPDATE room_members SET position = ? WHERE room_id = ? AND bot_id = ?");
      remaining.forEach((member, position) => updatePosition.run(position, roomId, member.bot_id));
      this.bumpMembership(roomId, expectedMembershipVersion);
    });
    return this.getRoomDetail(roomId);
  }

  private bumpMembership(roomId: string, expectedVersion: number): void {
    const result = this.database
      .prepare(
        `UPDATE rooms SET membership_version = membership_version + 1, updated_at = ?
         WHERE id = ? AND membership_version = ?`,
      )
      .run(now(), roomId, expectedVersion);
    if (Number(result.changes) === 0) {
      const current = this.getRoom(roomId);
      throw new MsBotError("ROOM_MEMBERSHIP_CONFLICT", undefined, undefined, { currentVersion: current.membershipVersion });
    }
  }

  getMainSession(botId: string): Session {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE bot_id = ? AND kind = 'MAIN'")
      .get(botId) as SessionRow | undefined;
    if (!row) throw new MsBotError("SESSION_NOT_FOUND", "没有找到该 Bot 的主会话。");
    return toSession(row);
  }

  getRoomMainSession(roomId: string): Session {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE room_id = ? AND kind = 'MAIN'")
      .get(roomId) as SessionRow | undefined;
    if (!row) throw new MsBotError("SESSION_NOT_FOUND", "没有找到该群聊的主会话。");
    return toSession(row);
  }

  getSession(sessionId: string): Session {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    if (!row) throw new MsBotError("SESSION_NOT_FOUND");
    return toSession(row);
  }

  getTranscriptCursor(sessionId: string): number {
    const row = this.database.prepare("SELECT transcript_cursor FROM sessions WHERE id = ?").get(sessionId) as
      | { transcript_cursor: number }
      | undefined;
    if (!row) throw new MsBotError("SESSION_NOT_FOUND");
    return Number(row.transcript_cursor);
  }

  getTranscriptHighWater(sessionId: string): number {
    const session = this.getSession(sessionId);
    const row = this.database
      .prepare("SELECT COALESCE(MAX(seq), 0) AS value FROM transcript_entries WHERE session_id = ? AND generation = ?")
      .get(sessionId, session.generation) as { value: number };
    return Number(row.value);
  }

  getBotForSession(sessionId: string): Bot {
    const row = this.database
      .prepare(
        `SELECT bots.* FROM bots
         INNER JOIN sessions ON sessions.bot_id = bots.id
         WHERE sessions.id = ?`,
      )
      .get(sessionId) as BotRow | undefined;
    if (!row) throw new MsBotError("SESSION_NOT_FOUND");
    return toBot(row);
  }

  listTranscript(sessionId: string): TranscriptEntry[] {
    this.getSession(sessionId);
    const rows = this.database
      .prepare(
        `SELECT transcript_entries.*, send_journal.state AS send_state
         FROM transcript_entries
         LEFT JOIN send_journal ON send_journal.client_nonce = transcript_entries.client_nonce
         WHERE transcript_entries.session_id = ?
         ORDER BY transcript_entries.generation ASC, transcript_entries.seq ASC`,
      )
      .all(sessionId) as TranscriptRow[];
    return rows.map(toTranscript);
  }

  listPromptEntries(sessionId: string, inputSeq = Number.MAX_SAFE_INTEGER): TranscriptEntry[] {
    const session = this.getSession(sessionId);
    return this.listTranscript(sessionId).filter(
      (entry) =>
        entry.generation === session.generation &&
        entry.seq <= inputSeq &&
        entry.status !== "failed" &&
        entry.status !== "cancelled" &&
        entry.body.trim().length > 0,
    );
  }

  private nextSequence(sessionId: string, generation: number): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(seq), 0) AS current FROM transcript_entries WHERE session_id = ? AND generation = ?")
      .get(sessionId, generation) as { current: number };
    return Number(row.current) + 1;
  }

  prepareMessage(command: SendCommand): { disposition: "prepared" | "duplicate"; journal: SendJournalEntry } {
    const digest = digestMessage(command.text);
    const existing = this.getSend(command.clientNonce);
    if (existing) {
      if (existing.bodyDigest !== digest) throw new MsBotError("MESSAGE_NONCE_CONFLICT");
      return { disposition: "duplicate", journal: existing };
    }
    if (this.getActiveRuntimeRun(command.sessionId)) throw new MsBotError("SESSION_BUSY");
    const session = this.getSession(command.sessionId);
    const timestamp = now();
    this.transaction(() => {
      const sequence = this.nextSequence(session.id, session.generation);
      const updatedSeq = this.nextTranscriptUpdateSeq(session.id);
      this.database
        .prepare(
          `INSERT INTO send_journal(
             client_nonce, session_id, body_digest, state, attempt_count,
             provider_request_id, last_error_code, created_at, updated_at
           ) VALUES (?, ?, ?, 'prepared', 0, NULL, NULL, ?, ?)`,
        )
        .run(command.clientNonce, session.id, digest, timestamp, timestamp);
      this.database
        .prepare(
          `INSERT INTO transcript_entries(
             id, session_id, generation, seq, client_nonce, role, body, status, updated_seq, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'user', ?, 'pending', ?, ?, ?)`,
        )
        .run(randomUUID(), session.id, session.generation, sequence, command.clientNonce, command.text, updatedSeq, timestamp, timestamp);
    });
    return { disposition: "prepared", journal: this.getSendOrThrow(command.clientNonce) };
  }

  prepareRoomMessage(command: RoomSendCommand): { disposition: "prepared" | "duplicate"; batch: RoomBatch } {
    const canonicalTargetIds = command.targetBotIds.toSorted();
    const bodyDigest = digestRoomCommand(command.roomId, command.sessionId, command.text, canonicalTargetIds);
    const existing = this.getSend(command.clientNonce);
    if (existing) {
      if (existing.bodyDigest !== bodyDigest) throw new MsBotError("MESSAGE_NONCE_CONFLICT");
      const batch = this.getRoomBatchByNonce(command.clientNonce);
      if (!batch) throw new MsBotError("ROOM_BATCH_NOT_FOUND");
      return { disposition: "duplicate", batch };
    }
    const room = this.getRoom(command.roomId);
    if (room.archivedAt) throw new MsBotError("ROOM_ARCHIVED");
    const session = this.getSession(command.sessionId);
    if (session.roomId !== room.id) throw new MsBotError("SESSION_NOT_FOUND");
    if (
      command.targetBotIds.length < 1 ||
      command.targetBotIds.length > 6 ||
      new Set(command.targetBotIds).size !== command.targetBotIds.length
    ) {
      throw new MsBotError("ROOM_MEMBER_INVALID");
    }
    const members = this.listRoomMembers(room.id);
    const memberById = new Map(members.map((member) => [member.botId, member]));
    if (command.targetBotIds.some((botId) => !memberById.has(botId))) throw new MsBotError("ROOM_MEMBER_INVALID");
    const orderedTargets = members.filter((member) => command.targetBotIds.includes(member.botId));
    if (this.getActiveRoomBatch(command.sessionId) || this.getActiveRuntimeRun(command.sessionId)) {
      throw new MsBotError("ROOM_BATCH_BUSY");
    }

    const timestamp = now();
    const batchId = randomUUID();
    this.transaction(() => {
      const sequence = this.nextSequence(session.id, session.generation);
      const updatedSeq = this.nextTranscriptUpdateSeq(session.id);
      this.database
        .prepare(
          `INSERT INTO send_journal(
             client_nonce, session_id, body_digest, state, attempt_count,
             provider_request_id, last_error_code, created_at, updated_at
           ) VALUES (?, ?, ?, 'acked', 0, NULL, NULL, ?, ?)`,
        )
        .run(command.clientNonce, session.id, bodyDigest, timestamp, timestamp);
      this.database
        .prepare(
          `INSERT INTO transcript_entries(
             id, session_id, generation, seq, client_nonce, role, body, status, updated_seq,
             speaker_bot_id, speaker_name_snapshot, source_turn_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'user', ?, 'completed', ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(randomUUID(), session.id, session.generation, sequence, command.clientNonce, command.text, updatedSeq, timestamp, timestamp);
      this.database
        .prepare(
          `INSERT INTO room_batches(
             id, room_id, session_id, client_nonce, target_digest, state, membership_version,
             version, created_at, updated_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 1, ?, ?, NULL)`,
        )
        .run(batchId, room.id, session.id, command.clientNonce, digestMessage(JSON.stringify(canonicalTargetIds)), room.membershipVersion, timestamp, timestamp);
      const insertTurn = this.database.prepare(
        `INSERT INTO room_turns(
           id, batch_id, member_bot_id, member_name_snapshot, position, attempt_no, version, state,
           runtime_run_id, prompt_cutoff_seq, last_error_code, created_at, updated_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, 1, 1, 'queued', NULL, NULL, NULL, ?, ?, NULL)`,
      );
      orderedTargets.forEach((member) => insertTurn.run(randomUUID(), batchId, member.botId, member.bot.name, member.position, timestamp, timestamp));
    });
    return { disposition: "prepared", batch: this.getRoomBatch(batchId) };
  }

  getSend(clientNonce: string): SendJournalEntry | null {
    const row = this.database.prepare("SELECT * FROM send_journal WHERE client_nonce = ?").get(clientNonce) as SendRow | undefined;
    return row ? toSend(row) : null;
  }

  getSendOrThrow(clientNonce: string): SendJournalEntry {
    const entry = this.getSend(clientNonce);
    if (!entry) throw new MsBotError("MESSAGE_NOT_FOUND");
    return entry;
  }

  getRoomBatch(id: string): RoomBatch {
    const row = this.database.prepare("SELECT * FROM room_batches WHERE id = ?").get(id) as RoomBatchRow | undefined;
    if (!row) throw new MsBotError("ROOM_BATCH_NOT_FOUND");
    return toRoomBatch(row);
  }

  getRoomBatchByNonce(clientNonce: string): RoomBatch | null {
    const row = this.database.prepare("SELECT * FROM room_batches WHERE client_nonce = ?").get(clientNonce) as RoomBatchRow | undefined;
    return row ? toRoomBatch(row) : null;
  }

  getActiveRoomBatch(sessionId: string): RoomBatch | null {
    const row = this.database
      .prepare("SELECT * FROM room_batches WHERE session_id = ? AND state IN ('queued', 'running') LIMIT 1")
      .get(sessionId) as RoomBatchRow | undefined;
    return row ? toRoomBatch(row) : null;
  }

  listRoomBatches(roomId: string): RoomBatch[] {
    this.getRoom(roomId);
    return (this.database
      .prepare("SELECT * FROM room_batches WHERE room_id = ? ORDER BY created_at ASC")
      .all(roomId) as RoomBatchRow[]).map(toRoomBatch);
  }

  getRoomTurn(id: string): RoomTurn {
    const row = this.database.prepare("SELECT * FROM room_turns WHERE id = ?").get(id) as RoomTurnRow | undefined;
    if (!row) throw new MsBotError("ROOM_TURN_NOT_FOUND");
    return toRoomTurn(row);
  }

  listRoomTurns(batchId: string): RoomTurn[] {
    this.getRoomBatch(batchId);
    return (this.database
      .prepare("SELECT * FROM room_turns WHERE batch_id = ? ORDER BY position ASC, attempt_no ASC")
      .all(batchId) as RoomTurnRow[]).map(toRoomTurn);
  }

  transitionRoomBatch(id: string, state: RoomBatchState): RoomBatch {
    const current = this.getRoomBatch(id);
    if (!ROOM_BATCH_TRANSITIONS[current.state].includes(state)) {
      throw new MsBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    const timestamp = now();
    const terminal = !["queued", "running"].includes(state);
    this.database
      .prepare(
        `UPDATE room_batches SET state = ?, version = version + 1, updated_at = ?,
         finished_at = CASE WHEN ? THEN ? ELSE NULL END WHERE id = ?`,
      )
      .run(state, timestamp, terminal ? 1 : 0, timestamp, id);
    return this.getRoomBatch(id);
  }

  transitionRoomTurn(
    id: string,
    state: RoomTurnState,
    options: { runtimeRunId?: string; promptCutoffSeq?: number; errorCode?: string | null } = {},
  ): RoomTurn {
    const current = this.getRoomTurn(id);
    if (!ROOM_TURN_TRANSITIONS[current.state].includes(state)) {
      throw new MsBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    const timestamp = now();
    const terminal = !["queued", "running"].includes(state);
    this.database
      .prepare(
        `UPDATE room_turns SET state = ?, runtime_run_id = COALESCE(?, runtime_run_id), version = version + 1,
         prompt_cutoff_seq = COALESCE(?, prompt_cutoff_seq), last_error_code = ?,
         updated_at = ?, finished_at = CASE WHEN ? THEN ? ELSE NULL END
         WHERE id = ?`,
      )
      .run(
        state,
        options.runtimeRunId ?? null,
        options.promptCutoffSeq ?? null,
        options.errorCode ?? null,
        timestamp,
        terminal ? 1 : 0,
        timestamp,
        id,
      );
    return this.getRoomTurn(id);
  }

  attachRoomTurnRuntime(id: string, runtimeRunId: string): RoomTurn {
    this.database
      .prepare("UPDATE room_turns SET runtime_run_id = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(runtimeRunId, now(), id);
    return this.getRoomTurn(id);
  }

  createRoomTurnRetry(turnId: string): RoomTurn {
    const previous = this.getRoomTurn(turnId);
    if (!["failed", "cancelled", "interrupted"].includes(previous.state)) {
      throw new MsBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "state" });
    }
    const batch = this.getRoomBatch(previous.batchId);
    if (this.getRoom(batch.roomId).archivedAt) throw new MsBotError("ROOM_ARCHIVED");
    if (!["partial", "cancelled", "interrupted"].includes(batch.state)) {
      throw new MsBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "batch-state" });
    }
    const latestBatch = this.database
      .prepare("SELECT id FROM room_batches WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(batch.sessionId) as { id: string } | undefined;
    if (latestBatch?.id !== batch.id) {
      throw new MsBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "not-latest-batch" });
    }
    if (this.getActiveRoomBatch(batch.sessionId) || this.getActiveRuntimeRun(batch.sessionId)) {
      throw new MsBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "active-batch" });
    }
    const attempt = this.database
      .prepare("SELECT COALESCE(MAX(attempt_no), 0) AS value FROM room_turns WHERE batch_id = ? AND member_bot_id = ?")
      .get(previous.batchId, previous.memberBotId) as { value: number };
    if (Number(attempt.value) !== previous.attemptNo) {
      throw new MsBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "not-latest" });
    }
    const id = randomUUID();
    const timestamp = now();
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO room_turns(
             id, batch_id, member_bot_id, member_name_snapshot, position, attempt_no, version, state,
             runtime_run_id, prompt_cutoff_seq, last_error_code, created_at, updated_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, 'queued', NULL, ?, NULL, ?, ?, NULL)`,
        )
        .run(
          id,
          previous.batchId,
          previous.memberBotId,
          previous.memberNameSnapshot,
          previous.position,
          Number(attempt.value) + 1,
          previous.promptCutoffSeq,
          timestamp,
          timestamp,
        );
      this.transitionRoomBatch(previous.batchId, "running");
    });
    return this.getRoomTurn(id);
  }

  continueInterruptedRoomBatch(batchId: string): RoomTurn[] {
    const batch = this.getRoomBatch(batchId);
    if (this.getRoom(batch.roomId).archivedAt) throw new MsBotError("ROOM_ARCHIVED");
    if (!["interrupted", "partial"].includes(batch.state)) {
      throw new MsBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "batch-state" });
    }
    const latestBatch = this.database
      .prepare("SELECT id FROM room_batches WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(batch.sessionId) as { id: string } | undefined;
    if (latestBatch?.id !== batch.id) {
      throw new MsBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "not-latest-batch" });
    }
    if (this.getActiveRoomBatch(batch.sessionId) || this.getActiveRuntimeRun(batch.sessionId)) {
      throw new MsBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "active-batch" });
    }
    const allTurns = this.listRoomTurns(batchId);
    const latest = new Map<string, RoomTurn>();
    for (const turn of allTurns) {
      const previous = latest.get(turn.memberBotId);
      if (!previous || previous.attemptNo < turn.attemptNo) latest.set(turn.memberBotId, turn);
    }
    const remaining = [...latest.values()].filter(
      (turn) => turn.state === "interrupted" && turn.promptCutoffSeq === null,
    );
    if (remaining.length === 0) {
      throw new MsBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "no-remaining" });
    }
    const timestamp = now();
    const created: string[] = [];
    this.transaction(() => {
      const insert = this.database.prepare(
        `INSERT INTO room_turns(
           id, batch_id, member_bot_id, member_name_snapshot, position, attempt_no, version, state,
           runtime_run_id, prompt_cutoff_seq, last_error_code, created_at, updated_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 'queued', NULL, NULL, NULL, ?, ?, NULL)`,
      );
      for (const turn of remaining) {
        const id = randomUUID();
        created.push(id);
        insert.run(
          id,
          batchId,
          turn.memberBotId,
          turn.memberNameSnapshot,
          turn.position,
          turn.attemptNo + 1,
          timestamp,
          timestamp,
        );
      }
      this.transitionRoomBatch(batchId, "running");
    });
    return created.map((id) => this.getRoomTurn(id));
  }

  finishRoomBatchFromTurns(batchId: string): RoomBatch {
    const turns = this.listRoomTurns(batchId);
    const latest = new Map<string, RoomTurn>();
    for (const turn of turns) {
      const previous = latest.get(turn.memberBotId);
      if (!previous || previous.attemptNo < turn.attemptNo) latest.set(turn.memberBotId, turn);
    }
    const states = [...latest.values()].map((turn) => turn.state);
    if (states.some((state) => state === "queued" || state === "running")) return this.getRoomBatch(batchId);
    const next: RoomBatchState = states.every((state) => state === "completed")
      ? "completed"
      : states.every((state) => state === "cancelled")
        ? "cancelled"
        : "partial";
    const current = this.getRoomBatch(batchId);
    if (current.state === next) return current;
    return this.transitionRoomBatch(batchId, next);
  }

  getUserMessage(clientNonce: string): TranscriptEntry {
    const row = this.database
      .prepare(
        `SELECT transcript_entries.*, send_journal.state AS send_state
         FROM transcript_entries
         INNER JOIN send_journal ON send_journal.client_nonce = transcript_entries.client_nonce
         WHERE transcript_entries.client_nonce = ? AND transcript_entries.role = 'user'`,
      )
      .get(clientNonce) as TranscriptRow | undefined;
    if (!row) throw new MsBotError("MESSAGE_NOT_FOUND");
    return toTranscript(row);
  }

  getLatestUserMessage(sessionId: string): TranscriptEntry | null {
    const row = this.database
      .prepare(
        `SELECT transcript_entries.*, send_journal.state AS send_state
         FROM transcript_entries
         LEFT JOIN send_journal ON send_journal.client_nonce = transcript_entries.client_nonce
         WHERE transcript_entries.session_id = ? AND transcript_entries.role = 'user'
         ORDER BY generation DESC, seq DESC LIMIT 1`,
      )
      .get(sessionId) as TranscriptRow | undefined;
    return row ? toTranscript(row) : null;
  }

  setSendState(clientNonce: string, state: SendState, errorCode: string | null = null): SendJournalEntry {
    const result = this.database
      .prepare("UPDATE send_journal SET state = ?, last_error_code = ?, updated_at = ? WHERE client_nonce = ?")
      .run(state, errorCode, now(), clientNonce);
    if (Number(result.changes) === 0) throw new MsBotError("MESSAGE_NOT_FOUND");
    return this.getSendOrThrow(clientNonce);
  }

  setSendProviderRequestId(clientNonce: string, providerRequestId: string): SendJournalEntry {
    const result = this.database
      .prepare("UPDATE send_journal SET provider_request_id = ?, updated_at = ? WHERE client_nonce = ?")
      .run(providerRequestId, now(), clientNonce);
    if (Number(result.changes) === 0) throw new MsBotError("MESSAGE_NOT_FOUND");
    return this.getSendOrThrow(clientNonce);
  }

  queueRetry(clientNonce: string): SendJournalEntry {
    const journal = this.getSendOrThrow(clientNonce);
    if (journal.state !== "failed-before-acceptance") throw new MsBotError("MESSAGE_RETRY_UNSAFE");
    if (this.getActiveRuntimeRun(journal.sessionId)) throw new MsBotError("SESSION_BUSY");
    const user = this.getUserMessage(clientNonce);
    const timestamp = now();
    this.transaction(() => {
      this.database
        .prepare(
          `UPDATE send_journal
           SET state = 'queued', attempt_count = attempt_count + 1, last_error_code = NULL, updated_at = ?
           WHERE client_nonce = ?`,
        )
        .run(timestamp, clientNonce);
      this.updateTranscriptRecord(user.id, undefined, "pending");
    });
    return this.getSendOrThrow(clientNonce);
  }

  acknowledgeUserMessage(clientNonce: string): TranscriptEntry {
    const user = this.getUserMessage(clientNonce);
    const timestamp = now();
    this.transaction(() => {
      this.updateTranscriptRecord(user.id, undefined, "completed");
      this.database
        .prepare("UPDATE send_journal SET state = 'acked', updated_at = ? WHERE client_nonce = ?")
        .run(timestamp, clientNonce);
    });
    return this.getUserMessage(clientNonce);
  }

  setUserMessageStatus(clientNonce: string, status: TranscriptStatus): TranscriptEntry {
    const user = this.getUserMessage(clientNonce);
    this.transaction(() => this.updateTranscriptRecord(user.id, undefined, status));
    return this.getUserMessage(clientNonce);
  }

  createAssistantEntry(
    sessionId: string,
    attribution: { speakerBotId?: string; speakerNameSnapshot?: string; sourceTurnId?: string } = {},
  ): TranscriptEntry {
    const session = this.getSession(sessionId);
    const timestamp = now();
    const id = randomUUID();
    this.transaction(() => {
      const updatedSeq = this.nextTranscriptUpdateSeq(session.id);
      this.database
        .prepare(
          `INSERT INTO transcript_entries(
             id, session_id, generation, seq, client_nonce, role, body, status, updated_seq,
             speaker_bot_id, speaker_name_snapshot, source_turn_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, 'assistant', '', 'streaming', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          session.id,
          session.generation,
          this.nextSequence(session.id, session.generation),
          updatedSeq,
          attribution.speakerBotId ?? null,
          attribution.speakerNameSnapshot ?? null,
          attribution.sourceTurnId ?? null,
          timestamp,
          timestamp,
        );
    });
    return this.getTranscriptEntry(id);
  }

  getTranscriptEntry(id: string): TranscriptEntry {
    const row = this.database.prepare("SELECT * FROM transcript_entries WHERE id = ?").get(id) as TranscriptRow | undefined;
    if (!row) throw new MsBotError("TRANSCRIPT_ENTRY_NOT_FOUND");
    return toTranscript(row);
  }

  updateTranscriptEntry(id: string, body: string, status: TranscriptStatus): TranscriptEntry {
    this.transaction(() => this.updateTranscriptRecord(id, body, status));
    return this.getTranscriptEntry(id);
  }

  createRuntimeRun(
    clientNonce: string,
    route: RuntimeRoute,
    promptManifest: PromptManifest,
    options: { executorBotId?: string; executionKey?: string; promptCutoffSeq?: number } = {},
  ): RuntimeRun {
    const journal = this.getSendOrThrow(clientNonce);
    const input = this.getUserMessage(clientNonce);
    if (this.getActiveRuntimeRun(journal.sessionId)) throw new MsBotError("SESSION_BUSY");
    const executorBotId = options.executorBotId ?? this.getBotForSession(journal.sessionId).id;
    const executionKey = options.executionKey ?? clientNonce;
    const attempt = this.database
      .prepare("SELECT COALESCE(MAX(attempt_no), 0) AS current FROM runtime_runs WHERE execution_key = ?")
      .get(executionKey) as { current: number };
    const timestamp = now();
    const id = randomUUID();
    try {
      this.database
        .prepare(
          `INSERT INTO runtime_runs(
             id, session_id, client_nonce, execution_key, executor_bot_id, attempt_no, state, route,
             input_generation, input_seq, prompt_cutoff_seq,
             assistant_entry_id, provider_request_id, prompt_manifest_json, version, last_error_code,
             created_at, accepted_at, last_activity_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, NULL, NULL, ?, 1, NULL, ?, NULL, ?, NULL)`,
        )
        .run(
          id,
          journal.sessionId,
          clientNonce,
          executionKey,
          executorBotId,
          Number(attempt.current) + 1,
          route,
          input.generation,
          input.seq,
          options.promptCutoffSeq ?? input.seq,
          JSON.stringify(promptManifest),
          timestamp,
          timestamp,
        );
    } catch (error) {
      if (this.getActiveRuntimeRun(journal.sessionId)) throw new MsBotError("SESSION_BUSY");
      throw error;
    }
    return this.getRuntimeRun(id);
  }

  getRuntimeRun(id: string): RuntimeRun {
    const row = this.database.prepare("SELECT * FROM runtime_runs WHERE id = ?").get(id) as RuntimeRow | undefined;
    if (!row) throw new MsBotError("RUNTIME_NOT_FOUND");
    return toRuntime(row);
  }

  getLatestRuntimeRun(clientNonce: string): RuntimeRun | null {
    const row = this.database
      .prepare("SELECT * FROM runtime_runs WHERE client_nonce = ? ORDER BY attempt_no DESC LIMIT 1")
      .get(clientNonce) as RuntimeRow | undefined;
    return row ? toRuntime(row) : null;
  }

  getActiveRuntimeRun(sessionId: string): RuntimeRun | null {
    const placeholders = ACTIVE_RUNTIME_STATES.map(() => "?").join(",");
    const row = this.database
      .prepare(`SELECT * FROM runtime_runs WHERE session_id = ? AND state IN (${placeholders}) LIMIT 1`)
      .get(sessionId, ...ACTIVE_RUNTIME_STATES) as RuntimeRow | undefined;
    return row ? toRuntime(row) : null;
  }

  listRuntimeRuns(sessionId: string): RuntimeRun[] {
    this.getSession(sessionId);
    return (this.database
      .prepare("SELECT * FROM runtime_runs WHERE session_id = ? ORDER BY created_at ASC, attempt_no ASC")
      .all(sessionId) as RuntimeRow[]).map(toRuntime);
  }

  transitionRuntimeRun(
    id: string,
    state: RuntimeState,
    options: { providerRequestId?: string; assistantEntryId?: string; errorCode?: string | null } = {},
  ): RuntimeRun {
    const current = this.getRuntimeRun(id);
    if (!RUNTIME_TRANSITIONS[current.state].includes(state)) {
      throw new MsBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    const timestamp = now();
    const terminal = isRuntimeTerminal(state);
    this.database
      .prepare(
        `UPDATE runtime_runs SET
           state = ?,
           provider_request_id = COALESCE(?, provider_request_id),
           assistant_entry_id = COALESCE(?, assistant_entry_id),
           last_error_code = ?,
           accepted_at = CASE WHEN ? = 'running' AND accepted_at IS NULL THEN ? ELSE accepted_at END,
           last_activity_at = ?,
           finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
           version = version + 1
         WHERE id = ?`,
      )
      .run(
        state,
        options.providerRequestId ?? null,
        options.assistantEntryId ?? null,
        options.errorCode ?? null,
        state,
        timestamp,
        timestamp,
        terminal ? 1 : 0,
        timestamp,
        id,
      );
    return this.getRuntimeRun(id);
  }

  touchRuntimeRun(id: string): RuntimeRun {
    this.database
      .prepare("UPDATE runtime_runs SET last_activity_at = ?, version = version + 1 WHERE id = ?")
      .run(now(), id);
    return this.getRuntimeRun(id);
  }

  bumpRuntimeVersion(id: string): RuntimeRun {
    this.database.prepare("UPDATE runtime_runs SET version = version + 1 WHERE id = ?").run(id);
    return this.getRuntimeRun(id);
  }

  attachAssistantEntry(id: string, assistantEntryId: string): RuntimeRun {
    this.database
      .prepare("UPDATE runtime_runs SET assistant_entry_id = ?, version = version + 1 WHERE id = ?")
      .run(assistantEntryId, id);
    return this.getRuntimeRun(id);
  }

  assertRuntimeRetryEligible(id: string): RuntimeRun {
    const run = this.getRuntimeRun(id);
    if (!["failed", "cancelled", "interrupted"].includes(run.state)) {
      throw new MsBotError("RUNTIME_RETRY_UNSAFE", undefined, undefined, { reason: "state" });
    }
    if (this.getActiveRuntimeRun(run.sessionId)) {
      throw new MsBotError("RUNTIME_RETRY_UNSAFE", undefined, undefined, { reason: "active-run" });
    }
    const journal = this.getSendOrThrow(run.clientNonce);
    if (journal.state !== "acked") {
      throw new MsBotError("RUNTIME_RETRY_UNSAFE", undefined, undefined, { reason: "message-not-acked" });
    }
    const latest = this.getLatestUserMessage(run.sessionId);
    if (latest?.clientNonce !== run.clientNonce) {
      throw new MsBotError("RUNTIME_RETRY_UNSAFE", undefined, undefined, { reason: "not-latest" });
    }
    return run;
  }

  recoverInterruptedSends(): number {
    const timestamp = now();
    this.transaction(() => {
      this.database
        .prepare(
          `UPDATE send_journal SET state = 'interrupted-unknown', last_error_code = 'APP_INTERRUPTED', updated_at = ?
           WHERE state IN ('dispatching', 'accepted-awaiting-echo')`,
        )
        .run(timestamp);
      this.database
        .prepare(
          `UPDATE send_journal SET state = 'failed-before-acceptance', last_error_code = 'APP_INTERRUPTED', updated_at = ?
           WHERE state IN ('prepared', 'queued')`,
        )
        .run(timestamp);
      const pending = this.database
        .prepare(
          `SELECT transcript_entries.id FROM transcript_entries
           INNER JOIN send_journal ON send_journal.client_nonce = transcript_entries.client_nonce
           WHERE send_journal.last_error_code = 'APP_INTERRUPTED' AND transcript_entries.status = 'pending'`,
        )
        .all() as Array<{ id: string }>;
      for (const entry of pending) this.updateTranscriptRecord(entry.id, undefined, "failed");
    });
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM send_journal WHERE last_error_code = 'APP_INTERRUPTED'")
      .get() as { count: number };
    return Number(row.count);
  }

  recoverInterruptedRuntimeRuns(): number {
    const active = this.database
      .prepare(
        `SELECT * FROM runtime_runs
         WHERE state IN ('created', 'dispatching', 'running', 'streaming', 'cancel-requested')`,
      )
      .all() as RuntimeRow[];
    if (active.length === 0) return 0;
    this.transaction(() => {
      for (const row of active) {
        const timestamp = now();
        this.database
          .prepare(
            `UPDATE runtime_runs SET state = 'interrupted', last_error_code = 'APP_INTERRUPTED',
             last_activity_at = ?, finished_at = ?, version = version + 1 WHERE id = ?`,
          )
          .run(timestamp, timestamp, row.id);
        if (row.assistant_entry_id) {
          const assistant = this.getTranscriptEntry(row.assistant_entry_id);
          if (assistant.status === "streaming") this.updateTranscriptRecord(assistant.id, undefined, "failed");
        }
      }
    });
    return active.length;
  }

  recoverInterruptedRooms(): number {
    const batches = this.database
      .prepare("SELECT id FROM room_batches WHERE state IN ('queued', 'running')")
      .all() as Array<{ id: string }>;
    const turns = this.database
      .prepare(
        `SELECT room_turns.id, room_turns.batch_id, room_batches.state AS batch_state
         FROM room_turns INNER JOIN room_batches ON room_batches.id = room_turns.batch_id
         WHERE room_turns.state IN ('queued', 'running')`,
      )
      .all() as Array<{ id: string; batch_id: string; batch_state: RoomBatchState }>;
    if (batches.length === 0 && turns.length === 0) return 0;
    const timestamp = now();
    this.transaction(() => {
      const updateTurn = this.database.prepare(
        `UPDATE room_turns SET state = ?, version = version + 1,
         last_error_code = ?, updated_at = ?, finished_at = ? WHERE id = ?`,
      );
      for (const turn of turns) {
        const cancelled = turn.batch_state === "cancelled";
        updateTurn.run(cancelled ? "cancelled" : "interrupted", cancelled ? "MESSAGE_CANCELLED" : "APP_INTERRUPTED", timestamp, timestamp, turn.id);
      }
      this.database
        .prepare(
          `UPDATE room_batches SET state = 'interrupted', version = version + 1,
           updated_at = ?, finished_at = ? WHERE state IN ('queued', 'running')`,
        )
        .run(timestamp, timestamp);
    });
    return new Set([...batches.map((batch) => batch.id), ...turns.map((turn) => turn.batch_id)]).size;
  }

  listRoomTurnsForRoom(roomId: string): RoomTurn[] {
    this.getRoom(roomId);
    return (this.database
      .prepare(
        `SELECT room_turns.* FROM room_turns
         INNER JOIN room_batches ON room_batches.id = room_turns.batch_id
         WHERE room_batches.room_id = ? ORDER BY room_batches.created_at ASC, room_turns.position ASC, room_turns.attempt_no ASC`,
      )
      .all(roomId) as RoomTurnRow[]).map(toRoomTurn);
  }

  getSetting(key: string): { value: string; encrypted: boolean } | null {
    const row = this.database.prepare("SELECT value, encrypted FROM app_settings WHERE key = ?").get(key) as
      | { value: string; encrypted: number }
      | undefined;
    return row ? { value: row.value, encrypted: row.encrypted === 1 } : null;
  }

  setSetting(key: string, value: string, encrypted: boolean): void {
    this.database
      .prepare(
        `INSERT INTO app_settings(key, value, encrypted, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = excluded.updated_at`,
      )
      .run(key, value, encrypted ? 1 : 0, now());
  }
}
