import type { ApiResult } from "./contracts";
import type { MessageMediaReference } from "./media-contracts";
export const SEARCH_KINDS = ["message", "document", "skill", "media", "task", "routine", "local-draft"] as const;
/** Host-owned scope, never accepted from a model/UI search payload. */
export type SearchExecutionContext = { sessionId: string; executorBotId: string; runtimeRunId?: string };
export type SearchKind = typeof SEARCH_KINDS[number];
export type SearchScope = { kind: "all" } | { kind: "session"; sessionId: string } | { kind: "project"; projectId: string };
export type SearchQueryInput = { query: string; scope?: SearchScope; kinds?: SearchKind[]; cursor?: string; limit?: number };
type SourceBase = { sessionId: string; authorityDigest: string };
export type SearchSourceReference = SourceBase & (
  | { type: "message"; id: string; generation: number; seq: number; digest: string }
  | { type: "document" | "skill"; id: string; revisionId: string; digest: string }
  | { type: "media"; id: string; reference: MessageMediaReference; digest: string }
  | { type: "voice-transcript"; id: string; generation: number; digest: string }
  | { type: "realtime-transcript"; id: string; voiceSessionId: string; generation: number; digest: string }
  | { type: "task" | "routine"; id: string; version: number; digest: string }
  | { type: "local-draft"; id: string; revisionId: string; executorBotId: string; digest: string }
);
export type SearchItem = { id: string; kind: SearchKind; title: string; snippet: string; updatedAt: string; source: SearchSourceReference };
export type SearchPage = { items: SearchItem[]; nextCursor: string | null; queryDigest: string };
export type SearchOpenInput = { source: SearchSourceReference };
/** The original source is validated again; no body, secret or alternative fuzzy match is returned. */
export type SearchOpenResult = { source: SearchSourceReference };
export type SearchApi = { query(input: SearchQueryInput): Promise<ApiResult<SearchPage>>; open(input: SearchOpenInput): Promise<ApiResult<SearchOpenResult>> };
