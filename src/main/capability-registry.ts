import type {
  CapabilityConnection,
  CapabilityDescriptor,
  CapabilityModelState,
  CapabilityPermission,
  CapabilityPromptSnapshot,
  CapabilitySnapshot,
  McpServerInfo,
  McpToolInfo,
  ModelSelection,
  ProviderCapabilities,
  ProviderInstanceInfo,
  Routine,
} from "@shared/contracts";
import type { AppRepository } from "./database";
import type { ProviderService } from "./provider-service";
import type { McpService } from "./mcp-service";
import { SKILL_SCRIPT_WORKER_VERSION } from "@shared/skill-execution-contracts";

export type CapabilityAppEnvironment = CapabilityPromptSnapshot["app"];

type SnapshotContext = {
  selection: ModelSelection;
  provider: ProviderInstanceInfo | null;
  providerCapabilities: ProviderCapabilities | null;
  room: boolean;
  mcpTools: McpToolInfo[];
  routines: Routine[];
  executionReady: boolean;
  scriptReady: boolean;
  nativeReadReady: boolean;
  browserReady: boolean;
  browserUserControlled: boolean;
};

const unsupported: Array<Pick<CapabilityDescriptor, "id" | "name" | "category" | "description" | "effectClass" | "adapterKind">> = [
  { id: "device.location", name: "定位", category: "device", description: "读取用户授权的位置。", effectClass: "read-local", adapterKind: "none" },
  { id: "device.personal-data", name: "设备个人数据", category: "device", description: "访问相册、日历或通讯录。", effectClass: "read-local", adapterKind: "none" },
  { id: "external.actions", name: "外部操作", category: "external", description: "发送消息、邮件、订票、下单或控制其他服务。", effectClass: "write-external", adapterKind: "none" },
  { id: "multimodal.input", name: "多模态输入", category: "multimodal", description: "理解图片、音频、视频或屏幕内容。", effectClass: "read-local", adapterKind: "none" },
];

function localTime(now: Date): Pick<CapabilityPromptSnapshot, "generatedAt" | "timezone" | "utcOffsetMinutes"> {
  return {
    generatedAt: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
    utcOffsetMinutes: -now.getTimezoneOffset(),
  };
}

function selectedModel(selection: ModelSelection, provider: ProviderInstanceInfo | null): CapabilityModelState {
  return {
    providerInstanceId: selection.providerInstanceId,
    providerName: provider?.displayName ?? selection.providerInstanceId,
    providerStatus: provider?.status ?? "unknown",
    modelId: selection.modelId,
  };
}

