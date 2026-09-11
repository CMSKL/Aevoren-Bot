export type Bot = {
  id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type BotPatch = Partial<Pick<Bot, "name" | "label" | "description" | "instructions">>;

export type Session = {
  id: string;
  botId: string;
  kind: "MAIN";
  generation: number;
  createdAt: string;
  updatedAt: string;
};

export type TranscriptRole = "user" | "assistant";
export type TranscriptStatus = "pending" | "streaming" | "completed" | "failed" | "cancelled";

export type SendState =
  | "prepared"
  | "queued"
  | "dispatching"
  | "accepted-awaiting-echo"
  | "acked"
  | "failed-before-acceptance"
  | "refused"
  | "conflict"
  | "cancelled"
  | "interrupted-unknown";

export type TranscriptEntry = {
  id: string;
  sessionId: string;
  generation: number;
  seq: number;
  clientNonce: string | null;
  role: TranscriptRole;
  body: string;
  status: TranscriptStatus;
  sendState: SendState | null;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
};

export type SendJournalEntry = {
  clientNonce: string;
  sessionId: string;
  bodyDigest: string;
  state: SendState;
  attemptCount: number;
  providerRequestId: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SendCommand = {
  sessionId: string;
  clientNonce: string;
  text: string;
};

export type SendResult = {
  clientNonce: string;
  runId: string;
  disposition: "accepted" | "duplicate";
  state: SendState;
};

export type RuntimeState =
  | "created"
  | "dispatching"
  | "running"
  | "streaming"
  | "cancel-requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RuntimeRoute = "fake" | "openai-compatible";
export type PromptAuthority = "agent-profile" | "user" | "assistant";

export type PromptManifestBlock = {
  authority: PromptAuthority;
  provenance: string;
  scope: string;
  digest: string;
  createdAt: string;
  sourceEntryId: string | null;
};

export type PromptManifest = {
  schemaVersion: 1;
  botId: string;
  profileVersion: number;
  sessionId: string;
  generation: number;
  inputSeq: number;
  blocks: PromptManifestBlock[];
  digest: string;
};

export type RuntimeRun = {
  id: string;
  sessionId: string;
  clientNonce: string;
  attemptNo: number;
  state: RuntimeState;
  route: RuntimeRoute;
  inputGeneration: number;
  inputSeq: number;
  assistantEntryId: string | null;
  providerRequestId: string | null;
  promptManifest: PromptManifest;
  version: number;
  lastErrorCode: string | null;
  createdAt: string;
  acceptedAt: string | null;
  lastActivityAt: string;
  finishedAt: string | null;
};

export type SessionLiveStateName =
  | "idle"
  | "starting"
  | "running"
  | "composing"
  | "retrying"
  | "cancelling"
  | "stale";

export type SessionLiveState = {
  sessionId: string;
  state: SessionLiveStateName;
  activeRunId: string | null;
  activeClientNonce: string | null;
  lastActivityAt: string | null;
  staleAfterMs: number;
};

export type SessionRuntimeSnapshot = {
  sessionId: string;
  generation: number;
  transcriptCursor: number;
  entries: TranscriptEntry[];
  runs: RuntimeRun[];
  liveState: SessionLiveState;
};

export type ModelConfiguration = {
  baseUrl: string;
  modelId: string;
  apiKeyConfigured: boolean;
};

export type SaveModelConfigurationInput = {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
};

export type ErrorDomain =
  | "validation"
  | "bot"
  | "session"
  | "message"
  | "runtime"
  | "provider"
  | "storage"
  | "security"
  | "internal";

export type AppError = {
  code: string;
  domain: ErrorDomain;
  retryable: boolean;
  safeMessage: string;
  details?: Record<string, string | number | boolean | null>;
};

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AppError };

export type TranscriptEvent = {
  sessionId: string;
  entry: TranscriptEntry;
};

export type SendStateEvent = {
  sessionId: string;
  clientNonce: string;
  state: SendState;
  error?: AppError;
};

export type RuntimeEvent = {
  sessionId: string;
  run: RuntimeRun;
  liveState: SessionLiveState;
  error?: AppError;
};

export interface MsBotApi {
  bots: {
    list(): Promise<ApiResult<Bot[]>>;
    create(): Promise<ApiResult<{ bot: Bot; session: Session }>>;
    update(input: { id: string; expectedVersion: number; patch: BotPatch }): Promise<ApiResult<Bot>>;
  };
  sessions: {
    getMain(botId: string): Promise<ApiResult<Session>>;
  };
  transcript: {
    list(sessionId: string): Promise<ApiResult<TranscriptEntry[]>>;
  };
  messages: {
    send(command: SendCommand): Promise<ApiResult<SendResult>>;
    retry(clientNonce: string): Promise<ApiResult<SendResult>>;
    cancel(clientNonce: string): Promise<ApiResult<void>>;
    getStatus(clientNonce: string): Promise<ApiResult<SendJournalEntry>>;
  };
  runtime: {
    getSessionSnapshot(sessionId: string): Promise<ApiResult<SessionRuntimeSnapshot>>;
    cancel(runId: string): Promise<ApiResult<RuntimeRun>>;
    retry(runId: string): Promise<ApiResult<SendResult>>;
  };
  settings: {
    getModelConfiguration(): Promise<ApiResult<ModelConfiguration>>;
    saveModelConfiguration(input: SaveModelConfigurationInput): Promise<ApiResult<ModelConfiguration>>;
    testModelConnection(): Promise<ApiResult<void>>;
  };
  events: {
    subscribeTranscript(listener: (event: TranscriptEvent) => void): () => void;
    subscribeSendState(listener: (event: SendStateEvent) => void): () => void;
    subscribeRuntime(listener: (event: RuntimeEvent) => void): () => void;
  };
  app: {
    ready(): void;
    subscribeBeforeClose(listener: () => void): () => void;
    subscribeCloseBlocked(listener: () => void): () => void;
    confirmClose(canClose: boolean): void;
  };
}
