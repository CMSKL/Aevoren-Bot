import type { DatabaseSync } from "node:sqlite";

/** Narrow read-only source discovery. All bodies and permissions are resolved by SearchService. */
export class SearchRepository {
  constructor(private readonly database: DatabaseSync) {
    database.function("aevoren_search_matches", { deterministic: true }, (value, query) => typeof value === "string" && typeof query === "string"
      && value.normalize("NFKC").toLocaleLowerCase().includes(query.normalize("NFKC").toLocaleLowerCase()) ? 1 : 0);
  }
  messages(sessionId: string, query?: string): string[] {
    return (this.database.prepare(`SELECT e.id FROM transcript_entries e JOIN sessions s ON s.id=e.session_id
      WHERE e.session_id=? AND e.generation=s.generation AND e.status='completed' AND (? IS NULL OR aevoren_search_matches(e.body,?)) ORDER BY e.seq DESC,e.id`)
      .all(sessionId, query ?? null, query ?? null) as { id: string }[]).map(row => row.id);
  }
  voiceTasks(sessionId: string, query?: string, runtimeRunId?: string): string[] {
    return (this.database.prepare(`SELECT v.id FROM voice_tasks v JOIN sessions s ON s.id=v.session_id WHERE v.session_id=? AND v.input_generation=s.generation
      AND v.kind='transcription' AND v.state='completed' AND v.access_revoked=0 AND v.transcript IS NOT NULL
      AND (? IS NULL OR v.runtime_run_id=?) AND (? IS NULL OR aevoren_search_matches(v.transcript,?)) ORDER BY v.updated_at DESC,v.id`)
      .all(sessionId, runtimeRunId ?? null, runtimeRunId ?? null, query ?? null, query ?? null) as { id: string }[]).map(row => row.id);
  }
  realtimeSessions(sessionId: string, query?: string, runtimeRunId?: string): string[] {
    return (this.database.prepare(`SELECT DISTINCT v.id FROM realtime_sessions v JOIN sessions s ON s.id=v.session_id JOIN realtime_turns t ON t.voice_session_id=v.id
      WHERE v.session_id=? AND v.input_generation=s.generation AND t.transcript IS NOT NULL
      AND (? IS NULL OR EXISTS(SELECT 1 FROM runtime_runs r JOIN realtime_turns own ON own.client_nonce=r.client_nonce WHERE r.id=? AND own.voice_session_id=v.id))
      AND (? IS NULL OR aevoren_search_matches(t.transcript,?)) ORDER BY v.id`)
      .all(sessionId, runtimeRunId ?? null, runtimeRunId ?? null, query ?? null, query ?? null) as { id: string }[]).map(row => row.id);
  }
  libraryBinding(sessionId: string, resourceId: string): number {
    return (this.database.prepare("SELECT version FROM session_resource_bindings WHERE session_id=? AND resource_id=? AND revoked_at IS NULL").get(sessionId, resourceId) as { version: number } | undefined)?.version ?? 0;
  }
  mediaBinding(sessionId: string, mediaId: string): string | null {
    return (this.database.prepare("SELECT incarnation FROM session_media_bindings WHERE session_id=? AND media_id=? AND revoked_at IS NULL").get(sessionId, mediaId) as { incarnation: string } | undefined)?.incarnation ?? null;
  }
}
