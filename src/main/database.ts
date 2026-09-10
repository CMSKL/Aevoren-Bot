import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Bot,
  BotPatch,
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

export function digestMessage(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

  listBots(): Bot[] {
    const rows = this.database.prepare("SELECT * FROM bots ORDER BY created_at ASC").all() as BotRow[];
    return rows.map(toBot);
  }

  getBot(id: string): Bot {
    const row = this.database.prepare("SELECT * FROM bots WHERE id = ?").get(id) as BotRow | undefined;
    if (!row) throw new MsBotError("BOT_NOT_FOUND", "没有找到这个 Bot。");
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
        .run(
          botId,
          DEFAULT_BOT.name,
          DEFAULT_BOT.label,
          DEFAULT_BOT.description,
          DEFAULT_BOT.instructions,
          timestamp,
          timestamp,
        );
      this.database
        .prepare(
          `INSERT INTO sessions(id, bot_id, kind, generation, created_at, updated_at)
           VALUES (?, ?, 'MAIN', 1, ?, ?)`,
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
        `UPDATE bots
         SET ${assignments}, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(...fields.map(([, value]) => value), now(), id, expectedVersion);
    if (Number(result.changes) === 0) {
      const current = this.getBot(id);
      throw new MsBotError("BOT_VERSION_CONFLICT", "Bot 已在别处更新，请重新确认后再保存。", true, {
        currentVersion: current.version,
      });
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
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
      | SessionRow
      | undefined;
    if (!row) throw new MsBotError("SESSION_NOT_FOUND", "没有找到这个会话。");
    return toSession(row);
  }

  getBotForSession(sessionId: string): Bot {
    const row = this.database
      .prepare(
        `SELECT bots.* FROM bots
         INNER JOIN sessions ON sessions.bot_id = bots.id
         WHERE sessions.id = ?`,
      )
      .get(sessionId) as BotRow | undefined;
    if (!row) throw new MsBotError("SESSION_NOT_FOUND", "没有找到这个会话。");
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
      if (existing.bodyDigest !== digest) {
        throw new MsBotError("MESSAGE_NONCE_CONFLICT", "相同消息标识不能用于不同内容。", false);
      }
      return { disposition: "duplicate", journal: existing };
    }
    const session = this.getSession(command.sessionId);
    const timestamp = now();
    this.transaction(() => {
      const sequence = this.nextSequence(session.id, session.generation);
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
             id, session_id, generation, seq, client_nonce, role, body, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'user', ?, 'pending', ?, ?)`,
        )
        .run(randomUUID(), session.id, session.generation, sequence, command.clientNonce, command.text, timestamp, timestamp);
    });
    return { disposition: "prepared", journal: this.getSendOrThrow(command.clientNonce) };
  }

  getSend(clientNonce: string): SendJournalEntry | null {
    const row = this.database.prepare("SELECT * FROM send_journal WHERE client_nonce = ?").get(clientNonce) as
      | SendRow
      | undefined;
    return row ? toSend(row) : null;
  }

  getSendOrThrow(clientNonce: string): SendJournalEntry {
    const entry = this.getSend(clientNonce);
    if (!entry) throw new MsBotError("MESSAGE_NOT_FOUND", "没有找到这条消息。");
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
    if (!row) throw new MsBotError("MESSAGE_NOT_FOUND", "没有找到这条用户消息。");
    return toTranscript(row);
  }

  setSendState(clientNonce: string, state: SendState, errorCode: string | null = null): SendJournalEntry {
    const result = this.database
      .prepare("UPDATE send_journal SET state = ?, last_error_code = ?, updated_at = ? WHERE client_nonce = ?")
      .run(state, errorCode, now(), clientNonce);
    if (Number(result.changes) === 0) throw new MsBotError("MESSAGE_NOT_FOUND", "没有找到这条消息。");
    return this.getSendOrThrow(clientNonce);
  }

  queueRetry(clientNonce: string): SendJournalEntry {
    const journal = this.getSendOrThrow(clientNonce);
    if (journal.state !== "failed-before-acceptance") {
      throw new MsBotError("MESSAGE_RETRY_UNSAFE", "这条消息可能已被接受，不能自动重发。", false);
    }
    const timestamp = now();
    this.transaction(() => {
      this.database
        .prepare(
          `UPDATE send_journal
           SET state = 'queued', attempt_count = attempt_count + 1, last_error_code = NULL, updated_at = ?
           WHERE client_nonce = ?`,
        )
        .run(timestamp, clientNonce);
      this.database
        .prepare("UPDATE transcript_entries SET status = 'pending', updated_at = ? WHERE client_nonce = ?")
        .run(timestamp, clientNonce);
    });
    return this.getSendOrThrow(clientNonce);
  }

  acknowledgeUserMessage(clientNonce: string): TranscriptEntry {
    const timestamp = now();
    this.transaction(() => {
      this.database
        .prepare("UPDATE transcript_entries SET status = 'completed', updated_at = ? WHERE client_nonce = ?")
        .run(timestamp, clientNonce);
      this.database
        .prepare("UPDATE send_journal SET state = 'acked', updated_at = ? WHERE client_nonce = ?")
        .run(timestamp, clientNonce);
    });
    return this.getUserMessage(clientNonce);
  }

  setUserMessageStatus(clientNonce: string, status: TranscriptStatus): TranscriptEntry {
    this.database
      .prepare("UPDATE transcript_entries SET status = ?, updated_at = ? WHERE client_nonce = ?")
      .run(status, now(), clientNonce);
    return this.getUserMessage(clientNonce);
  }

  createAssistantEntry(sessionId: string): TranscriptEntry {
    const session = this.getSession(sessionId);
    const timestamp = now();
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO transcript_entries(
           id, session_id, generation, seq, client_nonce, role, body, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, 'assistant', '', 'streaming', ?, ?)`,
      )
      .run(id, session.id, session.generation, this.nextSequence(session.id, session.generation), timestamp, timestamp);
    return this.getTranscriptEntry(id);
  }

  getTranscriptEntry(id: string): TranscriptEntry {
    const row = this.database.prepare("SELECT * FROM transcript_entries WHERE id = ?").get(id) as
      | TranscriptRow
      | undefined;
    if (!row) throw new MsBotError("TRANSCRIPT_ENTRY_NOT_FOUND", "没有找到这条记录。");
    return toTranscript(row);
  }

  updateTranscriptEntry(id: string, body: string, status: TranscriptStatus): TranscriptEntry {
    this.database
      .prepare("UPDATE transcript_entries SET body = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(body, status, now(), id);
    return this.getTranscriptEntry(id);
  }

  listPromptEntries(sessionId: string): TranscriptEntry[] {
    return this.listTranscript(sessionId).filter(
      (entry) => entry.status !== "failed" && entry.status !== "cancelled" && entry.body.trim().length > 0,
    );
  }

  recoverInterruptedSends(): number {
    const timestamp = now();
    this.transaction(() => {
      this.database
        .prepare(
          `UPDATE send_journal
           SET state = 'interrupted-unknown', last_error_code = 'APP_INTERRUPTED', updated_at = ?
           WHERE state IN ('dispatching', 'accepted-awaiting-echo')`,
        )
        .run(timestamp);
      this.database
        .prepare(
          `UPDATE send_journal
           SET state = 'failed-before-acceptance', last_error_code = 'APP_INTERRUPTED', updated_at = ?
           WHERE state IN ('prepared', 'queued')`,
        )
        .run(timestamp);
      this.database
        .prepare(
          `UPDATE transcript_entries
           SET status = 'failed', updated_at = ?
           WHERE client_nonce IN (
             SELECT client_nonce FROM send_journal
             WHERE last_error_code = 'APP_INTERRUPTED'
           ) AND status = 'pending'`,
        )
        .run(timestamp);
      this.database
        .prepare(
          `UPDATE transcript_entries
           SET status = 'failed', updated_at = ?
           WHERE role = 'assistant' AND status = 'streaming'`,
        )
        .run(timestamp);
    });
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM send_journal WHERE last_error_code = 'APP_INTERRUPTED'")
      .get() as { count: number };
    return Number(row.count);
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
