import { expect, it } from "vitest";
import type { Bot, ProviderInstanceInfo } from "@shared/contracts";
import { eligibleRoomLeads } from "./room-leads";

const provider: ProviderInstanceInfo = {
  id: "api", driverKind: "openai-compatible", displayName: "API", access: "cloud", enabled: true,
  version: 1, status: "available", reason: null, authenticated: true, runtimeVersion: null,
  discoveryMode: "manual", lastScannedAt: null, cliPath: null, cliDefault: null, manualCliPath: null,
  apiKeyConfigured: true, baseUrl: null, models: { default: "model", options: [{ id: "model", label: "Model" }] },
  capabilities: { roomOwnerSelection: true, handoff: true, workspaceTools: true },
};

const bot = { id: "bot", modelSelection: { providerInstanceId: "api", modelId: "model" } } as Bot;

it("offers only coordinator selections accepted by the IPC model availability guard", () => {
  expect(eligibleRoomLeads([bot], [provider])).toEqual([bot]);
  for (const unavailable of [
    { ...provider, enabled: false },
    { ...provider, status: "unavailable" as const },
    { ...provider, capabilities: { ...provider.capabilities, handoff: false } },
    { ...provider, models: { default: "other", options: [{ id: "other", label: "Other" }] } },
  ]) expect(eligibleRoomLeads([bot], [unavailable])).toEqual([]);
  expect(eligibleRoomLeads([bot], [])).toEqual([]);
  expect(eligibleRoomLeads([{ ...bot, modelSelection: { ...bot.modelSelection, modelId: "" } }], [provider])).toEqual([]);
});
