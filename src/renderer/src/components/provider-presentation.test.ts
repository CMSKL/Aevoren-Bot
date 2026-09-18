import { describe, expect, it } from "vitest";
import type { ProviderInstanceInfo } from "@shared/contracts";
import { providerDisplayState, providerStateLabel } from "./provider-presentation";

function provider(overrides: Partial<ProviderInstanceInfo> = {}): ProviderInstanceInfo {
  return {
    id: "codex.default",
    driverKind: "codex-cli",
    displayName: "Codex CLI",
    access: "cloud",
    enabled: true,
    version: 1,
    status: "unavailable",
    reason: null,
    authenticated: false,
    runtimeVersion: null,
    discoveryMode: "automatic",
    lastScannedAt: null,
    cliPath: null,
    cliDefault: "codex",
    manualCliPath: null,
    apiKeyConfigured: false,
    baseUrl: null,
    models: { default: "", options: [] },
    capabilities: { roomOwnerSelection: false, handoff: false, workspaceTools: false },
    ...overrides,
  };
}

describe("provider presentation state", () => {
  it.each([
    [provider({ status: "available", authenticated: true, cliPath: "/bin/codex" }), "ready", "可用"],
    [provider(), "not-installed", "未安装"],
    [provider({ cliPath: "/bin/codex", reason: "Codex CLI 尚未登录。" }), "signed-out", "未登录"],
    [provider({ cliPath: "/bin/codex", reason: "CLI 无法启动或协议不兼容。" }), "unavailable", "不可用"],
    [provider({ cliPath: "/bin/codex", authenticated: true }), "unavailable", "不可用"],
    [provider({ driverKind: "openai-compatible", cliDefault: null }), "unconfigured", "待配置"],
  ] as const)("maps runtime facts to %s", (instance, state, label) => {
    expect(providerDisplayState(instance)).toBe(state);
    expect(providerStateLabel(instance)).toBe(label);
  });
});
