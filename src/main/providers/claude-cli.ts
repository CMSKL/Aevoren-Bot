import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { structuredModelToolDefinitions, type ChatMessage, type ModelEvent, type ModelProvider, type ModelRunContext } from "../model";
import { AevorenBotError } from "../errors";
import { ClaudeToolBridge } from "./claude-tool-bridge";
import { cliEnvironment, cliShellOptions, probeCliVersion, resolveCliPath } from "./cli-utils";

const execFileAsync = promisify(execFile);
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/iu;
const REUSABLE_CLAUDE_ENVIRONMENT_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]);

const FALLBACK_CLAUDE_MODELS = {
  default: "sonnet",
  options: [
    { id: "sonnet", label: "Claude Sonnet" },
    { id: "opus", label: "Claude Opus" },
    { id: "fable", label: "Claude Fable" },
    { id: "haiku", label: "Claude Haiku" },
  ],
} as const;

export type ClaudeCliInspection = {
  path: string;
  version: string;
  authenticated: boolean;
  hostToolsSupported: boolean;
  models: {
    default: string;
    options: Array<{ id: string; label: string; provider?: string; custom?: boolean }>;
  };
};

function claudeEnvironment(hostTools = false): NodeJS.ProcessEnv {
  const environment = cliEnvironment();
  Object.assign(environment, claudeReusableEnvironment(process.env));
  if (hostTools) delete environment.CLAUDE_CODE_SAFE_MODE;
  else environment.CLAUDE_CODE_SAFE_MODE = "1";
  environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  delete environment.CLAUDECODE;
  delete environment.CLAUDE_CODE_ENTRYPOINT;
  return environment;
}

function claudeReusableEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const reusable: NodeJS.ProcessEnv = {};
  for (const key of REUSABLE_CLAUDE_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (typeof value === "string" && value.length <= 16_384) reusable[key] = value;
  }
  const configDirectory = environment.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(join(configDirectory, "settings.json"), "utf8"));
  } catch {
    return reusable;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return reusable;
  const source = (settings as { env?: unknown }).env;
  if (!source || typeof source !== "object" || Array.isArray(source)) return reusable;
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (REUSABLE_CLAUDE_ENVIRONMENT_KEYS.has(key) && typeof value === "string" && value.length <= 16_384) {
      reusable[key] = value;
    }
  }
  return reusable;
}

function configuredModels(environment: NodeJS.ProcessEnv): Array<{ id: string; label: string; provider?: string; custom?: boolean }> {
  const configDirectory = environment.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(join(configDirectory, "settings.json"), "utf8"));
  } catch {
    return [];
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [];
  const record = settings as Record<string, unknown>;
  const nestedEnvironment = record.env && typeof record.env === "object" && !Array.isArray(record.env)
    ? record.env as Record<string, unknown>
    : {};
  const values = [record.availableModels, record.customModels, record.extraModels];
  const baseUrl = nestedEnvironment.ANTHROPIC_BASE_URL ?? environment.ANTHROPIC_BASE_URL;
  let provider: string | undefined;
  if (typeof baseUrl === "string") {
    try {
      provider = new URL(baseUrl).hostname;
    } catch {
      provider = "custom";
    }
  }
  const models: Array<{ id: string; label: string; provider?: string; custom?: boolean }> = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" && MODEL_ID.test(value) && !models.some((model) => model.id === value)) {
      models.push({ id: value, label: value, ...(provider ? { provider, custom: true } : {}) });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const row = value as Record<string, unknown>;
    const id = [row.id, row.model, row.slug].find((candidate): candidate is string => (
      typeof candidate === "string" && MODEL_ID.test(candidate)
    ));
    if (!id || models.some((model) => model.id === id)) return;
    const label = [row.name, row.displayName, row.label].find((candidate): candidate is string => (
      typeof candidate === "string" && candidate.trim().length > 0
    ));
    models.push({ id, label: label?.trim() || id, ...(provider ? { provider, custom: true } : {}) });
  };
  for (const value of values) if (Array.isArray(value)) value.forEach(add);
  add(nestedEnvironment.ANTHROPIC_MODEL ?? environment.ANTHROPIC_MODEL);
  for (const key of [
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
  ]) add(nestedEnvironment[key] ?? environment[key]);
  return models;
}

