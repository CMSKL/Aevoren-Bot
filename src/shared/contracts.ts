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
  botId: string | null;
  roomId: string | null;
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
  speakerBotId: string | null;
  speakerNameSnapshot: string | null;
  sourceTurnId: string | null;
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
  speakerBotId?: string;
};

export type PromptManifest = {
  schemaVersion: 1 | 2;
  botId: string;
  profileVersion: number;
  sessionId: string;
  generation: number;
  inputSeq: number;
  promptCutoffSeq?: number;
  roomId?: string;
  roomMembershipVersion?: number;
  executorBotId?: string;
  sourceTurnId?: string;
  handoff?: {
    id: string;
    fromAgentId: string;
    taskDigest: string;
    contextRefs: string[];
    visibility: HandoffVisibility;
  };
  blocks: PromptManifestBlock[];
  digest: string;
};

export type RuntimeRun = {
  id: string;
  sessionId: string;
  clientNonce: string;
  executorBotId: string;
  executionKey: string;
  attemptNo: number;
  state: RuntimeState;
  route: RuntimeRoute;
  inputGeneration: number;
  inputSeq: number;
  promptCutoffSeq: number;
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

export type Room = {
  id: string;
  name: string;
  description: string;
  version: number;
  membershipVersion: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RoomPatch = Partial<Pick<Room, "name" | "description">>;

export type RoomMember = {
  roomId: string;
  botId: string;
  position: number;
  bot: Bot;
};

export type RoomDetail = {
  room: Room;
  members: RoomMember[];
  session: Session;
};

export type RoomRunState = "queued" | "running" | "completed" | "partial" | "cancelled" | "interrupted";
export type AgentTurnState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

// `room_batches` is the persisted RoomRun journal. The legacy names remain aliases
// because the current UI and coordinator still present one batch of member replies.
export type RoomBatchState = RoomRunState;
export type RoomTurnState = AgentTurnState;

export type AgentTurnOutcomeKind = "sent" | "pass" | "skipped" | "timeout" | "cancelled" | "error";

export type AgentTurnOutcome = {
  kind: AgentTurnOutcomeKind;
  summary?: string;
  errorCode?: string;
};

export type AgentTurnOrigin = "initial" | "handoff" | "retry";
export type HandoffVisibility = "room" | "direct";
export type HandoffState = "queued" | "dispatching" | "accepted" | "failed" | "cancelled";

export type RoomRun = {
  id: string;
  roomId: string;
  sessionId: string;
  clientNonce: string;
  triggerMessageId: string;
  targetDigest: string;
  state: RoomRunState;
  membershipVersion: number;
  maxTurns: number;
  usedTurns: number;
  maxHops: number;
  maxTargetsPerTurn: number;
  deadlineAt: string;
  windingDown: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type RoomBatch = RoomRun;

export type AgentTurn = {
  id: string;
  runId: string;
  batchId: string;
  agentId: string;
  memberBotId: string;
  memberNameSnapshot: string;
  logicalTurnId: string;
  parentTurnId: string | null;
  nonce: string;
  hop: number;
  origin: AgentTurnOrigin;
  inputGeneration: number;
  inputSeq: number;
  position: number;
  attemptNo: number;
  version: number;
  state: AgentTurnState;
  outcome: AgentTurnOutcome | null;
  runtimeRunId: string | null;
  promptCutoffSeq: number | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type RoomTurn = AgentTurn;

export type AgentHandoff = {
  id: string;
  runId: string;
  fromTurnId: string;
  fromLogicalTurnId: string;
  toAgentId: string;
  targetTurnId: string;
  task: string;
  contextRefs: string[];
  digest: string;
  visibility: HandoffVisibility;
  state: HandoffState;
  version: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type RoomHandoff = AgentHandoff;

export type InitialAgentTurnInput = {
  agentId: string;
  nonce: string;
};

export type CreateRoomRunInput = {
  roomId: string;
  sessionId: string;
  clientNonce: string;
  text: string;
  membershipVersion: number;
  maxTurns: number;
  maxHops: number;
  maxTargetsPerTurn: number;
  deadlineAt: string;
  initialTurns: InitialAgentTurnInput[];
};

export type CreateHandoffInput = {
  runId: string;
  fromTurnId: string;
  toAgentId: string;
  task: string;
  contextRefs: string[];
  visibility: HandoffVisibility;
  targetTurnNonce: string;
  inputGeneration: number;
  inputSeq: number;
};

export type RoomSendCommand = SendCommand & {
  roomId: string;
  targetBotIds: string[];
};

export type RoomSendResult = {
  clientNonce: string;
  batchId: string;
  disposition: "accepted" | "duplicate";
  state: RoomBatchState;
};

export type RoomRuntimeSnapshot = {
  detail: RoomDetail;
  transcriptCursor: number;
  entries: TranscriptEntry[];
  runs: RuntimeRun[];
  batches: RoomBatch[];
  turns: RoomTurn[];
  liveState: SessionLiveState;
};

export type RoomRuntimeEvent = {
  roomId: string;
  sessionId: string;
  batch: RoomBatch;
  turns: RoomTurn[];
  error?: AppError;
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
  | "room"
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
  rooms: {
    list(input?: { includeArchived?: boolean }): Promise<ApiResult<Room[]>>;
    create(input: { memberBotIds: string[]; name?: string; description?: string }): Promise<ApiResult<RoomDetail>>;
    get(id: string): Promise<ApiResult<RoomDetail>>;
    update(input: { id: string; expectedVersion: number; patch: RoomPatch }): Promise<ApiResult<Room>>;
    archive(input: { id: string; archived: boolean }): Promise<ApiResult<Room>>;
    addMember(input: { roomId: string; botId: string; expectedMembershipVersion: number }): Promise<ApiResult<RoomDetail>>;
    removeMember(input: { roomId: string; botId: string; expectedMembershipVersion: number }): Promise<ApiResult<RoomDetail>>;
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
  roomRuntime: {
    getSnapshot(roomId: string): Promise<ApiResult<RoomRuntimeSnapshot>>;
    send(command: RoomSendCommand): Promise<ApiResult<RoomSendResult>>;
    cancel(batchId: string): Promise<ApiResult<RoomBatch>>;
    continue(batchId: string): Promise<ApiResult<RoomBatch>>;
    retryTurn(turnId: string): Promise<ApiResult<RoomTurn>>;
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
    subscribeRoomRuntime(listener: (event: RoomRuntimeEvent) => void): () => void;
  };
  app: {
    ready(): void;
    subscribeBeforeClose(listener: () => void): () => void;
    subscribeCloseBlocked(listener: () => void): () => void;
    confirmClose(canClose: boolean): void;
  };
}