function capabilityDescriptors(
  workspaces: Array<{ writeEnabled: boolean }>,
  context: SnapshotContext,
): CapabilityDescriptor[] {
  const workspaceAvailable = workspaces.length > 0 && context.providerCapabilities?.workspaceTools === true;
  const workspaceReason = workspaces.length === 0
    ? "尚未授权工作区。"
    : context.providerCapabilities?.workspaceTools === true
      ? null
      : "当前模型来源未声明 Workspace 工具能力。";
  const networkAvailable = context.providerCapabilities?.networkTools === true;
  const networkReason = networkAvailable ? null : "当前模型来源未声明结构化联网工具能力。";
  const handoffAvailable = context.providerCapabilities?.handoff === true;
  const mcpAvailable = networkAvailable && context.mcpTools.length > 0;
  const executionTools = context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true;
  return [
    {
      id: "product.operations", name: "产品操作", category: "conversation",
      description: "查询完整产品动作目录，按统一授权调用设置、Bot、群聊、消息、任务、Memory、MCP、模型连接、项目、文件与更新。",
      effectClass: "write-reversible", adapterKind: "core",
      availability: context.providerCapabilities?.workspaceTools || context.providerCapabilities?.networkTools ? "available" : "unavailable",
      reason: context.providerCapabilities?.workspaceTools || context.providerCapabilities?.networkTools ? null : "当前模型来源尚未接入宿主产品工具。",
      permissionState: "not-required", toolNames: context.providerCapabilities?.workspaceTools || context.providerCapabilities?.networkTools ? ["product_catalog", "product_describe", "product_execute"] : [],
    },
    {
      id: "project.provisioning",
      name: "项目内 Bot 与群聊创建",
      category: "conversation",
      description: "查看当前项目真实成员，在用户审批后创建 Bot 和群聊；新资源不会自动执行任务，也不能跨项目创建。",
      effectClass: "write-reversible",
      adapterKind: "core",
      availability: context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true ? "available" : "unavailable",
      reason: context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true ? null : "当前模型来源不支持宿主结构化工具。",
      permissionState: "not-required",
      toolNames: context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true ? ["project_list_bots", "bot_create", "room_create"] : [],
    },
    {
      id: "conversation.text",
      name: "文本对话",
      category: "conversation",
      description: "可靠的流式文本对话、取消、重试和重启恢复。",
      effectClass: "pure",
      adapterKind: "core",
      availability: "available",
      reason: null,
      permissionState: "not-required",
      toolNames: [],
    },
    {
      id: "library.documents", name: "会话资料库", category: "workspace",
      description: "持久资料、文本检索、不可变版本和明确的会话授权；私聊资料不会自动进入群聊。",
      effectClass: "read-local", adapterKind: "core",
      availability: context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true ? "available" : "unavailable",
      reason: context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true ? null : "当前模型来源不支持宿主产品工具。",
      permissionState: "not-required", toolNames: context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true ? ["product_catalog", "product_describe", "product_execute"] : [],
    },
    {
      id: "skills.text", name: "文本 Skill", category: "conversation",
      description: "导入、管理并按需加载本会话授权的 SKILL.md 和辅助文本；脚本执行另需固定版本与隔离环境授权。",
      effectClass: "read-local", adapterKind: "core",
      availability: context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true ? "available" : "unavailable",
      reason: context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true ? null : "当前模型来源不支持宿主产品工具。",
      permissionState: "not-required", toolNames: context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true ? ["product_catalog", "product_describe", "product_execute"] : [],
    },
    {
      id: "skills.scripts", name: "隔离脚本 Skill", category: "workspace",
      description: "经精确版本授权和本次审批，在本会话 Bot 的隔离环境执行 Bash、Python、Node 脚本；元信息不会授予权限。",
      effectClass: "irreversible", adapterKind: "core", availability: executionTools && context.scriptReady ? "available" : "unavailable",
      reason: !executionTools ? "当前模型来源不支持宿主产品工具。" : context.scriptReady ? null : "请启动支持脚本 Skill 的环境；旧镜像需要明确重建，每个入口另需授权。",
      permissionState: "not-required", toolNames: executionTools ? ["product_catalog", "product_describe", "product_execute"] : [],
    },
    {
      id: "apps.read", name: "原生应用读取", category: "external",
      description: "读取当前会话 Bot 明确授权的 Gmail、所选 Drive 文件和共享 Notion 页面；配置连接不授予会话权限，本地草稿尚未外发。",
      effectClass: "read-remote", adapterKind: "core", availability: executionTools && context.nativeReadReady ? "available" : "unavailable",
      reason: !executionTools ? "当前来源未接入宿主工具。" : context.nativeReadReady ? null : "请先验证账号，并在当前会话为此 Bot 授予读取权限。",
      permissionState: context.nativeReadReady ? "granted" : "not-granted", toolNames: executionTools ? ["product_catalog", "product_describe", "product_execute"] : [],
    },
    {
      id: "environment.execution", name: "隔离 Linux 执行环境", category: "workspace",
      description: "在本会话与 Bot 独立的 Docker 环境运行 Node/Python 命令、传输文件和登记后台服务；每次写操作需审批，取消仅终止所属任务。",
      effectClass: "irreversible", adapterKind: "core", availability: executionTools && context.executionReady ? "available" : "unavailable",
      reason: !executionTools ? "当前模型来源不支持宿主产品工具。" : context.executionReady ? null : "当前会话的隔离环境尚未运行，请先检测 Docker、初始化镜像并启动环境。",
      permissionState: "not-required", toolNames: executionTools ? ["product_catalog", "product_describe", "product_execute"] : [],
    },
    {
      id: "computer.control", name: "隔离浏览器与电脑", category: "external", effectClass: "computer-control", adapterKind: "core",
      description: "在同一隔离浏览器与屏幕观察、导航和输入；用户接管会暂停 AI，归还后必须重新观察。宿主电脑与现有浏览器 Cookie 不在范围内。",
      availability: executionTools && context.browserReady && !context.browserUserControlled ? "available" : "unavailable",
      reason: context.browserUserControlled ? "用户正在接管，AI 输入与观察已暂停。" : !executionTools ? "当前来源未接入宿主工具。" : context.browserReady ? null : "当前浏览器伴随环境尚未运行。",
      permissionState: "not-required", toolNames: executionTools ? ["product_catalog", "product_describe", "product_execute"] : [],
    },
    {
      id: "browser.tool-images", name: "真实工具图片传递", category: "multimodal", effectClass: "read-local", adapterKind: "core",
      description: "将已授权画面的真实像素传入当前模型协议。传递验证不代表模型一定支持视觉理解；不支持时保留 DOM 操作。",
      availability: context.providerCapabilities?.toolImageInput && context.browserReady && !context.browserUserControlled ? "available" : "unavailable",
      reason: !context.providerCapabilities?.toolImageInput ? "当前来源未验证工具图片传递，不能声称已理解画面。" : context.browserUserControlled ? "接管期间画面上传已暂停。" : context.browserReady ? null : "当前浏览器伴随环境尚未运行。",
      permissionState: "not-required", toolNames: executionTools ? ["product_catalog", "product_describe", "product_execute"] : [],
    },
    {
      id: "room.collaboration",
      name: "多 Bot 群聊",
      category: "conversation",
      description: handoffAvailable
        ? "确定性路由、显式 @ 和有界 Agent Handoff。"
        : "确定性路由和显式 @；当前模型来源不支持模型驱动的结构化 Handoff。",
      effectClass: "pure",
      adapterKind: "core",
      availability: "available",
      reason: handoffAvailable ? null : "当前模型来源支持固定成员独立回复，不支持内部 Handoff；所有人仍可并行。",
      permissionState: "not-required",
      toolNames: context.room && handoffAvailable ? ["handoff_to_agent"] : [],
    },
    {
      id: "memory.manual",
      name: "显式长期记忆",
      category: "memory",
      description: "用户管理并审批的 user / Bot / Workspace 长期 Memory。",
      effectClass: "read-local",
      adapterKind: "local",
      availability: "available",
      reason: null,
      permissionState: "granted",
      toolNames: [],
    },
    {
      id: "computation.text-measure",
      name: "确定性文本计数",
      category: "conversation",
      description: "精确计算 Unicode 字符、非空白字符、词、行和 UTF-8 字节数。",
      effectClass: "pure",
      adapterKind: "core",
      availability: context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true ? "available" : "unavailable",
      reason: context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true ? null : "当前模型来源不支持结构化工具。",
      permissionState: "not-required",
      toolNames: context.providerCapabilities?.workspaceTools === true || context.providerCapabilities?.networkTools === true ? ["text_measure"] : [],
    },
    {
      id: "workspace.read",
      name: "Workspace 只读访问",
      category: "workspace",
      description: "在用户授权目录内列出、读取和搜索文本文件。",
      effectClass: "read-local",
      adapterKind: "local",
      availability: workspaceAvailable ? "available" : workspaces.length === 0 ? "permission-required" : "unavailable",
      reason: workspaceReason,
      permissionState: workspaces.length > 0 ? "granted" : "not-granted",
      toolNames: workspaceAvailable ? ["workspace_list", "workspace_read", "workspace_search"] : [],
    },
    {
      id: "workspace.write",
      name: "Workspace 文本成果写入",
      category: "workspace",
      description: "在单独授权的 Workspace 内创建新 Markdown/CSV；不覆盖、不删除。",
      effectClass: "write-reversible",
      adapterKind: "local",
      availability: workspaceAvailable && workspaces.some((workspace) => workspace.writeEnabled)
        ? "available"
        : workspaces.length === 0 ? "permission-required" : "unavailable",
      reason: workspaces.some((workspace) => workspace.writeEnabled) ? workspaceReason : "尚未为任何 Workspace 启用写入。",
      permissionState: workspaces.some((workspace) => workspace.writeEnabled) ? "granted" : "not-granted",
      toolNames: workspaceAvailable && workspaces.some((workspace) => workspace.writeEnabled) ? ["workspace_write"] : [],
    },
    {
      id: "network.search",
      name: "联网搜索",
      category: "network",
      description: "查询公开网页索引并返回来源和抓取时间。",
      effectClass: "read-remote",
      adapterKind: "connector",
      availability: networkAvailable ? "available" : "unavailable",
      reason: networkReason,
      permissionState: "not-required",
      toolNames: networkAvailable ? ["web_search", "web_fetch"] : [],
    },
    {
      id: "network.realtime-data",
      name: "时间与天气",
      category: "network",
      description: "查询权威系统时间和 Open-Meteo 当前天气。",
      effectClass: "read-remote",
      adapterKind: "connector",
      availability: networkAvailable ? "available" : "unavailable",
      reason: networkReason,
      permissionState: "not-required",
      toolNames: networkAvailable ? ["time_now", "weather_current"] : [],
    },
    {
      id: "mcp.client",
      name: "MCP",
      category: "external",
      description: "调用已经启用且明确声明为只读的 MCP 工具。",
      effectClass: "read-remote",
      adapterKind: "mcp",
      availability: mcpAvailable ? "available" : "unavailable",
      reason: mcpAvailable ? null : networkAvailable ? "尚无可用的只读 MCP 工具。" : networkReason,
      permissionState: context.mcpTools.length > 0 ? "granted" : "not-granted",
      toolNames: mcpAvailable ? context.mcpTools.map((tool) => tool.namespacedName) : [],
    },
    {
      id: "automation.scheduler",
      name: "定时与后台任务",
      category: "automation",
      description: "执行一次性、周期或 cron Bot Routine，并在启用时保持后台运行。",
      effectClass: "write-reversible",
      adapterKind: "local",
      availability: "available",
      reason: context.routines.some((routine) => routine.enabled) ? null : "尚未启用 Routine。",
      permissionState: "granted",
      toolNames: [],
    },
    {
      id: "device.clipboard",
      name: "剪贴板读取",
      category: "device",
      description: "在用户逐次确认后读取有限长度的纯文本剪贴板内容。",
      effectClass: "read-local",
      adapterKind: "native",
      availability: networkAvailable ? "available" : "unavailable",
      reason: networkAvailable ? null : "当前模型来源未声明结构化工具能力。",
      permissionState: "not-required",
      toolNames: networkAvailable ? ["clipboard_read"] : [],
    },
    ...unsupported.map((definition) => ({
      ...definition,
      availability: "not-supported" as const,
      reason: "当前版本未实现。",
      permissionState: "unsupported" as const,
      toolNames: [],
    })),
  ];
}

