import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Agent, fetch as undiciFetch } from "undici";
import type { McpServerInfo, McpServerMutation, McpToolInfo, McpToolRequest } from "@shared/contracts";
import type { AppRepository, McpServerConfig } from "./database";
import { AevorenBotError } from "./errors";
import type { SecretCodec } from "./settings";
import { createOAuthCallback, McpOAuthProvider, oauthState, parseMcpOAuthRecord, type McpOAuthRecord, type OAuthCallback } from "./mcp-oauth";
import { createPinnedLookup, fetchPinnedBuffered, resolveSafeNetworkUrl, type SafeNetworkTarget } from "./network-security";

type Connection = {
  client: Client;
  transport: Transport;
  tools: McpToolInfo[];
  dispatcher: Agent | null;
};

type McpExecutionResult = {
  content: string;
  metadata: Record<string, string | number | boolean | null>;
};

const CONNECT_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARACTERS = 100_000;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;

function secretKey(id: string): string {
  return `mcp.server.${id}.secrets`;
}

function oauthKey(id: string): string {
  return `mcp.server.${id}.oauth`;
}

function publicConfig(input: McpServerMutation["config"], trustedReadOnlyTools: string[]): Record<string, unknown> {
  return input.transport === "stdio"
    ? { command: input.command, args: input.args, envKeys: Object.keys(input.env).toSorted(), trustedReadOnlyTools }
    : { url: input.url, headerKeys: Object.keys(input.headers).toSorted(), trustedReadOnlyTools };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function classifyConnectionError(error: unknown): "MCP_AUTH_REQUIRED" | "MCP_SERVER_UNAVAILABLE" {
  if (error instanceof AevorenBotError && error.code === "MCP_AUTH_REQUIRED") return "MCP_AUTH_REQUIRED";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("401") || message.includes("unauthorized") || message.includes("authorization")
    ? "MCP_AUTH_REQUIRED"
    : "MCP_SERVER_UNAVAILABLE";
}

function boundedJson(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return serialized.length <= MAX_RESULT_CHARACTERS
    ? value
    : { truncated: true, preview: serialized.slice(0, MAX_RESULT_CHARACTERS) };
}

export class McpService {
  private readonly connections = new Map<string, Connection>();
  private readonly probedTools = new Map<string, McpToolInfo[]>();
  private readonly activeAuthorizations = new Map<string, OAuthCallback>();
  private readonly authorizingIds = new Set<string>();

  constructor(
    private readonly repository: AppRepository,
    private readonly secretCodec: SecretCodec,
    private readonly appVersion: string,
    private readonly openExternal: (url: string) => Promise<void> = async () => {},
  ) {}

  async initialize(): Promise<void> {
    await Promise.all(this.repository.listMcpServerConfigs().filter((server) => server.enabled).map(async (server) => {
      try {
        await this.connect(server);
      } catch {
        // The status is persisted by connect; one unavailable server must not block app startup.
      }
    }));
  }

  list(): McpServerInfo[] {
    return this.repository.listMcpServerConfigs().map((server) => this.info(server));
  }

  async save(input: McpServerMutation): Promise<McpServerInfo> {
    const existing = input.id ? this.repository.getMcpServerConfig(input.id) : null;
    if (existing && this.authorizingIds.has(existing.id)) throw new AevorenBotError("MCP_AUTH_IN_PROGRESS");
    const previousSecrets = existing ? this.readSecrets(existing.id) : {};
    const incomingSecrets = input.config.transport === "stdio" ? input.config.env : input.config.headers;
    const secrets: Record<string, string> = {};
    for (const [name, value] of Object.entries(incomingSecrets)) {
      if (value === true) {
        if (previousSecrets[name] === undefined) throw new AevorenBotError("INVALID_REQUEST");
        secrets[name] = previousSecrets[name];
      } else {
        secrets[name] = value;
      }
    }
    if (Object.keys(secrets).length > 0 && !this.secretCodec.isAvailable()) {
      throw new AevorenBotError("SECURE_STORAGE_UNAVAILABLE");
    }
    if (existing) await this.disconnect(existing.id);
    const previousTrusted = existing ? stringArray(existing.config.trustedReadOnlyTools) : [];
    const trustedReadOnlyTools = input.trustedReadOnlyTools ?? previousTrusted;
    const observedTools = existing ? this.probedTools.get(existing.id) ?? [] : [];
    if (trustedReadOnlyTools.some((name) => (
      !previousTrusted.includes(name) && !observedTools.some((tool) => tool.name === name && tool.claimedReadOnly)
    ))) {
      throw new AevorenBotError("INVALID_REQUEST");
    }
    const stored = existing
      ? this.repository.updateMcpServerConfig(existing.id, input.expectedVersion!, input.name, input.config.transport, publicConfig(input.config, trustedReadOnlyTools))
      : this.repository.createMcpServerConfig(input.name, input.config.transport, publicConfig(input.config, trustedReadOnlyTools));
    const oldOAuthTarget = existing?.transport === "streamable-http" && typeof existing.config.url === "string" ? existing.config.url : null;
    const newOAuthTarget = input.config.transport === "streamable-http" ? input.config.url : null;
    if (existing && oldOAuthTarget !== newOAuthTarget) this.repository.deleteSetting(oauthKey(stored.id));
    this.writeSecrets(stored.id, secrets);
    this.probedTools.delete(stored.id);
    return this.info(stored);
  }

  async setEnabled(id: string, expectedVersion: number, enabled: boolean): Promise<McpServerInfo> {
    if (this.authorizingIds.has(id)) throw new AevorenBotError("MCP_AUTH_IN_PROGRESS");
    await this.disconnect(id);
    const stored = this.repository.setMcpServerEnabled(id, expectedVersion, enabled);
    if (!enabled) return this.info(stored);
    try {
      await this.connect(stored);
    } catch {
      // Enabling remains an explicit user choice; status explains why it cannot currently run.
    }
    return this.info(this.repository.getMcpServerConfig(id));
  }

  async probe(id: string): Promise<McpServerInfo> {
    if (this.authorizingIds.has(id)) throw new AevorenBotError("MCP_AUTH_IN_PROGRESS");
    const stored = this.repository.getMcpServerConfig(id);
    await this.disconnect(id);
    try {
      const connection = await this.connect(stored, true);
      await connection.client.close();
      await connection.dispatcher?.close();
      this.connections.delete(id);
      if (!stored.enabled) this.repository.setMcpServerStatus(id, "disabled", null);
    } catch (error) {
      if (!stored.enabled) this.repository.setMcpServerStatus(id, "disabled", classifyConnectionError(error));
    }
    return this.info(this.repository.getMcpServerConfig(id));
  }

  async authorize(id: string): Promise<McpServerInfo> {
    const stored = this.repository.getMcpServerConfig(id);
    if (stored.transport !== "streamable-http" || typeof stored.config.url !== "string") {
      throw new AevorenBotError("INVALID_REQUEST");
    }
    if (this.authorizingIds.has(id)) throw new AevorenBotError("MCP_AUTH_IN_PROGRESS");
    if (!this.secretCodec.isAvailable()) throw new AevorenBotError("SECURE_STORAGE_UNAVAILABLE");
    this.authorizingIds.add(id);
    try {
      await this.disconnect(id);
    } catch (error) {
      this.authorizingIds.delete(id);
      throw error;
    }
    const state = oauthState();
    let callback: OAuthCallback;
    try {
      callback = await createOAuthCallback(state);
    } catch (error) {
      this.authorizingIds.delete(id);
      throw error;
    }
    this.activeAuthorizations.set(id, callback);
    const callbackOutcome = callback.result.then(
      (code) => ({ code, error: null }),
      (error: unknown) => ({ code: null, error }),
    );
    let previous: McpOAuthRecord;
    try {
      previous = this.readOAuth(id);
      this.writeOAuth(id, { redirectUri: callback.redirectUrl.toString() });
    } catch (error) {
      callback.cancel();
      this.activeAuthorizations.delete(id);
      this.authorizingIds.delete(id);
      throw error;
    }
    const serverUrl = new URL(stored.config.url);
    const allowLoopback = ["localhost", "127.0.0.1", "::1"].includes(serverUrl.hostname.replace(/^\[(.*)\]$/u, "$1"));
    const provider = this.oauthProvider(stored, callback.redirectUrl, state, true, allowLoopback);
    const fetchFn = (input: string | URL, init?: RequestInit): Promise<Response> => (
      fetchPinnedBuffered(input, init, allowLoopback)
    );
    try {
      const started = await auth(provider, { serverUrl, fetchFn });
      if (started === "REDIRECT") {
        const outcome = await callbackOutcome;
        if (outcome.error) throw outcome.error;
        const finished = await auth(provider, { serverUrl, authorizationCode: outcome.code!, fetchFn });
        if (finished !== "AUTHORIZED") throw new AevorenBotError("MCP_AUTH_INVALID");
      }
      const refreshed = this.repository.getMcpServerConfig(id);
      if (refreshed.enabled) {
        await this.connect(refreshed);
      } else {
        const connection = await this.connect(refreshed, true);
        await connection.client.close().catch(() => undefined);
        await connection.dispatcher?.close().catch(() => undefined);
        this.repository.setMcpServerStatus(id, "disabled", null);
      }
      this.activeAuthorizations.delete(id);
      this.authorizingIds.delete(id);
      return this.info(this.repository.getMcpServerConfig(id));
    } catch (error) {
      this.writeOAuth(id, previous);
      this.repository.setMcpServerStatus(id, stored.enabled ? "needs-auth" : "disabled", "MCP_AUTH_REQUIRED");
      if (error instanceof AevorenBotError) throw error;
      throw new AevorenBotError("MCP_AUTH_REQUIRED");
    } finally {
      callback.cancel();
      this.activeAuthorizations.delete(id);
      this.authorizingIds.delete(id);
    }
  }

  cancelAuthorization(id: string): void {
    const callback = this.activeAuthorizations.get(id);
    if (!callback) throw new AevorenBotError("MCP_AUTH_CANCELLED");
    this.activeAuthorizations.delete(id);
    this.authorizingIds.delete(id);
    callback.cancel();
  }

  async clearAuthorization(id: string, expectedVersion: number): Promise<McpServerInfo> {
    const stored = this.repository.getMcpServerConfig(id);
    const active = this.activeAuthorizations.get(id);
    active?.cancel();
    this.activeAuthorizations.delete(id);
    this.authorizingIds.delete(id);
    await this.disconnect(id);
    this.repository.deleteSetting(oauthKey(id));
    this.probedTools.delete(id);
    return this.info(this.repository.updateMcpServerConfig(
      id,
      expectedVersion,
      stored.name,
      stored.transport,
      stored.config,
    ));
  }

  async delete(id: string, expectedVersion: number): Promise<void> {
    this.activeAuthorizations.get(id)?.cancel();
    this.activeAuthorizations.delete(id);
    this.authorizingIds.delete(id);
    await this.disconnect(id);
    this.repository.deleteMcpServerConfig(id, expectedVersion);
    this.probedTools.delete(id);
    this.repository.deleteSetting(secretKey(id));
    this.repository.deleteSetting(oauthKey(id));
  }

  availableTools(botId?: string): McpToolInfo[] {
    const selected = botId ? this.repository.getBot(botId).mcpServerIds ?? null : null;
    return this.repository.listMcpServerConfigs()
      .filter((server) => server.enabled && server.lastStatus === "available" && (selected === null || selected.includes(server.id)))
      .flatMap((server) => this.probedTools.get(server.id) ?? [])
      .filter((tool) => tool.readOnly);
  }

  async run(tool: McpToolRequest, signal: AbortSignal): Promise<McpExecutionResult> {
    const server = this.repository.getMcpServerConfig(tool.serverId);
    if (!server.enabled) throw new AevorenBotError("MCP_SERVER_UNAVAILABLE");
    const connection = this.connections.get(server.id) ?? await this.connect(server);
    const definition = connection.tools.find((candidate) => candidate.name === tool.toolName);
    if (!definition) throw new AevorenBotError("MCP_TOOL_NOT_FOUND");
    if (!definition.readOnly || !tool.readOnly) throw new AevorenBotError("MCP_TOOL_NOT_READONLY");
    try {
      const result = await connection.client.callTool(
        { name: tool.toolName, arguments: tool.arguments },
        undefined,
        { signal, timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
      );
      if (result.isError) throw new AevorenBotError("MCP_RESULT_INVALID");
      const normalizedContent = (Array.isArray(result.content) ? result.content : []).map((raw) => {
        const block = object(raw);
        if (block?.type === "text" && typeof block.text === "string") {
          return { type: "text", text: block.text.slice(0, MAX_RESULT_CHARACTERS) };
        }
        const resource = object(block?.resource);
        if (block?.type === "resource" && resource && typeof resource.uri === "string" && typeof resource.text === "string") {
          return { type: "resource", uri: resource.uri, text: resource.text.slice(0, MAX_RESULT_CHARACTERS) };
        }
        return { type: typeof block?.type === "string" ? block.type : "unknown", omitted: true };
      });
      const retrievedAt = new Date().toISOString();
      return {
        content: JSON.stringify({
          untrusted: true,
          server: server.name,
          tool: definition.name,
          retrievedAt,
          content: boundedJson(normalizedContent),
          ...(result.structuredContent ? { structuredContent: boundedJson(result.structuredContent) } : {}),
        }),
        metadata: { kind: "mcp-call", server: server.name, tool: definition.name, retrievedAt },
      };
    } catch (error) {
      if (signal.aborted) throw new AevorenBotError("TOOL_EXECUTION_CANCELLED");
      if (error instanceof AevorenBotError) throw error;
      const code = classifyConnectionError(error);
      this.repository.setMcpServerStatus(server.id, code === "MCP_AUTH_REQUIRED" ? "needs-auth" : "unavailable", code);
      await this.disconnect(server.id);
      throw new AevorenBotError(code);
    }
  }

  async dispose(): Promise<void> {
    for (const authorization of this.activeAuthorizations.values()) authorization.cancel();
    this.activeAuthorizations.clear();
    this.authorizingIds.clear();
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  private async connect(server: McpServerConfig, probeOnly = false): Promise<Connection> {
    const client = new Client({ name: "Aevoren Bot", version: this.appVersion }, { capabilities: {} });
    let dispatcher: Agent | null = null;
    try {
      const safeTarget = server.transport === "streamable-http" && typeof server.config.url === "string"
        ? await resolveSafeNetworkUrl(server.config.url, true).catch(() => { throw new AevorenBotError("MCP_SERVER_UNAVAILABLE"); })
        : null;
      const allowLoopbackAuthorization = safeTarget !== null && ["localhost", "127.0.0.1", "::1"].includes(
        safeTarget.url.hostname.replace(/^\[(.*)\]$/u, "$1"),
      );
      const oauthRecord = safeTarget ? this.readOAuth(server.id) : {};
      const redirectUrl = (() => {
        try {
          return oauthRecord.redirectUri ? new URL(oauthRecord.redirectUri) : new URL("http://127.0.0.1/oauth/callback");
        } catch {
          throw new AevorenBotError("MCP_AUTH_STORAGE_INVALID");
        }
      })();
      const authProvider = safeTarget
        ? this.oauthProvider(server, redirectUrl, oauthState(), false, allowLoopbackAuthorization)
        : undefined;
      const prepared = this.transport(server, safeTarget, authProvider, allowLoopbackAuthorization);
      const transport = prepared.transport;
      dispatcher = prepared.dispatcher;
      if (server.enabled && !probeOnly) this.repository.setMcpServerStatus(server.id, "connecting", null);
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS, maxTotalTimeout: CONNECT_TIMEOUT_MS });
      const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS, maxTotalTimeout: CONNECT_TIMEOUT_MS });
      const trustedReadOnlyTools = new Set(stringArray(server.config.trustedReadOnlyTools));
      const tools = listed.tools.flatMap((tool): McpToolInfo[] => {
        if (!SAFE_TOOL_NAME.test(tool.name) || JSON.stringify(tool.inputSchema).length > 20_000) return [];
        const claimedReadOnly = tool.annotations?.readOnlyHint === true;
        return [{
          serverId: server.id,
          serverName: server.name,
          name: tool.name,
          namespacedName: `mcp__${server.name}__${tool.name}`,
          description: tool.description?.slice(0, 2_000) ?? "",
          inputSchema: tool.inputSchema as Record<string, unknown>,
          claimedReadOnly,
          readOnly: claimedReadOnly && trustedReadOnlyTools.has(tool.name),
        }];
      });
      this.probedTools.set(server.id, tools);
      const connection = { client, transport, tools, dispatcher };
      if (server.enabled && !probeOnly) {
        this.connections.set(server.id, connection);
        this.repository.setMcpServerStatus(server.id, "available", null);
      }
      return connection;
    } catch (error) {
      await client.close().catch(() => undefined);
      await dispatcher?.close().catch(() => undefined);
      if (error instanceof AevorenBotError && error.code === "MCP_AUTH_STORAGE_INVALID") {
        this.repository.setMcpServerStatus(server.id, "needs-auth", error.code);
        throw error;
      }
      const code = classifyConnectionError(error);
      this.repository.setMcpServerStatus(server.id, code === "MCP_AUTH_REQUIRED" ? "needs-auth" : "unavailable", code);
      throw new AevorenBotError(code);
    }
  }

  private transport(
    server: McpServerConfig,
    safeTarget: SafeNetworkTarget | null,
    authProvider?: OAuthClientProvider,
    allowLoopbackAuthorization = false,
  ): Pick<Connection, "transport" | "dispatcher"> {
    const secrets = this.readSecrets(server.id);
    if (server.transport === "stdio") {
      const command = typeof server.config.command === "string" ? server.config.command : "";
      if (!command) throw new AevorenBotError("INVALID_REQUEST");
      return { transport: new StdioClientTransport({
        command,
        args: stringArray(server.config.args),
        env: { ...getDefaultEnvironment(), ...secrets },
        stderr: "ignore",
        maxBufferSize: 1_048_576,
      }), dispatcher: null };
    }
    const url = typeof server.config.url === "string" ? server.config.url : "";
    if (!url) throw new AevorenBotError("INVALID_REQUEST");
    if (!safeTarget) throw new AevorenBotError("MCP_SERVER_UNAVAILABLE");
    const dispatcher = new Agent({ connect: { lookup: createPinnedLookup(safeTarget) } });
    const requestSecrets = { ...secrets };
    if (this.hasOAuthTokens(server.id)) {
      for (const key of Object.keys(requestSecrets)) if (key.toLowerCase() === "authorization") delete requestSecrets[key];
    }
    const fetchPinned = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const target = new URL(input.toString());
      if (target.origin !== safeTarget.url.origin) {
        const headers = new Headers(init?.headers);
        for (const [key, value] of Object.entries(secrets)) {
          if (headers.get(key) === value) headers.delete(key);
        }
        return fetchPinnedBuffered(target, { ...(init ?? {}), headers }, allowLoopbackAuthorization);
      }
      const response = await undiciFetch(target, {
        ...(init ?? {}),
        redirect: "error",
        dispatcher,
      } as Parameters<typeof undiciFetch>[1]);
      return response as unknown as Response;
    };
    return { transport: new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: new Headers(requestSecrets) },
      fetch: fetchPinned,
      authProvider,
      reconnectionOptions: {
        initialReconnectionDelay: 500,
        maxReconnectionDelay: 2_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 1,
      },
    }), dispatcher };
  }

  private info(server: McpServerConfig): McpServerInfo {
    return {
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.transport === "stdio" && typeof server.config.command === "string" ? server.config.command : null,
      args: server.transport === "stdio" ? stringArray(server.config.args) : [],
      url: server.transport === "streamable-http" && typeof server.config.url === "string" ? server.config.url : null,
      secretKeys: server.transport === "stdio" ? stringArray(server.config.envKeys) : stringArray(server.config.headerKeys),
      oauthConfigured: this.hasOAuthTokens(server.id),
      authenticating: this.authorizingIds.has(server.id),
      trustedReadOnlyTools: stringArray(server.config.trustedReadOnlyTools),
      enabled: server.enabled,
      status: server.enabled ? server.lastStatus : "disabled",
      lastErrorCode: server.lastErrorCode,
      lastConnectedAt: server.lastConnectedAt,
      version: server.version,
      tools: this.probedTools.get(server.id) ?? [],
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
    };
  }

  private readSecrets(id: string): Record<string, string> {
    const setting = this.repository.getSetting(secretKey(id));
    if (!setting) return {};
    if (!setting.encrypted || !this.secretCodec.isAvailable()) throw new AevorenBotError("SECURE_STORAGE_UNAVAILABLE");
    try {
      const parsed = object(JSON.parse(this.secretCodec.decrypt(setting.value)));
      if (!parsed || Object.values(parsed).some((value) => typeof value !== "string")) throw new Error("invalid");
      return parsed as Record<string, string>;
    } catch {
      throw new AevorenBotError("SECURE_STORAGE_UNAVAILABLE");
    }
  }

  private readOAuth(id: string): McpOAuthRecord {
    const setting = this.repository.getSetting(oauthKey(id));
    if (!setting) return {};
    if (!setting.encrypted || !this.secretCodec.isAvailable()) throw new AevorenBotError("MCP_AUTH_STORAGE_INVALID");
    try {
      return parseMcpOAuthRecord(this.secretCodec.decrypt(setting.value));
    } catch (error) {
      if (error instanceof AevorenBotError) throw error;
      throw new AevorenBotError("MCP_AUTH_STORAGE_INVALID");
    }
  }

  private writeOAuth(id: string, record: McpOAuthRecord): void {
    if (!this.secretCodec.isAvailable()) throw new AevorenBotError("SECURE_STORAGE_UNAVAILABLE");
    this.repository.setSetting(oauthKey(id), this.secretCodec.encrypt(JSON.stringify(record)), true);
  }

  private hasOAuthTokens(id: string): boolean {
    try {
      return Boolean(this.readOAuth(id).tokens?.access_token);
    } catch {
      return false;
    }
  }

  private oauthProvider(
    server: McpServerConfig,
    redirectUrl: URL,
    state: string,
    interactive: boolean,
    allowLoopbackAuthorization: boolean,
  ): McpOAuthProvider {
    return new McpOAuthProvider({
      appVersion: this.appVersion,
      redirectUrl,
      state,
      interactive,
      allowLoopbackAuthorization,
      store: {
        read: () => this.readOAuth(server.id),
        write: (record) => this.writeOAuth(server.id, record),
      },
      openAuthorization: async (url) => this.openExternal(url.toString()),
    });
  }

  private writeSecrets(id: string, secrets: Record<string, string>): void {
    if (!this.secretCodec.isAvailable()) {
      if (Object.keys(secrets).length > 0) throw new AevorenBotError("SECURE_STORAGE_UNAVAILABLE");
      return;
    }
    this.repository.setSetting(secretKey(id), this.secretCodec.encrypt(JSON.stringify(secrets)), true);
  }

  private async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.connections.delete(id);
    await connection.client.close().catch(() => undefined);
    await connection.dispatcher?.close().catch(() => undefined);
  }
}
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