export async function inspectClaudeCli(cliCommand: string): Promise<ClaudeCliInspection> {
  const probe = await probeCliVersion(cliCommand);
  const environment = claudeEnvironment();
  const authenticated = await (async (): Promise<boolean> => {
    try {
      const result = await execFileAsync(probe.path, ["auth", "status", "--json"], {
        env: environment,
        timeout: 8_000,
        maxBuffer: 64 * 1024,
        ...cliShellOptions(probe.path),
      });
      const status = JSON.parse(result.stdout) as { loggedIn?: unknown };
      return status.loggedIn === true;
    } catch {
      return false;
    }
  })();
  const configured = configuredModels(environment);
  // The verified isolated mode never reads OAuth/keychain credentials. Do not
  // advertise host tools for subscription-only auth; its existing text path
  // stays available until that separate authentication mode is verified.
  const bareAuth = Boolean(environment.ANTHROPIC_API_KEY || environment.ANTHROPIC_AUTH_TOKEN);
  const hostToolsSupported = await (async (): Promise<boolean> => {
    try {
      const result = await execFileAsync(probe.path, ["--help"], { env: environment, timeout: 8_000, maxBuffer: 256 * 1024, ...cliShellOptions(probe.path) });
      return bareAuth && ["--bare", "--restricted", "--strict-mcp-config", "--allowedTools"].every((flag) => result.stdout.includes(flag));
    } catch { return false; }
  })();
  const options: Array<{ id: string; label: string; provider?: string; custom?: boolean }> = configured.length > 0
    ? configured
    : FALLBACK_CLAUDE_MODELS.options.map((model) => ({ ...model }));
  const preferred = [
    environment.ANTHROPIC_MODEL,
    environment.ANTHROPIC_DEFAULT_SONNET_MODEL,
    environment.ANTHROPIC_DEFAULT_FABLE_MODEL,
    environment.ANTHROPIC_DEFAULT_OPUS_MODEL,
    environment.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  ].find((candidate): candidate is string => typeof candidate === "string" && options.some((model) => model.id === candidate));
  return {
    path: probe.path,
    version: probe.version,
    authenticated,
    hostToolsSupported,
    models: { default: preferred ?? options[0]?.id ?? "", options },
  };
}

function promptText(messages: ChatMessage[]): string {
  return messages.map((message) => {
    if (message.role === "tool") return `[tool ${message.tool_call_id}]\n${message.content}`;
    return `[${message.role}]\n${message.content}`;
  }).join("\n\n");
}

function textFromAssistantFrame(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const message = value as { content?: unknown };
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const item = block as { type?: unknown; text?: unknown };
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("");
}

function claudeResultError(frame: Record<string, unknown>): AevorenBotError {
  const message = [frame.result, frame.error, frame.message]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (/(?:not logged in|please run \/login|authentication|invalid api key|unauthorized)/iu.test(message)) {
    return new AevorenBotError("MODEL_AUTHENTICATION_FAILED");
  }
  if (/(?:usage limit|quota|rate.?limit|purchase extra usage|upgrade your plan)/iu.test(message)) {
    return new AevorenBotError("MODEL_QUOTA_EXCEEDED");
  }
  if (/(?:unrecognized.model|model.+(?:not found|unavailable|invalid|unsupported))/iu.test(message)) {
    return new AevorenBotError("MODEL_SELECTED_MODEL_UNAVAILABLE");
  }
  return new AevorenBotError("MODEL_REQUEST_REFUSED");
}

export class ClaudeCliProvider implements ModelProvider {
  constructor(
    private readonly cliCommand: string,
    private readonly modelId: string,
    private readonly cwd: string,
    private readonly hostToolsSupported = false,
  ) {}

