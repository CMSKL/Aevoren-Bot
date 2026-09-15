import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentTurn,
  AgentTurnOutcome,
  AgentTurnOrigin,
  Bot,
  BotPatch,
  CreateHandoffInput,
  CreateRoomRunInput,
  HandoffState,
  HandoffVisibility,
  PromptManifest,
  Room,
  RoomBatch,
  RoomBatchState,
  RoomDetail,
  RoomMember,
  RoomPatch,
  RoomSendCommand,
  RoomHandoff,
  RoomHandoffRejectionView,
  RoomRun,
  RoomRoutingMode,
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
import { AevorenBotError } from "./errors";

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

const HANDOFF_TRANSITIONS: Record<HandoffState, readonly HandoffState[]> = {
  queued: ["dispatching", "failed", "cancelled"],
  dispatching: ["accepted", "failed", "cancelled"],
  accepted: [],
  failed: [],
  cancelled: [],
};

const OUTCOMES_BY_TERMINAL_TURN_STATE: Partial<Record<RoomTurnState, readonly AgentTurnOutcome["kind"][]>> = {
  completed: ["sent", "pass", "skipped"],
  failed: ["timeout", "error"],
  cancelled: ["cancelled"],
  interrupted: ["timeout", "error"],
};

// Existing deterministic Room batches had no execution budget or deadline. These
// sentinels preserve that behavior while v4 records an explicit immutable policy.
const EXISTING_ROOM_RUN_MAX_TURNS = 2_147_483_647;
const EXISTING_ROOM_RUN_DEADLINE = "9999-12-31T23:59:59.999Z";
const MAX_HANDOFF_TASK_LENGTH = 20_000;
const MAX_HANDOFF_CONTEXT_REFS = 64;
const MAX_HANDOFF_CONTEXT_REF_LENGTH = 200;

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
  {
    version: 4,
    foreignKeysOff: true,
    sql: `
      CREATE TABLE room_batches_v4 (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL REFERENCES send_journal(client_nonce) ON DELETE CASCADE,
        trigger_message_id TEXT NOT NULL REFERENCES transcript_entries(id) ON DELETE RESTRICT,
        target_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'partial', 'cancelled', 'interrupted')),
        membership_version INTEGER NOT NULL CHECK (membership_version > 0),
        max_turns INTEGER NOT NULL CHECK (max_turns > 0),
        max_hops INTEGER NOT NULL CHECK (max_hops >= 0),
        max_targets_per_turn INTEGER NOT NULL CHECK (max_targets_per_turn > 0),
        deadline_at TEXT NOT NULL,
        is_winding_down INTEGER NOT NULL DEFAULT 0 CHECK (is_winding_down IN (0, 1)),
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (client_nonce),
        UNIQUE (room_id, trigger_message_id)
      );
      INSERT INTO room_batches_v4(
        id, room_id, session_id, client_nonce, trigger_message_id, target_digest, state,
        membership_version, max_turns, max_hops, max_targets_per_turn, deadline_at, is_winding_down,
        version, created_at, updated_at, finished_at
      )
      SELECT room_batches.id, room_batches.room_id, room_batches.session_id, room_batches.client_nonce,
             transcript_entries.id, room_batches.target_digest, room_batches.state,
             room_batches.membership_version, ${EXISTING_ROOM_RUN_MAX_TURNS},
             ${EXISTING_ROOM_RUN_MAX_TURNS}, ${EXISTING_ROOM_RUN_MAX_TURNS},
             '${EXISTING_ROOM_RUN_DEADLINE}', 0, room_batches.version,
             room_batches.created_at, room_batches.updated_at, room_batches.finished_at
      FROM room_batches
      INNER JOIN transcript_entries
        ON transcript_entries.client_nonce = room_batches.client_nonce AND transcript_entries.role = 'user';

      CREATE TABLE room_turns_v4 (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES room_batches_v4(id) ON DELETE CASCADE,
        member_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        member_name_snapshot TEXT NOT NULL,
        logical_turn_id TEXT NOT NULL,
        parent_turn_id TEXT,
        nonce TEXT NOT NULL,
        hop INTEGER NOT NULL CHECK (hop >= 0),
        origin TEXT NOT NULL CHECK (origin IN ('initial', 'handoff', 'retry')),
        input_generation INTEGER NOT NULL CHECK (input_generation > 0),
        input_seq INTEGER NOT NULL CHECK (input_seq > 0),
        position INTEGER NOT NULL CHECK (position >= 0),
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        version INTEGER NOT NULL CHECK (version > 0),
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
        outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
        runtime_run_id TEXT REFERENCES runtime_runs(id) ON DELETE SET NULL,
        prompt_cutoff_seq INTEGER,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (batch_id, member_bot_id, nonce),
        UNIQUE (batch_id, logical_turn_id, attempt_no),
        UNIQUE (batch_id, id),
        UNIQUE (batch_id, id, logical_turn_id),
        FOREIGN KEY (batch_id, parent_turn_id) REFERENCES room_turns_v4(batch_id, id) ON DELETE RESTRICT
      );
      INSERT INTO room_turns_v4(
        id, batch_id, member_bot_id, member_name_snapshot, logical_turn_id, parent_turn_id, nonce,
        hop, origin, input_generation, input_seq, position, attempt_no, version, state, outcome_json,
        runtime_run_id, prompt_cutoff_seq, last_error_code, created_at, updated_at, finished_at
      )
      SELECT room_turns.id, room_turns.batch_id, room_turns.member_bot_id, room_turns.member_name_snapshot,
             (SELECT first_turn.id FROM room_turns AS first_turn
              WHERE first_turn.batch_id = room_turns.batch_id
                AND first_turn.member_bot_id = room_turns.member_bot_id
              ORDER BY first_turn.attempt_no ASC LIMIT 1),
             NULL, room_turns.id, 0,
             CASE WHEN room_turns.attempt_no = 1 THEN 'initial' ELSE 'retry' END,
             transcript_entries.generation, transcript_entries.seq,
             room_turns.position, room_turns.attempt_no, room_turns.version, room_turns.state, NULL,
             room_turns.runtime_run_id, room_turns.prompt_cutoff_seq, room_turns.last_error_code,
             room_turns.created_at, room_turns.updated_at, room_turns.finished_at
      FROM room_turns
      INNER JOIN room_batches ON room_batches.id = room_turns.batch_id
      INNER JOIN transcript_entries
        ON transcript_entries.client_nonce = room_batches.client_nonce AND transcript_entries.role = 'user';

      DROP TABLE room_turns;
      DROP TABLE room_batches;
      ALTER TABLE room_batches_v4 RENAME TO room_batches;
      ALTER TABLE room_turns_v4 RENAME TO room_turns;

      UPDATE runtime_runs
      SET execution_key = (
        SELECT room_turns.batch_id || ':' || room_turns.logical_turn_id
        FROM room_turns WHERE room_turns.runtime_run_id = runtime_runs.id
      )
      WHERE EXISTS (SELECT 1 FROM room_turns WHERE room_turns.runtime_run_id = runtime_runs.id);

      CREATE UNIQUE INDEX room_one_active_batch_per_session
        ON room_batches(session_id) WHERE state IN ('queued', 'running');
      CREATE UNIQUE INDEX room_turn_one_runtime
        ON room_turns(runtime_run_id) WHERE runtime_run_id IS NOT NULL;

      CREATE TABLE agent_handoffs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES room_batches(id) ON DELETE CASCADE,
        from_turn_id TEXT NOT NULL,
        from_logical_turn_id TEXT NOT NULL,
        to_agent_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        target_turn_id TEXT NOT NULL,
        task TEXT NOT NULL,
        context_refs_json TEXT NOT NULL CHECK (json_valid(context_refs_json) AND json_type(context_refs_json) = 'array'),
        digest TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('room', 'direct')),
        state TEXT NOT NULL CHECK (state IN ('queued', 'dispatching', 'accepted', 'failed', 'cancelled')),
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (run_id, from_logical_turn_id, to_agent_id),
        UNIQUE (run_id, target_turn_id),
        FOREIGN KEY (run_id, from_turn_id, from_logical_turn_id)
          REFERENCES room_turns(batch_id, id, logical_turn_id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, target_turn_id) REFERENCES room_turns(batch_id, id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 5,
    foreignKeysOff: true,
    sql: `
      CREATE TABLE room_batches_v5 (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL REFERENCES send_journal(client_nonce) ON DELETE CASCADE,
        trigger_message_id TEXT NOT NULL REFERENCES transcript_entries(id) ON DELETE RESTRICT,
        target_digest TEXT NOT NULL,
        routing_mode TEXT NOT NULL CHECK (routing_mode IN ('legacy', 'automatic', 'explicit', 'everyone')),
        routing_reason TEXT CHECK (
          (routing_mode = 'automatic' AND routing_reason IS NOT NULL AND length(routing_reason) BETWEEN 1 AND 240)
          OR (routing_mode <> 'automatic' AND routing_reason IS NULL)
        ),
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'partial', 'cancelled', 'interrupted')),
        membership_version INTEGER NOT NULL CHECK (membership_version > 0),
        max_turns INTEGER NOT NULL CHECK (max_turns > 0),
        max_hops INTEGER NOT NULL CHECK (max_hops >= 0),
        max_targets_per_turn INTEGER NOT NULL CHECK (max_targets_per_turn > 0),
        deadline_at TEXT NOT NULL,
        is_winding_down INTEGER NOT NULL DEFAULT 0 CHECK (is_winding_down IN (0, 1)),
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (client_nonce),
        UNIQUE (room_id, trigger_message_id)
      );
      INSERT INTO room_batches_v5(
        id, room_id, session_id, client_nonce, trigger_message_id, target_digest,
        routing_mode, routing_reason, state, membership_version, max_turns, max_hops,
        max_targets_per_turn, deadline_at, is_winding_down, version, created_at, updated_at, finished_at
      )
      SELECT id, room_id, session_id, client_nonce, trigger_message_id, target_digest,
             'legacy', NULL, state, membership_version, max_turns, max_hops,
             max_targets_per_turn, deadline_at, is_winding_down, version, created_at, updated_at, finished_at
      FROM room_batches;

      DROP TABLE room_batches;
      ALTER TABLE room_batches_v5 RENAME TO room_batches;
      CREATE UNIQUE INDEX room_one_active_batch_per_session
        ON room_batches(session_id) WHERE state IN ('queued', 'running');
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE handoff_rejections (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES room_batches(id) ON DELETE CASCADE,
        from_turn_id TEXT NOT NULL,
        attempted_to_agent_id TEXT NOT NULL,
        tool_call_key TEXT NOT NULL CHECK (length(tool_call_key) = 64),
        error_code TEXT NOT NULL CHECK (length(error_code) BETWEEN 1 AND 100),
        created_at TEXT NOT NULL,
        UNIQUE (run_id, from_turn_id, tool_call_key),
        FOREIGN KEY (run_id, from_turn_id) REFERENCES room_turns(batch_id, id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE bots ADD COLUMN pinned_at TEXT;
      ALTER TABLE bots ADD COLUMN hidden_at TEXT;
      ALTER TABLE bots ADD COLUMN has_unread INTEGER NOT NULL DEFAULT 0 CHECK (has_unread IN (0, 1));
      ALTER TABLE bots ADD COLUMN deleted_at TEXT;

      CREATE INDEX bots_sidebar_state
        ON bots(deleted_at, hidden_at, pinned_at, created_at);
    `,
  },
] as const;

type BotRow = {
  id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  pinned_at: string | null;
  hidden_at: string | null;
  has_unread: number;
  deleted_at: string | null;
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
  pinned_at: string | null;
  hidden_at: string | null;
  has_unread: number;
  deleted_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type RoomBatchRow = {
  id: string;
  room_id: string;
  session_id: string;
  client_nonce: string;
  trigger_message_id: string;
  target_digest: string;
  routing_mode: RoomRoutingMode;
  routing_reason: string | null;
  state: RoomBatchState;
  membership_version: number;
  max_turns: number;
  used_turns: number;
  max_hops: number;
  max_targets_per_turn: number;
  deadline_at: string;
  is_winding_down: number;
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
  logical_turn_id: string;
  parent_turn_id: string | null;
  nonce: string;
  hop: number;
  origin: AgentTurnOrigin;
  input_generation: number;
  input_seq: number;
  position: number;
  attempt_no: number;
  version: number;
  state: RoomTurnState;
  outcome_json: string | null;
  runtime_run_id: string | null;
  prompt_cutoff_seq: number | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type HandoffRow = {
  id: string;
  run_id: string;
  from_turn_id: string;
  from_logical_turn_id: string;
  to_agent_id: string;
  target_turn_id: string;
  task: string;
  context_refs_json: string;
  digest: string;
  visibility: HandoffVisibility;
  state: HandoffState;
  version: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type HandoffRejectionRow = {
  id: string;
  run_id: string;
  from_turn_id: string;
  attempted_to_agent_id: string;
  tool_call_key: string;
  error_code: string;
  created_at: string;
};

type HandoffRejection = RoomHandoffRejectionView & { toolCallKey: string };

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
    pinnedAt: row.pinned_at,
    hiddenAt: row.hidden_at,
    hasUnread: row.has_unread === 1,
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
    triggerMessageId: row.trigger_message_id,
    targetDigest: row.target_digest,
    routingMode: row.routing_mode,
    routingReason: row.routing_reason,
    state: row.state,
    membershipVersion: row.membership_version,
    maxTurns: Number(row.max_turns),
    usedTurns: Number(row.used_turns),
    maxHops: Number(row.max_hops),
    maxTargetsPerTurn: Number(row.max_targets_per_turn),
    deadlineAt: row.deadline_at,
    windingDown: row.is_winding_down === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function toRoomTurn(row: RoomTurnRow): RoomTurn {
  let outcome: AgentTurnOutcome | null = null;
  if (row.outcome_json) {
    try {
      outcome = JSON.parse(row.outcome_json) as AgentTurnOutcome;
    } catch {
      throw new AevorenBotError("INTERNAL_ERROR");
    }
  }
  return {
    id: row.id,
    runId: row.batch_id,
    batchId: row.batch_id,
    agentId: row.member_bot_id,
    memberBotId: row.member_bot_id,
    memberNameSnapshot: row.member_name_snapshot,
    logicalTurnId: row.logical_turn_id,
    parentTurnId: row.parent_turn_id,
    nonce: row.nonce,
    hop: Number(row.hop),
    origin: row.origin,
    inputGeneration: Number(row.input_generation),
    inputSeq: Number(row.input_seq),
    position: row.position,
    attemptNo: row.attempt_no,
    version: row.version,
    state: row.state,
    outcome,
    runtimeRunId: row.runtime_run_id,
    promptCutoffSeq: row.prompt_cutoff_seq,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function toRoomHandoff(row: HandoffRow): RoomHandoff {
  let contextRefs: unknown;
  try {
    contextRefs = JSON.parse(row.context_refs_json);
  } catch {
    throw new AevorenBotError("INTERNAL_ERROR");
  }
  if (!Array.isArray(contextRefs) || contextRefs.some((reference) => typeof reference !== "string")) {
    throw new AevorenBotError("INTERNAL_ERROR");
  }
  return {
    id: row.id,
    runId: row.run_id,
    fromTurnId: row.from_turn_id,
    fromLogicalTurnId: row.from_logical_turn_id,
    toAgentId: row.to_agent_id,
    targetTurnId: row.target_turn_id,
    task: row.task,
    contextRefs: contextRefs as string[],
    digest: row.digest,
    visibility: row.visibility,
    state: row.state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function toHandoffRejection(row: HandoffRejectionRow): HandoffRejection {
  return {
    id: row.id,
    runId: row.run_id,
    fromTurnId: row.from_turn_id,
    attemptedToAgentId: row.attempted_to_agent_id,
    toolCallKey: row.tool_call_key,
    errorCode: row.error_code,
    createdAt: row.created_at,
  };
}

function toRuntime(row: RuntimeRow): RuntimeRun {
  let promptManifest: PromptManifest;
  try {
    promptManifest = JSON.parse(row.prompt_manifest_json) as PromptManifest;
  } catch {
    throw new AevorenBotError("INTERNAL_ERROR");
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

export function digestRoomCommand(
  roomId: string,
  sessionId: string,
  text: string,
  targetBotIds: string[],
  routingMode: RoomRoutingMode = "legacy",
): string {
  const command = { roomId, sessionId, text, targetBotIds: targetBotIds.toSorted() };
  return digestMessage(JSON.stringify(routingMode === "legacy" ? command : { ...command, routingMode }));
}

export function digestHandoff(task: string, contextRefs: string[]): string {
  return digestMessage(JSON.stringify({ task, contextRefs: contextRefs.toSorted() }));
}

function handoffToolCallKey(toolCallId: unknown): string {
  const normalized = typeof toolCallId === "string" && toolCallId.trim().length > 0
    ? toolCallId.trim()
    : "<invalid-tool-call>";
  return createHash("sha256").update(normalized).digest("hex");
}

function safeAttemptedAgentId(value: unknown): string {
  if (typeof value !== "string") return "invalid-target";
  const normalized = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : "invalid-target";
}

export function isRuntimeTerminal(state: RuntimeState): boolean {
  return TERMINAL_RUNTIME_STATES.includes(state);
}

const ROOM_RUN_SELECT = `SELECT room_batches.*,
  (SELECT COUNT(DISTINCT room_turns.logical_turn_id) FROM room_turns
   WHERE room_turns.batch_id = room_batches.id) AS used_turns
  FROM room_batches`;

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
    if (!row) throw new AevorenBotError("SESSION_NOT_FOUND");
    return Number(row.transcript_cursor);
  }

  private updateTranscriptRecord(id: string, body: string | undefined, status: TranscriptStatus | undefined): void {
    const row = this.database.prepare("SELECT session_id FROM transcript_entries WHERE id = ?").get(id) as
      | { session_id: string }
      | undefined;
    if (!row) throw new AevorenBotError("TRANSCRIPT_ENTRY_NOT_FOUND");
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
    return (this.database.prepare("SELECT * FROM bots WHERE deleted_at IS NULL ORDER BY created_at ASC").all() as BotRow[]).map(toBot);
  }

  getBot(id: string): Bot {
    const row = this.database.prepare("SELECT * FROM bots WHERE id = ? AND deleted_at IS NULL").get(id) as BotRow | undefined;
    if (!row) throw new AevorenBotError("BOT_NOT_FOUND");
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
      throw new AevorenBotError("BOT_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
    }
    return this.getBot(id);
  }

  setBotPinned(id: string, pinned: boolean): Bot {
    const result = this.database
      .prepare("UPDATE bots SET pinned_at = ?, hidden_at = CASE WHEN ? = 1 THEN NULL ELSE hidden_at END WHERE id = ? AND deleted_at IS NULL")
      .run(pinned ? now() : null, pinned ? 1 : 0, id);
    if (Number(result.changes) === 0) throw new AevorenBotError("BOT_NOT_FOUND");
    return this.getBot(id);
  }

  setBotUnread(id: string, unread: boolean): Bot {
    const result = this.database
      .prepare("UPDATE bots SET has_unread = ? WHERE id = ? AND deleted_at IS NULL")
      .run(unread ? 1 : 0, id);
    if (Number(result.changes) === 0) throw new AevorenBotError("BOT_NOT_FOUND");
    return this.getBot(id);
  }

  setBotHidden(id: string, hidden: boolean): Bot {
    const result = this.database
      .prepare("UPDATE bots SET hidden_at = ?, pinned_at = CASE WHEN ? = 1 THEN NULL ELSE pinned_at END WHERE id = ? AND deleted_at IS NULL")
      .run(hidden ? now() : null, hidden ? 1 : 0, id);
    if (Number(result.changes) === 0) throw new AevorenBotError("BOT_NOT_FOUND");
    return this.getBot(id);
  }

  duplicateBot(id: string): { bot: Bot; session: Session } {
    const source = this.getBot(id);
    const timestamp = now();
    const botId = randomUUID();
    const sessionId = randomUUID();
    const suffix = " 副本";
    const name = `${source.name.slice(0, 80 - suffix.length)}${suffix}`;
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO bots(id, name, label, description, instructions, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(botId, name, source.label, source.description, source.instructions, timestamp, timestamp);
      this.database
        .prepare(
          `INSERT INTO sessions(id, bot_id, room_id, kind, generation, transcript_cursor, created_at, updated_at)
           VALUES (?, ?, NULL, 'MAIN', 1, 0, ?, ?)`,
        )
        .run(sessionId, botId, timestamp, timestamp);
    });
    return { bot: this.getBot(botId), session: this.getMainSession(botId) };
  }

  deleteBot(id: string): { id: string; affectedRoomIds: string[]; archivedRoomIds: string[] } {
    this.getBot(id);
    const activeRuntime = this.database
      .prepare(
        `SELECT 1 FROM runtime_runs
         WHERE executor_bot_id = ? AND state IN ('created', 'dispatching', 'running', 'streaming', 'cancel-requested')
         LIMIT 1`,
      )
      .get(id);
    const activeRoom = this.database
      .prepare(
        `SELECT 1 FROM room_members
         INNER JOIN room_batches ON room_batches.room_id = room_members.room_id
         WHERE room_members.bot_id = ? AND room_batches.state IN ('queued', 'running')
         LIMIT 1`,
      )
      .get(id);
    if (activeRuntime || activeRoom) throw new AevorenBotError("BOT_BUSY");

    return this.transaction(() => {
      const timestamp = now();
      const memberships = this.database
        .prepare("SELECT room_id FROM room_members WHERE bot_id = ? ORDER BY room_id")
        .all(id) as Array<{ room_id: string }>;
      const affectedRoomIds = memberships.map((membership) => membership.room_id);
      const archivedRoomIds: string[] = [];

      this.database.prepare("DELETE FROM sessions WHERE bot_id = ?").run(id);
      this.database.prepare("DELETE FROM room_members WHERE bot_id = ?").run(id);

      for (const roomId of affectedRoomIds) {
        const members = this.database
          .prepare("SELECT bot_id FROM room_members WHERE room_id = ? ORDER BY position ASC")
          .all(roomId) as Array<{ bot_id: string }>;
        const updatePosition = this.database.prepare("UPDATE room_members SET position = ? WHERE room_id = ? AND bot_id = ?");
        members.forEach((member, position) => updatePosition.run(position, roomId, member.bot_id));
        const shouldArchive = members.length < 2;
        if (shouldArchive) archivedRoomIds.push(roomId);
        this.database
          .prepare(
            `UPDATE rooms
             SET membership_version = membership_version + 1,
                 version = version + 1,
                 archived_at = CASE WHEN ? = 1 THEN COALESCE(archived_at, ?) ELSE archived_at END,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(shouldArchive ? 1 : 0, timestamp, timestamp, roomId);
      }

      this.database
        .prepare(
          `UPDATE bots
           SET name = '已删除 Bot', label = '', description = '', instructions = '',
               pinned_at = NULL, hidden_at = NULL, has_unread = 0,
               deleted_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(timestamp, timestamp, id);

      return { id, affectedRoomIds, archivedRoomIds };
    });
  }

  listRooms(includeArchived = false): Room[] {
    const rows = this.database
      .prepare(`SELECT * FROM rooms ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at ASC`)
      .all() as RoomRow[];
    return rows.map(toRoom);
  }

  getRoom(id: string): Room {
    const row = this.database.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as RoomRow | undefined;
    if (!row) throw new AevorenBotError("ROOM_NOT_FOUND");
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
      throw new AevorenBotError("ROOM_MEMBER_INVALID");
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
      throw new AevorenBotError("ROOM_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
    }
    return this.getRoom(id);
  }

  archiveRoom(id: string, archived: boolean): Room {
    const room = this.getRoom(id);
    const sessionId = this.getRoomMainSession(room.id).id;
    if (this.getActiveRoomBatch(sessionId) || this.getActiveRuntimeRun(sessionId)) throw new AevorenBotError("ROOM_BUSY");
    const timestamp = now();
    const result = this.database
      .prepare("UPDATE rooms SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(archived ? timestamp : null, timestamp, id);
    if (Number(result.changes) === 0) throw new AevorenBotError("ROOM_NOT_FOUND");
    return this.getRoom(id);
  }

  addRoomMember(roomId: string, botId: string, expectedMembershipVersion: number): RoomDetail {
    this.transaction(() => {
      const room = this.getRoom(roomId);
      const sessionId = this.getRoomMainSession(roomId).id;
      if (this.getActiveRoomBatch(sessionId) || this.getActiveRuntimeRun(sessionId)) throw new AevorenBotError("ROOM_BUSY");
      this.getBot(botId);
      if (room.membershipVersion !== expectedMembershipVersion) {
        throw new AevorenBotError("ROOM_MEMBERSHIP_CONFLICT", undefined, undefined, { currentVersion: room.membershipVersion });
      }
      const members = this.listRoomMembers(roomId);
      if (members.some((member) => member.botId === botId) || members.length >= 6) throw new AevorenBotError("ROOM_MEMBER_INVALID");
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
      if (this.getActiveRoomBatch(sessionId) || this.getActiveRuntimeRun(sessionId)) throw new AevorenBotError("ROOM_BUSY");
      if (room.membershipVersion !== expectedMembershipVersion) {
        throw new AevorenBotError("ROOM_MEMBERSHIP_CONFLICT", undefined, undefined, { currentVersion: room.membershipVersion });
      }
      const members = this.listRoomMembers(roomId);
      if (members.length <= 2) throw new AevorenBotError("ROOM_MEMBER_INVALID");
      if (!members.some((member) => member.botId === botId)) throw new AevorenBotError("ROOM_MEMBER_NOT_FOUND");
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
      throw new AevorenBotError("ROOM_MEMBERSHIP_CONFLICT", undefined, undefined, { currentVersion: current.membershipVersion });
    }
  }

  getMainSession(botId: string): Session {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE bot_id = ? AND kind = 'MAIN'")
      .get(botId) as SessionRow | undefined;
    if (!row) throw new AevorenBotError("SESSION_NOT_FOUND", "没有找到该 Bot 的主会话。");
    return toSession(row);
  }

  getRoomMainSession(roomId: string): Session {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE room_id = ? AND kind = 'MAIN'")
      .get(roomId) as SessionRow | undefined;
    if (!row) throw new AevorenBotError("SESSION_NOT_FOUND", "没有找到该群聊的主会话。");
    return toSession(row);
  }

  getSession(sessionId: string): Session {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    if (!row) throw new AevorenBotError("SESSION_NOT_FOUND");
    return toSession(row);
  }

  getTranscriptCursor(sessionId: string): number {
    const row = this.database.prepare("SELECT transcript_cursor FROM sessions WHERE id = ?").get(sessionId) as
      | { transcript_cursor: number }
      | undefined;
    if (!row) throw new AevorenBotError("SESSION_NOT_FOUND");
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
    if (!row) throw new AevorenBotError("SESSION_NOT_FOUND");
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
      if (existing.bodyDigest !== digest) throw new AevorenBotError("MESSAGE_NONCE_CONFLICT");
      return { disposition: "duplicate", journal: existing };
    }
    if (this.getActiveRuntimeRun(command.sessionId)) throw new AevorenBotError("SESSION_BUSY");
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

  prepareRoomMessage(command: Omit<RoomSendCommand, "routingMode">): { disposition: "prepared" | "duplicate"; batch: RoomBatch } {
    const prepared = this.prepareRoomRun({
      ...command,
      membershipVersion: undefined,
      maxTurns: EXISTING_ROOM_RUN_MAX_TURNS,
      maxHops: EXISTING_ROOM_RUN_MAX_TURNS,
      maxTargetsPerTurn: EXISTING_ROOM_RUN_MAX_TURNS,
      deadlineAt: EXISTING_ROOM_RUN_DEADLINE,
      windingDown: false,
      initialTurns: command.targetBotIds.map((agentId) => ({ agentId, nonce: randomUUID() })),
      comparePolicyOnDuplicate: false,
      routingMode: "legacy",
      routingReason: null,
    });
    return {
      disposition: prepared.disposition === "created" ? "prepared" : "duplicate",
      batch: prepared.run,
    };
  }

  /** Atomically creates the persisted RoomRun root and all of its initial AgentTurns. */
  createRoomRunWithInitialTurns(input: CreateRoomRunInput): {
    disposition: "created" | "duplicate";
    run: RoomRun;
    turns: AgentTurn[];
  } {
    return this.prepareRoomRun({ ...input, windingDown: false, comparePolicyOnDuplicate: true });
  }

  private prepareRoomRun(input: Omit<CreateRoomRunInput, "membershipVersion"> & {
    membershipVersion?: number;
    windingDown: boolean;
    comparePolicyOnDuplicate: boolean;
  }): {
    disposition: "created" | "duplicate";
    run: RoomRun;
    turns: AgentTurn[];
  } {
    const canonicalTargetIds = input.initialTurns.map((turn) => turn.agentId).toSorted();
    const routingMode = input.routingMode ?? "legacy";
    const routingReason = input.routingReason?.trim() || null;
    const commandTargetIds = routingMode === "automatic" ? [] : canonicalTargetIds;
    if (
      input.initialTurns.length === 0 ||
      input.initialTurns.length > 6 ||
      input.clientNonce.trim().length === 0 ||
      input.text.trim().length === 0 ||
      new Set(input.initialTurns.map((turn) => turn.agentId)).size !== input.initialTurns.length ||
      input.initialTurns.some((turn) => turn.nonce.trim().length === 0) ||
      !Number.isInteger(input.maxTurns) ||
      input.maxTurns < input.initialTurns.length ||
      !Number.isInteger(input.maxHops) ||
      input.maxHops < 0 ||
      !Number.isInteger(input.maxTargetsPerTurn) ||
      input.maxTargetsPerTurn < 1 ||
      Number.isNaN(Date.parse(input.deadlineAt))
      || !["legacy", "automatic", "explicit", "everyone"].includes(routingMode)
      || (routingMode === "automatic" && (!routingReason || routingReason.length > 240 || input.initialTurns.length !== 1))
      || (routingMode !== "automatic" && routingReason !== null)
    ) {
      throw new AevorenBotError("INVALID_REQUEST");
    }
    const bodyDigest = digestRoomCommand(input.roomId, input.sessionId, input.text, commandTargetIds, routingMode);
    const targetDigest = digestMessage(JSON.stringify(canonicalTargetIds));
    const existingJournal = this.getSend(input.clientNonce);
    if (existingJournal) {
      if (existingJournal.bodyDigest !== bodyDigest) throw new AevorenBotError("MESSAGE_NONCE_CONFLICT");
      const existing = this.getRoomBatchByNonce(input.clientNonce);
      if (!existing) throw new AevorenBotError("ROOM_BATCH_NOT_FOUND");
      const turns = this.listRoomTurns(existing.id).filter((turn) => turn.origin === "initial");
      const expectedTurns = input.initialTurns
        .map((turn) => `${turn.agentId}:${turn.nonce}`)
        .toSorted();
      const actualTurns = turns.map((turn) => `${turn.agentId}:${turn.nonce}`).toSorted();
      if (input.comparePolicyOnDuplicate && (
        existing.roomId !== input.roomId ||
        existing.sessionId !== input.sessionId ||
        existing.membershipVersion !== input.membershipVersion ||
        existing.targetDigest !== targetDigest ||
        existing.routingMode !== routingMode ||
        existing.routingReason !== routingReason ||
        existing.maxTurns !== input.maxTurns ||
        existing.maxHops !== input.maxHops ||
        existing.maxTargetsPerTurn !== input.maxTargetsPerTurn ||
        existing.deadlineAt !== input.deadlineAt ||
        JSON.stringify(actualTurns) !== JSON.stringify(expectedTurns)
      )) {
        throw new AevorenBotError("ROOM_RUN_CONFLICT");
      }
      return { disposition: "duplicate", run: existing, turns };
    }
    if (Date.parse(input.deadlineAt) <= Date.now()) {
      throw new AevorenBotError("ROOM_RUN_LIMIT_EXCEEDED", undefined, undefined, { reason: "deadline" });
    }
    const room = this.getRoom(input.roomId);
    if (room.archivedAt) throw new AevorenBotError("ROOM_ARCHIVED");
    const session = this.getSession(input.sessionId);
    if (session.roomId !== room.id) throw new AevorenBotError("SESSION_NOT_FOUND");
    if (input.membershipVersion !== undefined && room.membershipVersion !== input.membershipVersion) {
      throw new AevorenBotError("ROOM_MEMBERSHIP_CONFLICT", undefined, undefined, { currentVersion: room.membershipVersion });
    }
    const members = this.listRoomMembers(room.id);
    const memberById = new Map(members.map((member) => [member.botId, member]));
    if (input.initialTurns.some((turn) => !memberById.has(turn.agentId))) {
      throw new AevorenBotError("ROOM_MEMBER_INVALID");
    }
    if (this.getActiveRoomBatch(session.id)) throw new AevorenBotError("ROOM_BATCH_BUSY");
    if (this.getActiveRuntimeRun(session.id)) throw new AevorenBotError("ROOM_BATCH_BUSY");

    const runId = randomUUID();
    const triggerMessageId = randomUUID();
    const timestamp = now();
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
        .run(input.clientNonce, session.id, bodyDigest, timestamp, timestamp);
      this.database
        .prepare(
          `INSERT INTO transcript_entries(
             id, session_id, generation, seq, client_nonce, role, body, status, updated_seq,
             speaker_bot_id, speaker_name_snapshot, source_turn_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'user', ?, 'completed', ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          triggerMessageId,
          session.id,
          session.generation,
          sequence,
          input.clientNonce,
          input.text,
          updatedSeq,
          timestamp,
          timestamp,
        );
      this.database
        .prepare(
          `INSERT INTO room_batches(
             id, room_id, session_id, client_nonce, trigger_message_id, target_digest, routing_mode, routing_reason, state, membership_version,
             max_turns, max_hops, max_targets_per_turn, deadline_at, is_winding_down,
             version, created_at, updated_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
        )
        .run(
          runId,
          room.id,
          session.id,
          input.clientNonce,
          triggerMessageId,
          targetDigest,
          routingMode,
          routingReason,
          input.membershipVersion ?? room.membershipVersion,
          input.maxTurns,
          input.maxHops,
          input.maxTargetsPerTurn,
          input.deadlineAt,
          input.windingDown ? 1 : 0,
          timestamp,
          timestamp,
        );
      const insertTurn = this.database.prepare(
        `INSERT INTO room_turns(
           id, batch_id, member_bot_id, member_name_snapshot, logical_turn_id, parent_turn_id, nonce,
           hop, origin, input_generation, input_seq, position, attempt_no, version, state, outcome_json,
           runtime_run_id, prompt_cutoff_seq, last_error_code, created_at, updated_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 'initial', ?, ?, ?, 1, 1, 'queued', NULL, NULL, NULL, NULL, ?, ?, NULL)`,
      );
      for (const turn of input.initialTurns) {
        const turnId = randomUUID();
        const member = memberById.get(turn.agentId)!;
        insertTurn.run(
          turnId,
          runId,
          member.botId,
          member.bot.name,
          turnId,
          turn.nonce,
          session.generation,
          sequence,
          member.position,
          timestamp,
          timestamp,
        );
      }
    });
    return { disposition: "created", run: this.getRoomRun(runId), turns: this.listAgentTurns(runId) };
  }

  createHandoff(input: CreateHandoffInput): {
    disposition: "created" | "duplicate";
    handoff: RoomHandoff;
    targetTurn: AgentTurn;
  } {
    if (
      typeof input.task !== "string" ||
      !Array.isArray(input.contextRefs) ||
      input.contextRefs.some((reference) => typeof reference !== "string")
    ) {
      throw new AevorenBotError("INVALID_REQUEST");
    }
    const task = input.task.trim();
    const contextRefs = input.contextRefs.map((reference) => reference.trim()).toSorted();
    if (
      task.length === 0 ||
      task.length > MAX_HANDOFF_TASK_LENGTH ||
      !["room", "direct"].includes(input.visibility) ||
      contextRefs.length > MAX_HANDOFF_CONTEXT_REFS ||
      contextRefs.some((reference) => (
        reference.length === 0 || reference.length > MAX_HANDOFF_CONTEXT_REF_LENGTH
      )) ||
      new Set(contextRefs).size !== contextRefs.length
    ) {
      throw new AevorenBotError("INVALID_REQUEST");
    }
    const run = this.getRoomRun(input.runId);
    const source = this.getRoomTurn(input.fromTurnId);
    if (source.runId !== run.id) throw new AevorenBotError("AGENT_TURN_CONFLICT");
    const target = this.getBot(input.toAgentId);
    const digest = digestHandoff(task, contextRefs);
    const existing = this.getHandoffBySemanticKey(run.id, source.logicalTurnId, target.id, digest, input.visibility);
    if (existing) {
      return { disposition: "duplicate", handoff: existing, targetTurn: this.getRoomTurn(existing.targetTurnId) };
    }
    if (
      input.targetTurnNonce.trim().length === 0 ||
      !Number.isInteger(input.inputGeneration) ||
      input.inputGeneration < 1 ||
      !Number.isInteger(input.inputSeq) ||
      input.inputSeq < 1
    ) {
      throw new AevorenBotError("INVALID_REQUEST");
    }
    const session = this.getSession(run.sessionId);
    const cursor = this.database
      .prepare(
        `SELECT status FROM transcript_entries
         WHERE session_id = ? AND generation = ? AND seq = ?`,
      )
      .get(run.sessionId, input.inputGeneration, input.inputSeq) as { status: TranscriptStatus } | undefined;
    if (
      input.inputGeneration !== session.generation ||
      input.inputSeq < source.inputSeq ||
      !cursor ||
      cursor.status !== "completed"
    ) {
      throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    }
    this.assertHandoffContextRefs(run, contextRefs, input.inputGeneration, input.inputSeq);
    if (run.state !== "running" || source.state !== "running") {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: source.state });
    }
    if (source.agentId === target.id) throw new AevorenBotError("HANDOFF_CYCLE");
    if (this.getHandoffByTarget(run.id, source.logicalTurnId, target.id)) throw new AevorenBotError("HANDOFF_TARGET_CONFLICT");
    if (input.visibility === "room") {
      const room = this.getRoom(run.roomId);
      if (room.membershipVersion !== run.membershipVersion) {
        throw new AevorenBotError("ROOM_MEMBERSHIP_CONFLICT", undefined, undefined, { currentVersion: room.membershipVersion });
      }
      if (!this.listRoomMembers(run.roomId).some((member) => member.botId === target.id)) {
        throw new AevorenBotError("ROOM_MEMBER_INVALID");
      }
    }
    const existingTurn = this.getAgentTurnByNonce(run.id, target.id, input.targetTurnNonce);
    if (existingTurn) throw new AevorenBotError("AGENT_TURN_CONFLICT");
    const hop = source.hop + 1;
    this.assertRoomRunCanCreateTurn(run, source, hop);
    if (this.wouldCreateHandoffCycle(run.id, source.logicalTurnId, target.id, digest)) throw new AevorenBotError("HANDOFF_CYCLE");
    const position = this.nextRoomTurnPosition(run.id);
    const targetTurnId = randomUUID();
    const handoffId = randomUUID();
    const timestamp = now();
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO room_turns(
             id, batch_id, member_bot_id, member_name_snapshot, logical_turn_id, parent_turn_id, nonce,
             hop, origin, input_generation, input_seq, position, attempt_no, version, state, outcome_json,
             runtime_run_id, prompt_cutoff_seq, last_error_code, created_at, updated_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'handoff', ?, ?, ?, 1, 1, 'queued', NULL, NULL, NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          targetTurnId,
          run.id,
          target.id,
          target.name,
          targetTurnId,
          source.id,
          input.targetTurnNonce,
          hop,
          input.inputGeneration,
          input.inputSeq,
          position,
          timestamp,
          timestamp,
        );
      this.database
        .prepare(
          `INSERT INTO agent_handoffs(
             id, run_id, from_turn_id, from_logical_turn_id, to_agent_id, target_turn_id, task, context_refs_json,
             digest, visibility, state, version, created_at, updated_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, NULL)`,
        )
        .run(
          handoffId,
          run.id,
          source.id,
          source.logicalTurnId,
          target.id,
          targetTurnId,
          task,
          JSON.stringify(contextRefs),
          digest,
          input.visibility,
          timestamp,
          timestamp,
        );
    });
    return {
      disposition: "created",
      handoff: this.getHandoff(handoffId),
      targetTurn: this.getRoomTurn(targetTurnId),
    };
  }

  getSend(clientNonce: string): SendJournalEntry | null {
    const row = this.database.prepare("SELECT * FROM send_journal WHERE client_nonce = ?").get(clientNonce) as SendRow | undefined;
    return row ? toSend(row) : null;
  }

  getSendOrThrow(clientNonce: string): SendJournalEntry {
    const entry = this.getSend(clientNonce);
    if (!entry) throw new AevorenBotError("MESSAGE_NOT_FOUND");
    return entry;
  }

  getRoomBatch(id: string): RoomBatch {
    const row = this.database.prepare(`${ROOM_RUN_SELECT} WHERE room_batches.id = ?`).get(id) as RoomBatchRow | undefined;
    if (!row) throw new AevorenBotError("ROOM_BATCH_NOT_FOUND");
    return toRoomBatch(row);
  }

  getRoomBatchByNonce(clientNonce: string): RoomBatch | null {
    const row = this.database
      .prepare(`${ROOM_RUN_SELECT} WHERE room_batches.client_nonce = ?`)
      .get(clientNonce) as RoomBatchRow | undefined;
    return row ? toRoomBatch(row) : null;
  }

  getActiveRoomBatch(sessionId: string): RoomBatch | null {
    const row = this.database
      .prepare(`${ROOM_RUN_SELECT} WHERE room_batches.session_id = ? AND room_batches.state IN ('queued', 'running') LIMIT 1`)
      .get(sessionId) as RoomBatchRow | undefined;
    return row ? toRoomBatch(row) : null;
  }

  listRoomBatches(roomId: string): RoomBatch[] {
    this.getRoom(roomId);
    return (this.database
      .prepare(`${ROOM_RUN_SELECT} WHERE room_batches.room_id = ? ORDER BY room_batches.created_at ASC`)
      .all(roomId) as RoomBatchRow[]).map(toRoomBatch);
  }

  getRoomRun(id: string): RoomRun {
    return this.getRoomBatch(id);
  }

  getRoomRunByTrigger(roomId: string, triggerMessageId: string): RoomRun | null {
    const row = this.database
      .prepare(
        `${ROOM_RUN_SELECT} WHERE room_batches.room_id = ? AND room_batches.trigger_message_id = ?`,
      )
      .get(roomId, triggerMessageId) as RoomBatchRow | undefined;
    return row ? toRoomBatch(row) : null;
  }

  getRoomTurn(id: string): RoomTurn {
    const row = this.database.prepare("SELECT * FROM room_turns WHERE id = ?").get(id) as RoomTurnRow | undefined;
    if (!row) throw new AevorenBotError("ROOM_TURN_NOT_FOUND");
    return toRoomTurn(row);
  }

  listRoomTurns(batchId: string): RoomTurn[] {
    this.getRoomBatch(batchId);
    return (this.database
      .prepare("SELECT * FROM room_turns WHERE batch_id = ? ORDER BY position ASC, attempt_no ASC")
      .all(batchId) as RoomTurnRow[]).map(toRoomTurn);
  }

  listAgentTurns(runId: string): AgentTurn[] {
    return this.listRoomTurns(runId);
  }

  getAgentTurnByNonce(runId: string, agentId: string, nonce: string): AgentTurn | null {
    const row = this.database
      .prepare("SELECT * FROM room_turns WHERE batch_id = ? AND member_bot_id = ? AND nonce = ?")
      .get(runId, agentId, nonce) as RoomTurnRow | undefined;
    return row ? toRoomTurn(row) : null;
  }

  getHandoff(id: string): RoomHandoff {
    const row = this.database.prepare("SELECT * FROM agent_handoffs WHERE id = ?").get(id) as HandoffRow | undefined;
    if (!row) throw new AevorenBotError("HANDOFF_NOT_FOUND");
    return toRoomHandoff(row);
  }

  listHandoffs(runId: string): RoomHandoff[] {
    this.getRoomRun(runId);
    return (this.database
      .prepare("SELECT * FROM agent_handoffs WHERE run_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(runId) as HandoffRow[]).map(toRoomHandoff);
  }

  recordHandoffRejection(input: {
    runId: string;
    fromTurnId: string;
    attemptedToAgentId: unknown;
    toolCallId: unknown;
    errorCode: string;
  }): { disposition: "created" | "duplicate"; rejection: HandoffRejection } {
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(input.errorCode)) throw new AevorenBotError("INVALID_REQUEST");
    const run = this.getRoomRun(input.runId);
    const source = this.getRoomTurn(input.fromTurnId);
    if (source.runId !== run.id) throw new AevorenBotError("AGENT_TURN_CONFLICT");
    const attemptedToAgentId = safeAttemptedAgentId(input.attemptedToAgentId);
    const toolCallKey = handoffToolCallKey(input.toolCallId);
    const existing = this.database
      .prepare(
        `SELECT * FROM handoff_rejections
         WHERE run_id = ? AND from_turn_id = ? AND tool_call_key = ?`,
      )
      .get(run.id, source.id, toolCallKey) as HandoffRejectionRow | undefined;
    if (existing) return { disposition: "duplicate", rejection: toHandoffRejection(existing) };

    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO handoff_rejections(
           id, run_id, from_turn_id, attempted_to_agent_id, tool_call_key, error_code, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, run.id, source.id, attemptedToAgentId, toolCallKey, input.errorCode, now());
    return { disposition: "created", rejection: this.getHandoffRejection(id) };
  }

  getHandoffRejection(id: string): HandoffRejection {
    const row = this.database.prepare("SELECT * FROM handoff_rejections WHERE id = ?").get(id) as HandoffRejectionRow | undefined;
    if (!row) throw new AevorenBotError("HANDOFF_NOT_FOUND");
    return toHandoffRejection(row);
  }

  listHandoffRejections(runId: string): HandoffRejection[] {
    this.getRoomRun(runId);
    return (this.database
      .prepare("SELECT * FROM handoff_rejections WHERE run_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(runId) as HandoffRejectionRow[]).map(toHandoffRejection);
  }

  getIncomingHandoff(targetTurnId: string): RoomHandoff | null {
    // A Handoff records its original delivery attempt. A retry keeps that audit
    // record terminal while resolving the same incoming task by logical Turn.
    const row = this.database
      .prepare(
        `SELECT agent_handoffs.* FROM room_turns AS current
         INNER JOIN room_turns AS original
           ON original.batch_id = current.batch_id AND original.logical_turn_id = current.logical_turn_id
         INNER JOIN agent_handoffs ON agent_handoffs.target_turn_id = original.id
         WHERE current.id = ? LIMIT 1`,
      )
      .get(targetTurnId) as HandoffRow | undefined;
    return row ? toRoomHandoff(row) : null;
  }

  isCoordinatedRoomRun(runId: string): boolean {
    const run = this.getRoomRun(runId);
    return run.maxTurns !== EXISTING_ROOM_RUN_MAX_TURNS
      || run.maxHops !== EXISTING_ROOM_RUN_MAX_TURNS
      || run.maxTargetsPerTurn !== EXISTING_ROOM_RUN_MAX_TURNS
      || run.deadlineAt !== EXISTING_ROOM_RUN_DEADLINE;
  }

  cancelOpenHandoffs(runId: string): RoomHandoff[] {
    const open = this.listHandoffs(runId).filter((handoff) => ["queued", "dispatching"].includes(handoff.state));
    return open.map((handoff) => this.transitionHandoff(handoff.id, "cancelled"));
  }

  private getHandoffBySemanticKey(
    runId: string,
    fromLogicalTurnId: string,
    toAgentId: string,
    digest: string,
    visibility: HandoffVisibility,
  ): RoomHandoff | null {
    const row = this.database
      .prepare(
        `SELECT * FROM agent_handoffs
         WHERE run_id = ? AND from_logical_turn_id = ? AND to_agent_id = ? AND digest = ? AND visibility = ?`,
      )
      .get(runId, fromLogicalTurnId, toAgentId, digest, visibility) as HandoffRow | undefined;
    return row ? toRoomHandoff(row) : null;
  }

  private getHandoffByTarget(runId: string, fromLogicalTurnId: string, toAgentId: string): RoomHandoff | null {
    const row = this.database
      .prepare(
        `SELECT * FROM agent_handoffs
         WHERE run_id = ? AND from_logical_turn_id = ? AND to_agent_id = ?`,
      )
      .get(runId, fromLogicalTurnId, toAgentId) as HandoffRow | undefined;
    return row ? toRoomHandoff(row) : null;
  }

  private assertHandoffContextRefs(
    run: RoomRun,
    contextRefs: string[],
    inputGeneration: number,
    inputSeq: number,
  ): void {
    const getContext = this.database.prepare(
      `SELECT session_id, generation, seq, status FROM transcript_entries WHERE id = ?`,
    );
    for (const reference of contextRefs) {
      const entry = getContext.get(reference) as Pick<TranscriptRow, "session_id" | "generation" | "seq" | "status"> | undefined;
      if (
        !entry ||
        entry.session_id !== run.sessionId ||
        Number(entry.generation) !== inputGeneration ||
        Number(entry.seq) > inputSeq ||
        entry.status !== "completed"
      ) {
        throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
      }
    }
  }

  private wouldCreateHandoffCycle(runId: string, sourceLogicalTurnId: string, targetAgentId: string, digest: string): boolean {
    // Only an identical task digest continues the same graph. A different digest is
    // a distinct task and may intentionally return to an earlier Agent.
    const row = this.database
      .prepare(
        `WITH RECURSIVE same_task_ancestors(id, logical_turn_id, parent_turn_id, member_bot_id) AS (
           SELECT id, logical_turn_id, parent_turn_id, member_bot_id
           FROM room_turns WHERE batch_id = ? AND logical_turn_id = ?
           UNION
           SELECT parent.id, parent.logical_turn_id, parent.parent_turn_id, parent.member_bot_id
           FROM same_task_ancestors AS child
           INNER JOIN room_turns AS delivered
             ON delivered.batch_id = ? AND delivered.logical_turn_id = child.logical_turn_id
           INNER JOIN agent_handoffs AS handoff
             ON handoff.run_id = ? AND handoff.target_turn_id = delivered.id AND handoff.digest = ?
           INNER JOIN room_turns AS parent
             ON parent.batch_id = handoff.run_id AND parent.id = handoff.from_turn_id
         )
         SELECT 1 AS found FROM same_task_ancestors WHERE member_bot_id = ? LIMIT 1`,
      )
      .get(runId, sourceLogicalTurnId, runId, runId, digest, targetAgentId) as { found: number } | undefined;
    return Boolean(row);
  }

  private nextRoomTurnPosition(runId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS value FROM room_turns WHERE batch_id = ?")
      .get(runId) as { value: number };
    return Number(row.value);
  }

  private assertRoomRunHardStopAllowsWork(run: RoomRun): void {
    if (run.windingDown) {
      throw new AevorenBotError("ROOM_RUN_LIMIT_EXCEEDED", undefined, undefined, { reason: "winding-down" });
    }
    if (Date.parse(run.deadlineAt) <= Date.now()) {
      throw new AevorenBotError("ROOM_RUN_LIMIT_EXCEEDED", undefined, undefined, { reason: "deadline" });
    }
  }

  private assertRoomTurnMembershipAllowsRetry(run: RoomRun, turn: RoomTurn): void {
    this.getBot(turn.agentId);
    const incoming = this.database
      .prepare(
        `SELECT agent_handoffs.visibility FROM agent_handoffs
         INNER JOIN room_turns AS target ON target.id = agent_handoffs.target_turn_id
         WHERE agent_handoffs.run_id = ? AND target.logical_turn_id = ? LIMIT 1`,
      )
      .get(run.id, turn.logicalTurnId) as { visibility: HandoffVisibility } | undefined;
    if (incoming?.visibility === "direct") return;
    const room = this.getRoom(run.roomId);
    if (room.membershipVersion !== run.membershipVersion) {
      throw new AevorenBotError("ROOM_MEMBERSHIP_CONFLICT", undefined, undefined, { currentVersion: room.membershipVersion });
    }
    if (!this.listRoomMembers(run.roomId).some((member) => member.botId === turn.agentId)) {
      throw new AevorenBotError("ROOM_MEMBER_INVALID");
    }
  }

  assertRoomTurnDispatchable(turnId: string): RoomTurn {
    const turn = this.getRoomTurn(turnId);
    if (turn.state !== "queued") {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: turn.state });
    }
    const run = this.getRoomRun(turn.runId);
    this.assertRoomRunHardStopAllowsWork(run);
    if (run.state !== "running") {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: run.state });
    }
    if (this.getRoom(run.roomId).archivedAt) throw new AevorenBotError("ROOM_ARCHIVED");
    this.assertRoomTurnMembershipAllowsRetry(run, turn);
    return turn;
  }

  private assertRoomRunCanCreateTurn(run: RoomRun, parent: RoomTurn | null, hop: number): void {
    if (!["queued", "running"].includes(run.state)) {
      throw new AevorenBotError("ROOM_RUN_LIMIT_EXCEEDED", undefined, undefined, { reason: "run-state" });
    }
    this.assertRoomRunHardStopAllowsWork(run);
    if (hop > run.maxHops) {
      throw new AevorenBotError("ROOM_RUN_LIMIT_EXCEEDED", undefined, undefined, { reason: "max-hops" });
    }
    const count = this.database
      .prepare("SELECT COUNT(DISTINCT logical_turn_id) AS value FROM room_turns WHERE batch_id = ?")
      .get(run.id) as { value: number };
    if (Number(count.value) >= run.maxTurns) {
      throw new AevorenBotError("ROOM_RUN_LIMIT_EXCEEDED", undefined, undefined, { reason: "max-turns" });
    }
    if (parent) {
      const targets = this.database
        .prepare(
          `SELECT COUNT(DISTINCT to_agent_id) AS value FROM agent_handoffs
           WHERE run_id = ? AND from_logical_turn_id = ?`,
        )
        .get(run.id, parent.logicalTurnId) as { value: number };
      if (Number(targets.value) >= run.maxTargetsPerTurn) {
        throw new AevorenBotError("ROOM_RUN_LIMIT_EXCEEDED", undefined, undefined, { reason: "max-targets-per-turn" });
      }
    }
  }

  transitionRoomBatch(id: string, state: RoomBatchState, expectedVersion?: number): RoomBatch {
    const current = this.getRoomBatch(id);
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    if (!ROOM_BATCH_TRANSITIONS[current.state].includes(state)) {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    const timestamp = now();
    const terminal = !["queued", "running"].includes(state);
    const result = this.database
      .prepare(
        `UPDATE room_batches SET state = ?, version = version + 1, updated_at = ?,
         finished_at = CASE WHEN ? THEN ? ELSE NULL END
         WHERE id = ? AND version = ? AND state = ?`,
      )
      .run(state, timestamp, terminal ? 1 : 0, timestamp, id, current.version, current.state);
    if (Number(result.changes) === 0) {
      const latest = this.getRoomBatch(id);
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: latest.state });
    }
    return this.getRoomBatch(id);
  }

  transitionRoomRun(id: string, state: RoomBatchState, expectedVersion?: number): RoomRun {
    return this.transitionRoomBatch(id, state, expectedVersion);
  }

  markRoomRunWindingDown(id: string, expectedVersion?: number): RoomRun {
    const current = this.getRoomRun(id);
    if (current.windingDown) return current;
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    if (!["queued", "running"].includes(current.state)) {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    const result = this.database
      .prepare(
        `UPDATE room_batches SET is_winding_down = 1, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND state = ? AND is_winding_down = 0`,
      )
      .run(now(), id, current.version, current.state);
    if (Number(result.changes) === 0) {
      const latest = this.getRoomRun(id);
      if (latest.windingDown) return latest;
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: latest.state });
    }
    return this.getRoomRun(id);
  }

  transitionRoomTurn(
    id: string,
    state: RoomTurnState,
    options: {
      runtimeRunId?: string;
      promptCutoffSeq?: number;
      errorCode?: string | null;
      outcome?: AgentTurnOutcome;
      expectedVersion?: number;
    } = {},
  ): RoomTurn {
    const current = this.getRoomTurn(id);
    if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    if (!ROOM_TURN_TRANSITIONS[current.state].includes(state)) {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    if (options.outcome && !OUTCOMES_BY_TERMINAL_TURN_STATE[state]?.includes(options.outcome.kind)) {
      throw new AevorenBotError("INVALID_REQUEST");
    }
    const timestamp = now();
    const terminal = !["queued", "running"].includes(state);
    const result = this.database
      .prepare(
        `UPDATE room_turns SET state = ?, runtime_run_id = COALESCE(?, runtime_run_id), version = version + 1,
         prompt_cutoff_seq = COALESCE(?, prompt_cutoff_seq), last_error_code = ?,
         outcome_json = COALESCE(?, outcome_json),
         updated_at = ?, finished_at = CASE WHEN ? THEN ? ELSE NULL END
         WHERE id = ? AND version = ? AND state = ?`,
      )
      .run(
        state,
        options.runtimeRunId ?? null,
        options.promptCutoffSeq ?? null,
        options.errorCode ?? null,
        options.outcome ? JSON.stringify(options.outcome) : null,
        timestamp,
        terminal ? 1 : 0,
        timestamp,
        id,
        current.version,
        current.state,
      );
    if (Number(result.changes) === 0) {
      const latest = this.getRoomTurn(id);
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: latest.state });
    }
    return this.getRoomTurn(id);
  }

  transitionAgentTurn(
    id: string,
    state: RoomTurnState,
    options: {
      runtimeRunId?: string;
      promptCutoffSeq?: number;
      errorCode?: string | null;
      outcome?: AgentTurnOutcome;
      expectedVersion?: number;
    } = {},
  ): AgentTurn {
    return this.transitionRoomTurn(id, state, options);
  }

  transitionHandoff(id: string, state: HandoffState, expectedVersion?: number): RoomHandoff {
    const current = this.getHandoff(id);
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    if (!HANDOFF_TRANSITIONS[current.state].includes(state)) {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    const timestamp = now();
    const terminal = ["accepted", "failed", "cancelled"].includes(state);
    const result = this.database
      .prepare(
        `UPDATE agent_handoffs SET state = ?, version = version + 1, updated_at = ?,
         finished_at = CASE WHEN ? THEN ? ELSE NULL END
         WHERE id = ? AND version = ? AND state = ?`,
      )
      .run(state, timestamp, terminal ? 1 : 0, timestamp, id, current.version, current.state);
    if (Number(result.changes) === 0) {
      const latest = this.getHandoff(id);
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: latest.state });
    }
    return this.getHandoff(id);
  }

  attachRoomTurnRuntime(id: string, runtimeRunId: string): RoomTurn {
    const turn = this.getRoomTurn(id);
    if (turn.runtimeRunId === runtimeRunId) return turn;
    const batch = this.getRoomBatch(turn.batchId);
    const runtime = this.getRuntimeRun(runtimeRunId);
    const attached = this.database
      .prepare("SELECT id FROM room_turns WHERE runtime_run_id = ? AND id <> ?")
      .get(runtimeRunId, id) as { id: string } | undefined;
    if (
      turn.state !== "running" ||
      turn.runtimeRunId !== null ||
      runtime.state !== "created" ||
      runtime.sessionId !== batch.sessionId ||
      runtime.clientNonce !== batch.clientNonce ||
      runtime.executorBotId !== turn.memberBotId ||
      runtime.executionKey !== `${batch.id}:${turn.logicalTurnId}` ||
      runtime.inputGeneration !== turn.inputGeneration ||
      runtime.inputSeq !== turn.inputSeq ||
      runtime.promptCutoffSeq !== turn.promptCutoffSeq ||
      runtime.promptManifest.sessionId !== batch.sessionId ||
      runtime.promptManifest.roomId !== batch.roomId ||
      runtime.promptManifest.roomMembershipVersion !== batch.membershipVersion ||
      runtime.promptManifest.botId !== turn.memberBotId ||
      runtime.promptManifest.executorBotId !== turn.memberBotId ||
      runtime.promptManifest.generation !== turn.inputGeneration ||
      runtime.promptManifest.inputSeq !== turn.inputSeq ||
      runtime.promptManifest.promptCutoffSeq !== turn.promptCutoffSeq ||
      runtime.promptManifest.sourceTurnId !== turn.id ||
      attached
    ) {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: runtime.state });
    }
    let changes: number;
    try {
      const result = this.database
        .prepare(
          `UPDATE room_turns SET runtime_run_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND state = 'running' AND runtime_run_id IS NULL`,
        )
        .run(runtimeRunId, now(), id, turn.version);
      changes = Number(result.changes);
    } catch {
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: runtime.state });
    }
    if (changes === 0) {
      const latest = this.getRoomTurn(id);
      if (latest.runtimeRunId === runtimeRunId) return latest;
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: latest.state });
    }
    return this.getRoomTurn(id);
  }

  createRoomTurnRetry(turnId: string): RoomTurn {
    const previous = this.getRoomTurn(turnId);
    if (!["failed", "cancelled", "interrupted"].includes(previous.state)) {
      throw new AevorenBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "state" });
    }
    const batch = this.getRoomBatch(previous.batchId);
    this.assertRoomRunHardStopAllowsWork(batch);
    this.assertRoomTurnMembershipAllowsRetry(batch, previous);
    if (this.getRoom(batch.roomId).archivedAt) throw new AevorenBotError("ROOM_ARCHIVED");
    if (!["partial", "cancelled", "interrupted"].includes(batch.state)) {
      throw new AevorenBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "batch-state" });
    }
    const latestBatch = this.database
      .prepare("SELECT id FROM room_batches WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(batch.sessionId) as { id: string } | undefined;
    if (latestBatch?.id !== batch.id) {
      throw new AevorenBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "not-latest-batch" });
    }
    if (this.getActiveRoomBatch(batch.sessionId) || this.getActiveRuntimeRun(batch.sessionId)) {
      throw new AevorenBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "active-batch" });
    }
    const attempt = this.database
      .prepare("SELECT COALESCE(MAX(attempt_no), 0) AS value FROM room_turns WHERE batch_id = ? AND logical_turn_id = ?")
      .get(previous.batchId, previous.logicalTurnId) as { value: number };
    if (Number(attempt.value) !== previous.attemptNo) {
      throw new AevorenBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "not-latest" });
    }
    const id = randomUUID();
    const timestamp = now();
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO room_turns(
             id, batch_id, member_bot_id, member_name_snapshot, logical_turn_id, parent_turn_id, nonce,
             hop, origin, input_generation, input_seq, position, attempt_no, version, state, outcome_json,
             runtime_run_id, prompt_cutoff_seq, last_error_code, created_at, updated_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'retry', ?, ?, ?, ?, 1, 'queued', NULL, NULL, ?, NULL, ?, ?, NULL)`,
        )
        .run(
          id,
          previous.batchId,
          previous.memberBotId,
          previous.memberNameSnapshot,
          previous.logicalTurnId,
          previous.parentTurnId,
          randomUUID(),
          previous.hop,
          previous.inputGeneration,
          previous.inputSeq,
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
    this.assertRoomRunHardStopAllowsWork(batch);
    if (this.getRoom(batch.roomId).archivedAt) throw new AevorenBotError("ROOM_ARCHIVED");
    if (!["interrupted", "partial"].includes(batch.state)) {
      throw new AevorenBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "batch-state" });
    }
    const latestBatch = this.database
      .prepare("SELECT id FROM room_batches WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(batch.sessionId) as { id: string } | undefined;
    if (latestBatch?.id !== batch.id) {
      throw new AevorenBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "not-latest-batch" });
    }
    if (this.getActiveRoomBatch(batch.sessionId) || this.getActiveRuntimeRun(batch.sessionId)) {
      throw new AevorenBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "active-batch" });
    }
    const allTurns = this.listRoomTurns(batchId);
    const latest = new Map<string, RoomTurn>();
    for (const turn of allTurns) {
      const previous = latest.get(turn.logicalTurnId);
      if (!previous || previous.attemptNo < turn.attemptNo) latest.set(turn.logicalTurnId, turn);
    }
    const remaining = [...latest.values()].filter(
      (turn) => turn.state === "interrupted" && turn.promptCutoffSeq === null,
    );
    if (remaining.length === 0) {
      throw new AevorenBotError("ROOM_TURN_RETRY_UNSAFE", undefined, undefined, { reason: "no-remaining" });
    }
    for (const turn of remaining) this.assertRoomTurnMembershipAllowsRetry(batch, turn);
    const timestamp = now();
    const created: string[] = [];
    this.transaction(() => {
      const insert = this.database.prepare(
        `INSERT INTO room_turns(
           id, batch_id, member_bot_id, member_name_snapshot, logical_turn_id, parent_turn_id, nonce,
           hop, origin, input_generation, input_seq, position, attempt_no, version, state, outcome_json,
           runtime_run_id, prompt_cutoff_seq, last_error_code, created_at, updated_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'retry', ?, ?, ?, ?, 1, 'queued', NULL, NULL, NULL, NULL, ?, ?, NULL)`,
      );
      for (const turn of remaining) {
        const id = randomUUID();
        created.push(id);
        insert.run(
          id,
          batchId,
          turn.memberBotId,
          turn.memberNameSnapshot,
          turn.logicalTurnId,
          turn.parentTurnId,
          randomUUID(),
          turn.hop,
          turn.inputGeneration,
          turn.inputSeq,
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
      const previous = latest.get(turn.logicalTurnId);
      if (!previous || previous.attemptNo < turn.attemptNo) latest.set(turn.logicalTurnId, turn);
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
    if (!row) throw new AevorenBotError("MESSAGE_NOT_FOUND");
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
    if (Number(result.changes) === 0) throw new AevorenBotError("MESSAGE_NOT_FOUND");
    return this.getSendOrThrow(clientNonce);
  }

  setSendProviderRequestId(clientNonce: string, providerRequestId: string): SendJournalEntry {
    const result = this.database
      .prepare("UPDATE send_journal SET provider_request_id = ?, updated_at = ? WHERE client_nonce = ?")
      .run(providerRequestId, now(), clientNonce);
    if (Number(result.changes) === 0) throw new AevorenBotError("MESSAGE_NOT_FOUND");
    return this.getSendOrThrow(clientNonce);
  }

  queueRetry(clientNonce: string): SendJournalEntry {
    const journal = this.getSendOrThrow(clientNonce);
    if (journal.state !== "failed-before-acceptance") throw new AevorenBotError("MESSAGE_RETRY_UNSAFE");
    if (this.getActiveRuntimeRun(journal.sessionId)) throw new AevorenBotError("SESSION_BUSY");
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
    if (!row) throw new AevorenBotError("TRANSCRIPT_ENTRY_NOT_FOUND");
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
    options: { executorBotId?: string; executionKey?: string; inputSeq?: number; promptCutoffSeq?: number } = {},
  ): RuntimeRun {
    const journal = this.getSendOrThrow(clientNonce);
    const input = this.getUserMessage(clientNonce);
    if (this.getActiveRuntimeRun(journal.sessionId)) throw new AevorenBotError("SESSION_BUSY");
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
          options.inputSeq ?? input.seq,
          options.promptCutoffSeq ?? input.seq,
          JSON.stringify(promptManifest),
          timestamp,
          timestamp,
        );
    } catch (error) {
      if (this.getActiveRuntimeRun(journal.sessionId)) throw new AevorenBotError("SESSION_BUSY");
      throw error;
    }
    return this.getRuntimeRun(id);
  }

  getRuntimeRun(id: string): RuntimeRun {
    const row = this.database.prepare("SELECT * FROM runtime_runs WHERE id = ?").get(id) as RuntimeRow | undefined;
    if (!row) throw new AevorenBotError("RUNTIME_NOT_FOUND");
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
      throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: current.state });
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
      throw new AevorenBotError("RUNTIME_RETRY_UNSAFE", undefined, undefined, { reason: "state" });
    }
    if (this.getActiveRuntimeRun(run.sessionId)) {
      throw new AevorenBotError("RUNTIME_RETRY_UNSAFE", undefined, undefined, { reason: "active-run" });
    }
    const journal = this.getSendOrThrow(run.clientNonce);
    if (journal.state !== "acked") {
      throw new AevorenBotError("RUNTIME_RETRY_UNSAFE", undefined, undefined, { reason: "message-not-acked" });
    }
    const latest = this.getLatestUserMessage(run.sessionId);
    if (latest?.clientNonce !== run.clientNonce) {
      throw new AevorenBotError("RUNTIME_RETRY_UNSAFE", undefined, undefined, { reason: "not-latest" });
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
    const turns = this.database
      .prepare(
        `SELECT room_turns.id, room_turns.batch_id, room_turns.runtime_run_id,
          room_batches.state AS batch_state, runtime_runs.state AS runtime_state,
          runtime_runs.assistant_entry_id, runtime_runs.last_error_code AS runtime_last_error_code
         FROM room_turns
         INNER JOIN room_batches ON room_batches.id = room_turns.batch_id
         LEFT JOIN runtime_runs ON runtime_runs.id = room_turns.runtime_run_id
         WHERE room_turns.state IN ('queued', 'running')`,
      )
      .all() as Array<{
        id: string;
        batch_id: string;
        runtime_run_id: string | null;
        batch_state: RoomBatchState;
        runtime_state: RuntimeState | null;
        assistant_entry_id: string | null;
        runtime_last_error_code: string | null;
      }>;
    const batchIds = new Set((this.database
      .prepare("SELECT id FROM room_batches WHERE state IN ('queued', 'running')")
      .all() as Array<{ id: string }>).map((batch) => batch.id));
    for (const turn of turns) batchIds.add(turn.batch_id);
    const openHandoffs = this.database
      .prepare("SELECT id FROM agent_handoffs WHERE state IN ('queued', 'dispatching')")
      .all() as Array<{ id: string }>;
    if (batchIds.size === 0 && openHandoffs.length === 0) return 0;
    const timestamp = now();
    this.transaction(() => {
      if (openHandoffs.length > 0) {
        this.database
          .prepare(
            `UPDATE agent_handoffs SET state = 'cancelled', version = version + 1,
             updated_at = ?, finished_at = ? WHERE state IN ('queued', 'dispatching')`,
          )
          .run(timestamp, timestamp);
      }
      const updateTurn = this.database.prepare(
        `UPDATE room_turns SET state = ?, version = version + 1,
         last_error_code = ?, updated_at = ?, finished_at = ? WHERE id = ?`,
      );
      for (const turn of turns) {
        let nextState: RoomTurnState;
        let errorCode: string | null;
        if (turn.batch_state === "cancelled" && turn.runtime_run_id && turn.runtime_state && ACTIVE_RUNTIME_STATES.includes(turn.runtime_state)) {
          if (turn.runtime_state !== "cancel-requested") {
            this.transitionRuntimeRun(turn.runtime_run_id, "cancel-requested", { errorCode: "MESSAGE_CANCELLED" });
          }
          this.transitionRuntimeRun(turn.runtime_run_id, "cancelled", { errorCode: "MESSAGE_CANCELLED" });
          if (turn.assistant_entry_id) {
            const assistant = this.getTranscriptEntry(turn.assistant_entry_id);
            if (assistant.status === "streaming") this.updateTranscriptRecord(assistant.id, undefined, "cancelled");
          }
          nextState = "cancelled";
          errorCode = "MESSAGE_CANCELLED";
        } else if (turn.runtime_state && TERMINAL_RUNTIME_STATES.includes(turn.runtime_state)) {
          nextState = turn.runtime_state as RoomTurnState;
          errorCode = nextState === "completed"
            ? null
            : nextState === "cancelled"
              ? "MESSAGE_CANCELLED"
              : turn.runtime_last_error_code ?? "APP_INTERRUPTED";
        } else if (turn.batch_state === "cancelled") {
          nextState = "cancelled";
          errorCode = "MESSAGE_CANCELLED";
        } else {
          nextState = "interrupted";
          errorCode = "APP_INTERRUPTED";
        }
        updateTurn.run(nextState, errorCode, timestamp, timestamp, turn.id);
      }
      for (const batchId of batchIds) {
        const batch = this.getRoomBatch(batchId);
        if (!["queued", "running"].includes(batch.state)) continue;
        const latest = new Map<string, RoomTurn>();
        for (const turn of this.listRoomTurns(batchId)) {
          const previous = latest.get(turn.logicalTurnId);
          if (!previous || previous.attemptNo < turn.attemptNo) latest.set(turn.logicalTurnId, turn);
        }
        const states = [...latest.values()].map((turn) => turn.state);
        const batchState: RoomBatchState = states.every((state) => state === "completed")
          ? "completed"
          : states.every((state) => state === "cancelled")
            ? "cancelled"
            : states.every((state) => state === "interrupted")
              ? "interrupted"
              : "partial";
        this.transitionRoomBatch(batchId, batchState);
      }
    });
    return batchIds.size;
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
