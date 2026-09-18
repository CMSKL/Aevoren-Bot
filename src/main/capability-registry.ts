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

export type CapabilityAppEnvironment = CapabilityPromptSnapshot["app"];

type SnapshotContext = {
  selection: ModelSelection;
  provider: ProviderInstanceInfo | null;
  providerCapabilities: ProviderCapabilities | null;
  room: boolean;
  mcpTools: McpToolInfo[];
  routines: Routine[];
};

const unsupported: Array<Pick<CapabilityDescriptor, "id" | "name" | "category" | "description" | "effectClass" | "adapterKind">> = [
  { id: "device.location", name: "定位", category: "device", description: "读取用户授权的位置。", effectClass: "read-local", adapterKind: "none" },
  { id: "device.personal-data", name: "设备个人数据", category: "device", description: "访问相册、日历或通讯录。", effectClass: "read-local", adapterKind: "none" },
  { id: "external.actions", name: "外部操作", category: "external", description: "发送消息、邮件、订票、下单或控制其他服务。", effectClass: "write-external", adapterKind: "none" },
  { id: "multimodal.input", name: "多模态输入", category: "multimodal", description: "理解图片、音频、视频或屏幕内容。", effectClass: "read-local", adapterKind: "none" },
  { id: "computer.control", name: "屏幕与电脑操作", category: "external", description: "观察并操作网页或桌面应用。", effectClass: "computer-control", adapterKind: "none" },
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
  workspaces: number,
  context: SnapshotContext,
): CapabilityDescriptor[] {
  const workspaceAvailable = workspaces > 0 && context.providerCapabilities?.workspaceTools === true;
  const workspaceReason = workspaces === 0
    ? "尚未授权工作区。"
    : context.providerCapabilities?.workspaceTools === true
      ? null
      : "当前模型来源未声明 Workspace 工具能力。";
  const networkAvailable = context.providerCapabilities?.networkTools === true;
  const networkReason = networkAvailable ? null : "当前模型来源未声明结构化联网工具能力。";
  const mcpAvailable = networkAvailable && context.mcpTools.length > 0;
  return [
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
      id: "room.collaboration",
      name: "多 Bot 群聊",
      category: "conversation",
      description: "确定性路由、显式 @ 和有界 Agent Handoff。",
      effectClass: "pure",
      adapterKind: "core",
      availability: "available",
      reason: null,
      permissionState: "not-required",
      toolNames: context.room ? ["handoff_to_agent"] : [],
    },
    {
      id: "memory.manual",
      name: "显式长期记忆",
      category: "memory",
      description: "用户管理的 Bot 级版本化 Memory。",
      effectClass: "read-local",
      adapterKind: "local",
      availability: "available",
      reason: null,
      permissionState: "granted",
      toolNames: [],
    },
    {
      id: "workspace.read",
      name: "Workspace 只读访问",
      category: "workspace",
      description: "在用户授权目录内列出、读取和搜索文本文件。",
      effectClass: "read-local",
      adapterKind: "local",
      availability: workspaceAvailable ? "available" : workspaces === 0 ? "permission-required" : "unavailable",
      reason: workspaceReason,
      permissionState: workspaces > 0 ? "granted" : "not-granted",
      toolNames: workspaceAvailable ? ["workspace_list", "workspace_read", "workspace_search"] : [],
    },
    {
      id: "network.search",
      name: "联网搜索",
      category: "network",
      description: "查询 Wikipedia 实时索引并返回来源和抓取时间。",
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

  async getSnapshot(input: { botId?: string } = {}): Promise<CapabilitySnapshot> {
    const providerList = await this.providers.list();
    const selection = input.botId
      ? this.repository.getBot(input.botId).modelSelection
      : this.repository.getDefaultModelSelection();
    const provider = providerList.find((candidate) => candidate.id === selection.providerInstanceId) ?? null;
    return this.build(selection, provider, providerList, this.mcp?.list() ?? [], false, input.botId);
  }

  forPrompt(botId: string, selection: ModelSelection, room: boolean): CapabilityPromptSnapshot {
    this.repository.getBot(botId);
    const snapshot = this.build(selection, this.providers.getCached(selection.providerInstanceId), [], this.mcp?.list() ?? [], room, botId);
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
  ): CapabilitySnapshot {
    const workspaces = this.repository.listWorkspaces();
    const providerCapabilities: ProviderCapabilities | null = (() => {
      try {
        return this.providers.getCapabilities(selection);
      } catch {
        return null;
      }
    })();
    const mcpTools = this.mcp?.availableTools(botId) ?? [];
    const routines = this.routineList();
    const capabilities = capabilityDescriptors(workspaces.length, { selection, provider, providerCapabilities, room, mcpTools, routines });
    const permissions: CapabilityPermission[] = [{
      id: "workspace.read",
      name: "Workspace 只读访问",
      state: workspaces.length > 0 ? "granted" : "not-granted",
      scopeSummary: workspaces.length > 0 ? `${workspaces.length} 个已授权文件夹` : "尚未授权文件夹",
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
      availableTools: capabilities.flatMap((capability) => capability.toolNames),
      capabilities,
      permissions,
      connections: [...providerList.map(connection), ...mcpServers.map(mcpConnection)],
      workspaceCount: workspaces.length,
      backgroundMode: routines.some((routine) => routine.enabled) ? "background-while-routines-enabled" : "foreground-only",
    };
  }
}