  async *run(messages: ChatMessage[], signal: AbortSignal, context?: ModelRunContext): AsyncIterable<ModelEvent> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const path = resolveCliPath(this.cliCommand, cliEnvironment());
    if (!path || !this.modelId) throw new AevorenBotError("MODEL_NOT_CONFIGURED");
    mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    const events = new ClaudeEventQueue();
    let requestId: string = randomUUID();
    let started = false;
    const accept = (): void => {
      if (started) return;
      started = true;
      events.push({ type: "started", requestId });
    };
    const bridge = this.hostToolsSupported && context && structuredModelToolDefinitions(context).length > 0
      ? new ClaudeToolBridge(context, (event) => { accept(); events.push(event); }, signal)
      : null;
    try {
      if (bridge) await bridge.start(this.cwd);
    } catch {
      await bridge?.close();
      throw new AevorenBotError("MODEL_HOST_TOOL_UNAVAILABLE");
    }
    const environment = claudeEnvironment(Boolean(bridge));
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", this.modelId,
      bridge ? "--bare" : "--safe-mode",
      "--restricted",
      "--strict-mcp-config",
      "--mcp-config", bridge?.configPath ?? '{"mcpServers":{}}',
      "--tools", "",
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--no-chrome",
      "--no-session-persistence",
      "--prompt-suggestions", "false",
    ];
    if (bridge) args.push("--allowedTools", ...bridge.toolNames);
    const child = spawn(path, args, {
      cwd: this.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      ...cliShellOptions(path),
    });
    let streamed = false;
    let completed = false;
    let assistantFallback = "";
    child.once("error", () => events.fail(new AevorenBotError("MODEL_CLI_INVALID")));
    const abort = (): void => { events.fail(new DOMException("Aborted", "AbortError")); child.kill("SIGTERM"); };
    signal.addEventListener("abort", abort, { once: true });
    const heartbeat = setInterval(() => events.push({ type: "activity" }), 15_000);
    heartbeat.unref();
    child.stdin.end(promptText(messages));
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    void (async () => {
      try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (frame.type === "system" && typeof frame.session_id === "string") {
          requestId = frame.session_id;
          if (bridge && frame.subtype === "init") {
            const servers = Array.isArray(frame.mcp_servers) ? frame.mcp_servers as Array<{ name?: unknown; status?: unknown }> : [];
            if (!servers.some((server) => server.name === "aevoren_host" && server.status === "connected")) throw new AevorenBotError("MODEL_HOST_TOOL_UNAVAILABLE");
          }
        }
        if (frame.type === "stream_event" && frame.event && typeof frame.event === "object") {
          const event = frame.event as Record<string, unknown>;
          const delta = event.delta && typeof event.delta === "object" ? event.delta as Record<string, unknown> : null;
          if (event.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
            accept();
            streamed = true;
            events.push({ type: "delta", text: delta.text });
          }
          continue;
        }
        if (frame.type === "assistant") {
          assistantFallback = textFromAssistantFrame(frame.message);
          continue;
        }
        if (frame.type !== "result") continue;
        if (frame.subtype !== "success" || frame.is_error === true) throw claudeResultError(frame);
        accept();
        const fallback = typeof frame.result === "string" ? frame.result : assistantFallback;
        if (!streamed && fallback) events.push({ type: "delta", text: fallback });
        completed = true;
        events.push({ type: "completed", finishReason: "stop" });
        events.end();
        return;
      }
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!completed) throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
      } catch (error) { events.fail(error); }
    })();
    try {
      for await (const event of events.iterate()) yield event;
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", abort);
      await bridge?.close();
      lines.close();
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }

  async testConnection(signal: AbortSignal): Promise<void> {
    let completed = false;
    for await (const event of this.run([
      { role: "user", content: "Reply only AEVOREN_CLAUDE_CONNECTION_OK." },
    ], signal)) {
      if (event.type === "completed") completed = true;
    }
    if (!completed) throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
  }
}

class ClaudeEventQueue {
  private readonly values: ModelEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private error: unknown = null;
  push(value: ModelEvent): void { if (!this.closed) { this.values.push(value); this.wake?.(); } }
  end(): void { this.closed = true; this.wake?.(); }
  fail(error: unknown): void { this.error = error; this.end(); }
  async *iterate(): AsyncIterable<ModelEvent> {
    while (true) {
      if (this.values.length) { yield this.values.shift()!; continue; }
      if (this.closed) { if (this.error) throw this.error; return; }
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }
}
