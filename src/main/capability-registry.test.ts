import { afterEach, describe, expect, it } from "vitest";
import type { McpServerInfo, McpToolInfo, PromptManifest, ProviderInstanceInfo } from "@shared/contracts";
import type { TaskExecutorSelection } from "@shared/task-session-contracts";
import { randomUUID } from "node:crypto";
import { AppRepository } from "./database";
import { CapabilityRegistry } from "./capability-registry";

const repositories: AppRepository[] = [];

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
});

function provider(): ProviderInstanceInfo {
  return {
    id: "openai-compatible.default",
    driverKind: "openai-compatible",
    displayName: "Fixture Provider",
    access: "cloud",
    enabled: true,
    version: 1,
    status: "available",
    reason: null,
    authenticated: true,
    runtimeVersion: null,
    discoveryMode: "not-applicable",
    lastScannedAt: null,
    cliPath: null,
    cliDefault: null,
    manualCliPath: null,
    apiKeyConfigured: true,
    baseUrl: "https://secret.example/v1",
    models: { default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture Model" }] },
    capabilities: { roomOwnerSelection: true, handoff: true, workspaceTools: true, networkTools: true },
  };
}

describe("CapabilityRegistry", () => {
  it("keeps an empty TASK capability scope out of global connections, private context and product families", async () => {
    const repository = new AppRepository(":memory:"); repositories.push(repository);
    repository.setDefaultModelSelection({ providerInstanceId: "openai-compatible.default", modelId: "fixture-model" });
    const registered = repository.registerWorkspaceRoot("/private/task-capability-root", "Private workspace"), created = repository.createBot(registered.project.id);
    repository.createMemory(created.bot.id, "PRIVATE_MEMORY");
    const selection: TaskExecutorSelection = { executorBotId: created.bot.id, memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: [], network: false, clipboard: false };
    const task = repository.tasks.create({ parentSessionId: created.session.id, expectedScopeVersion: repository.tasks.scopeVersion(created.session.id), clientNonce: randomUUID(), title: "Empty task", selections: [selection] });
    const current = provider(), other = { ...provider(), id: "other-provider-private", displayName: "PRIVATE_PROVIDER" };
    const registry = new CapabilityRegistry(repository, { list: async () => [current, other], getCached: () => current, getCapabilities: () => current.capabilities },
      { name: "Aevoren Bot", version: "39", platform: "darwin", architecture: "arm64", packaged: false });
    const snapshot = await registry.getSnapshot({ sessionId: task.session.id });
    expect(snapshot.model.providerInstanceId).toBe(created.bot.modelSelection.providerInstanceId);
    expect(snapshot.connections.map(item => item.id)).toEqual([current.id]); expect(snapshot.workspaceCount).toBe(0);
    for (const id of ["project.provisioning", "network.search", "network.realtime-data", "device.clipboard", "mcp.client", "media.documents", "media.audio-video", "media.tool-images", "library.documents", "skills.text", "skills.scripts", "voice.transcription", "voice.speech", "voice.realtime", "environment.execution", "computer.control", "automation.scheduler", "memory.manual"]) {
      expect(snapshot.capabilities.find(item => item.id === id)?.availability, id).not.toBe("available");
    }
    expect(snapshot.availableTools).toEqual(["product_catalog", "text_measure"]);
    expect(snapshot.capabilities.find(item => item.id === "product.operations")?.description).toContain("未选择可执行");
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_PROVIDER"); expect(snapshot.backgroundMode).toBe("foreground-only");
    const main = await registry.getSnapshot({ botId: created.bot.id, sessionId: created.session.id });
    expect(main.connections).toHaveLength(2); expect(main.availableTools).toContain("bot_create"); expect(main.availableTools).toContain("web_search"); expect(main.workspaceCount).toBe(1);
    const peer = repository.createBot(), room = repository.createRoom({ memberBotIds: [created.bot.id, peer.bot.id] });
    const roomTask = repository.tasks.create({ parentSessionId: room.session.id, expectedScopeVersion: repository.tasks.scopeVersion(room.session.id), clientNonce: randomUUID(), title: "Explicit actor", selections: [selection] });
    await expect(registry.getSnapshot({ sessionId: roomTask.session.id })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(registry.getSnapshot({ sessionId: roomTask.session.id, botId: peer.bot.id })).rejects.toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
  });

  it("advertises exactly selected MCP identities and independent clipboard, network and product ceilings", async () => {
    const repository = new AppRepository(":memory:"); repositories.push(repository);
    repository.setDefaultModelSelection({ providerInstanceId: "openai-compatible.default", modelId: "fixture-model" });
    const created = repository.createBot(), current = provider();
    const saved = repository.createMcpServerConfig("Selected MCP", "streamable-http", { url: "http://127.0.0.1:1/mcp" });
    const server = repository.setMcpServerEnabled(saved.id, saved.version, true), privateId = randomUUID();
    let identity = "a".repeat(64); repository.tasks.setMcpIdentityReader(() => ({ version: server.version, identityDigest: identity }));
    const selected: TaskExecutorSelection = { executorBotId: created.bot.id, memories: [], history: [], workspaces: [], mcp: [{ serverId: server.id, expectedVersion: server.version, toolNames: ["selected_read"] }], resourceRefs: [], mediaRefs: [], productOperations: ["library.read", "bots.create"], network: false, clipboard: true };
    const task = repository.tasks.create({ parentSessionId: created.session.id, expectedScopeVersion: repository.tasks.scopeVersion(created.session.id), clientNonce: randomUUID(), title: "Selected task", selections: [selected] });
    const mcpTool = (serverId: string, name: string): McpToolInfo => ({ serverId, serverName: serverId === server.id ? "Selected MCP" : "PRIVATE_MCP", name, namespacedName: `mcp_${name}`, description: name, inputSchema: {}, claimedReadOnly: true, readOnly: true });
    const tools = [mcpTool(server.id, "selected_read"), mcpTool(server.id, "not_selected"), mcpTool(privateId, "private_read")];
    const mcpServer = (id: string, name: string): McpServerInfo => ({ id, name, transport: "streamable-http", command: null, args: [], url: "http://127.0.0.1:1/mcp", secretKeys: [], oauthConfigured: false, authenticating: false, trustedReadOnlyTools: [], enabled: true, status: "available", lastErrorCode: null, lastConnectedAt: null, version: server.version, tools: tools.filter(tool => tool.serverId === id), createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z" });
    const registry = new CapabilityRegistry(repository, { list: async () => [current], getCached: () => current, getCapabilities: () => current.capabilities },
      { name: "Aevoren Bot", version: "39", platform: "darwin", architecture: "arm64", packaged: false }, undefined,
      { list: () => [mcpServer(server.id, "Selected MCP"), mcpServer(privateId, "PRIVATE_MCP")], availableTools: () => tools });
    const snapshot = await registry.getSnapshot({ botId: created.bot.id, sessionId: task.session.id });
    expect(snapshot.availableTools).toContain("mcp_selected_read"); expect(snapshot.availableTools).toContain("clipboard_read");
    expect(snapshot.availableTools).not.toContain("web_search"); expect(snapshot.availableTools).not.toContain("mcp_not_selected"); expect(snapshot.availableTools).not.toContain("mcp_private_read");
    expect(snapshot.connections.map(item => item.id)).toEqual([current.id, server.id]); expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_MCP");
    expect(snapshot.capabilities.find(item => item.id === "library.documents")?.availability).toBe("available");
    expect(snapshot.capabilities.find(item => item.id === "media.documents")?.availability).toBe("unavailable");
    expect(snapshot.capabilities.find(item => item.id === "product.operations")?.description).toContain("library.read");
    expect(snapshot.capabilities.find(item => item.id === "product.operations")?.description).not.toContain("bots.create");
    identity = "b".repeat(64); await expect(registry.getSnapshot({ botId: created.bot.id, sessionId: task.session.id })).rejects.toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
  });

  it("pins retry prompt capabilities to the original Runtime selection while interactive snapshots use the latest revision", async () => {
    const repository = new AppRepository(":memory:"); repositories.push(repository);
    repository.setDefaultModelSelection({ providerInstanceId: "openai-compatible.default", modelId: "fixture-model" });
    const registered = repository.registerWorkspaceRoot("/private/task-retry-root", "Retry workspace"), created = repository.createBot(registered.project.id), current = provider();
    const selected: TaskExecutorSelection = { executorBotId: created.bot.id, memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: [], network: false, clipboard: false };
    const task = repository.tasks.create({ parentSessionId: created.session.id, expectedScopeVersion: repository.tasks.scopeVersion(created.session.id), clientNonce: randomUUID(), title: "Retry task", selections: [selected] });
    const nonce = randomUUID(); repository.prepareMessage({ sessionId: task.session.id, clientNonce: nonce, text: "Original task" });
    const user = repository.getUserMessage(nonce), manifest: PromptManifest = { schemaVersion: 1, botId: created.bot.id, profileVersion: 1, sessionId: task.session.id, generation: user.generation, inputSeq: user.seq, blocks: [], digest: "original" };
    const run = repository.createRuntimeRun(nonce, "fake", manifest, { executorBotId: created.bot.id });
    repository.tasks.reviseSelection({ sessionId: task.session.id, expectedVersion: task.version, selections: [{ ...selected, network: true, clipboard: true, productOperations: ["library.read"], workspaces: [{ id: registered.workspace.id, read: true, write: false, automation: false }] }] });
    const registry = new CapabilityRegistry(repository, { list: async () => [current], getCached: () => current, getCapabilities: () => current.capabilities },
      { name: "Aevoren Bot", version: "39", platform: "darwin", architecture: "arm64", packaged: false });
    const latest = await registry.getSnapshot({ botId: created.bot.id, sessionId: task.session.id }); expect(latest.availableTools).toContain("web_search"); expect(latest.workspaceCount).toBe(1);
    const pinned = registry.forPrompt(created.bot.id, created.bot.modelSelection, false, task.session.id, run.id);
    expect(pinned.availableTools).not.toContain("web_search"); expect(pinned.availableTools).not.toContain("clipboard_read"); expect(pinned.availableTools).not.toContain("workspace_read"); expect(pinned.availableTools).not.toContain("product_execute");
    expect(pinned.capabilities.find(item => item.id === "library.documents")?.availability).toBe("unavailable");
  });
  it("reports media pixel transport independently of a running browser and leaves model vision unconfirmed", async () => {
    const repository = new AppRepository(":memory:"); repositories.push(repository);
    const actor = repository.createBot(), current = provider(); current.capabilities.toolImageInput = true;
    const registry = new CapabilityRegistry(repository, { list: async () => [current], getCached: () => current, getCapabilities: () => current.capabilities },
      { name: "Aevoren Bot", version: "1", platform: "darwin", architecture: "arm64", packaged: false });
    const snapshot = () => registry.getSnapshot({ botId: actor.bot.id, sessionId: actor.session.id });
    const first = await snapshot();
    expect(first.capabilities.find(item => item.id === "media.tool-images")).toMatchObject({ availability: "available", description: expect.stringContaining("不代表所选模型") });
    expect(first.capabilities.find(item => item.id === "browser.tool-images")).toMatchObject({ availability: "unavailable" });
    current.capabilities.toolImageInput = false;
    expect((await snapshot()).capabilities.find(item => item.id === "media.tool-images")).toMatchObject({ availability: "unavailable" });
    expect((await snapshot()).capabilities.find(item => item.id === "media.documents")).toMatchObject({ availability: "available" });
  });

  it("reports scoped MCP permission only for the current executor and live connection credential", async () => {
    const repository = new AppRepository(":memory:"); repositories.push(repository);
    const actor = repository.createBot(), peer = repository.createBot(), current = provider(); let credential = "a".repeat(64);
    const registry = new CapabilityRegistry(repository, { list: async () => [current], getCached: () => current, getCapabilities: () => current.capabilities },
      { name: "Aevoren Bot", version: "1", platform: "darwin", architecture: "arm64", packaged: false }, undefined,
      { list: () => [], availableTools: () => [], scopedCredentialDigest: () => credential });
    const scope = { sessionId: actor.session.id, executorBotId: actor.bot.id };
    const saved = repository.createMcpServerConfig("scoped", "streamable-http", { url: "http://127.0.0.1:1/mcp" });
    const server = repository.setMcpServerEnabled(saved.id, saved.version, true);
    const state = async (sessionId = scope.sessionId) => (await registry.getSnapshot({ botId: actor.bot.id, sessionId })).capabilities.find(item => item.id === "mcp.scoped-tools");
    expect(await state()).toMatchObject({ permissionState: "not-granted" });
    const grant = repository.mcpWrites.grant({ ...scope, serverId: server.id, expectedServerVersion: server.version, toolName: "change", schemaDigest: "b".repeat(64) }, credential);
    expect(await state()).toMatchObject({ permissionState: "granted", availability: "available" });
    const room = repository.createRoom({ memberBotIds: [actor.bot.id, peer.bot.id] });
    expect(await state(room.session.id)).toMatchObject({ permissionState: "not-granted" });
    credential = "c".repeat(64); expect(await state()).toMatchObject({ permissionState: "not-granted" });
    credential = "a".repeat(64); repository.mcpWrites.revoke({ ...scope, id: grant.id, expectedVersion: grant.version });
    expect(await state()).toMatchObject({ permissionState: "not-granted" });
  });
  it("advertises native writing only for the selected executor's current explicit grant", async () => {
    const repository = new AppRepository(":memory:"); repositories.push(repository);
    const actor = repository.createBot(), peer = repository.createBot(), current = provider();
    const registry = new CapabilityRegistry(repository, { list: async () => [current], getCached: () => current, getCapabilities: () => current.capabilities },
      { name: "Aevoren Bot", version: "1", platform: "darwin", architecture: "arm64", packaged: false });
    const scope = { sessionId: actor.session.id, executorBotId: actor.bot.id };
    const writing = async (sessionId = scope.sessionId) => (await registry.getSnapshot({ botId: actor.bot.id, sessionId })).capabilities.find(item => item.id === "apps.write");
    const configured = repository.connectors.configure({ provider: "notion", name: "Scoped writing", token: "fixture" }, "sealed-config");
    const pending = repository.connectors.beginAuthorization({ id: configured.id, expectedVersion: configured.version });
    const connected = repository.connectors.completeAuthorization(pending.id, pending.authVersion, { accountId: "fixture-account", displayName: "Fixture" }, ["read"], [], "sealed-credentials");
    expect(await writing()).toMatchObject({ availability: "unavailable", permissionState: "not-granted" });
    const grant = repository.outbound.grant({ ...scope, connectionId: connected.id, expectedAuthVersion: connected.authVersion, operation: "notion-create-page", targetIds: [crypto.randomUUID()] });
    expect(await writing()).toMatchObject({ availability: "available", permissionState: "granted" });
    const room = repository.createRoom({ memberBotIds: [actor.bot.id, peer.bot.id], leadBotId: null });
    expect(await writing(room.session.id)).toMatchObject({ availability: "unavailable", permissionState: "not-granted" });
    repository.outbound.revoke({ ...scope, id: grant.id, expectedVersion: grant.version });
    expect(await writing()).toMatchObject({ availability: "unavailable", permissionState: "not-granted" });
  });
  it("requires a current native grant and keeps private connection permission out of a Room", async () => {
    const repository = new AppRepository(":memory:"); repositories.push(repository);
    const actor = repository.createBot(), peer = repository.createBot();
    const current = provider();
    const registry = new CapabilityRegistry(repository, { list: async () => [current], getCached: () => current, getCapabilities: () => current.capabilities },
      { name: "Aevoren Bot", version: "1", platform: "darwin", architecture: "arm64", packaged: false });
    const selection = { botId: actor.bot.id, sessionId: actor.session.id };
    const capability = async (input = selection) => (await registry.getSnapshot(input)).capabilities.find(item => item.id === "apps.read");
    const configured = repository.connectors.configure({ provider: "notion", name: "Fixture shared pages", token: "fixture" }, "encrypted-config");
    const pending = repository.connectors.beginAuthorization({ id: configured.id, expectedVersion: configured.version });
    const connected = repository.connectors.completeAuthorization(pending.id, pending.authVersion, { accountId: "fixture-account", displayName: "Fixture" }, ["read"], [], "encrypted-credentials");
    expect(await capability()).toMatchObject({ availability: "unavailable", permissionState: "not-granted" });
    repository.connectors.bind({ sessionId: actor.session.id, executorBotId: actor.bot.id, connectionId: connected.id, expectedAuthVersion: connected.authVersion });
    expect(await capability()).toMatchObject({ availability: "available", permissionState: "granted" });
    const room = repository.createRoom({ name: "Separate grants", memberBotIds: [actor.bot.id, peer.bot.id], leadBotId: null });
    expect(await capability({ botId: actor.bot.id, sessionId: room.session.id })).toMatchObject({ availability: "unavailable", permissionState: "not-granted" });
    repository.connectors.revoke({ id: connected.id, expectedVersion: connected.version });
    expect(await capability()).toMatchObject({ availability: "unavailable", permissionState: "not-granted" });
  });
  it("advertises only the limited adapter's actual host tools, not unrelated capabilities", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const registered = repository.registerWorkspaceRoot("/private/tmp/limited-tool-scope", "限定工作区");
    const bot = repository.createBot(registered.project.id).bot;
    const current = provider();
    current.capabilities = { roomOwnerSelection: false, handoff: false, workspaceTools: true, networkTools: true, supportedToolNames: ["workspace_list", "workspace_read", "workspace_search", "workspace_write", "web_search", "web_fetch"] };
    const workspace = registered.workspace;
    repository.updateWorkspacePermissions(workspace.id, workspace.version, { writeEnabled: true, automationEnabled: false });
    const registry = new CapabilityRegistry(repository, { list: async () => [current], getCached: () => current, getCapabilities: () => current.capabilities }, { name: "Aevoren Bot", version: "1", platform: "darwin", architecture: "arm64", packaged: false });
    const snapshot = await registry.getSnapshot({ botId: bot.id });
    expect(snapshot.availableTools).toEqual(["workspace_list", "workspace_read", "workspace_search", "workspace_write", "web_search", "web_fetch"]);
    for (const id of ["project.provisioning", "computation.text-measure", "network.realtime-data", "device.clipboard"]) expect(snapshot.capabilities.find(capability => capability.id === id)?.availability).toBe("unavailable");
  });

  it("reports authoritative model, permission and unsupported capability state without exposing paths or secrets", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    const bot = repository.updateBot(created.bot.id, created.bot.version, {
      modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "fixture-model" },
    });
    const currentProvider = provider();
    const providers = {
      list: async () => [currentProvider],
      getCached: () => currentProvider,
      getCapabilities: () => currentProvider.capabilities,
    };
    const registry = new CapabilityRegistry(repository, providers, {
      name: "Aevoren Bot",
      version: "1.2.3",
      platform: "darwin",
      architecture: "arm64",
      packaged: true,
    }, () => new Date("2026-09-17T08:00:00.000Z"));

    const beforeGrant = await registry.getSnapshot({ botId: bot.id });
    expect(beforeGrant).toMatchObject({
      generatedAt: "2026-09-17T08:00:00.000Z",
      app: { version: "1.2.3", platform: "darwin", architecture: "arm64", packaged: true },
      model: { providerName: "Fixture Provider", providerStatus: "available", modelId: "fixture-model" },
      workspaceCount: 0,
      backgroundMode: "foreground-only",
    });
    expect(beforeGrant.capabilities.find((item) => item.id === "workspace.read")).toMatchObject({
      availability: "permission-required",
      permissionState: "not-granted",
      toolNames: [],
    });
    expect(beforeGrant.capabilities.find((item) => item.id === "network.search")).toMatchObject({
      availability: "available",
      adapterKind: "connector",
    });

    const registered = repository.registerWorkspaceRoot("/private/tmp/capability-secret-root", "Fixture Workspace");
    repository.setConversationProject(created.session.id, registered.project.id, repository.getConversation(created.session.id).version);
    const afterGrant = await registry.getSnapshot({ botId: bot.id });
    expect(afterGrant.availableTools).toEqual([
      "product_catalog", "product_describe", "product_execute",
      "project_list_bots", "bot_create", "room_create",
      "text_measure", "workspace_list", "workspace_read", "workspace_search", "web_search", "web_fetch", "time_now", "weather_current", "clipboard_read",
    ]);
    expect(afterGrant.permissions[0]).toMatchObject({ state: "granted", scopeSummary: "1 个已授权文件夹" });

    const prompt = registry.forPrompt(bot.id, bot.modelSelection, true);
    expect(prompt.availableTools).toEqual([
      "product_catalog", "product_describe", "product_execute",
      "project_list_bots", "bot_create", "room_create",
      "handoff_to_agent", "text_measure", "workspace_list", "workspace_read", "workspace_search", "web_search", "web_fetch", "time_now", "weather_current", "clipboard_read",
    ]);
    const serialized = JSON.stringify(prompt);
    expect(serialized).not.toContain("capability-secret-root");
    expect(serialized).not.toContain("secret.example");
    expect(serialized).not.toContain("API Key");
  });

  it("does not claim model-driven Handoff for a text-only provider", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    const currentProvider = { ...provider(), capabilities: { roomOwnerSelection: false, handoff: false, workspaceTools: false, networkTools: false } };
    const registry = new CapabilityRegistry(repository, {
      list: async () => [currentProvider],
      getCached: () => currentProvider,
      getCapabilities: () => currentProvider.capabilities,
    }, { name: "Aevoren Bot", version: "1.2.3", platform: "darwin", architecture: "arm64", packaged: true });

    const snapshot = await registry.getSnapshot({ botId: created.bot.id });
    expect(snapshot.capabilities.find((item) => item.id === "room.collaboration")).toMatchObject({
      availability: "available",
      reason: "当前模型来源支持固定成员独立回复，不支持内部 Handoff；所有人仍可并行。",
      toolNames: [],
    });
  });
});
