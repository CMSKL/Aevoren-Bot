import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MINIMUM_DATABASE_SCHEMA_VERSION = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TURN_STATES = ["queued", "running", "completed", "failed", "cancelled", "interrupted"] as const;
const RUNTIME_STATES = [
  "created",
  "dispatching",
  "running",
  "streaming",
  "cancel-requested",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
const HANDOFF_STATES = ["queued", "dispatching", "accepted", "failed", "cancelled"] as const;

const REQUIRED_COLUMNS = {
  room_batches: [
    "id", "room_id", "session_id", "state", "routing_mode", "routing_reason",
    "max_turns", "max_hops", "max_targets_per_turn",
  ],
  room_turns: ["batch_id", "member_bot_id", "logical_turn_id", "hop", "origin", "position", "state"],
  runtime_runs: ["execution_key", "state", "route", "accepted_at", "finished_at"],
  agent_handoffs: ["run_id", "state"],
  handoff_rejections: ["run_id", "error_code"],
} as const;

type DiagnosticErrorCode =
  | "INVALID_ARGUMENTS"
  | "DATABASE_UNAVAILABLE"
  | "UNSUPPORTED_SCHEMA"
  | "RUN_NOT_FOUND"
  | "DIAGNOSTICS_FAILED";

const SAFE_MESSAGES: Record<DiagnosticErrorCode, string> = {
  INVALID_ARGUMENTS: "Expected --db <database-file> and --run <uuid>.",
  DATABASE_UNAVAILABLE: "The database is unavailable for read-only diagnostics.",
  UNSUPPORTED_SCHEMA: "The database schema is not supported by this diagnostics command.",
  RUN_NOT_FOUND: "The requested Room run was not found.",
  DIAGNOSTICS_FAILED: "Room diagnostics could not be completed safely.",
};

class DiagnosticError extends Error {
  readonly code: DiagnosticErrorCode;

  constructor(code: DiagnosticErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.code = code;
  }
}

type CliArguments = { databasePath: string; runId: string };
type CountRow = { state: string; count: number };

function parseArguments(args: string[]): CliArguments {
  const valuesOnly = args[0] === "--" ? args.slice(1) : args;
  if (valuesOnly.length !== 4) throw new DiagnosticError("INVALID_ARGUMENTS");
  const values = new Map<string, string>();
  for (let index = 0; index < valuesOnly.length; index += 2) {
    const flag = valuesOnly[index];
    const value = valuesOnly[index + 1];
    if (!flag || !value || !["--db", "--run"].includes(flag) || values.has(flag) || value.startsWith("--")) {
      throw new DiagnosticError("INVALID_ARGUMENTS");
    }
    values.set(flag, value);
  }
  const databasePath = values.get("--db");
  const runId = values.get("--run");
  if (!databasePath || databasePath.length > 4_096 || databasePath.includes("\0") || !runId || !UUID.test(runId)) {
    throw new DiagnosticError("INVALID_ARGUMENTS");
  }
  return { databasePath, runId };
}

function assertDatabaseFile(databasePath: string): void {
  try {
    if (!statSync(databasePath).isFile()) throw new DiagnosticError("DATABASE_UNAVAILABLE");
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw new DiagnosticError("DATABASE_UNAVAILABLE");
  }
}

function assertSupportedSchema(database: DatabaseSync): number {
  try {
    const requiredTables = ["schema_migrations", ...Object.keys(REQUIRED_COLUMNS)];
    const rows = database
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${requiredTables.map(() => "?").join(",")})`)
      .all(...requiredTables) as Array<{ name: string }>;
    if (rows.length !== requiredTables.length) throw new DiagnosticError("UNSUPPORTED_SCHEMA");

    const migration = database
      .prepare("SELECT MIN(version) AS minimum, MAX(version) AS maximum, COUNT(*) AS count FROM schema_migrations")
      .get() as { minimum: number | null; maximum: number | null; count: number };
    if (
      migration.minimum !== 1
      || migration.maximum === null
      || migration.maximum < MINIMUM_DATABASE_SCHEMA_VERSION
      || migration.count !== migration.maximum
    ) {
      throw new DiagnosticError("UNSUPPORTED_SCHEMA");
    }

    for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
      const columns = new Set(
        (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      if (requiredColumns.some((column) => !columns.has(column))) throw new DiagnosticError("UNSUPPORTED_SCHEMA");
    }
    return migration.maximum;
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw new DiagnosticError("UNSUPPORTED_SCHEMA");
  }
}

function stateCounts<const T extends readonly string[]>(states: T, rows: CountRow[]): Record<T[number], number> {
  const found = new Map(rows.map((row) => [row.state, Number(row.count)]));
  return Object.fromEntries(states.map((state) => [state, found.get(state) ?? 0])) as Record<T[number], number>;
}

function diagnose(database: DatabaseSync, runId: string, schemaVersion: number) {
  const run = database
    .prepare(
      `SELECT id, room_id, session_id, state, routing_mode,
              routing_reason IS NOT NULL AS routing_reason_present,
              COALESCE(length(routing_reason), 0) AS routing_reason_length,
              max_turns, max_hops, max_targets_per_turn
       FROM room_batches WHERE id = ?`,
    )
    .get(runId) as {
      id: string;
      room_id: string;
      session_id: string;
      state: string;
      routing_mode: string;
      routing_reason_present: number;
      routing_reason_length: number;
      max_turns: number;
      max_hops: number;
      max_targets_per_turn: number;
    } | undefined;
  if (!run) throw new DiagnosticError("RUN_NOT_FOUND");

  const initialOwners = database
    .prepare("SELECT member_bot_id FROM room_turns WHERE batch_id = ? AND origin = 'initial' ORDER BY position, rowid")
    .all(runId) as Array<{ member_bot_id: string }>;
  const usage = database
    .prepare(
      `SELECT COUNT(DISTINCT logical_turn_id) AS used_turns,
              COALESCE(MAX(hop), 0) AS used_hops
       FROM room_turns WHERE batch_id = ?`,
    )
    .get(runId) as { used_turns: number; used_hops: number };
  const turnCounts = database
    .prepare("SELECT state, COUNT(*) AS count FROM room_turns WHERE batch_id = ? GROUP BY state")
    .all(runId) as CountRow[];
  const runtimeCounts = database
    .prepare(
      `SELECT runtime.state, COUNT(*) AS count
       FROM runtime_runs AS runtime
       WHERE EXISTS (
         SELECT 1 FROM room_turns AS turn
         WHERE turn.batch_id = ?
           AND runtime.execution_key = turn.batch_id || ':' || turn.logical_turn_id
       )
       GROUP BY runtime.state`,
    )
    .all(runId) as CountRow[];
  const handoffCounts = database
    .prepare("SELECT state, COUNT(*) AS count FROM agent_handoffs WHERE run_id = ? GROUP BY state")
    .all(runId) as CountRow[];
  const rejectionCounts = database
    .prepare("SELECT error_code, COUNT(*) AS count FROM handoff_rejections WHERE run_id = ? GROUP BY error_code ORDER BY error_code")
    .all(runId) as Array<{ error_code: string; count: number }>;
  const timing = database
    .prepare(
      `SELECT COUNT(duration_ms) AS count, MIN(duration_ms) AS minimum,
              MAX(duration_ms) AS maximum, ROUND(AVG(duration_ms)) AS average
       FROM (
         SELECT ROUND((julianday(finished_at) - julianday(accepted_at)) * 86400000) AS duration_ms
         FROM runtime_runs AS runtime
         WHERE route = 'openai-compatible'
           AND accepted_at IS NOT NULL AND finished_at IS NOT NULL
           AND julianday(accepted_at) IS NOT NULL AND julianday(finished_at) >= julianday(accepted_at)
           AND EXISTS (
             SELECT 1 FROM room_turns AS turn
             WHERE turn.batch_id = ?
               AND runtime.execution_key = turn.batch_id || ':' || turn.logical_turn_id
           )
       )`,
    )
    .get(runId) as { count: number; minimum: number | null; maximum: number | null; average: number | null };

  return {
    schemaVersion,
    runId: run.id,
    roomId: run.room_id,
    sessionId: run.session_id,
    state: run.state,
    routingMode: run.routing_mode,
    routingReason: {
      present: run.routing_reason_present === 1,
      length: Number(run.routing_reason_length),
    },
    initialOwnerIds: initialOwners.map((owner) => owner.member_bot_id),
    budget: {
      turns: { max: Number(run.max_turns), used: Number(usage.used_turns) },
      hops: { max: Number(run.max_hops), used: Number(usage.used_hops) },
      maxTargetsPerTurn: Number(run.max_targets_per_turn),
    },
    stateCounts: {
      turns: stateCounts(TURN_STATES, turnCounts),
      runtimes: stateCounts(RUNTIME_STATES, runtimeCounts),
      handoffs: stateCounts(HANDOFF_STATES, handoffCounts),
    },
    rejectionErrorCodeCounts: Object.fromEntries(
      rejectionCounts.map((row) => [row.error_code, Number(row.count)]),
    ),
    providerTimingMs: {
      count: Number(timing.count),
      min: timing.minimum === null ? null : Number(timing.minimum),
      max: timing.maximum === null ? null : Number(timing.maximum),
      avg: timing.average === null ? null : Number(timing.average),
    },
  };
}

function main(): void {
  let database: DatabaseSync | undefined;
  try {
    const { databasePath, runId } = parseArguments(process.argv.slice(2));
    assertDatabaseFile(databasePath);
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
    } catch {
      throw new DiagnosticError("DATABASE_UNAVAILABLE");
    }
    const schemaVersion = assertSupportedSchema(database);
    process.stdout.write(`${JSON.stringify(diagnose(database, runId, schemaVersion), null, 2)}\n`);
  } catch (error) {
    const code = error instanceof DiagnosticError ? error.code : "DIAGNOSTICS_FAILED";
    process.stderr.write(`${JSON.stringify({ error: { code, message: SAFE_MESSAGES[code] } })}\n`);
    process.exitCode = 1;
  } finally {
    database?.close();
  }
}

main();