function connection(provider: ProviderInstanceInfo): CapabilityConnection {
  return {
    id: provider.id,
    name: provider.displayName,
    kind: "model-provider",
    status: provider.status,
    access: provider.access,
    authenticated: provider.authenticated,
    modelCount: provider.models.options.length,
  };
}

function mcpConnection(server: McpServerInfo): CapabilityConnection {
  return {
    id: server.id,
    name: server.name,
    kind: "mcp",
    status: server.status === "available" ? "available" : "unavailable",
    access: server.transport === "stdio" ? "local" : "cloud",
    authenticated: server.status !== "needs-auth",
    modelCount: 0,
  };
}

export class CapabilityRegistry {
  constructor(
    private readonly repository: AppRepository,
    private readonly providers: Pick<ProviderService, "list" | "getCached" | "getCapabilities">,
    private readonly environment: CapabilityAppEnvironment,
    private readonly clock: () => Date = () => new Date(),
    private readonly mcp?: Pick<McpService, "list" | "availableTools">,
    private readonly routineList: () => Routine[] = () => [],
  ) {}

  async getSnapshot(input: { botId?: string; sessionId?: string } = {}): Promise<CapabilitySnapshot> {
    const providerList = await this.providers.list();
    const selection = input.botId
      ? this.repository.getBot(input.botId).modelSelection
      : this.repository.getDefaultModelSelection();
    const provider = providerList.find((candidate) => candidate.id === selection.providerInstanceId) ?? null;
    return this.build(selection, provider, providerList, this.mcp?.list() ?? [], Boolean(input.sessionId && this.repository.getSession(input.sessionId).roomId), input.botId, input.sessionId);
  }

