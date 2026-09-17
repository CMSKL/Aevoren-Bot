import { join } from "node:path";
import type {
  ModelSelection,
  ProviderCapabilities,
  ProviderInstanceInfo,
  ProviderModelOption,
  SaveCliProviderInput,
  SaveOpenAiCompatibleProviderInput,
} from "@shared/contracts";
import type { AppRepository, ProviderInstanceConfig } from "./database";
import { AevorenBotError } from "./errors";
import { OpenAiCompatibleProvider, type ModelProvider } from "./model";
import type { SecretCodec } from "./settings";
import { CodexCliProvider, inspectCodexCli, type CodexCliInspection } from "./providers/codex-cli";
import { ClaudeCliProvider, inspectClaudeCli, type ClaudeCliInspection } from "./providers/claude-cli";
import { OllamaCliProvider, inspectOllamaCli, type OllamaCliInspection } from "./providers/ollama-cli";
import { findCliCandidates, resolveCliPath } from "./providers/cli-utils";
import type { ProviderResolver, RuntimeProviderInstance } from "./providers/contracts";

const OPENAI_INSTANCE_ID = "openai-compatible.default";
const CODEX_INSTANCE_ID = "codex.default";
const CLAUDE_INSTANCE_ID = "claude.default";
const OLLAMA_INSTANCE_ID = "ollama.default";

const OPENAI_CAPABILITIES: ProviderCapabilities = {
  roomOwnerSelection: true,
  handoff: true,
  workspaceTools: true,
};

const CODEX_CAPABILITIES: ProviderCapabilities = {
  roomOwnerSelection: false,
  handoff: false,
  workspaceTools: false,
};

const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  roomOwnerSelection: false,
  handoff: false,
  workspaceTools: false,
};

const OLLAMA_CAPABILITIES: ProviderCapabilities = {
  roomOwnerSelection: false,
  handoff: false,
  workspaceTools: false,
};

