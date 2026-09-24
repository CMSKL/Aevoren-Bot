import type { BotAvatarColor, BotAvatarShape } from "./bot-avatar";

export const DEFAULT_PROJECT_ID = "10000000-0000-4000-8000-000000000001";

export type Bot = {
  id: string;
  projectId: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  modelSelection: ModelSelection;
  avatarShape: BotAvatarShape;
  avatarColor: BotAvatarColor;
  mcpServerIds?: string[] | null;
  memoryWorkspaceIds?: string[];
  pinnedAt: string | null;
  hiddenAt: string | null;
  hasUnread: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type BotPatch = Partial<Pick<Bot, "name" | "label" | "description" | "instructions" | "modelSelection" | "avatarShape" | "avatarColor" | "mcpServerIds" | "memoryWorkspaceIds">>;

export type BotDeleteResult = {
  id: string;
  affectedRoomIds: string[];
  archivedRoomIds: string[];
};

export type ConversationBatchDeleteInput = {
  botIds: string[];
  roomIds: string[];
};

export type ConversationBatchDeleteResult = {
  bots: BotDeleteResult[];
  rooms: RoomDeleteResult[];
};

export type MemorySource = "manual-user" | "model-captured";
export type MemoryKind = "fact" | "preference" | "decision" | "procedure";
export type MemoryScope = "user" | "bot" | "workspace";

export type MemoryScopeSelector = {
  scope: MemoryScope;
  scopeKey: string;
};

export type MemoryItem = {
  id: string;
  scope?: MemoryScope;
  scopeKey?: string;
  botId: string | null;
  workspaceId?: string | null;
  content: string;
  contentDigest: string;
  kind: MemoryKind;
  source: MemorySource;
  sourceEntryId: string | null;
  expiresAt: string | null;
  version: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryProposalState = "pending" | "accepted" | "rejected";

export type MemoryProposal = {
  id: string;
  botId: string;
  scope: MemoryScope;
  scopeKey: string;
  workspaceId: string | null;
  kind: MemoryKind;
  content: string;
  contentDigest: string;
  reason: string;
  sourceEntryId: string;
  supersedesMemoryId: string | null;
  expiresAt: string | null;
  state: MemoryProposalState;
  version: number;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Workspace = {
  id: string;
  name: string;
  writeEnabled: boolean;
  automationEnabled: boolean;
  version: number;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Project = {
  id: string;
  name: string;
  isDefault: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRegistrationResult = {
  disposition: "registered" | "duplicate" | "restored";
  workspace: Workspace;
};

export type TeamTemplateCreateResult = {
  disposition: "created" | "existing";
  bots: Bot[];
  room: RoomDetail;
};

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
  attachments?: MessageAttachment[];
  /** Main-only prompt enrichment; never populated in Renderer-facing snapshots. */
  attachmentContents?: Array<MessageAttachment & { content: string }>;
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

export type MessageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  kind: "text";
};

/** Content is transient Renderer state and is validated again in Main. */
export type AttachmentDraft = MessageAttachment & {
  content: string;
};

export type ArtifactSaveInput = {
  name: string;
  content: string;
};

export type ArtifactSaveResult = {
  name: string;
  path: string;
  size: number;
};

export type SendCommand = {
  sessionId: string;
  clientNonce: string;
  text: string;
  attachments?: AttachmentDraft[];
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

export type ProviderDriverKind = "openai-compatible" | "codex-cli" | "claude-cli" | "ollama-cli" | "acp-cli";
export type ProviderDiscoveryMode = "automatic" | "manual" | "not-applicable";

export type ModelSelection = {
  providerInstanceId: string;
  modelId: string;
};

export type DecisionProviderKind = "rules" | "fake" | "jev";

export type DecisionState =
  | "prepared"
  | "dispatched"
  | "completed"
  | "timeout"
  | "failed"
  | "rate-limited"
  | "fallback"
  | "cancelled";

export type DecisionAnswer = {
  value: unknown;
  confidence?: number;
  probabilities?: Record<string, number>;
};

export type DecisionRequest = {
  policyId: string;
  policyVersion: number;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  model?: string;
  timeoutMs?: number;
  idempotencyKey: string;
};

export type DecisionResult = {
  provider: DecisionProviderKind;
  modelVersion: string;
  answers: Record<string, DecisionAnswer>;
  latencyMs: number;
  requestId: string | null;
};

export type DecisionJournalEntry = {
  id: string;
  idempotencyKey: string;
  policyId: string;
  policyVersion: number;
  provider: DecisionProviderKind;
  modelVersion: string | null;
  state: DecisionState;
  inputDigest: string;
  answers: Record<string, DecisionAnswer>;
  confidence: Record<string, number>;
  fallbackReason: string | null;
  requestId: string | null;
  latencyMs: number | null;
  lastErrorCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ProviderCapabilities = {
  roomOwnerSelection: boolean;
  handoff: boolean;
  workspaceTools: boolean;
  networkTools?: boolean;
};

export type ProviderModelOption = {
  id: string;
  label: string;
  provider?: string;
  custom?: boolean;
  loaded?: boolean;
};

export type ProviderInstanceInfo = {
  id: string;
  driverKind: ProviderDriverKind;
  displayName: string;
  access: "cloud" | "local";
  enabled: boolean;
  version: number;
  status: "available" | "unavailable";
  reason: string | null;
  authenticated: boolean;
  runtimeVersion: string | null;
  discoveryMode: ProviderDiscoveryMode;
  lastScannedAt: string | null;
  cliPath: string | null;
  cliDefault: string | null;
  manualCliPath: string | null;
  apiKeyConfigured: boolean;
  baseUrl: string | null;
  models: {
    default: string;
    options: ProviderModelOption[];
  };
  capabilities: ProviderCapabilities;
};

export type SaveOpenAiCompatibleProviderInput = {
  instanceId: string;
  expectedVersion: number;
  baseUrl: string;
  apiKey?: string;
};

export type SaveCliProviderInput = {
  instanceId: string;
  expectedVersion: number;
  cliPath: string;
};

export type RuntimeRoute = "fake" | ProviderDriverKind;
export type PromptAuthority = "agent-profile" | "runtime-state" | "memory" | "room-context" | "user" | "assistant";

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
  schemaVersion: 1 | 2 | 3 | 4;
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
  providerInstanceId: string;
  providerModelId: string;
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

export type WorkspaceToolRequest =
  | {
      kind: "workspace-list";
      workspaceId: string;
      path: string;
      maxEntries: number;
    }
  | {
      kind: "workspace-read";
      workspaceId: string;
      path: string;
      maxBytes: number;
    }
  | {
      kind: "workspace-search";
      workspaceId: string;
      path: string;
      query: string;
      maxMatches: number;
    }
  | {
      kind: "workspace-write";
      workspaceId: string;
      path: string;
      content: string;
    };

export type NetworkToolRequest =
  | {
      kind: "web-search";
      query: string;
      maxResults: number;
    }
  | {
      kind: "web-fetch";
      url: string;
      maxCharacters: number;
    }
  | {
      kind: "weather-current";
      location: string;
    }
  | {
      kind: "time-now";
      timezone?: string;
    };

export type McpToolRequest = {
  kind: "mcp-call";
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  readOnly: true;
};

export type DeviceToolRequest = {
  kind: "clipboard-read";
  maxCharacters: number;
};

export type ComputationToolRequest = {
  kind: "text-measure";
  text: string;
};

export type ToolRequest = WorkspaceToolRequest | NetworkToolRequest | McpToolRequest | DeviceToolRequest | ComputationToolRequest;

export type McpTransportKind = "stdio" | "streamable-http";
export type McpServerStatus = "disabled" | "connecting" | "available" | "unavailable" | "needs-auth";

export type McpToolInfo = {
  serverId: string;
  serverName: string;
  name: string;
  namespacedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  claimedReadOnly: boolean;
  readOnly: boolean;
};

export type McpServerInfo = {
  id: string;
  name: string;
  transport: McpTransportKind;
  command: string | null;
  args: string[];
  url: string | null;
  secretKeys: string[];
  oauthConfigured: boolean;
  authenticating: boolean;
  trustedReadOnlyTools: string[];
  enabled: boolean;
  status: McpServerStatus;
  lastErrorCode: string | null;
  lastConnectedAt: string | null;
  version: number;
  tools: McpToolInfo[];
  createdAt: string;
  updatedAt: string;
};

export type McpServerMutation = {
  id?: string;
  expectedVersion?: number;
  name: string;
  enabled?: boolean;
  trustedReadOnlyTools?: string[];
  config:
    | {
        transport: "stdio";
        command: string;
        args: string[];
        env: Record<string, string | true>;
      }
    | {
        transport: "streamable-http";
        url: string;
        headers: Record<string, string | true>;
      };
};

export type ToolInvocationCommand = {
  runtimeRunId: string;
  toolCallId: string;
  idempotencyKey: string;
  tool: ToolRequest;
};

export type ToolInvocationState =
  | "prepared"
  | "awaiting-approval"
  | "approved"
  | "dispatching"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "expired"
  | "cancelled"
  | "failed-before-execution"
  | "interrupted-unknown";

export type ToolInvocation = {
  id: string;
  runtimeRunId: string;
  sessionId: string;
  executorBotId: string;
  toolCallId: string;
  idempotencyKey: string;
  commandDigest: string;
  toolKind: ToolRequest["kind"];
  effectClass: CapabilityEffectClass;
  workspaceId: string | null;
  targetPath: string;
  arguments: ToolRequest;
  state: ToolInvocationState;
  attemptCount: number;
  approvalRequestId: string;
  resultDigest: string | null;
  resultMetadata: Record<string, string | number | boolean | null> | null;
  lastErrorCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type ExecutionEvidenceReceipt = {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  roomId: string;
  generation: number;
  targetTurnId: string;
  sourceRuntimeRunId: string;
  sourceTurnId: string | null;
  sourceAgentId: string;
  sourceAssistantEntryId: string;
  sourceCompletedAt: string;
  taskRequirements: { sourceEntryId: string; text: string };
  approvedBrief: {
    candidate: "A" | "B" | "C";
    approvalEntryId: string;
    briefInvocationId: string;
    sha256: string;
  } | null;
  tools: Array<{
    invocationId: string;
    sourceRuntimeRunId: string;
    kind: ToolRequest["kind"];
    workspaceId: string | null;
    targetPath: string;
    resultDigest: string;
    resultMetadata: Record<string, string | number | boolean | null> | null;
    finishedAt: string;
  }>;
  artifacts: Array<{
    invocationId: string;
    sourceRuntimeRunId: string;
    workspaceId: string;
    path: string;
    resultDigest: string;
    sha256: string | null;
    bytes: number | null;
    finishedAt: string;
  }>;
  digest: string;
  createdAt: string;
};

export type BriefApprovalView = {
  approved: boolean;
  sourceRuntimeRunId: string;
  briefInvocationId: string;
  workspaceId: string;
  path: string;
  sha256: string;
  content: string;
};

export type BriefApprovalCommand = Pick<BriefApprovalView, "sourceRuntimeRunId" | "briefInvocationId" | "sha256"> & {
  roomId: string;
  clientNonce: string;
  candidate: "A" | "B" | "C";
};

export type ApprovalState = "pending" | "allowed" | "denied" | "expired" | "cancelled";
export type ApprovalResolution = "allow-once" | "deny";

export type ApprovalRequest = {
  id: string;
  toolInvocationId: string;
  runtimeRunId: string;
  sessionId: string;
  executorBotId: string;
  actionKind: ToolRequest["kind"];
  effectClass: CapabilityEffectClass;
  workspaceId: string | null;
  targetPath: string;
  targetDigest: string;
  argumentsDigest: string;
  requestedScope: "once";
  state: ApprovalState;
  resolution: ApprovalResolution | null;
  policyVersion: number;
  version: number;
  expiresAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ToolPrepareResult = {
  disposition: "prepared" | "duplicate";
  invocation: ToolInvocation;
  approval: ApprovalRequest;
};

export type ToolApprovalResult = {
  invocation: ToolInvocation;
  approval: ApprovalRequest;
};

export type Room = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  version: number;
  membershipVersion: number;
  archivedAt: string | null;
  pinnedAt: string | null;
  hiddenAt: string | null;
  hasUnread: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RoomPatch = Partial<Pick<Room, "name" | "description">>;

export type RoomDeleteResult = {
  id: string;
};

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
export type RoomRoutingMode = "legacy" | "automatic" | "explicit" | "everyone";
export type UserRoomRoutingMode = Exclude<RoomRoutingMode, "legacy">;

export type RoomRun = {
  id: string;
  roomId: string;
  sessionId: string;
  clientNonce: string;
  triggerMessageId: string;
  targetDigest: string;
  routingMode: RoomRoutingMode;
  routingReason: string | null;
  orchestrationEnabled: boolean;
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

export type RoomHandoffView = Pick<
  RoomHandoff,
  "id" | "runId" | "fromTurnId" | "toAgentId" | "targetTurnId" | "task" | "state" | "version" | "createdAt" | "updatedAt" | "finishedAt"
>;

export type RoomHandoffRejectionView = {
  id: string;
  runId: string;
  fromTurnId: string;
  attemptedToAgentId: string;
  errorCode: string;
  createdAt: string;
};

export type InitialAgentTurnInput = {
  agentId: string;
  nonce: string;
};

export type CreateRoomRunInput = {
  roomId: string;
  sessionId: string;
  clientNonce: string;
  text: string;
  attachments?: AttachmentDraft[];
  membershipVersion: number;
  maxTurns: number;
  maxHops: number;
  maxTargetsPerTurn: number;
  deadlineAt: string;
  initialTurns: InitialAgentTurnInput[];
  routingMode?: RoomRoutingMode;
  routingReason?: string | null;
  orchestrationEnabled?: boolean;
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
  routingMode: UserRoomRoutingMode;
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
  handoffs: RoomHandoffView[];
  rejections: RoomHandoffRejectionView[];
  liveState: SessionLiveState;
};

export type RoomRuntimeEvent = {
  roomId: string;
  sessionId: string;
  batch: RoomBatch;
  turns: RoomTurn[];
  handoffs: RoomHandoffView[];
  rejections: RoomHandoffRejectionView[];
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

export type AppearanceTheme = "system" | "light" | "dark";
export type LoginItemStatus = "unsupported" | "not-registered" | "enabled" | "requires-approval" | "not-found";
export const UPDATE_CHECK_INTERVAL_MINUTES = [60, 360, 720, 1_440] as const;
export type UpdateCheckIntervalMinutes = (typeof UPDATE_CHECK_INTERVAL_MINUTES)[number];

export type GeneralSettings = {
  theme: AppearanceTheme;
  memoryCaptureEnabled: boolean;
  autoApprovePublicReadTools: boolean;
  updateCheckIntervalMinutes: UpdateCheckIntervalMinutes;
  launchAtLogin: boolean;
  launchAtLoginSupported: boolean;
  launchAtLoginStatus: LoginItemStatus;
};

export type SaveGeneralSettings = {
  theme?: AppearanceTheme;
  memoryCaptureEnabled?: boolean;
  autoApprovePublicReadTools?: boolean;
  updateCheckIntervalMinutes?: UpdateCheckIntervalMinutes;
  launchAtLogin?: boolean;
};

export type CapabilityEffectClass =
  | "pure"
  | "read-local"
  | "read-remote"
  | "write-reversible"
  | "write-external"
  | "irreversible"
  | "computer-control";

export type CapabilityAdapterKind = "core" | "local" | "native" | "mcp" | "connector" | "none";
export type CapabilityAvailability = "available" | "unavailable" | "permission-required" | "not-supported";
export type CapabilityPermissionState = "not-required" | "granted" | "not-granted" | "unsupported";

export type CapabilityDescriptor = {
  id: string;
  name: string;
  category: "conversation" | "memory" | "workspace" | "network" | "device" | "automation" | "multimodal" | "external";
  description: string;
  effectClass: CapabilityEffectClass;
  adapterKind: CapabilityAdapterKind;
  availability: CapabilityAvailability;
  reason: string | null;
  permissionState: CapabilityPermissionState;
  toolNames: string[];
};

export type CapabilityPermission = {
  id: string;
  name: string;
  state: CapabilityPermissionState;
  scopeSummary: string;
  revocable: boolean;
};

export type CapabilityConnection = {
  id: string;
  name: string;
  kind: "model-provider" | "mcp" | "connector";
  status: "available" | "unavailable";
  access: "cloud" | "local";
  authenticated: boolean;
  modelCount: number;
};

export type CapabilityModelState = {
  providerInstanceId: string;
  providerName: string;
  providerStatus: "available" | "unavailable" | "unknown";
  modelId: string;
};

export type CapabilityPromptSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  timezone: string;
  utcOffsetMinutes: number;
  app: {
    name: "Aevoren Bot";
    version: string;
    platform: "darwin" | "win32" | "linux" | "other";
    architecture: string;
    packaged: boolean;
  };
  model: CapabilityModelState;
  availableTools: string[];
  capabilities: Array<Pick<CapabilityDescriptor, "id" | "availability" | "reason">>;
};

export type CapabilitySnapshot = Omit<CapabilityPromptSnapshot, "capabilities"> & {
  capabilities: CapabilityDescriptor[];
  permissions: CapabilityPermission[];
  connections: CapabilityConnection[];
  workspaceCount: number;
  backgroundMode: "foreground-only" | "background-while-routines-enabled";
};

export type UpdateChannel = "development" | "beta" | "stable";

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "install-interrupted"
  | "updated"
  | "error";

export type UpdateProgress = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

export type ErrorDomain =
  | "validation"
  | "bot"
  | "session"
  | "room"
  | "memory"
  | "workspace"
  | "message"
  | "runtime"
  | "tool"
  | "approval"
  | "decision"
  | "provider"
  | "storage"
  | "security"
  | "update"
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

export type ToolEvent = {
  sessionId: string;
  invocation: ToolInvocation;
  approval: ApprovalRequest;
};

export type UpdateState = {
  channel: UpdateChannel;
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  progress: UpdateProgress | null;
  checkedAt: string | null;
  error: AppError | null;
};

export type UpdateEvent = {
  state: UpdateState;
};

export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "interval"; everyMinutes: number; anchorAt: number }
  | { type: "cron"; expression: string; timeZone: string };

export type Routine = {
  id: string;
  name: string;
  prompt: string;
  botId: string;
  enabled: boolean;
  schedule: RoutineSchedule;
  nextRunAt: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type RoutineRun = {
  id: string;
  routineId: string;
  routineName: string;
  botId: string;
  promptSnapshot: string;
  scheduleSnapshot: RoutineSchedule;
  trigger: "schedule" | "manual";
  triggerKey: string;
  scheduledFor: number;
  state: "queued" | "waiting" | "running" | "completed" | "failed" | "cancelled" | "missed";
  clientNonce: string;
  runtimeRunId: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export interface AevorenBotApi {
  attachments: {
    pick(): Promise<ApiResult<AttachmentDraft[]>>;
  };
  artifacts: {
    save(input: ArtifactSaveInput): Promise<ApiResult<ArtifactSaveResult | null>>;
    reveal(path: string): Promise<ApiResult<boolean>>;
  };
  capabilities: {
    getSnapshot(input?: { botId?: string }): Promise<ApiResult<CapabilitySnapshot>>;
  };
  mcp: {
    list(): Promise<ApiResult<McpServerInfo[]>>;
    save(input: McpServerMutation): Promise<ApiResult<McpServerInfo>>;
    setEnabled(input: { id: string; expectedVersion: number; enabled: boolean }): Promise<ApiResult<McpServerInfo>>;
    probe(id: string): Promise<ApiResult<McpServerInfo>>;
    authorize(id: string): Promise<ApiResult<McpServerInfo>>;
    cancelAuthorization(id: string): Promise<ApiResult<void>>;
    clearAuthorization(input: { id: string; expectedVersion: number }): Promise<ApiResult<McpServerInfo>>;
    delete(input: { id: string; expectedVersion: number }): Promise<ApiResult<void>>;
  };
  routines: {
    list(): Promise<ApiResult<Routine[]>>;
    listRuns(routineId?: string): Promise<ApiResult<RoutineRun[]>>;
    create(input: { name: string; prompt: string; botId: string; schedule: RoutineSchedule; enabled?: boolean }): Promise<ApiResult<Routine>>;
    update(input: { id: string; expectedVersion: number; patch: Partial<Pick<Routine, "name" | "prompt" | "schedule">> }): Promise<ApiResult<Routine>>;
    setEnabled(input: { id: string; expectedVersion: number; enabled: boolean }): Promise<ApiResult<Routine>>;
    runNow(id: string): Promise<ApiResult<RoutineRun>>;
    delete(input: { id: string; expectedVersion: number }): Promise<ApiResult<void>>;
  };
  conversations: {
    deleteBatch(input: ConversationBatchDeleteInput): Promise<ApiResult<ConversationBatchDeleteResult>>;
  };
  teams: {
    createContentTeam(input?: { projectId?: string }): Promise<ApiResult<TeamTemplateCreateResult>>;
  };
  bots: {
    list(): Promise<ApiResult<Bot[]>>;
    create(input?: { projectId?: string }): Promise<ApiResult<{ bot: Bot; session: Session }>>;
    update(input: { id: string; expectedVersion: number; patch: BotPatch }): Promise<ApiResult<Bot>>;
    setPinned(input: { id: string; pinned: boolean }): Promise<ApiResult<Bot>>;
    setUnread(input: { id: string; unread: boolean }): Promise<ApiResult<Bot>>;
    setHidden(input: { id: string; hidden: boolean }): Promise<ApiResult<Bot>>;
    duplicate(id: string): Promise<ApiResult<{ bot: Bot; session: Session }>>;
    delete(id: string): Promise<ApiResult<BotDeleteResult>>;
    copyConversationId(id: string): Promise<ApiResult<void>>;
  };
  memories: {
    list(input: { botId: string; includeDeleted?: boolean } | (MemoryScopeSelector & { includeDeleted?: boolean })): Promise<ApiResult<MemoryItem[]>>;
    create(input: { botId: string; content: string; kind?: MemoryKind; expiresAt?: string | null } | (MemoryScopeSelector & { content: string; kind?: MemoryKind; expiresAt?: string | null })): Promise<ApiResult<MemoryItem>>;
    update(input: { id: string; expectedVersion: number; content: string; kind?: MemoryKind; expiresAt?: string | null }): Promise<ApiResult<MemoryItem>>;
    delete(input: { id: string; expectedVersion: number }): Promise<ApiResult<MemoryItem>>;
    restore(input: { id: string; expectedVersion: number }): Promise<ApiResult<MemoryItem>>;
    listProposals(input?: { botId?: string; state?: MemoryProposalState }): Promise<ApiResult<MemoryProposal[]>>;
    acceptProposal(input: { id: string; expectedVersion: number; content?: string; kind?: MemoryKind; expiresAt?: string | null }): Promise<ApiResult<{ proposal: MemoryProposal; memory: MemoryItem }>>;
    rejectProposal(input: { id: string; expectedVersion: number }): Promise<ApiResult<MemoryProposal>>;
  };
  workspaces: {
    list(): Promise<ApiResult<Workspace[]>>;
    add(): Promise<ApiResult<WorkspaceRegistrationResult | null>>;
    updatePermissions(input: { id: string; expectedVersion: number; writeEnabled: boolean; automationEnabled: boolean }): Promise<ApiResult<Workspace>>;
    reveal(input: { workspaceId: string; path: string }): Promise<ApiResult<boolean>>;
    remove(input: { id: string; expectedVersion: number }): Promise<ApiResult<Workspace>>;
  };
  projects: {
    list(): Promise<ApiResult<Project[]>>;
    create(input: { name: string }): Promise<ApiResult<Project>>;
  };
  tools: {
    list(input: { sessionId: string }): Promise<ApiResult<ToolInvocation[]>>;
  };
  approvals: {
    listPending(input: { sessionId: string }): Promise<ApiResult<ApprovalRequest[]>>;
    resolve(input: {
      sessionId: string;
      id: string;
      expectedVersion: number;
      resolution: ApprovalResolution;
    }): Promise<ApiResult<ToolApprovalResult>>;
  };
  sessions: {
    getMain(botId: string): Promise<ApiResult<Session>>;
  };
  rooms: {
    getBriefApproval(input: { roomId: string; sourceRuntimeRunId: string }): Promise<ApiResult<BriefApprovalView>>;
    approveBrief(input: BriefApprovalCommand): Promise<ApiResult<RoomSendResult>>;
    list(input?: { includeArchived?: boolean }): Promise<ApiResult<Room[]>>;
    create(input: { memberBotIds: string[]; name?: string; description?: string }): Promise<ApiResult<RoomDetail>>;
    get(id: string): Promise<ApiResult<RoomDetail>>;
    update(input: { id: string; expectedVersion: number; patch: RoomPatch }): Promise<ApiResult<Room>>;
    archive(input: { id: string; archived: boolean }): Promise<ApiResult<Room>>;
    setPinned(input: { id: string; pinned: boolean }): Promise<ApiResult<Room>>;
    setUnread(input: { id: string; unread: boolean }): Promise<ApiResult<Room>>;
    setHidden(input: { id: string; hidden: boolean }): Promise<ApiResult<Room>>;
    copyConversationId(id: string): Promise<ApiResult<void>>;
    delete(id: string): Promise<ApiResult<RoomDeleteResult>>;
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
    getGeneral(): Promise<ApiResult<GeneralSettings>>;
    saveGeneral(input: SaveGeneralSettings): Promise<ApiResult<GeneralSettings>>;
  };
  providers: {
    list(): Promise<ApiResult<ProviderInstanceInfo[]>>;
    scan(): Promise<ApiResult<ProviderInstanceInfo[]>>;
    saveOpenAiCompatible(input: SaveOpenAiCompatibleProviderInput): Promise<ApiResult<ProviderInstanceInfo>>;
    saveCli(input: SaveCliProviderInput): Promise<ApiResult<ProviderInstanceInfo>>;
    test(instanceId: string): Promise<ApiResult<void>>;
    refresh(instanceId: string): Promise<ApiResult<ProviderInstanceInfo>>;
  };
  updates: {
    getState(): Promise<ApiResult<UpdateState>>;
    check(): Promise<ApiResult<UpdateState>>;
    retry(): Promise<ApiResult<UpdateState>>;
    installAndRestart(): Promise<ApiResult<UpdateState>>;
  };
  events: {
    subscribeTranscript(listener: (event: TranscriptEvent) => void): () => void;
    subscribeSendState(listener: (event: SendStateEvent) => void): () => void;
    subscribeRuntime(listener: (event: RuntimeEvent) => void): () => void;
    subscribeRoomRuntime(listener: (event: RoomRuntimeEvent) => void): () => void;
    subscribeTool(listener: (event: ToolEvent) => void): () => void;
    subscribeUpdate(listener: (event: UpdateEvent) => void): () => void;
  };
  app: {
    ready(): void;
    subscribeBeforeClose(listener: () => void): () => void;
    subscribeCloseBlocked(listener: () => void): () => void;
    confirmClose(canClose: boolean): void;
  };
}
