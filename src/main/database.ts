import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Bot,
  BotPatch,
  PromptManifest,
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
import { DEFAULT_BOT } from "@shared/contracts";
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

const MIGRATIONS = [
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
  bot_id: string;
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
  attempt_no: number;
  state: RuntimeState;
  route: RuntimeRoute;
  input_generation: number;
  input_seq: number;
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
    attemptNo: row.attempt_no,
    state: row.state,
    route: row.route,
    inputGeneration: row.input_generation,
    inputSeq: row.input_seq,
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
      this.transaction(() => {
        this.database.exec(migration.sql);
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(migration.version, now());
      });
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
        .run(botId, DEFAULT_BOT.name, DEFAULT_BOT.label, DEFAULT_BOT.description, DEFAULT_BOT.instructions, timestamp, timestamp);
      this.database
        .prepare(
          `INSERT INTO sessions(id, bot_id, kind, generation, transcript_cursor, created_at, updated_at)
           VALUES (?, ?, 'MAIN', 1, 0, ?, ?)`,
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

  getMainSession(botId: string): Session {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE bot_id = ? AND kind = 'MAIN'")
      .get(botId) as SessionRow | undefined;
    if (!row) throw new MsBotError("SESSION_NOT_FOUND", "没有找到该 Bot 的主会话。");
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

  getSend(clientNonce: string): SendJournalEntry | null {
    const row = this.database.prepare("SELECT * FROM send_journal WHERE client_nonce = ?").get(clientNonce) as SendRow | undefined;
    return row ? toSend(row) : null;
  }

  getSendOrThrow(clientNonce: string): SendJournalEntry {
    const entry = this.getSend(clientNonce);
    if (!entry) throw new MsBotError("MESSAGE_NOT_FOUND");
    return entry;
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

  createAssistantEntry(sessionId: string): TranscriptEntry {
    const session = this.getSession(sessionId);
    const timestamp = now();
    const id = randomUUID();
    this.transaction(() => {
      const updatedSeq = this.nextTranscriptUpdateSeq(session.id);
      this.database
        .prepare(
          `INSERT INTO transcript_entries(
             id, session_id, generation, seq, client_nonce, role, body, status, updated_seq, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, 'assistant', '', 'streaming', ?, ?, ?)`,
        )
        .run(id, session.id, session.generation, this.nextSequence(session.id, session.generation), updatedSeq, timestamp, timestamp);
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

  createRuntimeRun(clientNonce: string, route: RuntimeRoute, promptManifest: PromptManifest): RuntimeRun {
    const journal = this.getSendOrThrow(clientNonce);
    const input = this.getUserMessage(clientNonce);
    if (this.getActiveRuntimeRun(journal.sessionId)) throw new MsBotError("SESSION_BUSY");
    const attempt = this.database
      .prepare("SELECT COALESCE(MAX(attempt_no), 0) AS current FROM runtime_runs WHERE client_nonce = ?")
      .get(clientNonce) as { current: number };
    const timestamp = now();
    const id = randomUUID();
    try {
      this.database
        .prepare(
          `INSERT INTO runtime_runs(
             id, session_id, client_nonce, attempt_no, state, route, input_generation, input_seq,
             assistant_entry_id, provider_request_id, prompt_manifest_json, version, last_error_code,
             created_at, accepted_at, last_activity_at, finished_at
           ) VALUES (?, ?, ?, ?, 'created', ?, ?, ?, NULL, NULL, ?, 1, NULL, ?, NULL, ?, NULL)`,
        )
        .run(
          id,
          journal.sessionId,
          clientNonce,
          Number(attempt.current) + 1,
          route,
          input.generation,
          input.seq,
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
