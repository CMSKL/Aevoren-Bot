import { ZodError } from "zod";
import type { ApiResult, AppError, ErrorDomain } from "@shared/contracts";

type ErrorDescriptor = {
  domain: ErrorDomain;
  retryable: boolean;
  safeMessage: string;
  allowedDetailKeys: readonly string[];
};

export const ERROR_REGISTRY = {
  INVALID_REQUEST: { domain: "validation", retryable: false, safeMessage: "请求参数不符合要求。", allowedDetailKeys: [] },
  BOT_NOT_FOUND: { domain: "bot", retryable: false, safeMessage: "没有找到这个 Bot。", allowedDetailKeys: [] },
  BOT_VERSION_CONFLICT: { domain: "bot", retryable: true, safeMessage: "Bot 已在别处更新，请重新确认后再保存。", allowedDetailKeys: ["currentVersion"] },
  SESSION_NOT_FOUND: { domain: "session", retryable: false, safeMessage: "没有找到这个会话。", allowedDetailKeys: [] },
  SESSION_BUSY: { domain: "session", retryable: true, safeMessage: "该 Bot 正在回复，请稍后重试。", allowedDetailKeys: [] },
  MESSAGE_NONCE_CONFLICT: { domain: "message", retryable: false, safeMessage: "相同消息标识不能用于不同内容。", allowedDetailKeys: [] },
  MESSAGE_NOT_FOUND: { domain: "message", retryable: false, safeMessage: "没有找到这条消息。", allowedDetailKeys: [] },
  MESSAGE_NOT_RUNNING: { domain: "message", retryable: false, safeMessage: "这条消息当前没有正在运行的请求。", allowedDetailKeys: [] },
  MESSAGE_RETRY_UNSAFE: { domain: "message", retryable: false, safeMessage: "这条消息可能已被接受，不能自动重发。", allowedDetailKeys: [] },
  MESSAGE_CANCELLED: { domain: "message", retryable: false, safeMessage: "已停止本次回复。", allowedDetailKeys: [] },
  TRANSCRIPT_ENTRY_NOT_FOUND: { domain: "session", retryable: false, safeMessage: "没有找到这条记录。", allowedDetailKeys: [] },
  RUNTIME_NOT_FOUND: { domain: "runtime", retryable: false, safeMessage: "没有找到这次运行。", allowedDetailKeys: [] },
  RUNTIME_STATE_INVALID: { domain: "runtime", retryable: false, safeMessage: "运行状态发生冲突，请重新加载后再试。", allowedDetailKeys: ["currentState"] },
  RUNTIME_RETRY_UNSAFE: { domain: "runtime", retryable: false, safeMessage: "当前运行不能安全地重新生成。", allowedDetailKeys: ["reason"] },
  MODEL_NOT_CONFIGURED: { domain: "provider", retryable: false, safeMessage: "请先完成模型设置。", allowedDetailKeys: [] },
  MODEL_REQUEST_REFUSED: { domain: "provider", retryable: false, safeMessage: "模型服务拒绝了请求。", allowedDetailKeys: ["status"] },
  MODEL_CONNECTION_FAILED: { domain: "provider", retryable: true, safeMessage: "无法连接模型服务。", allowedDetailKeys: ["status"] },
  MODEL_CONNECTION_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "连接模型服务超时。", allowedDetailKeys: [] },
  MODEL_FIRST_EVENT_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "模型长时间没有开始返回内容。", allowedDetailKeys: [] },
  MODEL_STREAM_IDLE_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "模型流式回复已停止响应。", allowedDetailKeys: [] },
  MODEL_RUN_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "模型运行超过最长时间。", allowedDetailKeys: [] },
  MODEL_STREAM_INVALID: { domain: "provider", retryable: true, safeMessage: "模型返回了无法解析的流式数据。", allowedDetailKeys: [] },
  MODEL_STREAM_TRUNCATED: { domain: "provider", retryable: true, safeMessage: "模型回复在完成前中断。", allowedDetailKeys: [] },
  MODEL_TRANSPORT_ERROR: { domain: "provider", retryable: true, safeMessage: "模型连接意外中断。", allowedDetailKeys: [] },
  SECURE_STORAGE_UNAVAILABLE: { domain: "storage", retryable: false, safeMessage: "系统安全存储当前不可用，API Key 未保存。", allowedDetailKeys: [] },
  UNTRUSTED_RENDERER: { domain: "security", retryable: false, safeMessage: "请求来源不受信任。", allowedDetailKeys: [] },
  APP_INTERRUPTED: { domain: "runtime", retryable: false, safeMessage: "应用中断了本次运行。", allowedDetailKeys: [] },
  INTERNAL_ERROR: { domain: "internal", retryable: false, safeMessage: "操作失败，请稍后重试。", allowedDetailKeys: [] },
} as const satisfies Record<string, ErrorDescriptor>;

export type ErrorCode = keyof typeof ERROR_REGISTRY;

function filterDetails(code: ErrorCode, details?: AppError["details"]): AppError["details"] | undefined {
  if (!details) return undefined;
  const allowed = new Set<string>(ERROR_REGISTRY[code].allowedDetailKeys);
  const filtered = Object.fromEntries(Object.entries(details).filter(([key]) => allowed.has(key)));
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export class MsBotError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly code: ErrorCode,
    safeMessage?: string,
    retryable?: boolean,
    public readonly details?: AppError["details"],
  ) {
    super(safeMessage ?? ERROR_REGISTRY[code].safeMessage);
    this.name = "MsBotError";
    this.retryable = retryable ?? ERROR_REGISTRY[code].retryable;
  }

  toAppError(): AppError {
    const descriptor = ERROR_REGISTRY[this.code];
    const details = filterDetails(this.code, this.details);
    return {
      code: this.code,
      domain: descriptor.domain,
      safeMessage: this.message,
      retryable: this.retryable,
      ...(details ? { details } : {}),
    };
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof MsBotError) return error.toAppError();
  if (error instanceof ZodError) return new MsBotError("INVALID_REQUEST").toAppError();
  return new MsBotError("INTERNAL_ERROR").toAppError();
}

export async function apiResult<T>(operation: () => T | Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return { ok: false, error: asAppError(error) };
  }
}
