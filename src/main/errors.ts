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
  MEMORY_PROPOSAL_NOT_FOUND: { domain: "memory", retryable: false, safeMessage: "没有找到这条 Memory 候选。", allowedDetailKeys: [] },
  MEMORY_PROPOSAL_RESOLVED: { domain: "memory", retryable: false, safeMessage: "这条 Memory 候选已经处理。", allowedDetailKeys: [] },
  MEMORY_SENSITIVE_CONTENT: { domain: "memory", retryable: false, safeMessage: "Memory 不能保存疑似密钥、密码或令牌。", allowedDetailKeys: [] },
  WORKSPACE_NOT_FOUND: { domain: "workspace", retryable: false, safeMessage: "没有找到这个工作区。", allowedDetailKeys: [] },
  WORKSPACE_VERSION_CONFLICT: { domain: "workspace", retryable: true, safeMessage: "工作区状态已变化，请刷新后再处理。", allowedDetailKeys: ["currentVersion"] },
  WORKSPACE_INVALID_ROOT: { domain: "workspace", retryable: false, safeMessage: "请选择一个存在且可访问的文件夹。", allowedDetailKeys: [] },
  WORKSPACE_SCOPE_TOO_BROAD: { domain: "workspace", retryable: false, safeMessage: "不能把整个文件系统作为工作区。", allowedDetailKeys: [] },
  WORKSPACE_PATH_OUTSIDE_ROOT: { domain: "workspace", retryable: false, safeMessage: "目标路径超出了已授权工作区。", allowedDetailKeys: [] },
  WORKSPACE_TARGET_NOT_FOUND: { domain: "workspace", retryable: false, safeMessage: "工作区内没有找到这个目标。", allowedDetailKeys: [] },
  WORKSPACE_TARGET_TYPE_INVALID: { domain: "workspace", retryable: false, safeMessage: "目标类型不符合这次操作。", allowedDetailKeys: [] },
  WORKSPACE_TARGET_CHANGED: { domain: "workspace", retryable: true, safeMessage: "目标在读取期间发生变化，结果已丢弃。", allowedDetailKeys: [] },
  WORKSPACE_BINARY_UNSUPPORTED: { domain: "workspace", retryable: false, safeMessage: "当前只读工具不支持二进制文件。", allowedDetailKeys: [] },
  WORKSPACE_WRITE_NOT_ENABLED: { domain: "workspace", retryable: false, safeMessage: "该工作区尚未启用 Markdown/CSV 写入。", allowedDetailKeys: [] },
  WORKSPACE_WRITE_CONFLICT: { domain: "workspace", retryable: false, safeMessage: "目标文件已存在；Bot 不会覆盖现有文件。", allowedDetailKeys: [] },
  WORKSPACE_WRITE_FAILED: { domain: "workspace", retryable: true, safeMessage: "共享成果未能安全写入，现有文件未被修改。", allowedDetailKeys: [] },
  WORKSPACE_WRITE_SECRET_BLOCKED: { domain: "security", retryable: false, safeMessage: "共享成果疑似包含凭据或密钥，已阻止写入。", allowedDetailKeys: [] },
  ROOM_NOT_FOUND: { domain: "room", retryable: false, safeMessage: "没有找到这个群聊。", allowedDetailKeys: [] },
  ROOM_VERSION_CONFLICT: { domain: "room", retryable: true, safeMessage: "群聊资料已更新，请重新加载后再保存。", allowedDetailKeys: ["currentVersion"] },
  ROOM_MEMBERSHIP_CONFLICT: { domain: "room", retryable: true, safeMessage: "群聊成员已发生变化，请刷新后再试。", allowedDetailKeys: ["currentVersion"] },
  ROOM_MEMBER_INVALID: { domain: "room", retryable: false, safeMessage: "群聊需要 2～6 个不重复的现有 Bot。", allowedDetailKeys: [] },
  ROOM_MEMBER_NOT_FOUND: { domain: "room", retryable: false, safeMessage: "这个 Bot 不在群聊中。", allowedDetailKeys: [] },
  ROOM_ARCHIVED: { domain: "room", retryable: false, safeMessage: "这个群聊已归档，不能继续发送。", allowedDetailKeys: [] },
  ROOM_BUSY: { domain: "room", retryable: true, safeMessage: "群聊正在运行，暂时不能修改成员或归档。", allowedDetailKeys: [] },
  ROOM_DELETE_BUSY: { domain: "room", retryable: true, safeMessage: "群聊正在运行，暂时不能删除。", allowedDetailKeys: [] },
  ROOM_BATCH_NOT_FOUND: { domain: "runtime", retryable: false, safeMessage: "没有找到这批群聊运行。", allowedDetailKeys: [] },
  ROOM_TURN_NOT_FOUND: { domain: "runtime", retryable: false, safeMessage: "没有找到这次成员运行。", allowedDetailKeys: [] },
  ROOM_RUN_CONFLICT: { domain: "runtime", retryable: false, safeMessage: "同一触发消息的群聊运行合同不一致。", allowedDetailKeys: [] },
  AGENT_TURN_CONFLICT: { domain: "runtime", retryable: false, safeMessage: "相同成员运行标识不能用于不同内容。", allowedDetailKeys: [] },
  ROOM_RUN_LIMIT_EXCEEDED: { domain: "runtime", retryable: false, safeMessage: "群聊运行已达到预设限制。", allowedDetailKeys: ["reason"] },
  HANDOFF_NOT_FOUND: { domain: "runtime", retryable: false, safeMessage: "没有找到这次任务转交。", allowedDetailKeys: [] },
  HANDOFF_TARGET_CONFLICT: { domain: "runtime", retryable: false, safeMessage: "同一成员运行不能重复转交给同一个 Bot。", allowedDetailKeys: [] },
  HANDOFF_CYCLE: { domain: "runtime", retryable: false, safeMessage: "已阻止重复任务形成 Agent 调用循环。", allowedDetailKeys: [] },
  HANDOFF_CONTEXT_INVALID: { domain: "runtime", retryable: false, safeMessage: "任务转交引用了不属于当前群聊的上下文。", allowedDetailKeys: [] },
  HUMAN_APPROVAL_REQUIRED: { domain: "runtime", retryable: false, safeMessage: "该阶段需要用户明确批准后才能继续转交。", allowedDetailKeys: [] },
  ROOM_BATCH_BUSY: { domain: "runtime", retryable: true, safeMessage: "这个群聊正在回复，请稍后再试。", allowedDetailKeys: [] },
  ROOM_TURN_RETRY_UNSAFE: { domain: "runtime", retryable: false, safeMessage: "当前成员运行不能安全重试。", allowedDetailKeys: ["reason"] },
  SESSION_NOT_FOUND: { domain: "session", retryable: false, safeMessage: "没有找到这个会话。", allowedDetailKeys: [] },
  SESSION_BUSY: { domain: "session", retryable: true, safeMessage: "该 Bot 正在回复，请稍后重试。", allowedDetailKeys: [] },
  MESSAGE_NONCE_CONFLICT: { domain: "message", retryable: false, safeMessage: "相同消息标识不能用于不同内容。", allowedDetailKeys: [] },
  MESSAGE_NOT_FOUND: { domain: "message", retryable: false, safeMessage: "没有找到这条消息。", allowedDetailKeys: [] },
  MESSAGE_NOT_RUNNING: { domain: "message", retryable: false, safeMessage: "这条消息当前没有正在运行的请求。", allowedDetailKeys: [] },
  MESSAGE_RETRY_UNSAFE: { domain: "message", retryable: false, safeMessage: "这条消息可能已被接受，不能自动重发。", allowedDetailKeys: [] },
  MESSAGE_CANCELLED: { domain: "message", retryable: false, safeMessage: "已停止本次回复。", allowedDetailKeys: [] },
  ATTACHMENTS_TOO_MANY: { domain: "message", retryable: false, safeMessage: "一次最多添加 6 个附件。", allowedDetailKeys: [] },
  ATTACHMENT_TOO_LARGE: { domain: "message", retryable: false, safeMessage: "附件超过 1 MB 限制。", allowedDetailKeys: [] },
  ATTACHMENT_UNSUPPORTED: { domain: "message", retryable: false, safeMessage: "当前只支持文本、代码、CSV、JSON 和 Markdown 附件。", allowedDetailKeys: [] },
  ATTACHMENT_INVALID: { domain: "message", retryable: false, safeMessage: "附件无法安全读取，请重新选择文件。", allowedDetailKeys: [] },
  ARTIFACT_TOO_LARGE: { domain: "message", retryable: false, safeMessage: "保存内容超过 2 MB 限制。", allowedDetailKeys: [] },
  ARTIFACT_ALREADY_EXISTS: { domain: "message", retryable: false, safeMessage: "目标文件已存在，请选择其他文件名。", allowedDetailKeys: [] },
  ARTIFACT_SAVE_FAILED: { domain: "message", retryable: true, safeMessage: "结果文件保存失败，请重试。", allowedDetailKeys: [] },
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
  TOOL_ROUND_LIMIT_EXCEEDED: { domain: "tool", retryable: false, safeMessage: "工具调用次数已达到本次运行上限。", allowedDetailKeys: [] },
  TOOL_EVIDENCE_REQUIRED: { domain: "tool", retryable: true, safeMessage: "回复声称执行了工具，但没有对应的成功工具记录，本轮未标记完成。", allowedDetailKeys: ["requirement"] },
  DATA_EVIDENCE_REQUIRED: { domain: "tool", retryable: true, safeMessage: "没有成功读取真实数据文件，数据分析结论未标记完成。", allowedDetailKeys: ["requirement"] },
  MEASUREMENT_EVIDENCE_REQUIRED: { domain: "tool", retryable: true, safeMessage: "没有执行确定性计数工具，长度结论未标记完成。", allowedDetailKeys: ["requirement"] },
  NETWORK_TOOL_UNAVAILABLE: { domain: "tool", retryable: true, safeMessage: "实时数据服务当前不可用。", allowedDetailKeys: ["status"] },
  NETWORK_TOOL_TIMEOUT: { domain: "tool", retryable: true, safeMessage: "实时数据查询超时。", allowedDetailKeys: [] },
  NETWORK_TOOL_RESPONSE_INVALID: { domain: "tool", retryable: true, safeMessage: "实时数据服务返回了无法验证的结果。", allowedDetailKeys: [] },
  NETWORK_LOCATION_NOT_FOUND: { domain: "tool", retryable: false, safeMessage: "没有找到这个地点。", allowedDetailKeys: [] },
  MCP_SERVER_NOT_FOUND: { domain: "tool", retryable: false, safeMessage: "没有找到这个 MCP Server。", allowedDetailKeys: [] },
  MCP_SERVER_NAME_CONFLICT: { domain: "tool", retryable: false, safeMessage: "已经存在同名 MCP Server。", allowedDetailKeys: [] },
  MCP_SERVER_VERSION_CONFLICT: { domain: "tool", retryable: true, safeMessage: "MCP Server 配置已变化，请刷新后再处理。", allowedDetailKeys: ["currentVersion"] },
  MCP_SERVER_UNAVAILABLE: { domain: "tool", retryable: true, safeMessage: "MCP Server 当前不可用。", allowedDetailKeys: [] },
  MCP_AUTH_REQUIRED: { domain: "tool", retryable: false, safeMessage: "MCP Server 需要重新授权。", allowedDetailKeys: [] },
  MCP_AUTH_TIMEOUT: { domain: "tool", retryable: true, safeMessage: "MCP 授权等待超时，请重新发起。", allowedDetailKeys: [] },
  MCP_AUTH_INVALID: { domain: "security", retryable: false, safeMessage: "MCP 授权回调无效，凭据未保存。", allowedDetailKeys: [] },
  MCP_AUTH_CANCELLED: { domain: "tool", retryable: false, safeMessage: "MCP 授权已取消。", allowedDetailKeys: [] },
  MCP_AUTH_CALLBACK_FAILED: { domain: "tool", retryable: true, safeMessage: "无法启动安全的本机授权回调。", allowedDetailKeys: [] },
  MCP_AUTH_STORAGE_INVALID: { domain: "storage", retryable: false, safeMessage: "MCP 授权凭据无法安全读取，请清除后重新授权。", allowedDetailKeys: [] },
  MCP_AUTH_IN_PROGRESS: { domain: "tool", retryable: false, safeMessage: "这个 MCP Server 正在授权，请先完成或取消当前流程。", allowedDetailKeys: [] },
  MCP_TOOL_NOT_FOUND: { domain: "tool", retryable: false, safeMessage: "MCP Server 没有提供这个工具。", allowedDetailKeys: [] },
  MCP_TOOL_NOT_READONLY: { domain: "tool", retryable: false, safeMessage: "当前阶段只允许明确声明为只读的 MCP 工具。", allowedDetailKeys: [] },
  MCP_RESULT_INVALID: { domain: "tool", retryable: true, safeMessage: "MCP 工具返回了无法安全处理的结果。", allowedDetailKeys: [] },
  ROUTINE_NOT_FOUND: { domain: "runtime", retryable: false, safeMessage: "没有找到这个定时任务。", allowedDetailKeys: [] },
  ROUTINE_VERSION_CONFLICT: { domain: "runtime", retryable: true, safeMessage: "定时任务已发生变化，请刷新后重试。", allowedDetailKeys: ["currentVersion"] },
  ROUTINE_BUSY: { domain: "runtime", retryable: true, safeMessage: "定时任务仍有运行中的实例，暂时不能删除。", allowedDetailKeys: [] },
  ROUTINE_RUN_NOT_FOUND: { domain: "runtime", retryable: false, safeMessage: "没有找到这次定时运行。", allowedDetailKeys: [] },
  ROUTINE_RUN_STATE_INVALID: { domain: "runtime", retryable: false, safeMessage: "定时运行状态不允许当前操作。", allowedDetailKeys: [] },
  ROUTINE_SCHEDULE_INVALID: { domain: "validation", retryable: false, safeMessage: "定时规则无效或没有下一次运行时间。", allowedDetailKeys: [] },
  APPROVAL_NOT_FOUND: { domain: "approval", retryable: false, safeMessage: "没有找到这次审批请求。", allowedDetailKeys: [] },
  APPROVAL_VERSION_CONFLICT: { domain: "approval", retryable: true, safeMessage: "审批状态已变化，请刷新后再处理。", allowedDetailKeys: ["currentVersion"] },
  APPROVAL_ALREADY_RESOLVED: { domain: "approval", retryable: false, safeMessage: "这次审批已经处理，不能重复结算。", allowedDetailKeys: [] },
  APPROVAL_EXPIRED: { domain: "approval", retryable: false, safeMessage: "这次审批已经过期，请重新发起工具请求。", allowedDetailKeys: [] },
  APPROVAL_SCOPE_INVALID: { domain: "approval", retryable: false, safeMessage: "审批与工具请求的作用域不一致。", allowedDetailKeys: [] },
  MODEL_NOT_CONFIGURED: { domain: "provider", retryable: false, safeMessage: "请先为这个 Bot 选择可用的模型，并完成设置 → 模型与 CLI。", allowedDetailKeys: [] },
  MODEL_PROVIDER_NOT_FOUND: { domain: "provider", retryable: false, safeMessage: "没有找到这个模型供应商实例。", allowedDetailKeys: [] },
  MODEL_PROVIDER_VERSION_CONFLICT: { domain: "provider", retryable: true, safeMessage: "模型供应商配置已变化，请刷新后再保存。", allowedDetailKeys: ["currentVersion"] },
  MODEL_PROVIDER_UNAVAILABLE: { domain: "provider", retryable: true, safeMessage: "当前模型供应商不可用，请检查安装或登录状态。", allowedDetailKeys: ["reason"] },
  MODEL_PROVIDER_BUSY: { domain: "provider", retryable: true, safeMessage: "正在使用这个模型供应商，请等待当前任务完成后再修改。", allowedDetailKeys: [] },
  MODEL_CLI_INVALID: { domain: "provider", retryable: false, safeMessage: "模型 CLI 无法启动，请检查配置路径。", allowedDetailKeys: [] },
  MODEL_CLI_PROTOCOL_ERROR: { domain: "provider", retryable: true, safeMessage: "模型 CLI 返回了无法识别的协议消息。", allowedDetailKeys: [] },
  MODEL_AUTHENTICATION_FAILED: { domain: "provider", retryable: false, safeMessage: "模型账号未登录、登录已失效或 API Key 无效，请重新认证。", allowedDetailKeys: [] },
  MODEL_QUOTA_EXCEEDED: { domain: "provider", retryable: true, safeMessage: "模型服务额度不足或已达到使用上限，请检查账户额度后重试。", allowedDetailKeys: [] },
  MODEL_SELECTED_MODEL_UNAVAILABLE: { domain: "provider", retryable: false, safeMessage: "当前选择的模型不可用，请刷新模型列表或改选其他模型。", allowedDetailKeys: [] },
  MODEL_REQUEST_REFUSED: { domain: "provider", retryable: false, safeMessage: "模型服务拒绝了请求。", allowedDetailKeys: ["status"] },
  MODEL_CONNECTION_FAILED: { domain: "provider", retryable: true, safeMessage: "无法连接模型服务。", allowedDetailKeys: ["status"] },
  MODEL_CONNECTION_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "连接模型服务超时。", allowedDetailKeys: [] },
  MODEL_FIRST_EVENT_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "模型长时间没有开始返回内容。", allowedDetailKeys: [] },
  MODEL_STREAM_IDLE_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "模型流式回复已停止响应。", allowedDetailKeys: [] },
  MODEL_RUN_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "模型运行超过最长时间。", allowedDetailKeys: [] },
  MODEL_STREAM_INVALID: { domain: "provider", retryable: true, safeMessage: "模型返回了无法解析的流式数据。", allowedDetailKeys: [] },
  MODEL_HANDOFF_INVALID: { domain: "provider", retryable: false, safeMessage: "模型返回了无效的任务转交。", allowedDetailKeys: [] },
  MODEL_WORKSPACE_TOOL_INVALID: { domain: "provider", retryable: false, safeMessage: "模型返回了无效的工作区工具请求。", allowedDetailKeys: [] },
  MODEL_NETWORK_TOOL_INVALID: { domain: "provider", retryable: false, safeMessage: "模型返回了无效的联网工具请求。", allowedDetailKeys: [] },
  MODEL_ROUTER_UNSUPPORTED: { domain: "provider", retryable: false, safeMessage: "当前模型适配器不支持群聊自动选择。", allowedDetailKeys: [] },
  MODEL_ROUTER_INVALID: { domain: "provider", retryable: false, safeMessage: "模型没有返回有效的群聊响应 Bot。", allowedDetailKeys: [] },
  MODEL_ROUTER_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "选择群聊响应 Bot 超时，请重试。", allowedDetailKeys: [] },
  MODEL_ROUTER_FAILED: { domain: "provider", retryable: true, safeMessage: "无法选择群聊响应 Bot，请重试。", allowedDetailKeys: ["status"] },
  MODEL_STREAM_TRUNCATED: { domain: "provider", retryable: true, safeMessage: "模型回复在完成前中断。", allowedDetailKeys: [] },
  MODEL_TRANSPORT_ERROR: { domain: "provider", retryable: true, safeMessage: "模型连接意外中断。", allowedDetailKeys: [] },
  DECISION_TIMEOUT: { domain: "decision", retryable: true, safeMessage: "结构化决策服务响应超时，已回退到本地规则。", allowedDetailKeys: [] },
  DECISION_RATE_LIMITED: { domain: "decision", retryable: true, safeMessage: "结构化决策服务暂时达到限流，请稍后重试。", allowedDetailKeys: ["status"] },
  DECISION_PROVIDER_FAILED: { domain: "decision", retryable: true, safeMessage: "结构化决策服务暂时不可用，已回退到本地规则。", allowedDetailKeys: ["status"] },
  DECISION_RESPONSE_INVALID: { domain: "decision", retryable: true, safeMessage: "结构化决策服务返回了无法验证的结果。", allowedDetailKeys: [] },
  DECISION_IDEMPOTENCY_CONFLICT: { domain: "decision", retryable: false, safeMessage: "相同决策标识不能用于不同内容。", allowedDetailKeys: [] },
  DECISION_NOT_FOUND: { domain: "decision", retryable: false, safeMessage: "没有找到这条结构化决策记录。", allowedDetailKeys: [] },
  SECURE_STORAGE_UNAVAILABLE: { domain: "storage", retryable: false, safeMessage: "系统安全存储当前不可用，API Key 未保存。", allowedDetailKeys: [] },
  SYSTEM_SETTING_UNAVAILABLE: { domain: "runtime", retryable: false, safeMessage: "当前运行环境不支持这个系统设置。", allowedDetailKeys: [] },
  SYSTEM_SETTING_FAILED: { domain: "runtime", retryable: true, safeMessage: "系统设置未能更新，请稍后重试。", allowedDetailKeys: [] },
  UPDATE_NOT_READY: { domain: "update", retryable: false, safeMessage: "更新尚未下载完成。", allowedDetailKeys: [] },
  UPDATE_CHECK_FAILED: { domain: "update", retryable: true, safeMessage: "检查更新失败，当前版本可继续使用。", allowedDetailKeys: [] },
  UPDATE_DOWNLOAD_FAILED: { domain: "update", retryable: true, safeMessage: "更新下载失败，当前版本可继续使用。", allowedDetailKeys: [] },
  UPDATE_INSTALL_FAILED: { domain: "update", retryable: true, safeMessage: "更新安装未能启动，当前版本可继续使用。", allowedDetailKeys: [] },
  UPDATE_INSTALL_INTERRUPTED: { domain: "update", retryable: true, safeMessage: "上次更新没有完成，当前版本仍可使用。", allowedDetailKeys: [] },
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
