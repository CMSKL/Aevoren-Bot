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
  BOT_BUSY: { domain: "bot", retryable: true, safeMessage: "该 Bot 正在运行，暂时不能删除。", allowedDetailKeys: [] },
  MEMORY_NOT_FOUND: { domain: "memory", retryable: false, safeMessage: "没有找到这条 Memory。", allowedDetailKeys: [] },
  MEMORY_VERSION_CONFLICT: { domain: "memory", retryable: true, safeMessage: "Memory 已在别处更新，当前草稿未覆盖新版本。", allowedDetailKeys: ["currentVersion"] },
  MEMORY_DUPLICATE: { domain: "memory", retryable: false, safeMessage: "这个 Bot 已有相同的 Memory。", allowedDetailKeys: [] },
  MEMORY_DELETED: { domain: "memory", retryable: false, safeMessage: "这条 Memory 已删除，请先恢复。", allowedDetailKeys: [] },
  MEMORY_LIMIT_EXCEEDED: { domain: "memory", retryable: false, safeMessage: "Memory 已达到当前容量限制。", allowedDetailKeys: ["reason"] },
  WORKSPACE_NOT_FOUND: { domain: "workspace", retryable: false, safeMessage: "没有找到这个工作区。", allowedDetailKeys: [] },
  WORKSPACE_VERSION_CONFLICT: { domain: "workspace", retryable: true, safeMessage: "工作区状态已变化，请刷新后再处理。", allowedDetailKeys: ["currentVersion"] },
  WORKSPACE_INVALID_ROOT: { domain: "workspace", retryable: false, safeMessage: "请选择一个存在且可访问的文件夹。", allowedDetailKeys: [] },
  WORKSPACE_SCOPE_TOO_BROAD: { domain: "workspace", retryable: false, safeMessage: "不能把整个文件系统作为工作区。", allowedDetailKeys: [] },
  WORKSPACE_PATH_OUTSIDE_ROOT: { domain: "workspace", retryable: false, safeMessage: "目标路径超出了已授权工作区。", allowedDetailKeys: [] },
  WORKSPACE_TARGET_NOT_FOUND: { domain: "workspace", retryable: false, safeMessage: "工作区内没有找到这个目标。", allowedDetailKeys: [] },
  WORKSPACE_TARGET_TYPE_INVALID: { domain: "workspace", retryable: false, safeMessage: "目标类型不符合这次操作。", allowedDetailKeys: [] },
  WORKSPACE_TARGET_CHANGED: { domain: "workspace", retryable: true, safeMessage: "目标在读取期间发生变化，结果已丢弃。", allowedDetailKeys: [] },
  WORKSPACE_BINARY_UNSUPPORTED: { domain: "workspace", retryable: false, safeMessage: "当前只读工具不支持二进制文件。", allowedDetailKeys: [] },
  ROOM_NOT_FOUND: { domain: "room", retryable: false, safeMessage: "没有找到这个群聊。", allowedDetailKeys: [] },
  ROOM_VERSION_CONFLICT: { domain: "room", retryable: true, safeMessage: "群聊资料已更新，请重新加载后再保存。", allowedDetailKeys: ["currentVersion"] },
  ROOM_MEMBERSHIP_CONFLICT: { domain: "room", retryable: true, safeMessage: "群聊成员已发生变化，请刷新后再试。", allowedDetailKeys: ["currentVersion"] },
  ROOM_MEMBER_INVALID: { domain: "room", retryable: false, safeMessage: "群聊需要 2～6 个不重复的现有 Bot。", allowedDetailKeys: [] },
  ROOM_MEMBER_NOT_FOUND: { domain: "room", retryable: false, safeMessage: "这个 Bot 不在群聊中。", allowedDetailKeys: [] },
  ROOM_ARCHIVED: { domain: "room", retryable: false, safeMessage: "这个群聊已归档，不能继续发送。", allowedDetailKeys: [] },
  ROOM_BUSY: { domain: "room", retryable: true, safeMessage: "群聊正在运行，暂时不能修改成员或归档。", allowedDetailKeys: [] },
  ROOM_BATCH_NOT_FOUND: { domain: "runtime", retryable: false, safeMessage: "没有找到这批群聊运行。", allowedDetailKeys: [] },
  ROOM_TURN_NOT_FOUND: { domain: "runtime", retryable: false, safeMessage: "没有找到这次成员运行。", allowedDetailKeys: [] },
  ROOM_RUN_CONFLICT: { domain: "runtime", retryable: false, safeMessage: "同一触发消息的群聊运行合同不一致。", allowedDetailKeys: [] },
  AGENT_TURN_CONFLICT: { domain: "runtime", retryable: false, safeMessage: "相同成员运行标识不能用于不同内容。", allowedDetailKeys: [] },
  ROOM_RUN_LIMIT_EXCEEDED: { domain: "runtime", retryable: false, safeMessage: "群聊运行已达到预设限制。", allowedDetailKeys: ["reason"] },
  HANDOFF_NOT_FOUND: { domain: "runtime", retryable: false, safeMessage: "没有找到这次任务转交。", allowedDetailKeys: [] },
  HANDOFF_TARGET_CONFLICT: { domain: "runtime", retryable: false, safeMessage: "同一成员运行不能重复转交给同一个 Bot。", allowedDetailKeys: [] },
  HANDOFF_CYCLE: { domain: "runtime", retryable: false, safeMessage: "已阻止重复任务形成 Agent 调用循环。", allowedDetailKeys: [] },
  HANDOFF_CONTEXT_INVALID: { domain: "runtime", retryable: false, safeMessage: "任务转交引用了不属于当前群聊的上下文。", allowedDetailKeys: [] },
  ROOM_BATCH_BUSY: { domain: "runtime", retryable: true, safeMessage: "这个群聊正在回复，请稍后再试。", allowedDetailKeys: [] },
  ROOM_TURN_RETRY_UNSAFE: { domain: "runtime", retryable: false, safeMessage: "当前成员运行不能安全重试。", allowedDetailKeys: ["reason"] },
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
  RUNTIME_CONTROL_SCOPE_INVALID: { domain: "runtime", retryable: false, safeMessage: "群聊运行必须使用群聊控制。", allowedDetailKeys: [] },
  TOOL_INVOCATION_NOT_FOUND: { domain: "tool", retryable: false, safeMessage: "没有找到这次工具调用。", allowedDetailKeys: [] },
  TOOL_IDEMPOTENCY_CONFLICT: { domain: "tool", retryable: false, safeMessage: "相同工具调用标识不能用于不同请求。", allowedDetailKeys: [] },
  TOOL_STATE_INVALID: { domain: "tool", retryable: false, safeMessage: "工具调用状态不允许当前操作。", allowedDetailKeys: ["currentState"] },
  TOOL_EXECUTION_FAILED: { domain: "tool", retryable: false, safeMessage: "只读工具执行失败。", allowedDetailKeys: [] },
  TOOL_EXECUTION_CANCELLED: { domain: "tool", retryable: false, safeMessage: "已取消这次工具调用。", allowedDetailKeys: [] },
  APPROVAL_NOT_FOUND: { domain: "approval", retryable: false, safeMessage: "没有找到这次审批请求。", allowedDetailKeys: [] },
  APPROVAL_VERSION_CONFLICT: { domain: "approval", retryable: true, safeMessage: "审批状态已变化，请刷新后再处理。", allowedDetailKeys: ["currentVersion"] },
  APPROVAL_ALREADY_RESOLVED: { domain: "approval", retryable: false, safeMessage: "这次审批已经处理，不能重复结算。", allowedDetailKeys: [] },
  APPROVAL_EXPIRED: { domain: "approval", retryable: false, safeMessage: "这次审批已经过期，请重新发起工具请求。", allowedDetailKeys: [] },
  APPROVAL_SCOPE_INVALID: { domain: "approval", retryable: false, safeMessage: "审批与工具请求的作用域不一致。", allowedDetailKeys: [] },
  MODEL_NOT_CONFIGURED: { domain: "provider", retryable: false, safeMessage: "请先完成模型设置。", allowedDetailKeys: [] },
  MODEL_REQUEST_REFUSED: { domain: "provider", retryable: false, safeMessage: "模型服务拒绝了请求。", allowedDetailKeys: ["status"] },
  MODEL_CONNECTION_FAILED: { domain: "provider", retryable: true, safeMessage: "无法连接模型服务。", allowedDetailKeys: ["status"] },
  MODEL_CONNECTION_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "连接模型服务超时。", allowedDetailKeys: [] },
  MODEL_FIRST_EVENT_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "模型长时间没有开始返回内容。", allowedDetailKeys: [] },
  MODEL_STREAM_IDLE_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "模型流式回复已停止响应。", allowedDetailKeys: [] },
  MODEL_RUN_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "模型运行超过最长时间。", allowedDetailKeys: [] },
  MODEL_STREAM_INVALID: { domain: "provider", retryable: true, safeMessage: "模型返回了无法解析的流式数据。", allowedDetailKeys: [] },
  MODEL_HANDOFF_INVALID: { domain: "provider", retryable: false, safeMessage: "模型返回了无效的任务转交。", allowedDetailKeys: [] },
  MODEL_ROUTER_UNSUPPORTED: { domain: "provider", retryable: false, safeMessage: "当前模型适配器不支持群聊自动选择。", allowedDetailKeys: [] },
  MODEL_ROUTER_INVALID: { domain: "provider", retryable: false, safeMessage: "模型没有返回有效的群聊响应 Bot。", allowedDetailKeys: [] },
  MODEL_ROUTER_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "选择群聊响应 Bot 超时，请重试。", allowedDetailKeys: [] },
  MODEL_ROUTER_FAILED: { domain: "provider", retryable: true, safeMessage: "无法选择群聊响应 Bot，请重试。", allowedDetailKeys: ["status"] },
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

export class AevorenBotError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly code: ErrorCode,
    safeMessage?: string,
    retryable?: boolean,
    public readonly details?: AppError["details"],
  ) {
    super(safeMessage ?? ERROR_REGISTRY[code].safeMessage);
    this.name = "AevorenBotError";
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
  if (error instanceof AevorenBotError) return error.toAppError();
  if (error instanceof ZodError) return new AevorenBotError("INVALID_REQUEST").toAppError();
  return new AevorenBotError("INTERNAL_ERROR").toAppError();
}

export async function apiResult<T>(operation: () => T | Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return { ok: false, error: asAppError(error) };
  }
}