function credentialKey(instanceId: string): string {
  return `provider.${instanceId}.apiKey`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

class OpenAiCompatibleRuntime implements RuntimeProviderInstance {
  readonly driverKind = "openai-compatible" as const;
  readonly capabilities = OPENAI_CAPABILITIES;
  readonly route = "openai-compatible" as const;
  private catalog: { default: string; options: ProviderModelOption[] };

  constructor(
    private readonly repository: AppRepository,
    private readonly secretCodec: SecretCodec,
    private readonly configuration: ProviderInstanceConfig,
  ) {
    const modelIds = repository.listModelIdsForProvider(configuration.id);
    const defaultSelection = repository.getDefaultModelSelection();
    const defaultModel = defaultSelection.providerInstanceId === configuration.id
      ? defaultSelection.modelId
      : modelIds[0] ?? "";
    const options = [...new Set([defaultModel, ...modelIds].filter(Boolean))].map((id) => ({ id, label: id }));
    this.catalog = { default: defaultModel || options[0]?.id || "", options };
  }

  get id(): string {
    return this.configuration.id;
  }

  async describe(): Promise<ProviderInstanceInfo> {
    const keyConfigured = this.repository.getSetting(credentialKey(this.id)) !== null;
    const baseUrl = text(this.configuration.config.baseUrl) ?? "https://api.openai.com/v1";
    return {
      id: this.id,
      driverKind: this.driverKind,
      displayName: this.configuration.displayName,
      access: "cloud",
      enabled: this.configuration.enabled,
      version: this.configuration.version,
      status: this.configuration.enabled && keyConfigured ? "available" : "unavailable",
      reason: !this.configuration.enabled ? "该供应商已停用。" : keyConfigured ? null : "尚未配置 API Key。",
      authenticated: keyConfigured,
      runtimeVersion: null,
      discoveryMode: "not-applicable",
      lastScannedAt: null,
      cliPath: null,
      cliDefault: null,
      manualCliPath: null,
      apiKeyConfigured: keyConfigured,
      baseUrl,
      models: this.catalog,
      capabilities: this.capabilities,
    };
  }

  createProvider(modelId: string): ModelProvider {
    if (!modelId) throw new AevorenBotError("MODEL_NOT_CONFIGURED");
    return new OpenAiCompatibleProvider(
      text(this.configuration.config.baseUrl) ?? "https://api.openai.com/v1",
      modelId,
      this.getApiKey(),
    );
  }

  async testConnection(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      await new OpenAiCompatibleProvider(
        text(this.configuration.config.baseUrl) ?? "https://api.openai.com/v1",
        this.catalog.default || "connection-test",
        this.getApiKey(),
      ).testConnection(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async refresh(): Promise<void> {
    const response = await fetch(`${text(this.configuration.config.baseUrl) ?? "https://api.openai.com/v1"}/models`, {
      headers: { authorization: `Bearer ${this.getApiKey()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new AevorenBotError("MODEL_CONNECTION_FAILED", undefined, response.status >= 500, { status: response.status });
    const body = await response.json() as { data?: Array<{ id?: unknown; name?: unknown }> };
    const options = (Array.isArray(body.data) ? body.data : []).flatMap((row) => {
      if (typeof row.id !== "string" || !row.id.trim()) return [];
      return [{ id: row.id, label: typeof row.name === "string" && row.name.trim() ? row.name : row.id }];
    });
    if (options.length === 0) return;
    const defaultModel = options.some((option) => option.id === this.catalog.default)
      ? this.catalog.default
      : options[0]!.id;
    this.catalog = { default: defaultModel, options };
  }

  async dispose(): Promise<void> {}

  private getApiKey(): string {
    const setting = this.repository.getSetting(credentialKey(this.id));
    if (!setting) throw new AevorenBotError("MODEL_NOT_CONFIGURED");
    if (!setting.encrypted || !this.secretCodec.isAvailable()) throw new AevorenBotError("SECURE_STORAGE_UNAVAILABLE");
    try {
      return this.secretCodec.decrypt(setting.value);
    } catch {
      throw new AevorenBotError("SECURE_STORAGE_UNAVAILABLE");
    }
  }
}

class CodexCliRuntime implements RuntimeProviderInstance {
  readonly driverKind = "codex-cli" as const;
  readonly capabilities = CODEX_CAPABILITIES;
  readonly route = "codex-cli" as const;
  private inspection: CodexCliInspection | null = null;
  private inspectionError: string | null = null;
  private lastScannedAt: string | null = null;

  constructor(
    private readonly configuration: ProviderInstanceConfig,
    private readonly workspaceDirectory: string,
    private readonly inspectOnDescribe: boolean,
  ) {}

  get id(): string {
    return this.configuration.id;
  }

  async describe(): Promise<ProviderInstanceInfo> {
    if (this.inspectOnDescribe && !this.inspection && !this.inspectionError) await this.inspect();
    const configured = text(this.configuration.config.cliPath) ?? "codex";
    const manual = configured !== "codex";
    const detectedPath = this.inspection?.path ?? resolveCliPath(configured);
    const available = this.configuration.enabled && Boolean(this.inspection?.authenticated && this.inspection.models.default);
    return {
      id: this.id,
      driverKind: this.driverKind,
      displayName: this.configuration.displayName,
      access: "cloud",
      enabled: this.configuration.enabled,
      version: this.configuration.version,
      status: available ? "available" : "unavailable",
      reason: !this.configuration.enabled
        ? "该供应商已停用。"
        : this.inspectionError ?? (this.inspection?.authenticated
          ? "Codex CLI 没有返回可用模型。"
          : this.inspectOnDescribe ? "Codex CLI 尚未登录。" : "测试环境未探测 Codex CLI。"),
      authenticated: this.inspection?.authenticated ?? false,
      runtimeVersion: this.inspection?.version ?? null,
      discoveryMode: manual ? "manual" : "automatic",
      lastScannedAt: this.lastScannedAt,
      cliPath: detectedPath,
      cliDefault: "codex",
      manualCliPath: manual ? configured : null,
      apiKeyConfigured: false,
      baseUrl: null,
      models: this.inspection?.models ?? { default: "", options: [] },
      capabilities: this.capabilities,
    };
  }

  createProvider(modelId: string): ModelProvider {
    if (!modelId) throw new AevorenBotError("MODEL_NOT_CONFIGURED");
    const configured = text(this.configuration.config.cliPath) ?? "codex";
    const path = this.inspection?.path ?? resolveCliPath(configured);
    if (!path || (this.inspectOnDescribe && !this.inspection?.authenticated)) {
      throw new AevorenBotError("MODEL_PROVIDER_UNAVAILABLE", undefined, false, { reason: "authentication" });
    }
    return new CodexCliProvider(
      path,
      modelId,
      join(this.workspaceDirectory, this.id),
    );
  }

  async testConnection(): Promise<void> {
    await this.inspect();
    if (!this.inspection?.authenticated || !this.inspection.models.default) {
      throw new AevorenBotError("MODEL_PROVIDER_UNAVAILABLE", undefined, false, { reason: "authentication" });
    }
  }

  async refresh(): Promise<void> {
    await this.inspect();
  }

  async dispose(): Promise<void> {}

  private async inspect(): Promise<void> {
    this.lastScannedAt = new Date().toISOString();
    const configured = text(this.configuration.config.cliPath) ?? "codex";
    try {
      this.inspection = await inspectCodexCli(
        configured,
        join(this.workspaceDirectory, this.id),
      );
      this.inspectionError = null;
    } catch {
      this.inspection = null;
      this.inspectionError = findCliCandidates(configured).length === 0
        ? "未检测到 Codex CLI。"
        : "Codex CLI 已检测到，但无法启动或协议不兼容。";
    }
  }
}

class ClaudeCliRuntime implements RuntimeProviderInstance {
  readonly driverKind = "claude-cli" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly route = "claude-cli" as const;
  private inspection: ClaudeCliInspection | null = null;
  private inspectionError: string | null = null;
  private lastScannedAt: string | null = null;

  constructor(
    private readonly configuration: ProviderInstanceConfig,
    private readonly workspaceDirectory: string,
    private readonly inspectOnDescribe: boolean,
  ) {}

  get id(): string {
    return this.configuration.id;
  }

  async describe(): Promise<ProviderInstanceInfo> {
    if (this.inspectOnDescribe && !this.inspection && !this.inspectionError) await this.inspect();
    const configured = text(this.configuration.config.cliPath) ?? "claude";
    const manual = configured !== "claude";
    const detectedPath = this.inspection?.path ?? resolveCliPath(configured);
    const available = this.configuration.enabled && Boolean(this.inspection?.authenticated && this.inspection.models.default);
    return {
      id: this.id,
      driverKind: this.driverKind,
      displayName: this.configuration.displayName,
      access: "cloud",
      enabled: this.configuration.enabled,
      version: this.configuration.version,
      status: available ? "available" : "unavailable",
      reason: !this.configuration.enabled
        ? "该供应商已停用。"
        : this.inspectionError ?? (this.inspection?.authenticated
          ? "Claude Code 没有返回可用模型。"
          : this.inspectOnDescribe ? "Claude Code 已检测到，但尚未登录。" : "测试环境未探测 Claude Code。"),
      authenticated: this.inspection?.authenticated ?? false,
      runtimeVersion: this.inspection?.version ?? null,
      discoveryMode: manual ? "manual" : "automatic",
      lastScannedAt: this.lastScannedAt,
      cliPath: detectedPath,
      cliDefault: "claude",
      manualCliPath: manual ? configured : null,
      apiKeyConfigured: false,
      baseUrl: null,
      models: this.inspection?.models ?? { default: "", options: [] },
      capabilities: this.capabilities,
    };
  }

  createProvider(modelId: string): ModelProvider {
    if (!modelId) throw new AevorenBotError("MODEL_NOT_CONFIGURED");
    const configured = text(this.configuration.config.cliPath) ?? "claude";
    const path = this.inspection?.path ?? resolveCliPath(configured);
    if (!path || (this.inspectOnDescribe && !this.inspection?.authenticated)) {
      throw new AevorenBotError("MODEL_PROVIDER_UNAVAILABLE", undefined, false, { reason: "authentication" });
    }
    return new ClaudeCliProvider(path, modelId, join(this.workspaceDirectory, this.id));
  }

  async testConnection(): Promise<void> {
    await this.inspect();
    if (!this.inspection?.authenticated || !this.inspection.models.default) {
      throw new AevorenBotError("MODEL_PROVIDER_UNAVAILABLE", undefined, false, { reason: "authentication" });
    }
  }

  async refresh(): Promise<void> {
    await this.inspect();
  }

  async dispose(): Promise<void> {}

  private async inspect(): Promise<void> {
    this.lastScannedAt = new Date().toISOString();
    const configured = text(this.configuration.config.cliPath) ?? "claude";
    try {
      this.inspection = await inspectClaudeCli(configured);
      this.inspectionError = null;
    } catch {
      this.inspection = null;
      this.inspectionError = findCliCandidates(configured).length === 0
        ? "未检测到 Claude Code。"
        : "Claude Code 已检测到，但无法启动或状态不可读。";
    }
  }
}

class OllamaCliRuntime implements RuntimeProviderInstance {
  readonly driverKind = "ollama-cli" as const;
  readonly capabilities = OLLAMA_CAPABILITIES;
  readonly route = "ollama-cli" as const;
  private inspection: OllamaCliInspection | null = null;
  private inspectionError: string | null = null;
  private lastScannedAt: string | null = null;

  constructor(
    private readonly configuration: ProviderInstanceConfig,
    private readonly workspaceDirectory: string,
    private readonly inspectOnDescribe: boolean,
  ) {}

  get id(): string {
    return this.configuration.id;
  }

  async describe(): Promise<ProviderInstanceInfo> {
    if (this.inspectOnDescribe && !this.inspection && !this.inspectionError) await this.inspect();
    const configured = text(this.configuration.config.cliPath) ?? "ollama";
    const manual = configured !== "ollama";
    const detectedPath = this.inspection?.path ?? resolveCliPath(configured);
    const available = this.configuration.enabled && Boolean(this.inspection?.models.default);
    return {
      id: this.id,
      driverKind: this.driverKind,
      displayName: this.configuration.displayName,
      access: "local",
      enabled: this.configuration.enabled,
      version: this.configuration.version,
      status: available ? "available" : "unavailable",
      reason: !this.configuration.enabled
        ? "该供应商已停用。"
        : this.inspectionError ?? (detectedPath
          ? "已检测到 Ollama，但服务未运行或尚无本地模型。"
          : this.inspectOnDescribe ? "未检测到 Ollama CLI。" : "测试环境未探测 Ollama。"),
      authenticated: Boolean(detectedPath),
      runtimeVersion: this.inspection?.version ?? null,
      discoveryMode: manual ? "manual" : "automatic",
      lastScannedAt: this.lastScannedAt,
      cliPath: detectedPath,
      cliDefault: "ollama",
      manualCliPath: manual ? configured : null,
      apiKeyConfigured: false,
      baseUrl: null,
      models: this.inspection?.models ?? { default: "", options: [] },
      capabilities: this.capabilities,
    };
  }

  createProvider(modelId: string): ModelProvider {
    if (!modelId) throw new AevorenBotError("MODEL_NOT_CONFIGURED");
    const configured = text(this.configuration.config.cliPath) ?? "ollama";
    const path = this.inspection?.path ?? resolveCliPath(configured);
    if (!path || (this.inspectOnDescribe && !this.inspection?.models.options.some((model) => model.id === modelId))) {
      throw new AevorenBotError("MODEL_PROVIDER_UNAVAILABLE", undefined, false, { reason: "models" });
    }
    return new OllamaCliProvider(path, modelId, join(this.workspaceDirectory, this.id));
  }

  async testConnection(): Promise<void> {
    await this.inspect();
    if (!this.inspection?.models.default) {
      throw new AevorenBotError("MODEL_PROVIDER_UNAVAILABLE", undefined, false, { reason: "models" });
    }
  }

  async refresh(): Promise<void> {
    await this.inspect();
  }

  async dispose(): Promise<void> {}

  private async inspect(): Promise<void> {
    this.lastScannedAt = new Date().toISOString();
    const configured = text(this.configuration.config.cliPath) ?? "ollama";
    try {
      this.inspection = await inspectOllamaCli(configured);
      this.inspectionError = null;
    } catch {
      this.inspection = null;
      this.inspectionError = findCliCandidates(configured).length === 0
        ? "未检测到 Ollama CLI。"
        : "Ollama CLI 已检测到，但本地服务不可用。";
    }
  }
}

export class ProviderService implements ProviderResolver {
  private instances = new Map<string, RuntimeProviderInstance>();

  constructor(
    private readonly repository: AppRepository,
    private readonly secretCodec: SecretCodec,
    private readonly workspaceDirectory: string,
    private readonly inspectCliOnInitialize = true,
  ) {}

  async initialize(): Promise<void> {
    await this.reload();
    const descriptions = await this.scan();
    const current = this.repository.getDefaultModelSelection();
    if (current.modelId) return;
    const preferred = descriptions.find((instance) => instance.id === CODEX_INSTANCE_ID && instance.status === "available")
      ?? descriptions.find((instance) => instance.id === CLAUDE_INSTANCE_ID && instance.status === "available")
      ?? descriptions.find((instance) => instance.status === "available");
    if (!preferred?.models.default) return;
    const selection = { providerInstanceId: preferred.id, modelId: preferred.models.default };
    this.repository.setDefaultModelSelection(selection);
    this.repository.applyDefaultSelectionToUnconfiguredBots(selection);
  }

  async reload(): Promise<void> {
    for (const instance of this.instances.values()) await instance.dispose();
    this.instances.clear();
    for (const configuration of this.repository.listProviderInstanceConfigs()) {
      this.instances.set(configuration.id, this.createRuntime(configuration));
    }
  }

  async list(): Promise<ProviderInstanceInfo[]> {
    return Promise.all([...this.instances.values()].map((instance) => instance.describe()));
  }

  async scan(): Promise<ProviderInstanceInfo[]> {
    if (!this.inspectCliOnInitialize) return this.list();
    await Promise.all([...this.instances.values()].map(async (instance) => {
      if (instance.driverKind === "openai-compatible") return;
      await instance.refresh();
    }));
    return this.list();
  }

  async get(instanceId: string): Promise<ProviderInstanceInfo> {
    const instance = this.requireInstance(instanceId);
    return instance.describe();
  }

  async saveOpenAiCompatible(input: SaveOpenAiCompatibleProviderInput): Promise<ProviderInstanceInfo> {
    const current = this.repository.getProviderInstanceConfig(input.instanceId);
    if (current.driverKind !== "openai-compatible") throw new AevorenBotError("INVALID_REQUEST");
    const encrypted = input.apiKey ? this.encryptCredential(input.apiKey) : null;
    this.repository.updateProviderInstanceConfig(input.instanceId, input.expectedVersion, {
      ...current.config,
      baseUrl: input.baseUrl.replace(/\/+$/u, ""),
    });
    if (encrypted) this.repository.setSetting(credentialKey(input.instanceId), encrypted, true);
    await this.reloadOne(input.instanceId);
    return this.get(input.instanceId);
  }

  async saveCli(input: SaveCliProviderInput): Promise<ProviderInstanceInfo> {
    const current = this.repository.getProviderInstanceConfig(input.instanceId);
    if (current.driverKind === "openai-compatible") throw new AevorenBotError("INVALID_REQUEST");
    this.repository.updateProviderInstanceConfig(input.instanceId, input.expectedVersion, {
      ...current.config,
      cliPath: input.cliPath,
    });
    await this.reloadOne(input.instanceId);
    return this.get(input.instanceId);
  }

  async test(instanceId: string): Promise<void> {
    await this.requireInstance(instanceId).testConnection();
  }

  async refresh(instanceId: string): Promise<ProviderInstanceInfo> {
    const instance = this.requireInstance(instanceId);
    await instance.refresh();
    return instance.describe();
  }

  getRoute(selection: ModelSelection) {
    return this.requireInstance(selection.providerInstanceId).route;
  }

  createProvider(selection: ModelSelection): ModelProvider {
    return this.requireInstance(selection.providerInstanceId).createProvider(selection.modelId);
  }

  getCapabilities(selection: ModelSelection): ProviderCapabilities {
    return this.requireInstance(selection.providerInstanceId).capabilities;
  }

  async dispose(): Promise<void> {
    for (const instance of this.instances.values()) await instance.dispose();
    this.instances.clear();
  }

  private createRuntime(configuration: ProviderInstanceConfig): RuntimeProviderInstance {
    if (configuration.driverKind === "openai-compatible") {
      return new OpenAiCompatibleRuntime(this.repository, this.secretCodec, configuration);
    }
    if (configuration.driverKind === "codex-cli") {
      return new CodexCliRuntime(configuration, this.workspaceDirectory, this.inspectCliOnInitialize);
    }
    if (configuration.driverKind === "claude-cli") {
      return new ClaudeCliRuntime(configuration, this.workspaceDirectory, this.inspectCliOnInitialize);
    }
    if (configuration.driverKind === "ollama-cli") {
      return new OllamaCliRuntime(configuration, this.workspaceDirectory, this.inspectCliOnInitialize);
    }
    throw new AevorenBotError("MODEL_PROVIDER_NOT_FOUND");
  }

  private requireInstance(id: string): RuntimeProviderInstance {
    const instance = this.instances.get(id);
    if (!instance) throw new AevorenBotError("MODEL_PROVIDER_NOT_FOUND");
    return instance;
  }

  private async reloadOne(id: string): Promise<void> {
    await this.instances.get(id)?.dispose();
    const configuration = this.repository.getProviderInstanceConfig(id);
    this.instances.set(id, this.createRuntime(configuration));
  }

  private encryptCredential(value: string): string {
    if (!this.secretCodec.isAvailable()) throw new AevorenBotError("SECURE_STORAGE_UNAVAILABLE");
    try {
      return this.secretCodec.encrypt(value);
    } catch {
      throw new AevorenBotError("SECURE_STORAGE_UNAVAILABLE");
    }
  }
}

export const DEFAULT_PROVIDER_INSTANCE_IDS = {
  codex: CODEX_INSTANCE_ID,
  claude: CLAUDE_INSTANCE_ID,
  ollama: OLLAMA_INSTANCE_ID,
  openAiCompatible: OPENAI_INSTANCE_ID,
} as const;
