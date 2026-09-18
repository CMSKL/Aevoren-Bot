import type { ProviderDriverKind, ProviderInstanceInfo } from "@shared/contracts";

export type ProviderDisplayState = "ready" | "not-installed" | "signed-out" | "unavailable" | "unconfigured";

const providerMarks: Partial<Record<ProviderDriverKind, string>> = {
  "openai-compatible": "API",
  "codex-cli": "CX",
  "claude-cli": "CL",
  "ollama-cli": "OL",
};

function initials(displayName: string): string {
  const words = displayName.trim().split(/[\s_-]+/u).filter(Boolean);
  if (words.length > 1) return words.map((word) => word[0]).join("").slice(0, 2).toLocaleUpperCase();
  return displayName.trim().slice(0, 2).toLocaleUpperCase() || "AI";
}

export function providerMarkText(provider: ProviderInstanceInfo): string {
  return providerMarks[provider.driverKind] ?? initials(provider.displayName);
}

export function providerDisplayState(provider: ProviderInstanceInfo): ProviderDisplayState {
  if (provider.status === "available") return "ready";
  if (provider.driverKind === "openai-compatible") return provider.apiKeyConfigured ? "unavailable" : "unconfigured";
  if (!provider.cliPath) return "not-installed";
  if (!provider.authenticated) return /(?:尚未|未)登录/u.test(provider.reason ?? "") ? "signed-out" : "unavailable";
  return "unavailable";
}

export function providerStateLabel(provider: ProviderInstanceInfo): string {
  const labels: Record<ProviderDisplayState, string> = {
    ready: "可用",
    "not-installed": "未安装",
    "signed-out": "未登录",
    unavailable: "不可用",
    unconfigured: "待配置",
  };
  return labels[providerDisplayState(provider)];
}

export function providerSubtitle(provider: ProviderInstanceInfo): string {
  if (provider.driverKind === "openai-compatible") return "兼容 API · 手动兜底";
  if (provider.driverKind === "ollama-cli") return "本地模型引擎";
  if (provider.driverKind === "acp-cli") return `${provider.access === "local" ? "本地" : "云端"} ACP 引擎`;
  return `${provider.access === "local" ? "本地" : "云端"} CLI`;
}
