import { createHash, randomInt, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentTurn,
  AgentTurnOutcome,
  AgentTurnOrigin,
  ApprovalRequest,
  ApprovalResolution,
  AttachmentDraft,
  MessageAttachment,
  Bot,
  BotDeleteResult,
  BotPatch,
  CapabilityEffectClass,
  ConversationBatchDeleteInput,
  ConversationBatchDeleteResult,
  CreateHandoffInput,
  CreateRoomRunInput,
  DecisionAnswer,
  DecisionJournalEntry,
  DecisionProviderKind,
  DecisionState,
  ExecutionEvidenceReceipt,
  HandoffState,
  HandoffVisibility,
  MemoryItem,
  MemoryKind,
  MemoryProposal,
  MemoryProposalState,
  MemoryScope,
  MemoryScopeSelector,
  MemorySource,
  McpServerStatus,
  McpTransportKind,
  ModelSelection,
  PromptManifest,
  ProviderDriverKind,
  Room,
  RoomBatch,
  RoomBatchState,
  RoomDetail,
  RoomDeleteResult,
  RoomMember,
  RoomPatch,
  RoomSendCommand,
  RoomHandoff,
  RoomHandoffRejectionView,
  RoomRun,
  RoomRoutingMode,
  RoomTurn,
  RoomTurnState,
  Routine,
  RoutineRun,
  RoutineSchedule,
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
  ToolApprovalResult,
  ToolInvocation,
  ToolInvocationCommand,
  ToolInvocationState,
  ToolPrepareResult,
  ToolRequest,
  TeamTemplateCreateResult,
  Workspace,
  WorkspaceRegistrationResult,
} from "@shared/contracts";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES } from "@shared/bot-avatar";
import { normalizeBotAvatarColor, normalizeBotAvatarShape } from "@shared/bot-avatar";
import { messageAttachmentsSchema, toolInvocationCommandSchema } from "@shared/schemas";
import { AevorenBotError } from "./errors";
import { containsLikelySecret } from "./memory-safety";

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

const TOOL_INVOCATION_TRANSITIONS: Record<ToolInvocationState, readonly ToolInvocationState[]> = {
  prepared: ["awaiting-approval"],
  "awaiting-approval": ["cancelled"],
  approved: ["dispatching", "cancelled", "expired"],
  dispatching: ["running", "failed-before-execution", "cancelled", "interrupted-unknown"],
  running: ["succeeded", "failed", "cancelled", "interrupted-unknown"],
  succeeded: [],
  failed: [],
  denied: [],
  expired: [],
  cancelled: [],
  "failed-before-execution": [],
  "interrupted-unknown": [],
};