  forPrompt(botId: string, selection: ModelSelection, room: boolean, sessionId?: string): CapabilityPromptSnapshot {
    this.repository.getBot(botId);
    const snapshot = this.build(selection, this.providers.getCached(selection.providerInstanceId), [], this.mcp?.list() ?? [], room, botId, sessionId);
    return {
      schemaVersion: snapshot.schemaVersion,
      generatedAt: snapshot.generatedAt,
      timezone: snapshot.timezone,
      utcOffsetMinutes: snapshot.utcOffsetMinutes,
      app: snapshot.app,
      model: snapshot.model,
      availableTools: snapshot.availableTools,
      capabilities: snapshot.capabilities.map(({ id, availability, reason }) => ({ id, availability, reason })),
    };
  }

  private build(
    selection: ModelSelection,
    provider: ProviderInstanceInfo | null,
    providerList: ProviderInstanceInfo[],
    mcpServers: McpServerInfo[],
    room: boolean,
    botId?: string,
    sessionId?: string,
  ): CapabilitySnapshot {
    const workspaces = botId
      ? this.repository.listSessionWorkspaces(sessionId ?? this.repository.getMainSession(botId).id, botId)
      : this.repository.listWorkspaces();
    const providerCapabilities: ProviderCapabilities | null = (() => {
      try {
        return this.providers.getCapabilities(selection);
      } catch {
        return null;
      }
    })();
    const mcpTools = this.mcp?.availableTools(botId) ?? [];
    const routines = this.routineList();
    const environment = botId && sessionId ? this.repository.environments.get({ sessionId, executorBotId: botId }) : null;
    const executionReady = environment?.state === "running";
    const browser = botId && sessionId ? this.repository.browsers.get({ sessionId, executorBotId: botId }) : null;
    const nativeReadReady = Boolean(botId && sessionId && this.repository.connectors.bindings({ sessionId, executorBotId: botId }).some(binding => {
      const connection = this.repository.connectors.get(binding.connectionId);
      return connection.state === "connected" && connection.authVersion === binding.authVersion && Boolean(connection.account);
    }));
    const capabilities = capabilityDescriptors(workspaces, { selection, provider, providerCapabilities, room, mcpTools, routines, executionReady, scriptReady: executionReady && environment.workerVersion === SKILL_SCRIPT_WORKER_VERSION, nativeReadReady,
      browserReady: browser?.state === "running", browserUserControlled: Boolean(botId && sessionId && this.repository.browsers.view({ sessionId, executorBotId: botId })?.owner === "user") }).map((capability) => {
      if (!providerCapabilities?.supportedToolNames || capability.toolNames.length === 0) return capability;
      const toolNames = capability.toolNames.filter((name) => providerCapabilities.supportedToolNames!.includes(name));
      return toolNames.length > 0 ? { ...capability, toolNames } : {
        ...capability,
        toolNames,
        availability: "unavailable" as const,
        reason: "当前模型来源尚未接入此工具。",
      };
    });
    const permissions: CapabilityPermission[] = [{
      id: "workspace.read",
      name: "Workspace 只读访问",
      state: workspaces.length > 0 ? "granted" : "not-granted",
      scopeSummary: workspaces.length > 0 ? `${workspaces.length} 个已授权文件夹` : "尚未授权文件夹",
      revocable: true,
    }, {
      id: "workspace.write",
      name: "Workspace 文本成果写入",
      state: workspaces.some((workspace) => workspace.writeEnabled) ? "granted" : "not-granted",
      scopeSummary: workspaces.some((workspace) => workspace.writeEnabled)
        ? `${workspaces.filter((workspace) => workspace.writeEnabled).length} 个可写 Workspace`
        : "尚未启用",
      revocable: true,
    }, {
      id: "mcp.read",
      name: "MCP 只读工具",
      state: mcpTools.length > 0 ? "granted" : "not-granted",
      scopeSummary: mcpTools.length > 0 ? `${mcpTools.length} 个只读工具` : "尚无已启用的只读工具",
      revocable: true,
    }];
    return {
      schemaVersion: 1,
      ...localTime(this.clock()),
      app: this.environment,
      model: selectedModel(selection, provider),
      availableTools: [...new Set(capabilities.flatMap((capability) => capability.toolNames))],
      capabilities,
      permissions,
      connections: [...providerList.map(connection), ...mcpServers.map(mcpConnection)],
      workspaceCount: workspaces.length,
      backgroundMode: routines.some((routine) => routine.enabled) ? "background-while-routines-enabled" : "foreground-only",
    };
  }
}
