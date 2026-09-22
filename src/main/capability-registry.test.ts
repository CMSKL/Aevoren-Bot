import { afterEach, describe, expect, it } from "vitest";
import type { ProviderInstanceInfo } from "@shared/contracts";
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

    repository.registerWorkspaceRoot("/private/tmp/capability-secret-root", "Fixture Workspace");
    const afterGrant = await registry.getSnapshot({ botId: bot.id });
    expect(afterGrant.availableTools).toEqual([
      "text_measure", "workspace_list", "workspace_read", "workspace_search", "web_search", "web_fetch", "time_now", "weather_current", "clipboard_read",
    ]);
    expect(afterGrant.permissions[0]).toMatchObject({ state: "granted", scopeSummary: "1 个已授权文件夹" });

    const prompt = registry.forPrompt(bot.id, bot.modelSelection, true);
    expect(prompt.availableTools).toEqual([
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
      reason: "当前模型来源仅支持顺序群聊和显式目标。",
      toolNames: [],
    });
  });
});
