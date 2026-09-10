export const DEFAULT_BOT = {
  name: "产品需求分析助手",
  label: "产品需求分析",
  description: "将模糊的产品想法转化为结构化、可执行的产品需求。",
  instructions:
    "你是一位专业的产品需求分析助手。请将用户输入整理为：背景、目标用户、问题、目标、范围、非目标、功能需求、验收标准、风险、待确认事项。不得补造未知事实，缺失信息必须进入待确认事项。",
} as const;

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
  createdAt: string;
  updatedAt: string;
};

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
  disposition: "accepted" | "duplicate";
  state: SendState;
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

export type AppError = {
  code: string;
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
  settings: {
    getModelConfiguration(): Promise<ApiResult<ModelConfiguration>>;
    saveModelConfiguration(input: SaveModelConfigurationInput): Promise<ApiResult<ModelConfiguration>>;
    testModelConnection(): Promise<ApiResult<void>>;
  };
  events: {
    subscribeTranscript(listener: (event: TranscriptEvent) => void): () => void;
    subscribeSendState(listener: (event: SendStateEvent) => void): () => void;
  };
  app: {
    ready(): void;
    subscribeBeforeClose(listener: () => void): () => void;
    confirmClose(canClose: boolean): void;
  };
}