const TERMINAL_TOOL_INVOCATION_STATES: readonly ToolInvocationState[] = [
  "succeeded",
  "failed",
  "denied",
  "expired",
  "cancelled",
  "failed-before-execution",
  "interrupted-unknown",
];

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
const MAX_ACTIVE_MEMORIES_PER_BOT = 100;
const MAX_ACTIVE_MEMORY_CHARACTERS = 20_000;
export const MAX_RUNTIME_MEMORY_BYTES = 24_000;

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
  {
    version: 8,
    sql: `
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
        content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
        source TEXT NOT NULL CHECK (source = 'manual-user'),
        version INTEGER NOT NULL CHECK (version > 0),
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX memory_one_active_content_per_bot
        ON memory_items(bot_id, content_digest) WHERE deleted_at IS NULL;
      CREATE INDEX memory_items_by_bot
        ON memory_items(bot_id, deleted_at, created_at, id);
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        tool_invocation_id TEXT NOT NULL UNIQUE
          REFERENCES tool_invocations(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        runtime_run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        action_kind TEXT NOT NULL CHECK (action_kind IN ('workspace-list', 'workspace-read', 'workspace-search')),
        workspace_id TEXT NOT NULL,
        target_path TEXT NOT NULL CHECK (length(target_path) <= 1024),
        target_digest TEXT NOT NULL CHECK (length(target_digest) = 64),
        arguments_digest TEXT NOT NULL CHECK (length(arguments_digest) = 64),
        requested_scope TEXT NOT NULL CHECK (requested_scope = 'once'),
        state TEXT NOT NULL CHECK (state IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
        resolution TEXT CHECK (resolution IS NULL OR resolution IN ('allow-once', 'deny')),
        policy_version INTEGER NOT NULL CHECK (policy_version > 0),
        version INTEGER NOT NULL CHECK (version > 0),
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tool_invocations (
        id TEXT PRIMARY KEY,
        runtime_run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL CHECK (length(tool_call_id) BETWEEN 1 AND 200),
        idempotency_key TEXT NOT NULL UNIQUE,
        command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
        tool_kind TEXT NOT NULL CHECK (tool_kind IN ('workspace-list', 'workspace-read', 'workspace-search')),
        workspace_id TEXT NOT NULL,
        target_path TEXT NOT NULL CHECK (length(target_path) <= 1024),
        arguments_json TEXT NOT NULL CHECK (length(arguments_json) BETWEEN 2 AND 4096),
        state TEXT NOT NULL CHECK (
          state IN (
            'prepared', 'awaiting-approval', 'approved', 'dispatching', 'running', 'succeeded',
            'denied', 'expired', 'cancelled', 'failed-before-execution', 'interrupted-unknown'
          )
        ),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        approval_request_id TEXT NOT NULL UNIQUE
          REFERENCES approval_requests(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
        result_metadata_json TEXT,
        last_error_code TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(runtime_run_id, tool_call_id)
      );

      CREATE INDEX tool_invocations_by_session
        ON tool_invocations(session_id, state, created_at, id);
      CREATE INDEX tool_invocations_by_runtime
        ON tool_invocations(runtime_run_id, created_at, id);
      CREATE INDEX approval_requests_pending
        ON approval_requests(state, expires_at, created_at, id);
    `,
  },
  {
    version: 10,
    foreignKeysOff: true,
    sql: `
      CREATE TABLE tool_invocations_v10 (
        id TEXT PRIMARY KEY,
        runtime_run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL CHECK (length(tool_call_id) BETWEEN 1 AND 200),
        idempotency_key TEXT NOT NULL UNIQUE,
        command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
        tool_kind TEXT NOT NULL CHECK (tool_kind IN ('workspace-list', 'workspace-read', 'workspace-search')),
        workspace_id TEXT NOT NULL,
        target_path TEXT NOT NULL CHECK (length(target_path) <= 1024),
        arguments_json TEXT NOT NULL CHECK (length(arguments_json) BETWEEN 2 AND 4096),
        state TEXT NOT NULL CHECK (
          state IN (
            'prepared', 'awaiting-approval', 'approved', 'dispatching', 'running', 'succeeded', 'failed',
            'denied', 'expired', 'cancelled', 'failed-before-execution', 'interrupted-unknown'
          )
        ),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        approval_request_id TEXT NOT NULL UNIQUE
          REFERENCES approval_requests(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
        result_metadata_json TEXT,
        last_error_code TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(runtime_run_id, tool_call_id)
      );

      INSERT INTO tool_invocations_v10(
        id, runtime_run_id, session_id, executor_bot_id, tool_call_id, idempotency_key,
        command_digest, tool_kind, workspace_id, target_path, arguments_json, state,
        attempt_count, approval_request_id, result_digest, result_metadata_json,
        last_error_code, version, created_at, updated_at, started_at, finished_at
      )
      SELECT id, runtime_run_id, session_id, executor_bot_id, tool_call_id, idempotency_key,
             command_digest, tool_kind, workspace_id, target_path, arguments_json, state,
             attempt_count, approval_request_id, result_digest, result_metadata_json,
             last_error_code, version, created_at, updated_at, started_at, finished_at
      FROM tool_invocations;

      DROP TABLE tool_invocations;
      ALTER TABLE tool_invocations_v10 RENAME TO tool_invocations;
      CREATE INDEX tool_invocations_by_session
        ON tool_invocations(session_id, state, created_at, id);
      CREATE INDEX tool_invocations_by_runtime
        ON tool_invocations(runtime_run_id, created_at, id);

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        canonical_root TEXT NOT NULL,
        canonical_root_digest TEXT NOT NULL CHECK (length(canonical_root_digest) = 64),
        version INTEGER NOT NULL CHECK (version > 0),
        removed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX workspace_active_canonical_root
        ON workspaces(canonical_root) WHERE removed_at IS NULL;
      CREATE INDEX workspaces_visible
        ON workspaces(removed_at, created_at, id);
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE rooms ADD COLUMN pinned_at TEXT;
      ALTER TABLE rooms ADD COLUMN has_unread INTEGER NOT NULL DEFAULT 0 CHECK (has_unread IN (0, 1));

      CREATE INDEX rooms_sidebar_state
        ON rooms(archived_at, pinned_at, created_at);
    `,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE rooms ADD COLUMN hidden_at TEXT;

      DROP INDEX rooms_sidebar_state;
      CREATE INDEX rooms_sidebar_state
        ON rooms(archived_at, hidden_at, pinned_at, created_at);
    `,
  },
  {
    version: 13,
    foreignKeysOff: true,
    sql: `
      CREATE TABLE provider_instances (
        id TEXT PRIMARY KEY,
        driver_kind TEXT NOT NULL CHECK (driver_kind IN ('openai-compatible', 'codex-cli')),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
        config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO provider_instances(id, driver_kind, display_name, config_json, enabled, version, created_at, updated_at)
      VALUES (
        'openai-compatible.default',
        'openai-compatible',
        'OpenAI-compatible',
        json_object('baseUrl', COALESCE((SELECT value FROM app_settings WHERE key = 'model.baseUrl'), 'https://api.openai.com/v1')),
        1,
        1,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
      INSERT INTO provider_instances(id, driver_kind, display_name, config_json, enabled, version, created_at, updated_at)
      VALUES (
        'codex.default',
        'codex-cli',
        'Codex CLI',
        json_object('cliPath', 'codex'),
        1,
        1,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );

      ALTER TABLE bots ADD COLUMN provider_instance_id TEXT NOT NULL DEFAULT 'openai-compatible.default';
      ALTER TABLE bots ADD COLUMN model_id TEXT NOT NULL DEFAULT '';
      UPDATE bots
      SET provider_instance_id = CASE
            WHEN COALESCE((SELECT trim(value) FROM app_settings WHERE key = 'model.modelId'), '') <> ''
              THEN 'openai-compatible.default'
            ELSE 'codex.default'
          END,
          model_id = COALESCE((SELECT trim(value) FROM app_settings WHERE key = 'model.modelId'), '');

      INSERT OR IGNORE INTO app_settings(key, value, encrypted, updated_at)
      VALUES (
        'provider.defaultInstanceId',
        CASE
          WHEN COALESCE((SELECT trim(value) FROM app_settings WHERE key = 'model.modelId'), '') <> ''
            THEN 'openai-compatible.default'
          ELSE 'codex.default'
        END,
        0,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
      INSERT OR IGNORE INTO app_settings(key, value, encrypted, updated_at)
      VALUES (
        'provider.defaultModelId',
        COALESCE((SELECT trim(value) FROM app_settings WHERE key = 'model.modelId'), ''),
        0,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );

      CREATE TABLE runtime_runs_v13 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL REFERENCES send_journal(client_nonce) ON DELETE CASCADE,
        execution_key TEXT NOT NULL,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        state TEXT NOT NULL CHECK (state IN (
          'created', 'dispatching', 'running', 'streaming', 'cancel-requested',
          'completed', 'failed', 'cancelled', 'interrupted'
        )),
        route TEXT NOT NULL CHECK (route IN ('fake', 'openai-compatible', 'codex-cli')),
        provider_instance_id TEXT NOT NULL,
        provider_model_id TEXT NOT NULL,
        input_generation INTEGER NOT NULL,
        input_seq INTEGER NOT NULL,
        prompt_cutoff_seq INTEGER NOT NULL,
        assistant_entry_id TEXT REFERENCES transcript_entries(id) ON DELETE SET NULL,
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
      INSERT INTO runtime_runs_v13(
        id, session_id, client_nonce, execution_key, executor_bot_id, attempt_no, state, route,
        provider_instance_id, provider_model_id, input_generation, input_seq, prompt_cutoff_seq,
        assistant_entry_id, provider_request_id, prompt_manifest_json, version, last_error_code,
        created_at, accepted_at, last_activity_at, finished_at
      )
      SELECT id, session_id, client_nonce, execution_key, executor_bot_id, attempt_no, state, route,
             CASE WHEN route = 'fake' THEN 'fake' ELSE 'openai-compatible.default' END,
             CASE WHEN route = 'fake' THEN '' ELSE COALESCE((SELECT trim(value) FROM app_settings WHERE key = 'model.modelId'), '') END,
             input_generation, input_seq, prompt_cutoff_seq, assistant_entry_id, provider_request_id,
             prompt_manifest_json, version, last_error_code, created_at, accepted_at, last_activity_at, finished_at
      FROM runtime_runs;

      DROP TABLE runtime_runs;
      ALTER TABLE runtime_runs_v13 RENAME TO runtime_runs;
      CREATE UNIQUE INDEX runtime_one_active_per_session
        ON runtime_runs(session_id)
        WHERE state IN ('created', 'dispatching', 'running', 'streaming', 'cancel-requested');

      INSERT OR IGNORE INTO app_settings(key, value, encrypted, updated_at)
      SELECT 'provider.openai-compatible.default.apiKey', value, encrypted, updated_at
      FROM app_settings WHERE key = 'model.apiKey';
      DELETE FROM app_settings WHERE key IN ('model.baseUrl', 'model.modelId', 'model.apiKey');

      CREATE INDEX provider_instances_by_driver ON provider_instances(driver_kind, enabled, created_at, id);
    `,
  },
  {
    version: 14,
    foreignKeysOff: true,
    sql: `
      CREATE TABLE provider_instances_v14 (
        id TEXT PRIMARY KEY,
        driver_kind TEXT NOT NULL CHECK (driver_kind IN ('openai-compatible', 'codex-cli', 'claude-cli', 'ollama-cli')),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
        config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO provider_instances_v14
      SELECT id, driver_kind, display_name, config_json, enabled, version, created_at, updated_at
      FROM provider_instances;
      DROP TABLE provider_instances;
      ALTER TABLE provider_instances_v14 RENAME TO provider_instances;

      INSERT INTO provider_instances(id, driver_kind, display_name, config_json, enabled, version, created_at, updated_at)
      VALUES (
        'claude.default',
        'claude-cli',
        'Claude Code',
        json_object('cliPath', 'claude'),
        1,
        1,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
      INSERT INTO provider_instances(id, driver_kind, display_name, config_json, enabled, version, created_at, updated_at)
      VALUES (
        'ollama.default',
        'ollama-cli',
        'Ollama',
        json_object('cliPath', 'ollama'),
        1,
        1,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
      CREATE INDEX provider_instances_by_driver ON provider_instances(driver_kind, enabled, created_at, id);

      CREATE TABLE runtime_runs_v14 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL REFERENCES send_journal(client_nonce) ON DELETE CASCADE,
        execution_key TEXT NOT NULL,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        state TEXT NOT NULL CHECK (state IN (
          'created', 'dispatching', 'running', 'streaming', 'cancel-requested',
          'completed', 'failed', 'cancelled', 'interrupted'
        )),
        route TEXT NOT NULL CHECK (route IN ('fake', 'openai-compatible', 'codex-cli', 'claude-cli', 'ollama-cli')),
        provider_instance_id TEXT NOT NULL,
        provider_model_id TEXT NOT NULL,
        input_generation INTEGER NOT NULL,
        input_seq INTEGER NOT NULL,
        prompt_cutoff_seq INTEGER NOT NULL,
        assistant_entry_id TEXT REFERENCES transcript_entries(id) ON DELETE SET NULL,
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
      INSERT INTO runtime_runs_v14(
        id, session_id, client_nonce, execution_key, executor_bot_id, attempt_no, state, route,
        provider_instance_id, provider_model_id, input_generation, input_seq, prompt_cutoff_seq,
        assistant_entry_id, provider_request_id, prompt_manifest_json, version, last_error_code,
        created_at, accepted_at, last_activity_at, finished_at
      )
      SELECT id, session_id, client_nonce, execution_key, executor_bot_id, attempt_no, state, route,
             provider_instance_id, provider_model_id, input_generation, input_seq, prompt_cutoff_seq,
             assistant_entry_id, provider_request_id, prompt_manifest_json, version, last_error_code,
             created_at, accepted_at, last_activity_at, finished_at
      FROM runtime_runs;
      DROP TABLE runtime_runs;
      ALTER TABLE runtime_runs_v14 RENAME TO runtime_runs;
      CREATE UNIQUE INDEX runtime_one_active_per_session
        ON runtime_runs(session_id)
        WHERE state IN ('created', 'dispatching', 'running', 'streaming', 'cancel-requested');
    `,
  },
  {
    version: 15,
    foreignKeysOff: true,
    sql: `
      CREATE TABLE provider_instances_v15 (
        id TEXT PRIMARY KEY,
        driver_kind TEXT NOT NULL CHECK (driver_kind IN ('openai-compatible', 'codex-cli', 'claude-cli', 'ollama-cli', 'acp-cli')),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
        config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO provider_instances_v15
      SELECT id, driver_kind, display_name, config_json, enabled, version, created_at, updated_at
      FROM provider_instances;
      DROP TABLE provider_instances;
      ALTER TABLE provider_instances_v15 RENAME TO provider_instances;

      INSERT INTO provider_instances(id, driver_kind, display_name, config_json, enabled, version, created_at, updated_at)
      VALUES
        ('grok.default', 'acp-cli', 'Grok Build', json_object('adapter', 'grok', 'cliPath', 'grok'), 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('kimi.default', 'acp-cli', 'Kimi Code', json_object('adapter', 'kimi', 'cliPath', 'kimi'), 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('droid.default', 'acp-cli', 'Factory Droid', json_object('adapter', 'droid', 'cliPath', 'droid'), 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('cursor.default', 'acp-cli', 'Cursor Agent', json_object('adapter', 'cursor', 'cliPath', 'cursor-agent'), 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('opencode.default', 'acp-cli', 'OpenCode', json_object('adapter', 'opencode', 'cliPath', 'opencode'), 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('qwen.default', 'acp-cli', 'Qwen Code', json_object('adapter', 'qwen', 'cliPath', 'qwen'), 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('hermes.default', 'acp-cli', 'Hermes', json_object('adapter', 'hermes', 'cliPath', 'hermes'), 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('gemini.default', 'acp-cli', 'Gemini CLI', json_object('adapter', 'gemini', 'cliPath', 'gemini'), 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      CREATE INDEX provider_instances_by_driver ON provider_instances(driver_kind, enabled, created_at, id);

      CREATE TABLE runtime_runs_v15 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL REFERENCES send_journal(client_nonce) ON DELETE CASCADE,
        execution_key TEXT NOT NULL,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        state TEXT NOT NULL CHECK (state IN (
          'created', 'dispatching', 'running', 'streaming', 'cancel-requested',
          'completed', 'failed', 'cancelled', 'interrupted'
        )),
        route TEXT NOT NULL CHECK (route IN ('fake', 'openai-compatible', 'codex-cli', 'claude-cli', 'ollama-cli', 'acp-cli')),
        provider_instance_id TEXT NOT NULL,
        provider_model_id TEXT NOT NULL,
        input_generation INTEGER NOT NULL,
        input_seq INTEGER NOT NULL,
        prompt_cutoff_seq INTEGER NOT NULL,
        assistant_entry_id TEXT REFERENCES transcript_entries(id) ON DELETE SET NULL,
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
      INSERT INTO runtime_runs_v15
      SELECT id, session_id, client_nonce, execution_key, executor_bot_id, attempt_no, state, route,
             provider_instance_id, provider_model_id, input_generation, input_seq, prompt_cutoff_seq,
             assistant_entry_id, provider_request_id, prompt_manifest_json, version, last_error_code,
             created_at, accepted_at, last_activity_at, finished_at
      FROM runtime_runs;
      DROP TABLE runtime_runs;
      ALTER TABLE runtime_runs_v15 RENAME TO runtime_runs;
      CREATE UNIQUE INDEX runtime_one_active_per_session
        ON runtime_runs(session_id)
        WHERE state IN ('created', 'dispatching', 'running', 'streaming', 'cancel-requested');
    `,
  },
  {
    version: 16,
    foreignKeysOff: true,
    sql: `
      ALTER TABLE bots ADD COLUMN mcp_server_ids_json TEXT
        CHECK (mcp_server_ids_json IS NULL OR (json_valid(mcp_server_ids_json) AND json_type(mcp_server_ids_json) = 'array'));

      CREATE TABLE approval_requests_v16 (
        id TEXT PRIMARY KEY,
        tool_invocation_id TEXT NOT NULL UNIQUE
          REFERENCES tool_invocations_v16(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        runtime_run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        action_kind TEXT NOT NULL CHECK (action_kind IN (
          'workspace-list', 'workspace-read', 'workspace-search',
          'web-search', 'weather-current', 'time-now', 'mcp-call', 'clipboard-read'
        )),
        effect_class TEXT NOT NULL CHECK (effect_class IN ('pure', 'read-local', 'read-remote')),
        workspace_id TEXT,
        target_path TEXT NOT NULL CHECK (length(target_path) <= 2048),
        target_digest TEXT NOT NULL CHECK (length(target_digest) = 64),
        arguments_digest TEXT NOT NULL CHECK (length(arguments_digest) = 64),
        requested_scope TEXT NOT NULL CHECK (requested_scope = 'once'),
        state TEXT NOT NULL CHECK (state IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
        resolution TEXT CHECK (resolution IS NULL OR resolution IN ('allow-once', 'deny')),
        policy_version INTEGER NOT NULL CHECK (policy_version > 0),
        version INTEGER NOT NULL CHECK (version > 0),
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tool_invocations_v16 (
        id TEXT PRIMARY KEY,
        runtime_run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL CHECK (length(tool_call_id) BETWEEN 1 AND 200),
        idempotency_key TEXT NOT NULL UNIQUE,
        command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
        tool_kind TEXT NOT NULL CHECK (tool_kind IN (
          'workspace-list', 'workspace-read', 'workspace-search',
          'web-search', 'weather-current', 'time-now', 'mcp-call', 'clipboard-read'
        )),
        effect_class TEXT NOT NULL CHECK (effect_class IN ('pure', 'read-local', 'read-remote')),
        workspace_id TEXT,
        target_path TEXT NOT NULL CHECK (length(target_path) <= 2048),
        arguments_json TEXT NOT NULL CHECK (length(arguments_json) BETWEEN 2 AND 16384),
        state TEXT NOT NULL CHECK (
          state IN (
            'prepared', 'awaiting-approval', 'approved', 'dispatching', 'running', 'succeeded', 'failed',
            'denied', 'expired', 'cancelled', 'failed-before-execution', 'interrupted-unknown'
          )
        ),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        approval_request_id TEXT NOT NULL UNIQUE
          REFERENCES approval_requests_v16(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
        result_metadata_json TEXT,
        last_error_code TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(runtime_run_id, tool_call_id)
      );

      INSERT INTO approval_requests_v16(
        id, tool_invocation_id, runtime_run_id, session_id, executor_bot_id,
        action_kind, effect_class, workspace_id, target_path, target_digest, arguments_digest,
        requested_scope, state, resolution, policy_version, version,
        expires_at, resolved_at, created_at, updated_at
      )
      SELECT id, tool_invocation_id, runtime_run_id, session_id, executor_bot_id,
             action_kind, 'read-local', workspace_id, target_path, target_digest, arguments_digest,
             requested_scope, state, resolution, policy_version, version,
             expires_at, resolved_at, created_at, updated_at
      FROM approval_requests;

      INSERT INTO tool_invocations_v16(
        id, runtime_run_id, session_id, executor_bot_id, tool_call_id, idempotency_key,
        command_digest, tool_kind, effect_class, workspace_id, target_path, arguments_json, state,
        attempt_count, approval_request_id, result_digest, result_metadata_json,
        last_error_code, version, created_at, updated_at, started_at, finished_at
      )
      SELECT id, runtime_run_id, session_id, executor_bot_id, tool_call_id, idempotency_key,
             command_digest, tool_kind, 'read-local', workspace_id, target_path, arguments_json, state,
             attempt_count, approval_request_id, result_digest, result_metadata_json,
             last_error_code, version, created_at, updated_at, started_at, finished_at
      FROM tool_invocations;

      DROP TABLE tool_invocations;
      DROP TABLE approval_requests;
      ALTER TABLE approval_requests_v16 RENAME TO approval_requests;
      ALTER TABLE tool_invocations_v16 RENAME TO tool_invocations;
      CREATE INDEX tool_invocations_by_session
        ON tool_invocations(session_id, state, created_at, id);
      CREATE INDEX tool_invocations_by_runtime
        ON tool_invocations(runtime_run_id, created_at, id);
      CREATE INDEX approval_requests_pending
        ON approval_requests(state, expires_at, created_at, id);

      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 32),
        transport TEXT NOT NULL CHECK (transport IN ('stdio', 'streamable-http')),
        config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        version INTEGER NOT NULL CHECK (version > 0),
        last_status TEXT NOT NULL CHECK (last_status IN ('disabled', 'connecting', 'available', 'unavailable', 'needs-auth')),
        last_error_code TEXT,
        last_connected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX mcp_servers_enabled ON mcp_servers(enabled, name, id);
    `,
  },
  {
    version: 17,
    foreignKeysOff: true,
    sql: `
      ALTER TABLE bots ADD COLUMN memory_workspace_ids_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(memory_workspace_ids_json) AND json_type(memory_workspace_ids_json) = 'array');

      CREATE TABLE memory_items_v17 (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('user', 'bot', 'workspace')),
        scope_key TEXT NOT NULL,
        bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
        content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
        source TEXT NOT NULL CHECK (source = 'manual-user'),
        version INTEGER NOT NULL CHECK (version > 0),
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (scope = 'user' AND scope_key = 'user' AND bot_id IS NULL AND workspace_id IS NULL) OR
          (scope = 'bot' AND scope_key = bot_id AND bot_id IS NOT NULL AND workspace_id IS NULL) OR
          (scope = 'workspace' AND scope_key = workspace_id AND workspace_id IS NOT NULL AND bot_id IS NULL)
        )
      );
      INSERT INTO memory_items_v17(
        id, scope, scope_key, bot_id, workspace_id, content, content_digest,
        source, version, deleted_at, created_at, updated_at
      )
      SELECT id, 'bot', bot_id, bot_id, NULL, content, content_digest,
             source, version, deleted_at, created_at, updated_at
      FROM memory_items;
      DROP TABLE memory_items;
      ALTER TABLE memory_items_v17 RENAME TO memory_items;
      CREATE UNIQUE INDEX memory_one_active_content_per_scope
        ON memory_items(scope, scope_key, content_digest) WHERE deleted_at IS NULL;
      CREATE INDEX memory_items_by_scope
        ON memory_items(scope, scope_key, deleted_at, created_at, id);
      CREATE INDEX memory_items_by_bot
        ON memory_items(bot_id, deleted_at, created_at, id);
    `,
  },
  {
    version: 18,
    sql: `
      CREATE TABLE routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 20000),
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        schedule_json TEXT NOT NULL CHECK (json_valid(schedule_json) AND json_type(schedule_json) = 'object'),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        next_run_at INTEGER,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX routines_due ON routines(enabled, next_run_at, id);

      CREATE TABLE routine_runs (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
        routine_name TEXT NOT NULL,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        prompt_snapshot TEXT NOT NULL,
        schedule_snapshot_json TEXT NOT NULL CHECK (json_valid(schedule_snapshot_json) AND json_type(schedule_snapshot_json) = 'object'),
        trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
        trigger_key TEXT NOT NULL UNIQUE,
        scheduled_for INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'waiting', 'running', 'completed', 'failed', 'cancelled', 'missed')),
        client_nonce TEXT NOT NULL UNIQUE,
        runtime_run_id TEXT REFERENCES runtime_runs(id) ON DELETE SET NULL,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE UNIQUE INDEX routine_one_active_run
        ON routine_runs(routine_id) WHERE state IN ('queued', 'waiting', 'running');
      CREATE INDEX routine_runs_history ON routine_runs(routine_id, scheduled_for DESC, id DESC);
    `,
  },
  {
    version: 19,
    foreignKeysOff: true,
    sql: `
      CREATE TABLE approval_requests_v19 (
        id TEXT PRIMARY KEY,
        tool_invocation_id TEXT NOT NULL UNIQUE
          REFERENCES tool_invocations_v19(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        runtime_run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        action_kind TEXT NOT NULL CHECK (action_kind IN (
          'workspace-list', 'workspace-read', 'workspace-search',
          'web-search', 'web-fetch', 'weather-current', 'time-now', 'mcp-call', 'clipboard-read', 'text-measure'
        )),
        effect_class TEXT NOT NULL CHECK (effect_class IN ('pure', 'read-local', 'read-remote')),
        workspace_id TEXT,
        target_path TEXT NOT NULL CHECK (length(target_path) <= 2048),
        target_digest TEXT NOT NULL CHECK (length(target_digest) = 64),
        arguments_digest TEXT NOT NULL CHECK (length(arguments_digest) = 64),
        requested_scope TEXT NOT NULL CHECK (requested_scope = 'once'),
        state TEXT NOT NULL CHECK (state IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
        resolution TEXT CHECK (resolution IS NULL OR resolution IN ('allow-once', 'deny')),
        policy_version INTEGER NOT NULL CHECK (policy_version > 0),
        version INTEGER NOT NULL CHECK (version > 0),
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tool_invocations_v19 (
        id TEXT PRIMARY KEY,
        runtime_run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL CHECK (length(tool_call_id) BETWEEN 1 AND 200),
        idempotency_key TEXT NOT NULL UNIQUE,
        command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
        tool_kind TEXT NOT NULL CHECK (tool_kind IN (
          'workspace-list', 'workspace-read', 'workspace-search',
          'web-search', 'web-fetch', 'weather-current', 'time-now', 'mcp-call', 'clipboard-read', 'text-measure'
        )),
        effect_class TEXT NOT NULL CHECK (effect_class IN ('pure', 'read-local', 'read-remote')),
        workspace_id TEXT,
        target_path TEXT NOT NULL CHECK (length(target_path) <= 2048),
        arguments_json TEXT NOT NULL CHECK (length(arguments_json) BETWEEN 2 AND 16384),
        state TEXT NOT NULL CHECK (
          state IN (
            'prepared', 'awaiting-approval', 'approved', 'dispatching', 'running', 'succeeded', 'failed',
            'denied', 'expired', 'cancelled', 'failed-before-execution', 'interrupted-unknown'
          )
        ),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        approval_request_id TEXT NOT NULL UNIQUE
          REFERENCES approval_requests_v19(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
        result_metadata_json TEXT,
        last_error_code TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(runtime_run_id, tool_call_id)
      );

      INSERT INTO approval_requests_v19 SELECT * FROM approval_requests;
      INSERT INTO tool_invocations_v19 SELECT * FROM tool_invocations;
      DROP TABLE tool_invocations;
      DROP TABLE approval_requests;
      ALTER TABLE approval_requests_v19 RENAME TO approval_requests;
      ALTER TABLE tool_invocations_v19 RENAME TO tool_invocations;
      CREATE INDEX tool_invocations_by_session
        ON tool_invocations(session_id, state, created_at, id);
      CREATE INDEX tool_invocations_by_runtime
        ON tool_invocations(runtime_run_id, created_at, id);
      CREATE INDEX approval_requests_pending
        ON approval_requests(state, expires_at, created_at, id);
    `,
  },
  {
    version: 20,
    sql: `
      ALTER TABLE transcript_entries ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
      CREATE TABLE message_attachments (
        id TEXT PRIMARY KEY,
        transcript_entry_id TEXT NOT NULL REFERENCES transcript_entries(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL REFERENCES send_journal(client_nonce) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
        mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 120),
        size INTEGER NOT NULL CHECK (size >= 0 AND size <= 1048576),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        kind TEXT NOT NULL CHECK (kind = 'text'),
        content TEXT NOT NULL CHECK (length(content) <= 1048576),
        created_at TEXT NOT NULL
      );
      CREATE INDEX message_attachments_by_entry
        ON message_attachments(transcript_entry_id, created_at, id);
      CREATE INDEX message_attachments_by_nonce
        ON message_attachments(client_nonce, created_at, id);
    `,
  },
  {
    version: 21,
    sql: `
      CREATE TABLE decision_journal (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
        policy_id TEXT NOT NULL CHECK (length(policy_id) BETWEEN 1 AND 120),
        policy_version INTEGER NOT NULL CHECK (policy_version > 0),
        provider TEXT NOT NULL CHECK (provider IN ('rules', 'fake', 'jev')),
        model_version TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'dispatched', 'completed', 'timeout', 'failed',
          'rate-limited', 'fallback', 'cancelled'
        )),
        input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
        answers_json TEXT NOT NULL CHECK (json_valid(answers_json) AND json_type(answers_json) = 'object'),
        confidence_json TEXT NOT NULL CHECK (json_valid(confidence_json) AND json_type(confidence_json) = 'object'),
        fallback_reason TEXT,
        request_id TEXT,
        latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
        last_error_code TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX decision_journal_by_policy
        ON decision_journal(policy_id, created_at DESC, id DESC);
      CREATE INDEX decision_journal_by_state
        ON decision_journal(state, updated_at DESC, id DESC);
    `,
  },
  {
    version: 22,
    foreignKeysOff: true,
    sql: `
      CREATE TABLE memory_items_v22 (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('user', 'bot', 'workspace')),
        scope_key TEXT NOT NULL,
        bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
        content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
        kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'decision', 'procedure')),
        source TEXT NOT NULL CHECK (source IN ('manual-user', 'model-captured')),
        source_entry_id TEXT,
        expires_at TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (scope = 'user' AND scope_key = 'user' AND bot_id IS NULL AND workspace_id IS NULL) OR
          (scope = 'bot' AND scope_key = bot_id AND bot_id IS NOT NULL AND workspace_id IS NULL) OR
          (scope = 'workspace' AND scope_key = workspace_id AND workspace_id IS NOT NULL AND bot_id IS NULL)
        )
      );
      INSERT INTO memory_items_v22(
        id, scope, scope_key, bot_id, workspace_id, content, content_digest,
        kind, source, source_entry_id, expires_at, version, deleted_at, created_at, updated_at
      )
      SELECT id, scope, scope_key, bot_id, workspace_id, content, content_digest,
             'fact', source, NULL, NULL, version, deleted_at, created_at, updated_at
      FROM memory_items;
      DROP TABLE memory_items;
      ALTER TABLE memory_items_v22 RENAME TO memory_items;
      CREATE UNIQUE INDEX memory_one_active_content_per_scope
        ON memory_items(scope, scope_key, content_digest) WHERE deleted_at IS NULL;
      CREATE INDEX memory_items_by_scope
        ON memory_items(scope, scope_key, deleted_at, created_at, id);
      CREATE INDEX memory_items_by_bot
        ON memory_items(bot_id, deleted_at, created_at, id);
      CREATE INDEX memory_items_by_expiry
        ON memory_items(expires_at, deleted_at, updated_at);

      CREATE TABLE memory_proposals (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('user', 'bot', 'workspace')),
        scope_key TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'decision', 'procedure')),
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
        content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
        source_entry_id TEXT NOT NULL,
        supersedes_memory_id TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
        expires_at TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected')),
        version INTEGER NOT NULL CHECK (version > 0),
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX memory_pending_digest_per_scope
        ON memory_proposals(scope, scope_key, content_digest) WHERE state = 'pending';
      CREATE INDEX memory_proposals_by_state
        ON memory_proposals(state, created_at DESC, id DESC);
      CREATE INDEX memory_proposals_by_bot
        ON memory_proposals(bot_id, state, created_at DESC, id DESC);
    `,
  },
  {
    version: 23,
    foreignKeysOff: true,
    sql: `
      ALTER TABLE workspaces ADD COLUMN write_enabled INTEGER NOT NULL DEFAULT 0 CHECK (write_enabled IN (0, 1));
      ALTER TABLE workspaces ADD COLUMN automation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (automation_enabled IN (0, 1));

      CREATE TABLE approval_requests_v23 (
        id TEXT PRIMARY KEY,
        tool_invocation_id TEXT NOT NULL UNIQUE
          REFERENCES tool_invocations_v23(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        runtime_run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        action_kind TEXT NOT NULL CHECK (action_kind IN (
          'workspace-list', 'workspace-read', 'workspace-search', 'workspace-write',
          'web-search', 'web-fetch', 'weather-current', 'time-now', 'mcp-call', 'clipboard-read', 'text-measure'
        )),
        effect_class TEXT NOT NULL CHECK (effect_class IN ('pure', 'read-local', 'read-remote', 'write-reversible')),
        workspace_id TEXT,
        target_path TEXT NOT NULL CHECK (length(target_path) <= 2048),
        target_digest TEXT NOT NULL CHECK (length(target_digest) = 64),
        arguments_digest TEXT NOT NULL CHECK (length(arguments_digest) = 64),
        requested_scope TEXT NOT NULL CHECK (requested_scope = 'once'),
        state TEXT NOT NULL CHECK (state IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
        resolution TEXT CHECK (resolution IS NULL OR resolution IN ('allow-once', 'deny')),
        policy_version INTEGER NOT NULL CHECK (policy_version > 0),
        version INTEGER NOT NULL CHECK (version > 0),
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tool_invocations_v23 (
        id TEXT PRIMARY KEY,
        runtime_run_id TEXT NOT NULL REFERENCES runtime_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL CHECK (length(tool_call_id) BETWEEN 1 AND 200),
        idempotency_key TEXT NOT NULL UNIQUE,
        command_digest TEXT NOT NULL CHECK (length(command_digest) = 64),
        tool_kind TEXT NOT NULL CHECK (tool_kind IN (
          'workspace-list', 'workspace-read', 'workspace-search', 'workspace-write',
          'web-search', 'web-fetch', 'weather-current', 'time-now', 'mcp-call', 'clipboard-read', 'text-measure'
        )),
        effect_class TEXT NOT NULL CHECK (effect_class IN ('pure', 'read-local', 'read-remote', 'write-reversible')),
        workspace_id TEXT,
        target_path TEXT NOT NULL CHECK (length(target_path) <= 2048),
        arguments_json TEXT NOT NULL CHECK (length(arguments_json) BETWEEN 2 AND 600000),
        state TEXT NOT NULL CHECK (
          state IN (
            'prepared', 'awaiting-approval', 'approved', 'dispatching', 'running', 'succeeded', 'failed',
            'denied', 'expired', 'cancelled', 'failed-before-execution', 'interrupted-unknown'
          )
        ),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        approval_request_id TEXT NOT NULL UNIQUE
          REFERENCES approval_requests_v23(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
        result_metadata_json TEXT,
        last_error_code TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(runtime_run_id, tool_call_id)
      );

      INSERT INTO approval_requests_v23 SELECT * FROM approval_requests;
      INSERT INTO tool_invocations_v23 SELECT * FROM tool_invocations;
      DROP TABLE tool_invocations;
      DROP TABLE approval_requests;
      ALTER TABLE approval_requests_v23 RENAME TO approval_requests;
      ALTER TABLE tool_invocations_v23 RENAME TO tool_invocations;
      CREATE INDEX tool_invocations_by_session ON tool_invocations(session_id, state, created_at, id);
      CREATE INDEX tool_invocations_by_runtime ON tool_invocations(runtime_run_id, created_at, id);
      CREATE INDEX approval_requests_pending ON approval_requests(state, expires_at, created_at, id);
    `,
  },
  {
    version: 24,
    sql: `
      ALTER TABLE room_turns ADD COLUMN execution_receipt_json TEXT
        CHECK (execution_receipt_json IS NULL OR json_valid(execution_receipt_json));
      ALTER TABLE room_batches ADD COLUMN orchestration_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (orchestration_enabled IN (0, 1));
      UPDATE room_batches SET orchestration_enabled = 1 WHERE routing_mode = 'automatic';
    `,
  },
  {
    version: 25,
    sql: `
      ALTER TABLE bots ADD COLUMN avatar_shape TEXT NOT NULL DEFAULT 'rounded';
      ALTER TABLE bots ADD COLUMN avatar_color TEXT NOT NULL DEFAULT 'cobalt';
    `,
  },
] as const;

type BotRow = {
  id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  provider_instance_id: string;
  model_id: string;
  avatar_shape: string;
  avatar_color: string;
  mcp_server_ids_json: string | null;
  memory_workspace_ids_json: string;
  pinned_at: string | null;
  hidden_at: string | null;
  has_unread: number;
  deleted_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type ProviderInstanceRow = {
  id: string;
  driver_kind: ProviderDriverKind;
  display_name: string;
  config_json: string;
  enabled: number;
  version: number;
  created_at: string;
  updated_at: string;
};

type DecisionJournalRow = {
  id: string;
  idempotency_key: string;
  policy_id: string;
  policy_version: number;
  provider: DecisionProviderKind;
  model_version: string | null;
  state: DecisionState;
  input_digest: string;
  answers_json: string;
  confidence_json: string;
  fallback_reason: string | null;
  request_id: string | null;
  latency_ms: number | null;
  last_error_code: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export type ProviderInstanceConfig = {
  id: string;
  driverKind: ProviderDriverKind;
  displayName: string;
  config: Record<string, unknown>;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type MemoryRow = {
  id: string;
  scope: MemoryScope;
  scope_key: string;
  bot_id: string | null;
  workspace_id: string | null;
  content: string;
  content_digest: string;
  kind: MemoryKind;
  source: MemorySource;
  source_entry_id: string | null;
  expires_at: string | null;
  version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type MemoryProposalRow = {
  id: string;
  bot_id: string;
  scope: MemoryScope;
  scope_key: string;
  workspace_id: string | null;
  kind: MemoryKind;
  content: string;
  content_digest: string;
  reason: string;
  source_entry_id: string;
  supersedes_memory_id: string | null;
  expires_at: string | null;
  state: MemoryProposalState;
  version: number;
  resolved_at: string | null;
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
  attachments_json?: string;
  status: TranscriptStatus;
  send_state?: SendState | null;
  speaker_bot_id: string | null;
  speaker_name_snapshot: string | null;
  source_turn_id: string | null;
  updated_seq: number;
  created_at: string;
  updated_at: string;
};

type PromptAttachment = MessageAttachment & { content: string };

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
  provider_instance_id: string;
  provider_model_id: string;
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

type ToolInvocationRow = {
  id: string;
  runtime_run_id: string;
  session_id: string;
  executor_bot_id: string;
  tool_call_id: string;
  idempotency_key: string;
  command_digest: string;
  tool_kind: ToolRequest["kind"];
  effect_class: CapabilityEffectClass;
  workspace_id: string | null;
  target_path: string;
  arguments_json: string;
  state: ToolInvocationState;
  attempt_count: number;
  approval_request_id: string;
  result_digest: string | null;
  result_metadata_json: string | null;
  last_error_code: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type ApprovalRequestRow = {
  id: string;
  tool_invocation_id: string;
  runtime_run_id: string;
  session_id: string;
  executor_bot_id: string;
  action_kind: ToolRequest["kind"];
  effect_class: CapabilityEffectClass;
  workspace_id: string | null;
  target_path: string;
  target_digest: string;
  arguments_digest: string;
  requested_scope: "once";
  state: ApprovalRequest["state"];
  resolution: ApprovalResolution | null;
  policy_version: number;
  version: number;
  expires_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

type WorkspaceRow = {
  id: string;
  name: string;
  canonical_root: string;
  canonical_root_digest: string;
  write_enabled: number;
  automation_enabled: number;
  version: number;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
};

type McpServerRow = {
  id: string;
  name: string;
  transport: McpTransportKind;
  config_json: string;
  enabled: number;
  version: number;
  last_status: McpServerStatus;
  last_error_code: string | null;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
};

type RoutineRow = {
  id: string;
  name: string;
  prompt: string;
  bot_id: string;
  schedule_json: string;
  enabled: number;
  next_run_at: number | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type RoutineRunRow = {
  id: string;
  routine_id: string;
  routine_name: string;
  bot_id: string;
  prompt_snapshot: string;
  schedule_snapshot_json: string;
  trigger: "schedule" | "manual";
  trigger_key: string;
  scheduled_for: number;
  state: RoutineRun["state"];
  client_nonce: string;
  runtime_run_id: string | null;
  last_error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type McpServerConfig = {
  id: string;
  name: string;
  transport: McpTransportKind;
  config: Record<string, unknown>;
  enabled: boolean;
  version: number;
  lastStatus: McpServerStatus;
  lastErrorCode: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type RoomRow = {
  id: string;
  name: string;
  description: string;
  version: number;
  membership_version: number;
  archived_at: string | null;
  pinned_at: string | null;
  hidden_at: string | null;
  has_unread: number;
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
  provider_instance_id: string;
  model_id: string;
  avatar_shape: string;
  avatar_color: string;
  mcp_server_ids_json: string | null;
  memory_workspace_ids_json: string;
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
  orchestration_enabled: number;
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
  execution_receipt_json: string | null;
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

function randomBotAvatar(): { shape: typeof BOT_AVATAR_SHAPES[number]; color: typeof BOT_AVATAR_COLORS[number] } {
  return {
    shape: BOT_AVATAR_SHAPES[randomInt(BOT_AVATAR_SHAPES.length)]!,
    color: BOT_AVATAR_COLORS[randomInt(BOT_AVATAR_COLORS.length)]!,
  };
}

function toBot(row: BotRow): Bot {
  const mcpServerIds = row.mcp_server_ids_json === null
    ? null
    : (JSON.parse(row.mcp_server_ids_json) as unknown[]).filter((value): value is string => typeof value === "string");
  const memoryWorkspaceIds = (JSON.parse(row.memory_workspace_ids_json) as unknown[])
    .filter((value): value is string => typeof value === "string");
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    description: row.description,
    instructions: row.instructions,
    modelSelection: {
      providerInstanceId: row.provider_instance_id,
      modelId: row.model_id,
    },
    avatarShape: normalizeBotAvatarShape(row.avatar_shape),
    avatarColor: normalizeBotAvatarColor(row.avatar_color),
    mcpServerIds,
    memoryWorkspaceIds,
    pinnedAt: row.pinned_at,
    hiddenAt: row.hidden_at,
    hasUnread: row.has_unread === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProviderInstanceConfig(row: ProviderInstanceRow): ProviderInstanceConfig {
  let config: unknown;
  try {
    config = JSON.parse(row.config_json);
  } catch {
    throw new AevorenBotError("INTERNAL_ERROR");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new AevorenBotError("INTERNAL_ERROR");
  return {
    id: row.id,
    driverKind: row.driver_kind,
    displayName: row.display_name,
    config: config as Record<string, unknown>,
    enabled: row.enabled === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMemory(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    scope: row.scope,
    scopeKey: row.scope_key,
    botId: row.bot_id,
    workspaceId: row.workspace_id,
    content: row.content,
    contentDigest: row.content_digest,
    kind: row.kind,
    source: row.source,
    sourceEntryId: row.source_entry_id,
    expiresAt: row.expires_at,
    version: Number(row.version),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMemoryProposal(row: MemoryProposalRow): MemoryProposal {
  return {
    id: row.id,
    botId: row.bot_id,
    scope: row.scope,
    scopeKey: row.scope_key,
    workspaceId: row.workspace_id,
    kind: row.kind,
    content: row.content,
    contentDigest: row.content_digest,
    reason: row.reason,
    sourceEntryId: row.source_entry_id,
    supersedesMemoryId: row.supersedes_memory_id,
    expiresAt: row.expires_at,
    state: row.state,
    version: Number(row.version),
    resolvedAt: row.resolved_at,
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
    attachments: parseAttachmentMetadata(row.attachments_json),
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

function toDecisionJournal(row: DecisionJournalRow): DecisionJournalEntry {
  let answers: Record<string, DecisionAnswer>;
  let confidence: Record<string, number>;
  try {
    answers = JSON.parse(row.answers_json) as Record<string, DecisionAnswer>;
    confidence = JSON.parse(row.confidence_json) as Record<string, number>;
  } catch {
    throw new AevorenBotError("INTERNAL_ERROR");
  }
  if (!answers || typeof answers !== "object" || Array.isArray(answers) || !confidence || typeof confidence !== "object" || Array.isArray(confidence)) {
    throw new AevorenBotError("INTERNAL_ERROR");
  }
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    provider: row.provider,
    modelVersion: row.model_version,
    state: row.state,
    inputDigest: row.input_digest,
    answers,
    confidence,
    fallbackReason: row.fallback_reason,
    requestId: row.request_id,
    latencyMs: row.latency_ms,
    lastErrorCode: row.last_error_code,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toToolInvocation(row: ToolInvocationRow): ToolInvocation {
  return {
    id: row.id,
    runtimeRunId: row.runtime_run_id,
    sessionId: row.session_id,
    executorBotId: row.executor_bot_id,
    toolCallId: row.tool_call_id,
    idempotencyKey: row.idempotency_key,
    commandDigest: row.command_digest,
    toolKind: row.tool_kind,
    effectClass: row.effect_class,
    workspaceId: row.workspace_id,
    targetPath: row.target_path,
    arguments: JSON.parse(row.arguments_json) as ToolRequest,
    state: row.state,
    attemptCount: Number(row.attempt_count),
    approvalRequestId: row.approval_request_id,
    resultDigest: row.result_digest,
    resultMetadata: row.result_metadata_json
      ? JSON.parse(row.result_metadata_json) as Record<string, string | number | boolean | null>
      : null,
    lastErrorCode: row.last_error_code,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toApprovalRequest(row: ApprovalRequestRow): ApprovalRequest {
  return {
    id: row.id,
    toolInvocationId: row.tool_invocation_id,
    runtimeRunId: row.runtime_run_id,
    sessionId: row.session_id,
    executorBotId: row.executor_bot_id,
    actionKind: row.action_kind,
    effectClass: row.effect_class,
    workspaceId: row.workspace_id,
    targetPath: row.target_path,
    targetDigest: row.target_digest,
    argumentsDigest: row.arguments_digest,
    requestedScope: row.requested_scope,
    state: row.state,
    resolution: row.resolution,
    policyVersion: Number(row.policy_version),
    version: Number(row.version),
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    writeEnabled: row.write_enabled === 1,
    automationEnabled: row.automation_enabled === 1,
    version: Number(row.version),
    removedAt: row.removed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMcpServerConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    enabled: row.enabled === 1,
    version: Number(row.version),
    lastStatus: row.last_status,
    lastErrorCode: row.last_error_code,
    lastConnectedAt: row.last_connected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    botId: row.bot_id,
    enabled: row.enabled === 1,
    schedule: JSON.parse(row.schedule_json) as RoutineSchedule,
    nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRoutineRun(row: RoutineRunRow): RoutineRun {
  return {
    id: row.id,
    routineId: row.routine_id,
    routineName: row.routine_name,
    botId: row.bot_id,
    promptSnapshot: row.prompt_snapshot,
    scheduleSnapshot: JSON.parse(row.schedule_snapshot_json) as RoutineSchedule,
    trigger: row.trigger,
    triggerKey: row.trigger_key,
    scheduledFor: Number(row.scheduled_for),
    state: row.state,
    clientNonce: row.client_nonce,
    runtimeRunId: row.runtime_run_id,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
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
    pinnedAt: row.pinned_at,
    hiddenAt: row.hidden_at,
    hasUnread: row.has_unread === 1,
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
    orchestrationEnabled: row.orchestration_enabled === 1,
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
    providerInstanceId: row.provider_instance_id,
    providerModelId: row.provider_model_id,
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

export function digestMessage(text: string, attachments: readonly MessageAttachment[] = []): string {
  if (attachments.length === 0) return createHash("sha256").update(text, "utf8").digest("hex");
  return createHash("sha256")
    .update(JSON.stringify({
      text,
      attachments: attachments.map(({ id: _id, ...attachment }) => attachment),
    }), "utf8")
    .digest("hex");
}

function parseAttachmentMetadata(value: string | undefined): MessageAttachment[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const candidate = item as Record<string, unknown>;
      if (
        typeof candidate.id !== "string" || typeof candidate.name !== "string" ||
        typeof candidate.mimeType !== "string" || typeof candidate.size !== "number" ||
        typeof candidate.sha256 !== "string" || candidate.kind !== "text"
      ) return [];
      return [{
        id: candidate.id,
        name: candidate.name,
        mimeType: candidate.mimeType,
        size: candidate.size,
        sha256: candidate.sha256,
        kind: "text" as const,
      }];
    });
  } catch {
    return [];
  }
}

function normalizeAttachmentDrafts(input: readonly AttachmentDraft[] | undefined): PromptAttachment[] {
  if (!input || input.length === 0) return [];
  let parsed: AttachmentDraft[];
  try {
    parsed = messageAttachmentsSchema.parse(input) as AttachmentDraft[];
  } catch {
    throw new AevorenBotError("ATTACHMENT_INVALID");
  }
  const seen = new Set<string>();
  const result: PromptAttachment[] = [];
  for (const attachment of parsed) {
    if (seen.has(attachment.id)) throw new AevorenBotError("ATTACHMENT_INVALID");
    seen.add(attachment.id);
    const bytes = Buffer.from(attachment.content, "utf8");
    if (bytes.length !== attachment.size || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) {
      throw new AevorenBotError("ATTACHMENT_INVALID");
    }
    result.push({ ...attachment });
  }
  return result;
}

function normalizeMemoryContent(content: string): string {
  return content.trim();
}

function digestMemoryContent(content: string): string {
  return digestMessage(content.normalize("NFC").replace(/\s+/g, " ").trim());
}

function canonicalToolCommand(input: ToolInvocationCommand): string {
  return JSON.stringify({
    runtimeRunId: input.runtimeRunId,
    toolCallId: input.toolCallId,
    tool: input.tool,
  });
}

function toolEffectClass(tool: ToolRequest): CapabilityEffectClass {
  if (tool.kind === "time-now" || tool.kind === "text-measure") return "pure";
  if (tool.kind === "workspace-write") return "write-reversible";
  if (tool.kind === "web-search" || tool.kind === "web-fetch" || tool.kind === "weather-current" || tool.kind === "mcp-call") return "read-remote";
  return "read-local";
}

function toolWorkspaceId(tool: ToolRequest): string | null {
  switch (tool.kind) {
    case "workspace-list":
    case "workspace-read":
    case "workspace-search":
    case "workspace-write":
      return tool.workspaceId;
    default:
      return null;
  }
}

function toolTargetPath(tool: ToolRequest): string {
  switch (tool.kind) {
    case "workspace-list":
    case "workspace-read":
    case "workspace-search":
    case "workspace-write":
      return tool.path;
    case "web-search":
      return tool.query;
    case "web-fetch":
      return tool.url;
    case "weather-current":
      return tool.location;
    case "time-now":
      return tool.timezone ?? "local";
    case "mcp-call":
      return `${tool.serverId}:${tool.toolName}`;
    case "clipboard-read":
      return "clipboard";
    case "text-measure":
      return "text";
  }
}

function toolTargetDigest(tool: ToolRequest): string {
  return digestMessage(JSON.stringify({ kind: tool.kind, target: toolTargetPath(tool) }));
}

function defaultApprovalExpiry(): string {
  return new Date(Date.now() + 5 * 60_000).toISOString();
}

export function digestRoomCommand(
  roomId: string,
  sessionId: string,
  text: string,
  targetBotIds: string[],
  routingMode: RoomRoutingMode = "legacy",
  attachments: readonly MessageAttachment[] = [],
): string {
  const command = attachments.length === 0
    ? { roomId, sessionId, text, targetBotIds: targetBotIds.toSorted() }
    : {
        roomId,
        sessionId,
        text,
        targetBotIds: targetBotIds.toSorted(),
        attachments: attachments.map(({ id: _id, ...attachment }) => attachment),
      };
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

export type AppRepositoryOptions = {
  appVersion?: string;
  backupDirectory?: string;
};

const ROOM_RUN_SELECT = `SELECT room_batches.*,
  (SELECT COUNT(DISTINCT room_turns.logical_turn_id) FROM room_turns
   WHERE room_turns.batch_id = room_batches.id) AS used_turns
  FROM room_batches`;

export class AppRepository {
  private readonly database: DatabaseSync;

  constructor(private readonly filename: string, private readonly options: AppRepositoryOptions = {}) {
    this.database = new DatabaseSync(filename);
    try {
      this.database.exec("PRAGMA foreign_keys = ON;");
      if (filename !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    const hadMigrationTable = Boolean(this.database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get());
    const sourceSchemaVersion = hadMigrationTable
      ? Number((this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version)
      : 0;
    const targetSchemaVersion = MIGRATIONS.at(-1)?.version ?? 0;
    if (this.filename !== ":memory:" && hadMigrationTable && sourceSchemaVersion < targetSchemaVersion) {
      this.createMigrationBackup(sourceSchemaVersion, targetSchemaVersion);
    }
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

  private createMigrationBackup(sourceSchemaVersion: number, targetSchemaVersion: number): void {
    const backupDirectory = this.options.backupDirectory ?? join(dirname(this.filename), "Backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    chmodSync(backupDirectory, 0o700);
    const timestamp = now().replace(/[:.]/g, "-");
    const suffix = randomUUID().slice(0, 8);
    const baseName = `aevoren-bot-schema-v${sourceSchemaVersion}-to-v${targetSchemaVersion}-${timestamp}-${suffix}`;
    const databaseBackupPath = join(backupDirectory, `${baseName}.sqlite`);
    const metadataPath = join(backupDirectory, `${baseName}.json`);
    const sourceAppVersion = this.readLastOpenedAppVersion();
    this.database.exec(`VACUUM INTO '${databaseBackupPath.replaceAll("'", "''")}'`);
    chmodSync(databaseBackupPath, 0o600);
    const backup = new DatabaseSync(databaseBackupPath, { readOnly: true });
    try {
      const integrity = backup.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      if (integrity.integrity_check !== "ok") throw new Error("Migration backup failed integrity check");
    } finally {
      backup.close();
    }
    writeFileSync(metadataPath, `${JSON.stringify({
      createdAt: now(),
      sourceDatabase: this.filename,
      databaseBackup: databaseBackupPath,
      sourceSchemaVersion,
      targetSchemaVersion,
      sourceAppVersion,
      targetAppVersion: this.options.appVersion ?? null,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(metadataPath, 0o600);
  }

  private readLastOpenedAppVersion(): string | null {
    const hasSettings = Boolean(this.database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'")
      .get());
    if (!hasSettings) return null;
    const row = this.database.prepare("SELECT value FROM app_settings WHERE key = 'app.lastOpenedVersion'").get() as
      | { value: string }
      | undefined;
    return row?.value || null;
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

  listProviderInstanceConfigs(): ProviderInstanceConfig[] {
    return (this.database
      .prepare("SELECT * FROM provider_instances ORDER BY created_at ASC, id ASC")
      .all() as ProviderInstanceRow[]).map(toProviderInstanceConfig);
  }

  getProviderInstanceConfig(id: string): ProviderInstanceConfig {
    const row = this.database.prepare("SELECT * FROM provider_instances WHERE id = ?").get(id) as ProviderInstanceRow | undefined;
    if (!row) throw new AevorenBotError("MODEL_PROVIDER_NOT_FOUND");
    return toProviderInstanceConfig(row);
  }

  updateProviderInstanceConfig(
    id: string,
    expectedVersion: number,
    config: Record<string, unknown>,
  ): ProviderInstanceConfig {
    this.getProviderInstanceConfig(id);
    const result = this.database
      .prepare(
        `UPDATE provider_instances
         SET config_json = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(JSON.stringify(config), now(), id, expectedVersion);
    if (Number(result.changes) === 0) {
      const current = this.getProviderInstanceConfig(id);
      throw new AevorenBotError("MODEL_PROVIDER_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
    }
    return this.getProviderInstanceConfig(id);
  }

  getDefaultModelSelection(): ModelSelection {
    return {
      providerInstanceId: this.getSetting("provider.defaultInstanceId")?.value || "codex.default",
      modelId: this.getSetting("provider.defaultModelId")?.value || "",
    };
  }

  setDefaultModelSelection(selection: ModelSelection): ModelSelection {
    this.getProviderInstanceConfig(selection.providerInstanceId);
    this.transaction(() => {
      this.setSetting("provider.defaultInstanceId", selection.providerInstanceId, false);
      this.setSetting("provider.defaultModelId", selection.modelId, false);
    });
    return this.getDefaultModelSelection();
  }

  listModelIdsForProvider(providerInstanceId: string): string[] {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT model_id FROM bots
         WHERE provider_instance_id = ? AND deleted_at IS NULL AND length(trim(model_id)) > 0
         ORDER BY model_id ASC`,
      )
      .all(providerInstanceId) as Array<{ model_id: string }>;
    return rows.map((row) => row.model_id);
  }

  hasActiveRuntimeForProvider(providerInstanceId: string): boolean {
    return Boolean(this.database
      .prepare(
        `SELECT 1 FROM runtime_runs
         WHERE provider_instance_id = ?
           AND state IN ('created', 'dispatching', 'running', 'streaming', 'cancel-requested')
         LIMIT 1`,
      )
      .get(providerInstanceId));
  }

  applyDefaultSelectionToUnconfiguredBots(selection: ModelSelection): number {
    this.getProviderInstanceConfig(selection.providerInstanceId);
    const result = this.database
      .prepare(
        `UPDATE bots
         SET provider_instance_id = ?, model_id = ?, version = version + 1, updated_at = ?
         WHERE deleted_at IS NULL AND length(trim(model_id)) = 0`,
      )
      .run(selection.providerInstanceId, selection.modelId, now());
    return Number(result.changes);
  }

  applyDefaultSelectionToUnsupportedBots(
    supportedProviderInstanceIds: readonly string[],
    selection: ModelSelection,
  ): number {
    if (supportedProviderInstanceIds.length === 0) throw new AevorenBotError("INVALID_REQUEST");
    this.getProviderInstanceConfig(selection.providerInstanceId);
    const placeholders = supportedProviderInstanceIds.map(() => "?").join(",");
    const result = this.database
      .prepare(
        `UPDATE bots
         SET provider_instance_id = ?, model_id = ?, version = version + 1, updated_at = ?
         WHERE deleted_at IS NULL AND provider_instance_id NOT IN (${placeholders})`,
      )
      .run(selection.providerInstanceId, selection.modelId, now(), ...supportedProviderInstanceIds);
    return Number(result.changes);
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
    const modelSelection = this.getDefaultModelSelection();
    const avatar = randomBotAvatar();
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO bots(
             id, name, label, description, instructions, provider_instance_id, model_id,
             avatar_shape, avatar_color, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          botId,
          "新建 Bot",
          "",
          "",
          "",
          modelSelection.providerInstanceId,
          modelSelection.modelId,
          avatar.shape,
          avatar.color,
          timestamp,
          timestamp,
        );
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
    const columns: Record<Exclude<keyof BotPatch, "modelSelection" | "mcpServerIds" | "memoryWorkspaceIds">, string> = {
      name: "name",
      label: "label",
      description: "description",
      instructions: "instructions",
      avatarShape: "avatar_shape",
      avatarColor: "avatar_color",
    };
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    for (const field of ["name", "label", "description", "instructions", "avatarShape", "avatarColor"] as const) {
      const value = patch[field];
      if (value === undefined) continue;
      assignments.push(`${columns[field]} = ?`);
      values.push(value);
    }
    if (patch.modelSelection) {
      this.getProviderInstanceConfig(patch.modelSelection.providerInstanceId);
      assignments.push("provider_instance_id = ?", "model_id = ?");
      values.push(patch.modelSelection.providerInstanceId, patch.modelSelection.modelId);
    }
    if (patch.mcpServerIds !== undefined) {
      for (const serverId of patch.mcpServerIds ?? []) this.getMcpServerConfig(serverId);
      assignments.push("mcp_server_ids_json = ?");
      values.push(patch.mcpServerIds === null ? null : JSON.stringify(patch.mcpServerIds));
    }
    if (patch.memoryWorkspaceIds !== undefined) {
      for (const workspaceId of patch.memoryWorkspaceIds) this.getWorkspace(workspaceId);
      assignments.push("memory_workspace_ids_json = ?");
      values.push(JSON.stringify(patch.memoryWorkspaceIds));
    }
    if (assignments.length === 0) return this.getBot(id);
    const result = this.database
      .prepare(
        `UPDATE bots SET ${assignments.join(", ")}, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(...values, now(), id, expectedVersion);
    if (Number(result.changes) === 0) {
      const current = this.getBot(id);
      throw new AevorenBotError("BOT_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
    }
    return this.getBot(id);
  }

  listMemories(botId: string, includeDeleted = false): MemoryItem[] {
    return this.listScopedMemories({ scope: "bot", scopeKey: botId }, includeDeleted);
  }

  listScopedMemories(selector: MemoryScopeSelector, includeDeleted = false): MemoryItem[] {
    this.assertMemoryScope(selector);
    const rows = this.database
      .prepare(
        `SELECT * FROM memory_items
         WHERE scope = ? AND scope_key = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}
         ORDER BY created_at ASC, id ASC`,
      )
      .all(selector.scope, selector.scopeKey) as MemoryRow[];
    return rows.map(toMemory);
  }

  listRuntimeMemories(botId: string): MemoryItem[] {
    const bot = this.getBot(botId);
    const timestamp = now();
    const candidates = [
      ...this.listScopedMemories({ scope: "user", scopeKey: "user" }),
      ...(bot.memoryWorkspaceIds ?? []).flatMap((workspaceId) => {
        try {
          return this.listScopedMemories({ scope: "workspace", scopeKey: workspaceId });
        } catch (error) {
          if (error instanceof AevorenBotError && error.code === "WORKSPACE_NOT_FOUND") return [];
          throw error;
        }
      }),
      ...this.listScopedMemories({ scope: "bot", scopeKey: botId }),
    ].filter((memory) => memory.deletedAt === null && (!memory.expiresAt || memory.expiresAt > timestamp));
    const groups = new Map<string, MemoryItem[]>();
    for (const memory of candidates) {
      const key = `${memory.scope}:${memory.scopeKey}`;
      const group = groups.get(key) ?? [];
      group.push(memory);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      group.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    }
    const selected: MemoryItem[] = [];
    let bytes = 0;
    while ([...groups.values()].some((group) => group.length > 0)) {
      for (const group of groups.values()) {
        const memory = group.shift();
        if (!memory) continue;
        const itemBytes = Buffer.byteLength(memory.content, "utf8");
        if (bytes + itemBytes > MAX_RUNTIME_MEMORY_BYTES) continue;
        selected.push(memory);
        bytes += itemBytes;
      }
    }
    return selected.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  getMemory(id: string): MemoryItem {
    const row = this.database.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as MemoryRow | undefined;
    if (!row) throw new AevorenBotError("MEMORY_NOT_FOUND");
    return toMemory(row);
  }

  createMemory(
    botId: string,
    content: string,
    options: { kind?: MemoryKind; expiresAt?: string | null; source?: MemorySource; sourceEntryId?: string | null } = {},
  ): MemoryItem {
    return this.createScopedMemory({ scope: "bot", scopeKey: botId }, content, options);
  }

  createScopedMemory(
    selector: MemoryScopeSelector,
    content: string,
    options: { kind?: MemoryKind; expiresAt?: string | null; source?: MemorySource; sourceEntryId?: string | null } = {},
  ): MemoryItem {
    this.assertMemoryScope(selector);
    const normalized = normalizeMemoryContent(content);
    const contentDigest = digestMemoryContent(normalized);
    const kind = options.kind ?? "fact";
    const source = options.source ?? "manual-user";
    const expiresAt = this.normalizeMemoryExpiresAt(options.expiresAt);
    this.assertMemoryKind(kind);
    this.assertMemoryContent(normalized);
    this.assertNoActiveMemoryDuplicate(selector, contentDigest);
    this.assertMemoryCapacity(selector, normalized.length, 1);
    const id = randomUUID();
    const timestamp = now();
    const botId = selector.scope === "bot" ? selector.scopeKey : null;
    const workspaceId = selector.scope === "workspace" ? selector.scopeKey : null;
    this.database
      .prepare(
        `INSERT INTO memory_items(
           id, scope, scope_key, bot_id, workspace_id, content, content_digest,
           kind, source, source_entry_id, expires_at, version, deleted_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      )
      .run(
        id, selector.scope, selector.scopeKey, botId, workspaceId, normalized, contentDigest,
        kind, source, options.sourceEntryId ?? null, expiresAt, timestamp, timestamp,
      );
    return this.getMemory(id);
  }

  updateMemory(
    id: string,
    expectedVersion: number,
    content: string,
    options: { kind?: MemoryKind; expiresAt?: string | null } = {},
  ): MemoryItem {
    const current = this.getMemory(id);
    if (current.deletedAt) throw new AevorenBotError("MEMORY_DELETED");
    if (current.version !== expectedVersion) {
      throw new AevorenBotError("MEMORY_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
    }
    const normalized = normalizeMemoryContent(content);
    const contentDigest = digestMemoryContent(normalized);
    const kind = options.kind ?? current.kind;
    const expiresAt = options.expiresAt === undefined ? current.expiresAt : this.normalizeMemoryExpiresAt(options.expiresAt);
    this.assertMemoryKind(kind);
    this.assertMemoryContent(normalized);
    const selector = { scope: current.scope!, scopeKey: current.scopeKey! };
    this.assertNoActiveMemoryDuplicate(selector, contentDigest, id);
    this.assertMemoryCapacity(selector, normalized.length - current.content.length, 0);
    const result = this.database
      .prepare(
        `UPDATE memory_items
         SET content = ?, content_digest = ?, kind = ?, expires_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      )
      .run(normalized, contentDigest, kind, expiresAt, now(), id, expectedVersion);
    if (Number(result.changes) === 0) this.throwMemoryConflict(id);
    return this.getMemory(id);
  }

  deleteMemory(id: string, expectedVersion: number): MemoryItem {
    const current = this.getMemory(id);
    if (current.version !== expectedVersion) {
      throw new AevorenBotError("MEMORY_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
    }
    if (current.deletedAt) throw new AevorenBotError("MEMORY_DELETED");
    const timestamp = now();
    const result = this.database
      .prepare(
        `UPDATE memory_items
         SET deleted_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      )
      .run(timestamp, timestamp, id, expectedVersion);
    if (Number(result.changes) === 0) this.throwMemoryConflict(id);
    return this.getMemory(id);
  }

  restoreMemory(id: string, expectedVersion: number): MemoryItem {
    const current = this.getMemory(id);
    if (current.version !== expectedVersion) {
      throw new AevorenBotError("MEMORY_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
    }
    if (!current.deletedAt) return current;
    const selector = { scope: current.scope!, scopeKey: current.scopeKey! };
    this.assertMemoryScope(selector);
    this.assertNoActiveMemoryDuplicate(selector, current.contentDigest, id);
    this.assertMemoryCapacity(selector, current.content.length, 1);
    const result = this.database
      .prepare(
        `UPDATE memory_items
         SET deleted_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND deleted_at IS NOT NULL`,
      )
      .run(now(), id, expectedVersion);
    if (Number(result.changes) === 0) this.throwMemoryConflict(id);
    return this.getMemory(id);
  }

  listMemoryProposals(filter: { botId?: string; state?: MemoryProposalState } = {}): MemoryProposal[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.botId) {
      this.getBot(filter.botId);
      clauses.push("bot_id = ?");
      values.push(filter.botId);
    }
    if (filter.state) {
      clauses.push("state = ?");
      values.push(filter.state);
    }
    const rows = this.database.prepare(
      `SELECT * FROM memory_proposals ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC`,
    ).all(...values) as MemoryProposalRow[];
    return rows.map(toMemoryProposal);
  }

  getMemoryProposal(id: string): MemoryProposal {
    const row = this.database.prepare("SELECT * FROM memory_proposals WHERE id = ?").get(id) as MemoryProposalRow | undefined;
    if (!row) throw new AevorenBotError("MEMORY_PROPOSAL_NOT_FOUND");
    return toMemoryProposal(row);
  }

  createMemoryProposal(input: {
    botId: string;
    scope: MemoryScope;
    scopeKey: string;
    kind: MemoryKind;
    content: string;
    reason: string;
    sourceEntryId: string;
    supersedesMemoryId?: string | null;
    expiresAt?: string | null;
  }): MemoryProposal | null {
    const bot = this.getBot(input.botId);
    const source = this.getTranscriptEntry(input.sourceEntryId);
    if (source.role !== "user") throw new AevorenBotError("INVALID_REQUEST");
    const sourceSession = this.getSession(source.sessionId);
    const belongsToBot = sourceSession.botId === bot.id || Boolean(
      sourceSession.roomId && this.listRoomMembers(sourceSession.roomId).some((member) => member.botId === bot.id),
    );
    if (!belongsToBot) throw new AevorenBotError("INVALID_REQUEST");
    const selector = { scope: input.scope, scopeKey: input.scopeKey } as MemoryScopeSelector;
    this.assertMemoryScope(selector);
    if (input.scope === "bot" && input.scopeKey !== bot.id) throw new AevorenBotError("INVALID_REQUEST");
    if (input.scope === "workspace" && !(bot.memoryWorkspaceIds ?? []).includes(input.scopeKey)) {
      throw new AevorenBotError("INVALID_REQUEST");
    }
    const content = normalizeMemoryContent(input.content);
    const contentDigest = digestMemoryContent(content);
    const reason = input.reason.trim().slice(0, 1_000);
    this.assertMemoryContent(content);
    this.assertMemoryKind(input.kind);
    if (!reason) throw new AevorenBotError("INVALID_REQUEST");
    const existing = this.database.prepare(
      "SELECT 1 FROM memory_items WHERE scope = ? AND scope_key = ? AND content_digest = ? AND deleted_at IS NULL",
    ).get(input.scope, input.scopeKey, contentDigest);
    if (existing) return null;
    const pending = this.database.prepare(
      "SELECT * FROM memory_proposals WHERE scope = ? AND scope_key = ? AND content_digest = ? AND state = 'pending'",
    ).get(input.scope, input.scopeKey, contentDigest) as MemoryProposalRow | undefined;
    if (pending) return toMemoryProposal(pending);
    if (input.supersedesMemoryId) {
      const replaced = this.getMemory(input.supersedesMemoryId);
      if (replaced.deletedAt || replaced.scope !== input.scope || replaced.scopeKey !== input.scopeKey) {
        throw new AevorenBotError("INVALID_REQUEST");
      }
    }
    const id = randomUUID();
    const timestamp = now();
    const workspaceId = input.scope === "workspace" ? input.scopeKey : null;
    this.database.prepare(
      `INSERT INTO memory_proposals(
        id, bot_id, scope, scope_key, workspace_id, kind, content, content_digest, reason,
        source_entry_id, supersedes_memory_id, expires_at, state, version, resolved_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, NULL, ?, ?)`,
    ).run(
      id, input.botId, input.scope, input.scopeKey, workspaceId, input.kind, content, contentDigest, reason,
      input.sourceEntryId, input.supersedesMemoryId ?? null, this.normalizeMemoryExpiresAt(input.expiresAt), timestamp, timestamp,
    );
    return this.getMemoryProposal(id);
  }

  acceptMemoryProposal(
    id: string,
    expectedVersion: number,
    edit: { content?: string; kind?: MemoryKind; expiresAt?: string | null } = {},
  ): { proposal: MemoryProposal; memory: MemoryItem } {
    return this.transaction(() => {
      const proposal = this.getMemoryProposal(id);
      if (proposal.version !== expectedVersion) {
        throw new AevorenBotError("MEMORY_VERSION_CONFLICT", undefined, undefined, { currentVersion: proposal.version });
      }
      if (proposal.state !== "pending") throw new AevorenBotError("MEMORY_PROPOSAL_RESOLVED");
      const content = edit.content ?? proposal.content;
      const kind = edit.kind ?? proposal.kind;
      const expiresAt = edit.expiresAt === undefined ? proposal.expiresAt : edit.expiresAt;
      if (proposal.supersedesMemoryId) {
        const replaced = this.getMemory(proposal.supersedesMemoryId);
        if (!replaced.deletedAt) this.deleteMemory(replaced.id, replaced.version);
      }
      const memory = this.createScopedMemory(
        { scope: proposal.scope, scopeKey: proposal.scopeKey },
        content,
        { kind, expiresAt, source: "model-captured", sourceEntryId: proposal.sourceEntryId },
      );
      const timestamp = now();
      const result = this.database.prepare(
        `UPDATE memory_proposals
         SET content = ?, content_digest = ?, kind = ?, expires_at = ?, state = 'accepted',
             version = version + 1, resolved_at = ?, updated_at = ?
         WHERE id = ? AND version = ? AND state = 'pending'`,
      ).run(
        memory.content, memory.contentDigest, memory.kind, memory.expiresAt,
        timestamp, timestamp, id, expectedVersion,
      );
      if (Number(result.changes) !== 1) throw new AevorenBotError("MEMORY_VERSION_CONFLICT");
      return { proposal: this.getMemoryProposal(id), memory };
    });
  }

  rejectMemoryProposal(id: string, expectedVersion: number): MemoryProposal {
    const timestamp = now();
    const result = this.database.prepare(
      `UPDATE memory_proposals
       SET state = 'rejected', version = version + 1, resolved_at = ?, updated_at = ?
       WHERE id = ? AND version = ? AND state = 'pending'`,
    ).run(timestamp, timestamp, id, expectedVersion);
    if (Number(result.changes) !== 1) {
      const current = this.getMemoryProposal(id);
      if (current.state !== "pending") throw new AevorenBotError("MEMORY_PROPOSAL_RESOLVED");
      throw new AevorenBotError("MEMORY_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
    }
    return this.getMemoryProposal(id);
  }

  private assertMemoryContent(content: string): void {
    if (content.length === 0 || content.length > 4_000) throw new AevorenBotError("INVALID_REQUEST");
    if (containsLikelySecret(content)) throw new AevorenBotError("MEMORY_SENSITIVE_CONTENT");
  }

  private assertMemoryKind(kind: MemoryKind): void {
    if (!["fact", "preference", "decision", "procedure"].includes(kind)) throw new AevorenBotError("INVALID_REQUEST");
  }

  private normalizeMemoryExpiresAt(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value === "") return null;
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime())) throw new AevorenBotError("INVALID_REQUEST");
    return timestamp.toISOString();
  }

  private assertMemoryScope(selector: MemoryScopeSelector): void {
    if (selector.scope === "user") {
      if (selector.scopeKey !== "user") throw new AevorenBotError("INVALID_REQUEST");
      return;
    }
    if (selector.scope === "bot") {
      this.getBot(selector.scopeKey);
      return;
    }
    this.getWorkspace(selector.scopeKey);
  }

  private assertNoActiveMemoryDuplicate(selector: MemoryScopeSelector, contentDigest: string, excludedId?: string): void {
    const duplicate = this.database
      .prepare(
        `SELECT 1 FROM memory_items
         WHERE scope = ? AND scope_key = ? AND content_digest = ? AND deleted_at IS NULL ${excludedId ? "AND id <> ?" : ""}
         LIMIT 1`,
      )
      .get(...(excludedId
        ? [selector.scope, selector.scopeKey, contentDigest, excludedId]
        : [selector.scope, selector.scopeKey, contentDigest]));
    if (duplicate) throw new AevorenBotError("MEMORY_DUPLICATE");
  }

  private assertMemoryCapacity(selector: MemoryScopeSelector, characterDelta: number, countDelta: number): void {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(length(content)), 0) AS characters
         FROM memory_items WHERE scope = ? AND scope_key = ? AND deleted_at IS NULL`,
      )
      .get(selector.scope, selector.scopeKey) as { count: number; characters: number };
    if (Number(row.count) + countDelta > MAX_ACTIVE_MEMORIES_PER_BOT) {
      throw new AevorenBotError("MEMORY_LIMIT_EXCEEDED", undefined, undefined, { reason: "item-count" });
    }
    if (Number(row.characters) + characterDelta > MAX_ACTIVE_MEMORY_CHARACTERS) {
      throw new AevorenBotError("MEMORY_LIMIT_EXCEEDED", undefined, undefined, { reason: "character-count" });
    }
  }

  private throwMemoryConflict(id: string): never {
    const current = this.getMemory(id);
    throw new AevorenBotError("MEMORY_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
  }

  registerWorkspaceRoot(canonicalRoot: string, name: string): WorkspaceRegistrationResult {
    const normalizedName = name.trim().slice(0, 120);
    if (!canonicalRoot || !normalizedName) throw new AevorenBotError("WORKSPACE_INVALID_ROOT");
    const existing = this.database
      .prepare("SELECT * FROM workspaces WHERE canonical_root = ? ORDER BY created_at ASC LIMIT 1")
      .get(canonicalRoot) as WorkspaceRow | undefined;
    if (existing && !existing.removed_at) {
      return { disposition: "duplicate", workspace: toWorkspace(existing) };
    }
    if (existing) {
      const timestamp = now();
      const updated = this.database
        .prepare(
          `UPDATE workspaces
           SET name = ?, removed_at = NULL, version = version + 1, updated_at = ?
           WHERE id = ? AND removed_at IS NOT NULL AND version = ?`,
        )
        .run(normalizedName, timestamp, existing.id, existing.version);
      if (Number(updated.changes) !== 1) throw new AevorenBotError("WORKSPACE_VERSION_CONFLICT");
      return { disposition: "restored", workspace: this.getWorkspace(existing.id) };
    }
    const id = randomUUID();
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO workspaces(
           id, name, canonical_root, canonical_root_digest, version, removed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, NULL, ?, ?)`,
      )
      .run(id, normalizedName, canonicalRoot, digestMessage(canonicalRoot), timestamp, timestamp);
    return { disposition: "registered", workspace: this.getWorkspace(id) };
  }

  listWorkspaces(): Workspace[] {
    return (
      this.database
        .prepare("SELECT * FROM workspaces WHERE removed_at IS NULL ORDER BY created_at ASC, id ASC")
        .all() as WorkspaceRow[]
    ).map(toWorkspace);
  }

  getWorkspace(id: string, includeRemoved = false): Workspace {
    const row = this.database.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
    if (!row || row.removed_at && !includeRemoved) throw new AevorenBotError("WORKSPACE_NOT_FOUND");
    return toWorkspace(row);
  }

  getWorkspaceRoot(id: string): { workspace: Workspace; rootPath: string } {
    const row = this.database.prepare("SELECT * FROM workspaces WHERE id = ? AND removed_at IS NULL").get(id) as
      | WorkspaceRow
      | undefined;
    if (!row) throw new AevorenBotError("WORKSPACE_NOT_FOUND");
    return { workspace: toWorkspace(row), rootPath: row.canonical_root };
  }

  updateWorkspacePermissions(
    id: string,
    expectedVersion: number,
    permissions: { writeEnabled: boolean; automationEnabled: boolean },
  ): Workspace {
    const result = this.database
      .prepare(
        `UPDATE workspaces
         SET write_enabled = ?, automation_enabled = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND removed_at IS NULL`,
      )
      .run(permissions.writeEnabled ? 1 : 0, permissions.automationEnabled ? 1 : 0, now(), id, expectedVersion);
    if (Number(result.changes) !== 1) {
      const current = this.getWorkspace(id, true);
      throw new AevorenBotError("WORKSPACE_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
    }
    return this.getWorkspace(id);
  }

  removeWorkspace(id: string, expectedVersion: number): Workspace {
    const timestamp = now();
    const updated = this.database
      .prepare(
        `UPDATE workspaces
         SET removed_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND removed_at IS NULL`,
      )
      .run(timestamp, timestamp, id, expectedVersion);
    if (Number(updated.changes) !== 1) {
      const current = this.getWorkspace(id, true);
      throw new AevorenBotError("WORKSPACE_VERSION_CONFLICT", undefined, undefined, {
        currentVersion: current.version,
      });
    }
    return this.getWorkspace(id, true);
  }

  prepareToolInvocation(
    input: ToolInvocationCommand,
    expiresAt = defaultApprovalExpiry(),
  ): ToolPrepareResult {
    const parsed = toolInvocationCommandSchema.parse(input) as ToolInvocationCommand;
    if (!Number.isFinite(Date.parse(expiresAt))) throw new AevorenBotError("INVALID_REQUEST");
    const runtime = this.getRuntimeRun(parsed.runtimeRunId);
    if (runtime.state !== "running" && runtime.state !== "streaming") {
      throw new AevorenBotError("TOOL_STATE_INVALID", undefined, undefined, { currentState: runtime.state });
    }
    const session = this.getSession(runtime.sessionId);
    const commandDigest = digestMessage(canonicalToolCommand(parsed));
    const existingByKey = this.database
      .prepare("SELECT * FROM tool_invocations WHERE idempotency_key = ?")
      .get(parsed.idempotencyKey) as ToolInvocationRow | undefined;
    const existingByCall = this.database
      .prepare("SELECT * FROM tool_invocations WHERE runtime_run_id = ? AND tool_call_id = ?")
      .get(runtime.id, parsed.toolCallId) as ToolInvocationRow | undefined;
    if (existingByKey && existingByCall && existingByKey.id !== existingByCall.id) {
      throw new AevorenBotError("TOOL_IDEMPOTENCY_CONFLICT");
    }
    const existing = existingByKey ?? existingByCall;
    if (existing) {
      if (existing.command_digest !== commandDigest) throw new AevorenBotError("TOOL_IDEMPOTENCY_CONFLICT");
      const invocation = toToolInvocation(existing);
      return {
        disposition: "duplicate",
        invocation,
        approval: this.getApprovalRequest(invocation.approvalRequestId),
      };
    }

    const invocationId = randomUUID();
    const approvalId = randomUUID();
    const timestamp = now();
    const argumentsJson = JSON.stringify(parsed.tool);
    const targetDigest = toolTargetDigest(parsed.tool);
    const effectClass = toolEffectClass(parsed.tool);
    const workspaceId = toolWorkspaceId(parsed.tool);
    const targetPath = toolTargetPath(parsed.tool);
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO tool_invocations(
             id, runtime_run_id, session_id, executor_bot_id, tool_call_id, idempotency_key,
             command_digest, tool_kind, effect_class, workspace_id, target_path, arguments_json, state,
             attempt_count, approval_request_id, result_digest, result_metadata_json,
             last_error_code, version, created_at, updated_at, started_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting-approval',
             0, ?, NULL, NULL, NULL, 1, ?, ?, NULL, NULL)`,
        )
        .run(
          invocationId,
          runtime.id,
          session.id,
          runtime.executorBotId,
          parsed.toolCallId,
          parsed.idempotencyKey,
          commandDigest,
          parsed.tool.kind,
          effectClass,
          workspaceId,
          targetPath,
          argumentsJson,
          approvalId,
          timestamp,
          timestamp,
        );
      this.database
        .prepare(
          `INSERT INTO approval_requests(
             id, tool_invocation_id, runtime_run_id, session_id, executor_bot_id,
             action_kind, effect_class, workspace_id, target_path, target_digest, arguments_digest,
             requested_scope, state, resolution, policy_version, version,
             expires_at, resolved_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'once', 'pending', NULL, 1, 1, ?, NULL, ?, ?)`,
        )
        .run(
          approvalId,
          invocationId,
          runtime.id,
          session.id,
          runtime.executorBotId,
          parsed.tool.kind,
          effectClass,
          workspaceId,
          targetPath,
          targetDigest,
          commandDigest,
          expiresAt,
          timestamp,
          timestamp,
        );
    });
    return {
      disposition: "prepared",
      invocation: this.getToolInvocation(invocationId),
      approval: this.getApprovalRequest(approvalId),
    };
  }

  getToolInvocation(id: string): ToolInvocation {
    const row = this.database.prepare("SELECT * FROM tool_invocations WHERE id = ?").get(id) as
      | ToolInvocationRow
      | undefined;
    if (!row) throw new AevorenBotError("TOOL_INVOCATION_NOT_FOUND");
    return toToolInvocation(row);
  }

  listToolInvocations(sessionId: string): ToolInvocation[] {
    this.getSession(sessionId);
    return (
      this.database
        .prepare("SELECT * FROM tool_invocations WHERE session_id = ? ORDER BY created_at ASC, id ASC")
        .all(sessionId) as ToolInvocationRow[]
    ).map(toToolInvocation);
  }

  getApprovalRequest(id: string): ApprovalRequest {
    const row = this.database.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as
      | ApprovalRequestRow
      | undefined;
    if (!row) throw new AevorenBotError("APPROVAL_NOT_FOUND");
    return toApprovalRequest(row);
  }

  listPendingApprovalRequests(sessionId: string): ApprovalRequest[] {
    this.getSession(sessionId);
    return (
      this.database
        .prepare(
          `SELECT * FROM approval_requests
           WHERE session_id = ? AND state = 'pending'
           ORDER BY created_at ASC, id ASC`,
        )
        .all(sessionId) as ApprovalRequestRow[]
    ).map(toApprovalRequest);
  }

  resolveToolApproval(
    id: string,
    expectedVersion: number,
    resolution: ApprovalResolution,
  ): ToolApprovalResult {
    let expired = false;
    let result: ToolApprovalResult | null = null;
    this.transaction(() => {
      const approval = this.getApprovalRequest(id);
      if (approval.version !== expectedVersion) {
        throw new AevorenBotError("APPROVAL_VERSION_CONFLICT", undefined, undefined, {
          currentVersion: approval.version,
        });
      }
      if (approval.state !== "pending") throw new AevorenBotError("APPROVAL_ALREADY_RESOLVED");
      const invocation = this.getToolInvocation(approval.toolInvocationId);
      if (
        invocation.state !== "awaiting-approval" ||
        invocation.runtimeRunId !== approval.runtimeRunId ||
        invocation.sessionId !== approval.sessionId ||
        invocation.executorBotId !== approval.executorBotId ||
        invocation.toolKind !== approval.actionKind ||
        invocation.workspaceId !== approval.workspaceId ||
        invocation.targetPath !== approval.targetPath ||
        invocation.commandDigest !== approval.argumentsDigest
      ) {
        throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
      }

      const timestamp = now();
      if (Date.parse(approval.expiresAt) <= Date.parse(timestamp)) {
        this.database
          .prepare(
            `UPDATE approval_requests
             SET state = 'expired', version = version + 1, resolved_at = ?, updated_at = ?
             WHERE id = ? AND version = ? AND state = 'pending'`,
          )
          .run(timestamp, timestamp, id, expectedVersion);
        this.database
          .prepare(
            `UPDATE tool_invocations
             SET state = 'expired', version = version + 1, finished_at = ?, updated_at = ?
             WHERE id = ? AND state = 'awaiting-approval'`,
          )
          .run(timestamp, timestamp, invocation.id);
        expired = true;
        return;
      }

      const approvalState = resolution === "allow-once" ? "allowed" : "denied";
      const invocationState = resolution === "allow-once" ? "approved" : "denied";
      const approvalUpdate = this.database
        .prepare(
          `UPDATE approval_requests
           SET state = ?, resolution = ?, version = version + 1, resolved_at = ?, updated_at = ?
           WHERE id = ? AND version = ? AND state = 'pending'`,
        )
        .run(approvalState, resolution, timestamp, timestamp, id, expectedVersion);
      const invocationUpdate = this.database
        .prepare(
          `UPDATE tool_invocations
           SET state = ?, version = version + 1, finished_at = CASE WHEN ? = 'denied' THEN ? ELSE NULL END,
               updated_at = ?
           WHERE id = ? AND state = 'awaiting-approval'`,
        )
        .run(invocationState, invocationState, timestamp, timestamp, invocation.id);
      if (Number(approvalUpdate.changes) !== 1 || Number(invocationUpdate.changes) !== 1) {
        throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
      }
      result = {
        approval: this.getApprovalRequest(id),
        invocation: this.getToolInvocation(invocation.id),
      };
    });
    if (expired) throw new AevorenBotError("APPROVAL_EXPIRED");
    if (!result) throw new AevorenBotError("INTERNAL_ERROR");
    return result;
  }

  transitionToolInvocation(id: string, state: ToolInvocationState): ToolInvocation {
    const current = this.getToolInvocation(id);
    if (!TOOL_INVOCATION_TRANSITIONS[current.state].includes(state)) {
      throw new AevorenBotError("TOOL_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    if (state === "dispatching") {
      const approval = this.getApprovalRequest(current.approvalRequestId);
      if (
        approval.state !== "allowed" ||
        approval.resolution !== "allow-once" ||
        approval.toolInvocationId !== current.id ||
        approval.argumentsDigest !== current.commandDigest
      ) {
        throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
      }
    }
    const timestamp = now();
    const terminal = TERMINAL_TOOL_INVOCATION_STATES.includes(state);
    const update = this.database
      .prepare(
        `UPDATE tool_invocations
         SET state = ?, attempt_count = attempt_count + CASE WHEN ? = 'dispatching' THEN 1 ELSE 0 END,
             version = version + 1,
             started_at = CASE WHEN ? = 'dispatching' AND started_at IS NULL THEN ? ELSE started_at END,
             finished_at = CASE WHEN ? THEN ? ELSE NULL END,
             updated_at = ?
         WHERE id = ? AND version = ? AND state = ?`,
      )
      .run(
        state,
        state,
        state,
        timestamp,
        terminal ? 1 : 0,
        timestamp,
        timestamp,
        id,
        current.version,
        current.state,
      );
    if (Number(update.changes) !== 1) {
      const latest = this.getToolInvocation(id);
      throw new AevorenBotError("TOOL_STATE_INVALID", undefined, undefined, { currentState: latest.state });
    }
    return this.getToolInvocation(id);
  }

  completeToolInvocation(
    id: string,
    resultDigest: string,
    resultMetadata: Record<string, string | number | boolean | null>,
  ): ToolInvocation {
    if (!/^[a-f0-9]{64}$/.test(resultDigest)) throw new AevorenBotError("INVALID_REQUEST");
    const current = this.getToolInvocation(id);
    if (current.state !== "running") {
      throw new AevorenBotError("TOOL_STATE_INVALID", undefined, undefined, { currentState: current.state });
    }
    const metadataJson = JSON.stringify(resultMetadata);
    if (metadataJson.length > 4_096) throw new AevorenBotError("INVALID_REQUEST");
    const timestamp = now();
    const updated = this.database
      .prepare(
        `UPDATE tool_invocations
         SET state = 'succeeded', result_digest = ?, result_metadata_json = ?, last_error_code = NULL,
             version = version + 1, finished_at = ?, updated_at = ?
         WHERE id = ? AND version = ? AND state = 'running'`,
      )
      .run(resultDigest, metadataJson, timestamp, timestamp, id, current.version);
    if (Number(updated.changes) !== 1) {
      const latest = this.getToolInvocation(id);
      throw new AevorenBotError("TOOL_STATE_INVALID", undefined, undefined, { currentState: latest.state });
    }
    return this.getToolInvocation(id);
  }

  failToolInvocation(id: string, errorCode: string): ToolInvocation {
    const current = this.getToolInvocation(id);
    const state: ToolInvocationState = current.state === "dispatching"
      ? "failed-before-execution"
      : current.state === "running"
        ? "failed"
        : (() => {
            throw new AevorenBotError("TOOL_STATE_INVALID", undefined, undefined, { currentState: current.state });
          })();
    const timestamp = now();
    const updated = this.database
      .prepare(
        `UPDATE tool_invocations
         SET state = ?, result_digest = NULL, result_metadata_json = NULL, last_error_code = ?,
             version = version + 1, finished_at = ?, updated_at = ?
         WHERE id = ? AND version = ? AND state = ?`,
      )
      .run(state, errorCode.slice(0, 100), timestamp, timestamp, id, current.version, current.state);
    if (Number(updated.changes) !== 1) {
      const latest = this.getToolInvocation(id);
      throw new AevorenBotError("TOOL_STATE_INVALID", undefined, undefined, { currentState: latest.state });
    }
    return this.getToolInvocation(id);
  }

  cancelToolInvocation(id: string): ToolInvocation {
    return this.transaction(() => {
      const current = this.getToolInvocation(id);
      if (!["awaiting-approval", "approved", "dispatching", "running"].includes(current.state)) {
        throw new AevorenBotError("TOOL_STATE_INVALID", undefined, undefined, { currentState: current.state });
      }
      const timestamp = now();
      const approval = this.getApprovalRequest(current.approvalRequestId);
      if (approval.state === "pending" || approval.state === "allowed") {
        this.database
          .prepare(
            `UPDATE approval_requests
             SET state = 'cancelled', version = version + 1, resolved_at = COALESCE(resolved_at, ?), updated_at = ?
             WHERE id = ? AND version = ? AND state = ?`,
          )
          .run(timestamp, timestamp, approval.id, approval.version, approval.state);
      }
      const updated = this.database
        .prepare(
          `UPDATE tool_invocations
           SET state = 'cancelled', version = version + 1, last_error_code = 'TOOL_EXECUTION_CANCELLED',
               finished_at = ?, updated_at = ?
           WHERE id = ? AND version = ? AND state = ?`,
        )
        .run(timestamp, timestamp, id, current.version, current.state);
      if (Number(updated.changes) !== 1) {
        const latest = this.getToolInvocation(id);
        throw new AevorenBotError("TOOL_STATE_INVALID", undefined, undefined, { currentState: latest.state });
      }
      return this.getToolInvocation(id);
    });
  }

  recoverToolInvocations(): { expired: number; interrupted: number } {
    const timestamp = now();
    return this.transaction(() => {
      const expiredPending = this.database
        .prepare(
          `SELECT approval.id, approval.tool_invocation_id
           FROM approval_requests AS approval
           JOIN tool_invocations AS invocation ON invocation.id = approval.tool_invocation_id
           WHERE approval.state = 'pending' AND invocation.state = 'awaiting-approval'
             AND approval.expires_at <= ?`,
        )
        .all(timestamp) as Array<{ id: string; tool_invocation_id: string }>;
      for (const approval of expiredPending) {
        this.database
          .prepare(
            "UPDATE approval_requests SET state = 'expired', version = version + 1, resolved_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(timestamp, timestamp, approval.id);
        this.database
          .prepare(
            "UPDATE tool_invocations SET state = 'expired', version = version + 1, finished_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(timestamp, timestamp, approval.tool_invocation_id);
      }

      const orphanedPending = this.database
        .prepare(
          `SELECT approval.id, approval.tool_invocation_id
           FROM approval_requests AS approval
           JOIN tool_invocations AS invocation ON invocation.id = approval.tool_invocation_id
           JOIN runtime_runs AS runtime ON runtime.id = invocation.runtime_run_id
           WHERE approval.state = 'pending' AND invocation.state = 'awaiting-approval'
             AND runtime.state NOT IN ('created', 'dispatching', 'running', 'streaming', 'cancel-requested')`,
        )
        .all() as Array<{ id: string; tool_invocation_id: string }>;
      for (const approval of orphanedPending) {
        this.database
          .prepare(
            "UPDATE approval_requests SET state = 'expired', version = version + 1, resolved_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(timestamp, timestamp, approval.id);
        this.database
          .prepare(
            "UPDATE tool_invocations SET state = 'expired', version = version + 1, finished_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(timestamp, timestamp, approval.tool_invocation_id);
      }

      const approved = this.database
        .prepare("SELECT id, approval_request_id FROM tool_invocations WHERE state = 'approved'")
        .all() as Array<{ id: string; approval_request_id: string }>;
      for (const invocation of approved) {
        this.database
          .prepare(
            `UPDATE approval_requests
             SET state = 'expired', version = version + 1, updated_at = ?
             WHERE id = ? AND state = 'allowed'`,
          )
          .run(timestamp, invocation.approval_request_id);
        this.database
          .prepare(
            "UPDATE tool_invocations SET state = 'expired', version = version + 1, finished_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(timestamp, timestamp, invocation.id);
      }

      const interrupted = this.database
        .prepare("SELECT id FROM tool_invocations WHERE state IN ('dispatching', 'running')")
        .all() as Array<{ id: string }>;
      for (const invocation of interrupted) {
        this.database
          .prepare(
            `UPDATE tool_invocations
             SET state = 'interrupted-unknown', version = version + 1,
                 last_error_code = 'APP_INTERRUPTED', finished_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(timestamp, timestamp, invocation.id);
      }
      return { expired: expiredPending.length + orphanedPending.length + approved.length, interrupted: interrupted.length };
    });
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
    const avatar = randomBotAvatar();
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO bots(
             id, name, label, description, instructions, provider_instance_id, model_id, avatar_shape, avatar_color, mcp_server_ids_json, memory_workspace_ids_json,
             version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          botId,
          name,
          source.label,
          source.description,
          source.instructions,
          source.modelSelection.providerInstanceId,
          source.modelSelection.modelId,
          avatar.shape,
          avatar.color,
          source.mcpServerIds == null ? null : JSON.stringify(source.mcpServerIds),
          JSON.stringify(source.memoryWorkspaceIds ?? []),
          timestamp,
          timestamp,
        );
      this.database
        .prepare(
          `INSERT INTO sessions(id, bot_id, room_id, kind, generation, transcript_cursor, created_at, updated_at)
           VALUES (?, ?, NULL, 'MAIN', 1, 0, ?, ?)`,
        )
        .run(sessionId, botId, timestamp, timestamp);
    });
    return { bot: this.getBot(botId), session: this.getMainSession(botId) };
  }

  deleteBot(id: string): BotDeleteResult {
    this.assertBotDeletable(id);
    return this.transaction(() => this.deleteBotRecord(id));
  }

  private assertBotDeletable(id: string): void {
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
  }

  private deleteBotRecord(id: string): BotDeleteResult {
    const timestamp = now();
    const memberships = this.database
      .prepare("SELECT room_id FROM room_members WHERE bot_id = ? ORDER BY room_id")
      .all(id) as Array<{ room_id: string }>;
    const affectedRoomIds = memberships.map((membership) => membership.room_id);
    const archivedRoomIds: string[] = [];

    this.database.prepare("DELETE FROM memory_items WHERE bot_id = ?").run(id);
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

  createContentTeamTemplate(): TeamTemplateCreateResult {
    const settingKey = "template.content-team.roomId";
    const existingRoomId = this.getSetting(settingKey)?.value;
    if (existingRoomId) {
      try {
        const room = this.getRoomDetail(existingRoomId);
        return { disposition: "existing", bots: room.members.map((member) => member.bot), room };
      } catch {
        // The prior template was deleted; create a fresh atomic instance below.
      }
    }
    const roles = [
      {
        name: "情报侦察员",
        label: "一手信息研究",
        description: "检索并核验一手来源，形成可追溯线索。",
        instructions: "你负责一手信息研究。必须通过真实 web_search/web_fetch 获取来源；没有成功工具记录不得声称已抓取或核验。将验收通过的线索使用 workspace_write 新建到 01-inbox，包含来源 URL、抓取时间、事实/观点/假设、缺口与风险；不得覆盖已有文件。每次任务只创建用户指定的一个正式线索文件，成功后不得再创建 v2、确认、索引或审计文件。完成后使用结构化 handoff 交给选题策划师。",
      },
      {
        name: "选题策划师",
        label: "选题评估与 Brief",
        description: "基于真实线索和账号风格产出互斥选题 Brief。",
        instructions: "你负责选题策划。先通过真实 workspace_read 读取上游线索与 voice.md，再产出 3 个互斥候选；没有成功读取不得生成或声称已读。使用 workspace_write 新建用户指定的唯一 Brief 到 02-briefs；第一次写入成功后立即停止写文件，不得创建 v2、清单、索引、README、审计或确认文件。等待用户批准后才能结构化 handoff 给内容主笔。",
      },
      {
        name: "内容主笔",
        label: "多平台内容写作",
        description: "根据批准的 Brief 和风格材料生成候选稿。",
        instructions: "你负责内容写作。只有收到批准后的结构化 handoff 才启动；先真实读取 Brief 与 voice.md。用 text_measure 记录初稿长度，不得估算；主笔阶段最多修订测量 6 次，然后写入当前最佳草稿并交给事实编辑，由事实编辑负责最终长度收敛。只创建用户指定的一个正式草稿文件；workspace_write 成功后不得创建副本或确认文件，随后结构化 handoff 给事实编辑。",
      },
      {
        name: "事实编辑",
        label: "事实核验与风格审校",
        description: "复核事实、来源、数字、引语、上下文和长度。",
        instructions: "你负责事实与风格审校。必须真实读取 Brief、草稿、voice.md，并对需要复核的公开来源使用真实 web_fetch。必须使用 text_measure 计算长度。若任务要求短帖与展开版而草稿只含一种，你必须派生两个独立版本并分别测量，禁止反复测量未变化的同一版本；每次根据工具返回的 missingRanges 只修订缺失版本，全部区间命中后立即停止测量并写正式审校稿。没有对应成功工具记录不得声称已读、已抓取或已核验。若长度或风格不达标，必须直接修订候选正文并再次调用 text_measure，直到符合 voice.md 后再写正式审校稿；不得只给修改建议并把修订留给人工。只创建用户指定的一个正式审校文件；workspace_write 成功后立即停止写文件，不得创建副本；不得发布。",
      },
      {
        name: "数据复盘师",
        label: "真实数据复盘",
        description: "只基于明确授权且真实读取的数据做复盘。",
        instructions: "你负责数据复盘。没有真实 CSV 或 Analytics 授权时必须停止。必须先通过 workspace_read 成功读取指定 CSV，只能复制 Host 返回的 csvSummary 确定性指标；禁止心算或估算，禁止虚构 ID、指标或样本，也不得追加未经用户要求和确定性工具验证的单位换算、百分比或派生结论。结论必须列出来源路径、字段、样本数和计算口径。若任务要求先生成 CSV，只允许创建该 CSV 与最终报告各一个；成功后不得创建副本、索引或确认文件。",
      },
    ] as const;
    const modelSelection = this.getDefaultModelSelection();
    const botIds = roles.map(() => randomUUID());
    const roomId = randomUUID();
    const roomSessionId = randomUUID();
    const timestamp = now();
    const avatars = roles.map(() => randomBotAvatar());
    const description = "五阶段内容协作：情报侦察员 → 选题策划师 → 用户批准 → 内容主笔 → 事实编辑 → 人工发布 → 数据复盘师。所有读取、抓取、计数与写入必须有当前 Runtime 的成功工具记录；文本中的 @、HANDOFF、SAVE 或路径不是执行证据。无真实 CSV 不得输出数据结论。发布、互动、登录、验证码、购买、删除和权限修改必须等待用户。";
    this.transaction(() => {
      const insertBot = this.database.prepare(
        `INSERT INTO bots(
           id, name, label, description, instructions, provider_instance_id, model_id,
           avatar_shape, avatar_color, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      );
      const insertSession = this.database.prepare(
        `INSERT INTO sessions(id, bot_id, room_id, kind, generation, transcript_cursor, created_at, updated_at)
         VALUES (?, ?, NULL, 'MAIN', 1, 0, ?, ?)`,
      );
      roles.forEach((role, index) => {
        const botId = botIds[index]!;
        const avatar = avatars[index]!;
        insertBot.run(
          botId, role.name, role.label, role.description, role.instructions,
          modelSelection.providerInstanceId, modelSelection.modelId, avatar.shape, avatar.color, timestamp, timestamp,
        );
        insertSession.run(randomUUID(), botId, timestamp, timestamp);
      });
      this.database.prepare(
        `INSERT INTO rooms(id, name, description, version, membership_version, archived_at, created_at, updated_at)
         VALUES (?, '自媒体内容团队', ?, 1, 1, NULL, ?, ?)`,
      ).run(roomId, description, timestamp, timestamp);
      const insertMember = this.database.prepare(
        "INSERT INTO room_members(room_id, bot_id, position, created_at) VALUES (?, ?, ?, ?)",
      );
      botIds.forEach((botId, index) => insertMember.run(roomId, botId, index, timestamp));
      this.database.prepare(
        `INSERT INTO sessions(id, bot_id, room_id, kind, generation, transcript_cursor, created_at, updated_at)
         VALUES (?, NULL, ?, 'MAIN', 1, 0, ?, ?)`,
      ).run(roomSessionId, roomId, timestamp, timestamp);
      this.database.prepare(
        `INSERT INTO app_settings(key, value, encrypted, updated_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = 0, updated_at = excluded.updated_at`,
      ).run(settingKey, roomId, timestamp);
    });
    const room = this.getRoomDetail(roomId);
    return { disposition: "created", bots: room.members.map((member) => member.bot), room };
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

  setRoomPinned(id: string, pinned: boolean): Room {
    this.getRoom(id);
    const timestamp = now();
    const result = this.database
      .prepare("UPDATE rooms SET pinned_at = ?, updated_at = ? WHERE id = ?")
      .run(pinned ? timestamp : null, timestamp, id);
    if (Number(result.changes) === 0) throw new AevorenBotError("ROOM_NOT_FOUND");
    return this.getRoom(id);
  }

  setRoomUnread(id: string, unread: boolean): Room {
    this.getRoom(id);
    const result = this.database
      .prepare("UPDATE rooms SET has_unread = ? WHERE id = ?")
      .run(unread ? 1 : 0, id);
    if (Number(result.changes) === 0) throw new AevorenBotError("ROOM_NOT_FOUND");
    return this.getRoom(id);
  }

  setRoomHidden(id: string, hidden: boolean): Room {
    this.getRoom(id);
    const timestamp = now();
    const result = this.database
      .prepare("UPDATE rooms SET hidden_at = ?, pinned_at = CASE WHEN ? = 1 THEN NULL ELSE pinned_at END, updated_at = ? WHERE id = ?")
      .run(hidden ? timestamp : null, hidden ? 1 : 0, timestamp, id);
    if (Number(result.changes) === 0) throw new AevorenBotError("ROOM_NOT_FOUND");
    return this.getRoom(id);
  }

  deleteRoom(id: string): RoomDeleteResult {
    this.assertRoomDeletable(id);
    return this.transaction(() => this.deleteRoomRecord(id));
  }

  deleteConversations(input: ConversationBatchDeleteInput): ConversationBatchDeleteResult {
    const count = input.botIds.length + input.roomIds.length;
    if (
      count < 2 || count > 200 ||
      new Set(input.botIds).size !== input.botIds.length ||
      new Set(input.roomIds).size !== input.roomIds.length
    ) {
      throw new AevorenBotError("INVALID_REQUEST");
    }
    input.roomIds.forEach((id) => this.assertRoomDeletable(id));
    input.botIds.forEach((id) => this.assertBotDeletable(id));
    return this.transaction(() => ({
      rooms: input.roomIds.map((id) => this.deleteRoomRecord(id)),
      bots: input.botIds.map((id) => this.deleteBotRecord(id)),
    }));
  }

  private assertRoomDeletable(id: string): void {
    const room = this.getRoom(id);
    const sessionId = this.getRoomMainSession(room.id).id;
    if (this.getActiveRoomBatch(sessionId) || this.getActiveRuntimeRun(sessionId)) {
      throw new AevorenBotError("ROOM_DELETE_BUSY");
    }
  }

  private deleteRoomRecord(id: string): RoomDeleteResult {
    this.database
      .prepare(
        `UPDATE room_turns
         SET parent_turn_id = NULL
         WHERE batch_id IN (SELECT id FROM room_batches WHERE room_id = ?)
           AND parent_turn_id IS NOT NULL`,
      )
      .run(id);
    const result = this.database.prepare("DELETE FROM rooms WHERE id = ?").run(id);
    if (Number(result.changes) === 0) throw new AevorenBotError("ROOM_NOT_FOUND");
    return { id };
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
    ).map((entry) => {
      const rows = this.database.prepare(
        `SELECT id, name, mime_type, size, sha256, kind, content
         FROM message_attachments WHERE transcript_entry_id = ? ORDER BY created_at ASC, id ASC`,
      ).all(entry.id) as Array<{
        id: string;
        name: string;
        mime_type: string;
        size: number;
        sha256: string;
        kind: "text";
        content: string;
      }>;
      if (rows.length === 0) return entry;
      return {
        ...entry,
        attachmentContents: rows.map((row) => ({
          id: row.id,
          name: row.name,
          mimeType: row.mime_type,
          size: row.size,
          sha256: row.sha256,
          kind: row.kind,
          content: row.content,
        })),
      } as TranscriptEntry & { attachmentContents: PromptAttachment[] };
    });
  }

  private nextSequence(sessionId: string, generation: number): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(seq), 0) AS current FROM transcript_entries WHERE session_id = ? AND generation = ?")
      .get(sessionId, generation) as { current: number };
    return Number(row.current) + 1;
  }

  private insertMessageAttachments(entryId: string, clientNonce: string, attachments: readonly PromptAttachment[]): string {
    const metadata = attachments.map(({ content: _content, ...attachment }) => attachment);
    const insert = this.database.prepare(
      `INSERT INTO message_attachments(
         id, transcript_entry_id, client_nonce, name, mime_type, size, sha256, kind, content, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const timestamp = now();
    for (const attachment of attachments) {
      insert.run(
        attachment.id,
        entryId,
        clientNonce,
        attachment.name,
        attachment.mimeType,
        attachment.size,
        attachment.sha256,
        attachment.kind,
        attachment.content,
        timestamp,
      );
    }
    return JSON.stringify(metadata);
  }

  prepareMessage(command: SendCommand): { disposition: "prepared" | "duplicate"; journal: SendJournalEntry } {
    const attachments = normalizeAttachmentDrafts(command.attachments);
    const attachmentMetadata = attachments.map(({ content: _content, ...attachment }) => attachment);
    const digest = digestMessage(command.text, attachmentMetadata);
    const existing = this.getSend(command.clientNonce);
    if (existing) {
      if (existing.bodyDigest !== digest) throw new AevorenBotError("MESSAGE_NONCE_CONFLICT");
      return { disposition: "duplicate", journal: existing };
    }
    if (this.getActiveRuntimeRun(command.sessionId)) throw new AevorenBotError("SESSION_BUSY");
    const session = this.getSession(command.sessionId);
    const timestamp = now();
    const userEntryId = randomUUID();
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
             id, session_id, generation, seq, client_nonce, role, body, attachments_json, status, updated_seq, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'user', ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(userEntryId, session.id, session.generation, sequence, command.clientNonce, command.text, JSON.stringify(attachmentMetadata), updatedSeq, timestamp, timestamp);
      this.insertMessageAttachments(userEntryId, command.clientNonce, attachments);
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
      orchestrationEnabled: false,
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

  /** Approval, its user entry, initial turn, and evidence are committed together. */
  createApprovedBriefRun(input: CreateRoomRunInput, approval: {
    sourceRuntimeRunId: string;
    briefInvocationId: string;
    sha256: string;
    candidate: "A" | "B" | "C";
  }): ReturnType<AppRepository["createRoomRunWithInitialTurns"]> {
    if (input.initialTurns.length !== 1 || !["A", "B", "C"].includes(approval.candidate)) {
      throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    }
    const source = this.getCompletedWorkspaceArtifact(input.sessionId, approval.briefInvocationId, approval.sourceRuntimeRunId);
    if (!source || !source.invocation.targetPath.startsWith("02-briefs/") || source.invocation.resultMetadata?.sha256 !== approval.sha256) {
      throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    }
    const previous = this.database.prepare(
      `SELECT room_batches.client_nonce FROM room_turns
       INNER JOIN room_batches ON room_batches.id = room_turns.batch_id
       WHERE json_extract(room_turns.execution_receipt_json, '$.approvedBrief.briefInvocationId') = ?
         AND room_turns.parent_turn_id IS NULL LIMIT 1`,
    ).get(approval.briefInvocationId) as { client_nonce: string } | undefined;
    if (previous && previous.client_nonce !== input.clientNonce) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    const attachReceipt = (prepared: ReturnType<AppRepository["createRoomRunWithInitialTurns"]>): void => {
      if (prepared.disposition === "created") {
        const latest = this.findLatestCompletedWorkspaceArtifact(input.sessionId, "02-briefs/");
        if (latest?.invocation.id !== approval.briefInvocationId) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
      }
      const previousApproval = this.database.prepare(
        `SELECT batch_id FROM room_turns WHERE parent_turn_id IS NULL
         AND json_extract(execution_receipt_json, '$.approvedBrief.briefInvocationId') = ? LIMIT 1`,
      ).get(approval.briefInvocationId) as { batch_id: string } | undefined;
      if (previousApproval && previousApproval.batch_id !== prepared.run.id) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
      this.createExecutionEvidenceReceipt(prepared.turns[0]!.id, approval.sourceRuntimeRunId, {
        candidate: approval.candidate,
        approvalEntryId: prepared.run.triggerMessageId,
        briefInvocationId: approval.briefInvocationId,
        sha256: approval.sha256,
      });
    };
    // A transport retry repeats the human decision, not the wall-clock deadline calculation.
    const existingRun = this.getRoomBatchByNonce(input.clientNonce);
    const prepared = this.prepareRoomRun({
      ...input,
      deadlineAt: existingRun?.deadlineAt ?? input.deadlineAt,
      windingDown: false,
      comparePolicyOnDuplicate: true,
    }, attachReceipt);
    if (prepared.disposition === "duplicate") attachReceipt(prepared);
    return prepared;
  }

  private prepareRoomRun(input: Omit<CreateRoomRunInput, "membershipVersion"> & {
    membershipVersion?: number;
    windingDown: boolean;
    comparePolicyOnDuplicate: boolean;
  }, afterCreate?: (prepared: ReturnType<AppRepository["createRoomRunWithInitialTurns"]>) => void): {
    disposition: "created" | "duplicate";
    run: RoomRun;
    turns: AgentTurn[];
  } {
    const attachments = normalizeAttachmentDrafts(input.attachments);
    const attachmentMetadata = attachments.map(({ content: _content, ...attachment }) => attachment);
    const canonicalTargetIds = input.initialTurns.map((turn) => turn.agentId).toSorted();
    const routingMode = input.routingMode ?? "legacy";
    const routingReason = input.routingReason?.trim() || null;
    const orchestrationEnabled = input.orchestrationEnabled ?? routingMode !== "legacy";
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
    const bodyDigest = digestRoomCommand(input.roomId, input.sessionId, input.text, commandTargetIds, routingMode, attachmentMetadata);
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
        existing.orchestrationEnabled !== orchestrationEnabled ||
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
             id, session_id, generation, seq, client_nonce, role, body, attachments_json, status, updated_seq,
             speaker_bot_id, speaker_name_snapshot, source_turn_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'user', ?, ?, 'completed', ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          triggerMessageId,
          session.id,
          session.generation,
          sequence,
          input.clientNonce,
          input.text,
          JSON.stringify(attachmentMetadata),
          updatedSeq,
          timestamp,
          timestamp,
        );
      this.insertMessageAttachments(triggerMessageId, input.clientNonce, attachments);
      this.database
        .prepare(
          `INSERT INTO room_batches(
             id, room_id, session_id, client_nonce, trigger_message_id, target_digest, routing_mode, routing_reason, orchestration_enabled, state, membership_version,
             max_turns, max_hops, max_targets_per_turn, deadline_at, is_winding_down,
             version, created_at, updated_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
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
          orchestrationEnabled ? 1 : 0,
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
      afterCreate?.({ disposition: "created", run: this.getRoomRun(runId), turns: this.listAgentTurns(runId) });
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

  findLatestCompletedWorkspaceArtifact(sessionId: string, pathPrefix: string): {
    invocation: ToolInvocation;
    run: RuntimeRun;
    sourceTurnId: string | null;
  } | null {
    const session = this.getSession(sessionId);
    const prefix = pathPrefix.trim();
    if (!prefix || prefix.length > 1_024) throw new AevorenBotError("INVALID_REQUEST");
    // A newer incomplete/failed write must not silently resurrect an older Brief.
    const invocation = (this.database.prepare(
      `SELECT tool_invocations.* FROM tool_invocations
       INNER JOIN runtime_runs ON runtime_runs.id = tool_invocations.runtime_run_id
       WHERE tool_invocations.session_id = ? AND runtime_runs.input_generation = ?
         AND tool_invocations.tool_kind = 'workspace-write'
       ORDER BY tool_invocations.created_at DESC, tool_invocations.rowid DESC`,
    ).all(sessionId, session.generation) as ToolInvocationRow[])
      .map(toToolInvocation).find((candidate) => candidate.targetPath.startsWith(prefix));
    return invocation ? this.getCompletedWorkspaceArtifact(sessionId, invocation.id) : null;
  }

  getCompletedWorkspaceArtifact(sessionId: string, invocationId: string, runtimeRunId?: string): {
    invocation: ToolInvocation;
    run: RuntimeRun;
    sourceTurnId: string;
  } | null {
    const session = this.getSession(sessionId);
    const invocation = this.getToolInvocation(invocationId);
    if (
      invocation.sessionId !== sessionId || (runtimeRunId && invocation.runtimeRunId !== runtimeRunId) ||
      invocation.toolKind !== "workspace-write" || invocation.state !== "succeeded" ||
      !invocation.workspaceId || !invocation.resultDigest || !invocation.finishedAt
    ) return null;
    try {
      const { source, sourceTurn } = this.completedReceiptSource(invocation.runtimeRunId, sessionId, session.generation);
      this.receiptArtifact(invocation);
      return { invocation, run: source, sourceTurnId: sourceTurn.id };
    } catch {
      return null;
    }
  }

  private completedReceiptSource(sourceRuntimeRunId: string, sessionId: string, generation: number): {
    source: RuntimeRun;
    sourceTurn: RoomTurn;
    assistant: TranscriptEntry;
  } {
    const source = this.getRuntimeRun(sourceRuntimeRunId);
    const sourceTurnRow = this.database.prepare("SELECT id FROM room_turns WHERE runtime_run_id = ? LIMIT 1")
      .get(source.id) as { id: string } | undefined;
    if (
      source.sessionId !== sessionId || source.inputGeneration !== generation || source.state !== "completed" ||
      !source.assistantEntryId || !source.finishedAt || !sourceTurnRow
    ) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    const sourceTurn = this.getRoomTurn(sourceTurnRow.id);
    const assistant = this.getTranscriptEntry(source.assistantEntryId);
    const sourceBatch = this.getRoomRun(sourceTurn.runId);
    if (
      sourceTurn.state !== "completed" || sourceTurn.inputGeneration !== generation || sourceTurn.agentId !== source.executorBotId ||
      sourceBatch.sessionId !== sessionId || assistant.sessionId !== sessionId || assistant.generation !== generation ||
      assistant.status !== "completed" || assistant.role !== "assistant" || assistant.sourceTurnId !== sourceTurn.id ||
      assistant.speakerBotId !== source.executorBotId
    ) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    return { source, sourceTurn, assistant };
  }

  private receiptArtifact(invocation: ToolInvocation): ExecutionEvidenceReceipt["artifacts"][number] {
    const sha256 = invocation.resultMetadata?.sha256;
    const bytes = invocation.resultMetadata?.bytes;
    if (
      invocation.toolKind !== "workspace-write" || invocation.arguments.kind !== "workspace-write" ||
      invocation.state !== "succeeded" || !invocation.workspaceId || !invocation.resultDigest || !invocation.finishedAt ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256) ||
      typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 ||
      bytes !== Buffer.byteLength(invocation.arguments.content, "utf8") ||
      sha256 !== createHash("sha256").update(invocation.arguments.content, "utf8").digest("hex")
    ) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    this.getWorkspace(invocation.workspaceId);
    return {
      invocationId: invocation.id,
      sourceRuntimeRunId: invocation.runtimeRunId,
      workspaceId: invocation.workspaceId,
      path: invocation.targetPath,
      resultDigest: invocation.resultDigest,
      sha256,
      bytes,
      finishedAt: invocation.finishedAt,
    };
  }

  createExecutionEvidenceReceipt(
    targetTurnId: string,
    sourceRuntimeRunId: string,
    approval?: NonNullable<ExecutionEvidenceReceipt["approvedBrief"]>,
  ): ExecutionEvidenceReceipt {
    const target = this.getRoomTurn(targetTurnId);
    const existing = this.getExecutionEvidenceReceipt(targetTurnId);
    if (existing) {
      if (
        existing.sourceRuntimeRunId !== sourceRuntimeRunId ||
        (approval && (
          existing.approvedBrief?.candidate !== approval.candidate ||
          existing.approvedBrief.approvalEntryId !== approval.approvalEntryId ||
          existing.approvedBrief.briefInvocationId !== approval.briefInvocationId ||
          existing.approvedBrief.sha256 !== approval.sha256
        ))
      ) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
      return existing;
    }
    if (target.state !== "queued") throw new AevorenBotError("RUNTIME_STATE_INVALID", undefined, undefined, { currentState: target.state });
    const evidence = this.collectExecutionEvidence(target, sourceRuntimeRunId, approval, new Set([target.id]));
    const unsigned = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      targetTurnId: target.id,
      ...evidence,
      createdAt: now(),
    };
    const receipt: ExecutionEvidenceReceipt = {
      ...unsigned,
      digest: createHash("sha256").update(JSON.stringify(unsigned), "utf8").digest("hex"),
    };
    const updated = this.database.prepare(
      `UPDATE room_turns SET execution_receipt_json = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND state = 'queued' AND execution_receipt_json IS NULL`,
    ).run(JSON.stringify(receipt), now(), target.id);
    if (Number(updated.changes) !== 1) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    return this.getExecutionEvidenceReceipt(target.id)!;
  }

  private collectExecutionEvidence(
    target: RoomTurn,
    sourceRuntimeRunId: string,
    approval: ExecutionEvidenceReceipt["approvedBrief"] | undefined,
    seen: Set<string>,
  ): Omit<ExecutionEvidenceReceipt, "schemaVersion" | "id" | "targetTurnId" | "createdAt" | "digest"> {
    const batch = this.getRoomRun(target.runId);
    const session = this.getSession(batch.sessionId);
    if (session.roomId !== batch.roomId || target.inputGeneration !== session.generation) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    const { source, sourceTurn, assistant } = this.completedReceiptSource(sourceRuntimeRunId, session.id, session.generation);
    const sourceBatch = this.getRoomRun(sourceTurn.runId);
    if (sourceBatch.roomId !== batch.roomId || sourceTurn.id === target.id) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    const inherited = this.readExecutionEvidenceReceipt(sourceTurn.id, seen);
    let approvedBrief = inherited?.approvedBrief ?? null;
    if (target.parentTurnId) {
      if (target.parentTurnId !== sourceTurn.id || sourceTurn.runId !== target.runId || approval) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
      const incoming = this.getIncomingHandoff(target.id);
      if (!incoming || incoming.fromTurnId !== sourceTurn.id || incoming.toAgentId !== target.agentId) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    } else {
      if (!approval || !["A", "B", "C"].includes(approval.candidate)) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
      const approvalEntry = this.getTranscriptEntry(approval.approvalEntryId);
      const brief = this.getCompletedWorkspaceArtifact(session.id, approval.briefInvocationId, source.id);
      if (
        approvalEntry.id !== batch.triggerMessageId || approvalEntry.clientNonce !== batch.clientNonce ||
        approvalEntry.sessionId !== session.id || approvalEntry.generation !== session.generation ||
        approvalEntry.role !== "user" || approvalEntry.status !== "completed" || approvalEntry.seq <= assistant.seq ||
        !brief || !brief.invocation.targetPath.startsWith("02-briefs/") || brief.invocation.resultMetadata?.sha256 !== approval.sha256
      ) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
      approvedBrief = approval;
    }
    const succeeded = this.listToolInvocations(batch.sessionId).filter((invocation) => (
      invocation.runtimeRunId === source.id &&
      invocation.state === "succeeded" &&
      invocation.resultDigest !== null &&
      invocation.finishedAt !== null
    ));
    const tools = succeeded.map((invocation) => ({
      invocationId: invocation.id,
      sourceRuntimeRunId: invocation.runtimeRunId,
      kind: invocation.toolKind,
      workspaceId: invocation.workspaceId,
      targetPath: invocation.targetPath,
      resultDigest: invocation.resultDigest!,
      resultMetadata: invocation.resultMetadata,
      finishedAt: invocation.finishedAt!,
    }));
    const artifacts = succeeded.filter((invocation) => invocation.toolKind === "workspace-write")
      .map((invocation) => this.receiptArtifact(invocation));
    const request = this.getTranscriptEntry(sourceBatch.triggerMessageId);
    if (request.sessionId !== session.id || request.generation !== session.generation || request.role !== "user" || request.status !== "completed") {
      throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    }
    return {
      roomId: batch.roomId,
      sessionId: batch.sessionId,
      generation: session.generation,
      sourceRuntimeRunId: source.id,
      sourceTurnId: sourceTurn.id,
      sourceAgentId: source.executorBotId,
      sourceAssistantEntryId: source.assistantEntryId!,
      sourceCompletedAt: source.finishedAt!,
      taskRequirements: inherited?.taskRequirements ?? { sourceEntryId: request.id, text: request.body },
      approvedBrief,
      tools: [...new Map([...(inherited?.tools ?? []), ...tools].map((tool) => [tool.invocationId, tool])).values()],
      artifacts: [...new Map([...(inherited?.artifacts ?? []), ...artifacts].map((artifact) => [artifact.invocationId, artifact])).values()],
    };
  }

  getExecutionEvidenceReceipt(turnId: string): ExecutionEvidenceReceipt | null {
    return this.readExecutionEvidenceReceipt(turnId, new Set());
  }

  isBriefApproved(sessionId: string, briefInvocationId: string, sha256: string): boolean {
    this.getSession(sessionId);
    const rows = this.database.prepare(
      `SELECT room_turns.id FROM room_turns INNER JOIN room_batches ON room_batches.id = room_turns.batch_id
       WHERE room_batches.session_id = ? AND room_turns.parent_turn_id IS NULL
         AND json_extract(room_turns.execution_receipt_json, '$.approvedBrief.briefInvocationId') = ?
         AND json_extract(room_turns.execution_receipt_json, '$.approvedBrief.sha256') = ?`,
    ).all(sessionId, briefInvocationId, sha256) as Array<{ id: string }>;
    return rows.some((row) => this.getExecutionEvidenceReceipt(row.id)?.approvedBrief?.briefInvocationId === briefInvocationId);
  }

  private readExecutionEvidenceReceipt(turnId: string, seen: Set<string>): ExecutionEvidenceReceipt | null {
    if (seen.has(turnId) || seen.size > 64) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    const ancestors = new Set(seen).add(turnId);
    const turn = this.getRoomTurn(turnId);
    const row = this.database.prepare(
      `SELECT id, execution_receipt_json FROM room_turns
       WHERE batch_id = ? AND logical_turn_id = ? AND execution_receipt_json IS NOT NULL
       ORDER BY attempt_no ASC LIMIT 1`,
    ).get(turn.batchId, turn.logicalTurnId) as { id: string; execution_receipt_json: string } | undefined;
    if (!row) return null;
    try {
      const receipt = JSON.parse(row.execution_receipt_json) as ExecutionEvidenceReceipt;
      const { digest, ...unsigned } = receipt;
      const actual = createHash("sha256").update(JSON.stringify(unsigned), "utf8").digest("hex");
      if (
        receipt.schemaVersion !== 1 ||
        receipt.targetTurnId !== row.id ||
        digest !== actual
      ) throw new Error("invalid receipt");
      const original = this.getRoomTurn(row.id);
      if (original.agentId !== turn.agentId || original.inputGeneration !== turn.inputGeneration) throw new Error("invalid retry scope");
      const evidence = this.collectExecutionEvidence(original, receipt.sourceRuntimeRunId,
        original.parentTurnId ? undefined : receipt.approvedBrief, ancestors);
      const expected = { schemaVersion: 1, id: receipt.id, targetTurnId: original.id, ...evidence, createdAt: receipt.createdAt };
      if (JSON.stringify(unsigned) !== JSON.stringify(expected)) throw new Error("receipt evidence changed");
      return receipt;
    } catch {
      throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    }
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
    return this.getRoomRun(runId).orchestrationEnabled;
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
    options: {
      executorBotId?: string;
      executionKey?: string;
      inputSeq?: number;
      promptCutoffSeq?: number;
      providerInstanceId?: string;
      providerModelId?: string;
    } = {},
  ): RuntimeRun {
    const journal = this.getSendOrThrow(clientNonce);
    const input = this.getUserMessage(clientNonce);
    if (this.getActiveRuntimeRun(journal.sessionId)) throw new AevorenBotError("SESSION_BUSY");
    const executorBotId = options.executorBotId ?? this.getBotForSession(journal.sessionId).id;
    const executorBot = this.getBot(executorBotId);
    const providerInstanceId = options.providerInstanceId ?? (route === "fake" ? "fake" : executorBot.modelSelection.providerInstanceId);
    const providerModelId = options.providerModelId ?? (route === "fake" ? "" : executorBot.modelSelection.modelId);
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
             provider_instance_id, provider_model_id,
             input_generation, input_seq, prompt_cutoff_seq,
             assistant_entry_id, provider_request_id, prompt_manifest_json, version, last_error_code,
             created_at, accepted_at, last_activity_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1, NULL, ?, NULL, ?, NULL)`,
        )
        .run(
          id,
          journal.sessionId,
          clientNonce,
          executionKey,
          executorBotId,
          Number(attempt.current) + 1,
          route,
          providerInstanceId,
          providerModelId,
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

  listMcpServerConfigs(): McpServerConfig[] {
    return (this.database
      .prepare("SELECT * FROM mcp_servers ORDER BY name ASC, id ASC")
      .all() as McpServerRow[]).map(toMcpServerConfig);
  }

  listRoutines(): Routine[] {
    return (this.database.prepare("SELECT * FROM routines ORDER BY created_at ASC, id ASC").all() as RoutineRow[]).map(toRoutine);
  }

  getRoutine(id: string): Routine {
    const row = this.database.prepare("SELECT * FROM routines WHERE id = ?").get(id) as RoutineRow | undefined;
    if (!row) throw new AevorenBotError("ROUTINE_NOT_FOUND");
    return toRoutine(row);
  }

  createRoutine(input: { name: string; prompt: string; botId: string; schedule: RoutineSchedule; enabled: boolean; nextRunAt: number | null }): Routine {
    this.getBot(input.botId);
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(
      `INSERT INTO routines(id,name,prompt,bot_id,schedule_json,enabled,next_run_at,version,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,1,?,?)`,
    ).run(id, input.name, input.prompt, input.botId, JSON.stringify(input.schedule), input.enabled ? 1 : 0, input.nextRunAt, timestamp, timestamp);
    return this.getRoutine(id);
  }

  updateRoutine(id: string, expectedVersion: number, patch: Partial<Pick<Routine, "name" | "prompt" | "schedule">>, nextRunAt: number | null): Routine {
    const current = this.getRoutine(id);
    const updated = this.database.prepare(
      `UPDATE routines SET name=?,prompt=?,schedule_json=?,next_run_at=?,version=version+1,updated_at=? WHERE id=? AND version=?`,
    ).run(patch.name ?? current.name, patch.prompt ?? current.prompt, JSON.stringify(patch.schedule ?? current.schedule), nextRunAt, now(), id, expectedVersion);
    if (Number(updated.changes) !== 1) this.throwRoutineConflict(id);
    return this.getRoutine(id);
  }

  setRoutineEnabled(id: string, expectedVersion: number, enabled: boolean, nextRunAt: number | null): Routine {
    const updated = this.database.prepare(
      "UPDATE routines SET enabled=?,next_run_at=?,version=version+1,updated_at=? WHERE id=? AND version=?",
    ).run(enabled ? 1 : 0, nextRunAt, now(), id, expectedVersion);
    if (Number(updated.changes) !== 1) this.throwRoutineConflict(id);
    return this.getRoutine(id);
  }

  deleteRoutine(id: string, expectedVersion: number): void {
    const active = this.database.prepare("SELECT 1 FROM routine_runs WHERE routine_id=? AND state IN ('queued','waiting','running')").get(id);
    if (active) throw new AevorenBotError("ROUTINE_BUSY");
    const deleted = this.database.prepare("DELETE FROM routines WHERE id=? AND version=?").run(id, expectedVersion);
    if (Number(deleted.changes) !== 1) this.throwRoutineConflict(id);
  }

  listRoutineRuns(routineId?: string): RoutineRun[] {
    if (routineId) this.getRoutine(routineId);
    const rows = this.database.prepare(
      `SELECT * FROM routine_runs ${routineId ? "WHERE routine_id = ?" : ""} ORDER BY scheduled_for DESC, id DESC LIMIT 500`,
    ).all(...(routineId ? [routineId] : [])) as RoutineRunRow[];
    return rows.map(toRoutineRun);
  }

  createRoutineRun(routine: Routine, trigger: "schedule" | "manual", triggerKey: string, scheduledFor: number, state: RoutineRun["state"] = "queued"): RoutineRun {
    const id = randomUUID();
    const clientNonce = randomUUID();
    const timestamp = now();
    this.database.prepare(
      `INSERT INTO routine_runs(
         id,routine_id,routine_name,bot_id,prompt_snapshot,schedule_snapshot_json,trigger,trigger_key,
         scheduled_for,state,client_nonce,runtime_run_id,last_error_code,created_at,started_at,finished_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,NULL,?)`,
    ).run(
      id, routine.id, routine.name, routine.botId, routine.prompt, JSON.stringify(routine.schedule), trigger, triggerKey,
      scheduledFor, state, clientNonce, timestamp, ["missed", "cancelled"].includes(state) ? timestamp : null,
    );
    return this.getRoutineRun(id);
  }

  getRoutineRun(id: string): RoutineRun {
    const row = this.database.prepare("SELECT * FROM routine_runs WHERE id=?").get(id) as RoutineRunRow | undefined;
    if (!row) throw new AevorenBotError("ROUTINE_RUN_NOT_FOUND");
    return toRoutineRun(row);
  }

  listPendingRoutineRuns(): RoutineRun[] {
    return (this.database.prepare("SELECT * FROM routine_runs WHERE state IN ('queued','waiting','running') ORDER BY scheduled_for ASC,id ASC").all() as RoutineRunRow[]).map(toRoutineRun);
  }

  advanceRoutineAndCreateRun(routineId: string, expectedNextRunAt: number, nextRunAt: number | null, missed: boolean): RoutineRun | null {
    return this.transaction(() => {
      const routine = this.getRoutine(routineId);
      const updated = this.database.prepare(
        "UPDATE routines SET next_run_at=?,enabled=CASE WHEN json_extract(schedule_json,'$.type')='once' THEN 0 ELSE enabled END,version=version+1,updated_at=? WHERE id=? AND enabled=1 AND next_run_at=?",
      ).run(nextRunAt, now(), routineId, expectedNextRunAt);
      if (Number(updated.changes) !== 1) return null;
      return this.createRoutineRun(routine, "schedule", `${routine.id}:schedule:${expectedNextRunAt}`, expectedNextRunAt, missed ? "missed" : "queued");
    });
  }

  attachRoutineRuntime(runId: string, runtimeRunId: string): RoutineRun {
    const updated = this.database.prepare(
      "UPDATE routine_runs SET runtime_run_id=?,state='running',started_at=? WHERE id=? AND state IN ('queued','waiting')",
    ).run(runtimeRunId, now(), runId);
    if (Number(updated.changes) !== 1) throw new AevorenBotError("ROUTINE_RUN_STATE_INVALID");
    return this.getRoutineRun(runId);
  }

  transitionRoutineRun(runId: string, state: RoutineRun["state"], errorCode: string | null = null): RoutineRun {
    const terminal = ["completed", "failed", "cancelled", "missed"].includes(state);
    const updated = this.database.prepare(
      "UPDATE routine_runs SET state=?,last_error_code=?,finished_at=CASE WHEN ?=1 THEN ? ELSE finished_at END WHERE id=?",
    ).run(state, errorCode, terminal ? 1 : 0, now(), runId);
    if (Number(updated.changes) !== 1) throw new AevorenBotError("ROUTINE_RUN_NOT_FOUND");
    return this.getRoutineRun(runId);
  }

  hasEnabledRoutines(): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM routines WHERE enabled=1 LIMIT 1").get());
  }

  private throwRoutineConflict(id: string): never {
    const current = this.getRoutine(id);
    throw new AevorenBotError("ROUTINE_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
  }

  getMcpServerConfig(id: string): McpServerConfig {
    const row = this.database.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as McpServerRow | undefined;
    if (!row) throw new AevorenBotError("MCP_SERVER_NOT_FOUND");
    return toMcpServerConfig(row);
  }

  createMcpServerConfig(name: string, transport: McpTransportKind, config: Record<string, unknown>): McpServerConfig {
    if (this.database.prepare("SELECT 1 FROM mcp_servers WHERE name = ?").get(name)) {
      throw new AevorenBotError("MCP_SERVER_NAME_CONFLICT");
    }
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(
      `INSERT INTO mcp_servers(
         id, name, transport, config_json, enabled, version, last_status,
         last_error_code, last_connected_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, 1, 'disabled', NULL, NULL, ?, ?)`,
    ).run(id, name, transport, JSON.stringify(config), timestamp, timestamp);
    return this.getMcpServerConfig(id);
  }

  updateMcpServerConfig(
    id: string,
    expectedVersion: number,
    name: string,
    transport: McpTransportKind,
    config: Record<string, unknown>,
  ): McpServerConfig {
    const duplicate = this.database.prepare("SELECT id FROM mcp_servers WHERE name = ? AND id <> ?").get(name, id);
    if (duplicate) throw new AevorenBotError("MCP_SERVER_NAME_CONFLICT");
    const timestamp = now();
    const updated = this.database.prepare(
      `UPDATE mcp_servers
       SET name = ?, transport = ?, config_json = ?, enabled = 0, version = version + 1,
           last_status = 'disabled', last_error_code = NULL, last_connected_at = NULL, updated_at = ?
       WHERE id = ? AND version = ?`,
    ).run(name, transport, JSON.stringify(config), timestamp, id, expectedVersion);
    if (Number(updated.changes) !== 1) this.throwMcpVersionConflict(id);
    return this.getMcpServerConfig(id);
  }

  setMcpServerEnabled(id: string, expectedVersion: number, enabled: boolean): McpServerConfig {
    const timestamp = now();
    const updated = this.database.prepare(
      `UPDATE mcp_servers
       SET enabled = ?, version = version + 1, last_status = ?, last_error_code = NULL, updated_at = ?
       WHERE id = ? AND version = ?`,
    ).run(enabled ? 1 : 0, enabled ? "connecting" : "disabled", timestamp, id, expectedVersion);
    if (Number(updated.changes) !== 1) this.throwMcpVersionConflict(id);
    return this.getMcpServerConfig(id);
  }

  setMcpServerStatus(id: string, status: McpServerStatus, lastErrorCode: string | null): McpServerConfig {
    const timestamp = now();
    const updated = this.database.prepare(
      `UPDATE mcp_servers
       SET last_status = ?, last_error_code = ?, last_connected_at = CASE WHEN ? = 'available' THEN ? ELSE last_connected_at END,
           updated_at = ?
       WHERE id = ?`,
    ).run(status, lastErrorCode, status, timestamp, timestamp, id);
    if (Number(updated.changes) !== 1) throw new AevorenBotError("MCP_SERVER_NOT_FOUND");
    return this.getMcpServerConfig(id);
  }

  deleteMcpServerConfig(id: string, expectedVersion: number): void {
    const deleted = this.database.prepare("DELETE FROM mcp_servers WHERE id = ? AND version = ?").run(id, expectedVersion);
    if (Number(deleted.changes) !== 1) this.throwMcpVersionConflict(id);
  }

  private throwMcpVersionConflict(id: string): never {
    const current = this.getMcpServerConfig(id);
    throw new AevorenBotError("MCP_SERVER_VERSION_CONFLICT", undefined, undefined, { currentVersion: current.version });
  }

  prepareDecisionJournal(input: {
    idempotencyKey: string;
    policyId: string;
    policyVersion: number;
    provider: DecisionProviderKind;
    inputDigest: string;
  }): { disposition: "prepared" | "duplicate"; journal: DecisionJournalEntry } {
    const existing = this.database
      .prepare("SELECT * FROM decision_journal WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as DecisionJournalRow | undefined;
    if (existing) {
      if (
        existing.policy_id !== input.policyId ||
        existing.policy_version !== input.policyVersion ||
        existing.provider !== input.provider ||
        existing.input_digest !== input.inputDigest
      ) throw new AevorenBotError("DECISION_IDEMPOTENCY_CONFLICT");
      return { disposition: "duplicate", journal: toDecisionJournal(existing) };
    }
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(
      `INSERT INTO decision_journal(
        id, idempotency_key, policy_id, policy_version, provider, model_version, state,
        input_digest, answers_json, confidence_json, fallback_reason, request_id,
        latency_ms, last_error_code, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'prepared', ?, '{}', '{}', NULL, NULL, NULL, NULL, 1, ?, ?)`,
    ).run(
      id,
      input.idempotencyKey,
      input.policyId,
      input.policyVersion,
      input.provider,
      input.inputDigest,
      timestamp,
      timestamp,
    );
    return { disposition: "prepared", journal: this.getDecisionJournal(id) };
  }

  getDecisionJournal(id: string): DecisionJournalEntry {
    const row = this.database.prepare("SELECT * FROM decision_journal WHERE id = ?").get(id) as DecisionJournalRow | undefined;
    if (!row) throw new AevorenBotError("DECISION_NOT_FOUND");
    return toDecisionJournal(row);
  }

  getDecisionJournalByIdempotencyKey(idempotencyKey: string): DecisionJournalEntry | null {
    const row = this.database.prepare("SELECT * FROM decision_journal WHERE idempotency_key = ?").get(idempotencyKey) as DecisionJournalRow | undefined;
    return row ? toDecisionJournal(row) : null;
  }

  updateDecisionJournal(id: string, patch: {
    state?: DecisionState;
    modelVersion?: string | null;
    answers?: Record<string, DecisionAnswer>;
    confidence?: Record<string, number>;
    fallbackReason?: string | null;
    requestId?: string | null;
    latencyMs?: number | null;
    lastErrorCode?: string | null;
  }): DecisionJournalEntry {
    const current = this.getDecisionJournal(id);
    const assignments: string[] = ["version = version + 1", "updated_at = ?"];
    const values: Array<string | number | null> = [now()];
    if (patch.state !== undefined) {
      assignments.push("state = ?");
      values.push(patch.state);
    }
    if (patch.modelVersion !== undefined) {
      assignments.push("model_version = ?");
      values.push(patch.modelVersion);
    }
    if (patch.answers !== undefined) {
      assignments.push("answers_json = ?");
      values.push(JSON.stringify(patch.answers));
    }
    if (patch.confidence !== undefined) {
      assignments.push("confidence_json = ?");
      values.push(JSON.stringify(patch.confidence));
    }
    if (patch.fallbackReason !== undefined) {
      assignments.push("fallback_reason = ?");
      values.push(patch.fallbackReason);
    }
    if (patch.requestId !== undefined) {
      assignments.push("request_id = ?");
      values.push(patch.requestId);
    }
    if (patch.latencyMs !== undefined) {
      assignments.push("latency_ms = ?");
      values.push(patch.latencyMs);
    }
    if (patch.lastErrorCode !== undefined) {
      assignments.push("last_error_code = ?");
      values.push(patch.lastErrorCode);
    }
    values.push(id, current.version);
    const updated = this.database.prepare(
      `UPDATE decision_journal SET ${assignments.join(", ")} WHERE id = ? AND version = ?`,
    ).run(...values);
    if (Number(updated.changes) !== 1) throw new AevorenBotError("DECISION_IDEMPOTENCY_CONFLICT");
    return this.getDecisionJournal(id);
  }

  listDecisionJournals(limit = 100): DecisionJournalEntry[] {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    return (this.database.prepare(
      "SELECT * FROM decision_journal ORDER BY created_at DESC, id DESC LIMIT ?",
    ).all(boundedLimit) as DecisionJournalRow[]).map(toDecisionJournal);
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

  deleteSetting(key: string): void {
    this.database.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
  }
}
