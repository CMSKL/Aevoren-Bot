import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import type { ProviderModelOption } from "@shared/contracts";
import type { ChatMessage, ModelEvent, ModelProvider } from "../model";
import { AevorenBotError } from "../errors";
import { cliEnvironment, cliShellOptions, probeCliVersion } from "./cli-utils";

type JsonObject = Record<string, unknown>;

export type AcpCliSpec = {
  id: string;
  displayName: string;
  defaultCommand: string;
  access: "cloud" | "local";
  models: { default: string; options: ProviderModelOption[] };
  allowedEnvironment?: string[];
  spawnArgs(modelId?: string): string[];
  selectModel?: { method: "session/set_model" } | { method: "session/set_config_option"; configId: string };
};

export const ACP_CLI_SPECS: AcpCliSpec[] = [
  {
    id: "grok",
    displayName: "Grok Build",
    defaultCommand: "grok",
    access: "cloud",
    models: { default: "grok-4.6", options: [{ id: "grok-4.6", label: "Grok 4.6" }, { id: "grok-4.5", label: "Grok 4.5" }] },
    spawnArgs: (model) => ["--permission-mode", "default", "agent", ...(model ? ["-m", model] : []), "stdio"],
    selectModel: { method: "session/set_model" },
  },
  {
    id: "kimi",
    displayName: "Kimi Code",
    defaultCommand: "kimi",
    access: "cloud",
    models: {
      default: "kimi-code/k3",
      options: [
        { id: "kimi-code/k3", label: "Kimi K3" },
        { id: "kimi-code/k3-256k", label: "Kimi K3 256K" },
        { id: "kimi-code/kimi-for-coding", label: "Kimi for Coding" },
        { id: "kimi-code/kimi-for-coding-highspeed", label: "Kimi for Coding Highspeed" },
      ],
    },
    spawnArgs: (model) => [...(model ? ["-m", model] : []), "acp"],
  },
  {
    id: "droid",
    displayName: "Factory Droid",
    defaultCommand: "droid",
    access: "cloud",
    models: {
      default: "claude-sonnet-5-20260301",
      options: [
        { id: "claude-sonnet-5-20260301", label: "Claude Sonnet 5" },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
        { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
        { id: "glm-5.2", label: "GLM 5.2" },
        { id: "kimi-k3", label: "Kimi K3" },
        { id: "grok-4.6", label: "Grok 4.6" },
      ],
    },
    allowedEnvironment: ["FACTORY_API_KEY"],
    spawnArgs: () => ["exec", "-o", "acp"],
    selectModel: { method: "session/set_model" },
  },
  {
    id: "cursor",
    displayName: "Cursor Agent",
    defaultCommand: "cursor-agent",
    access: "cloud",
    models: {
      default: "auto",
      options: [
        { id: "auto", label: "Auto" },
        { id: "composer-2.5", label: "Composer 2.5" },
        { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
        { id: "gpt-5.3-codex", label: "Codex 5.3" },
        { id: "claude-sonnet-5-thinking-high", label: "Claude Sonnet 5 Thinking" },
      ],
    },
    allowedEnvironment: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
    spawnArgs: (model) => [...(model ? ["--model", model] : []), "acp"],
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    defaultCommand: "opencode",
    access: "cloud",
    models: { default: "opencode/x-preview-f-free", options: [{ id: "opencode/x-preview-f-free", label: "Zen · Ox Alpha Free", provider: "opencode" }] },
    allowedEnvironment: ["OPENCODE_API_KEY"],
    spawnArgs: () => ["acp"],
    selectModel: { method: "session/set_config_option", configId: "model" },
  },
  {
    id: "qwen",
    displayName: "Qwen Code",
    defaultCommand: "qwen",
    access: "local",
    models: { default: "", options: [] },
    spawnArgs: () => ["--acp"],
    selectModel: { method: "session/set_config_option", configId: "model" },
  },
  {
    id: "hermes",
    displayName: "Hermes",
    defaultCommand: "hermes",
    access: "local",
    models: { default: "", options: [] },
    spawnArgs: () => ["acp"],
    selectModel: { method: "session/set_model" },
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    defaultCommand: "gemini",
    access: "cloud",
    models: { default: "gemini-2.5-pro", options: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }, { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }] },
    allowedEnvironment: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    spawnArgs: (model) => ["--acp", ...(model ? ["-m", model] : [])],
  },
];

export function acpSpec(id: string): AcpCliSpec | null {
  return ACP_CLI_SPECS.find((candidate) => candidate.id === id) ?? null;
}

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

class AcpClient {
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new Set<(message: JsonObject) => void>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  start(): void {
    mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.environment,
      stdio: ["pipe", "pipe", "pipe"],
      ...cliShellOptions(this.command),
    });
    this.child = child;
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.on("error", () => this.failAll(new AevorenBotError("MODEL_CLI_INVALID")));
    child.on("close", () => {
      this.closed = true;
      this.failAll(new AevorenBotError("MODEL_TRANSPORT_ERROR"));
    });
  }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    const child = this.child;
    if (!child || this.closed) return Promise.reject(new AevorenBotError("MODEL_TRANSPORT_ERROR"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AevorenBotError("MODEL_CONNECTION_TIMEOUT"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child || this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  onNotification(listener: (message: JsonObject) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.closed = true;
    this.failAll(new AevorenBotError("MODEL_TRANSPORT_ERROR"));
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("close", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null && typeof message.method === "string") {
      this.answerServerRequest(message);
      return;
    }
    if (id !== null) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new AevorenBotError("MODEL_REQUEST_REFUSED"));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") for (const listener of this.notifications) listener(message);
  }

  private answerServerRequest(message: JsonObject): void {
    if (!this.child) return;
    if (message.method !== "session/request_permission") {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } })}\n`);
      return;
    }
    const params = object(message.params) ?? {};
    const options = Array.isArray(params.options) ? params.options : [];
    const rejection = options.find((value) => {
      const option = object(value);
      return typeof option?.optionId === "string" && String(option.kind ?? "").startsWith("reject");
    });
    const optionId = object(rejection)?.optionId;
    const result = typeof optionId === "string"
      ? { outcome: { outcome: "selected", optionId } }
      : { outcome: { outcome: "cancelled" } };
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class AsyncEventQueue {
  private values: ModelEvent[] = [];
  private waiters: Array<(result: IteratorResult<ModelEvent>) => void> = [];
  private error: unknown = null;
  private ended = false;

  push(value: ModelEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    this.error = error;
    this.end();
  }

  async *iterate(): AsyncIterable<ModelEvent> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.ended) {
        if (this.error) throw this.error;
        return;
      }
      const result = await new Promise<IteratorResult<ModelEvent>>((resolve) => this.waiters.push(resolve));
      if (result.done) {
        if (this.error) throw this.error;
        return;
      }
      yield result.value;
    }
  }
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function environmentFor(spec: AcpCliSpec): NodeJS.ProcessEnv {
  const environment = cliEnvironment();
  for (const name of spec.allowedEnvironment ?? []) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function collectModels(...sources: unknown[]): ProviderModelOption[] {
  const result: ProviderModelOption[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const id = [row.modelId, row.id, row.value].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
    if (id && !result.some((model) => model.id === id)) {
      const label = [row.name, row.label].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
      result.push({ id, label: label?.trim() || id });
    }
    for (const nested of [row.availableModels, row.options, row.models]) visit(nested);
  };
  sources.forEach(visit);
  return result;
}

function selectedModel(value: unknown, configId?: string): string | null {
  const result = object(value) ?? {};
  const direct = object(result.models)?.currentModelId ?? object(object(result._meta)?.modelState)?.currentModelId;
  if (typeof direct === "string" && direct.trim()) return direct;
  if (!configId || !Array.isArray(result.configOptions)) return null;
  const option = result.configOptions.map(object).find((candidate) => candidate?.id === configId);
  return typeof option?.currentValue === "string" && option.currentValue.trim() ? option.currentValue : null;
}

async function initializeSession(client: AcpClient, cwd: string): Promise<{ init: JsonObject; session: JsonObject; sessionId: string }> {
  const init = object(await client.request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "aevoren-bot", version: "1" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  }, 15_000)) ?? {};
  const session = object(await client.request("session/new", { cwd, mcpServers: [] }, 15_000)) ?? {};
  if (typeof session.sessionId !== "string") throw new AevorenBotError("MODEL_CLI_PROTOCOL_ERROR");
  return { init, session, sessionId: session.sessionId };
}

export type AcpCliInspection = {
  path: string;
  version: string;
  authenticated: boolean;
  models: { default: string; options: ProviderModelOption[] };
};

export async function inspectAcpCli(cliCommand: string, spec: AcpCliSpec, cwd: string): Promise<AcpCliInspection> {
  const probe = await probeCliVersion(cliCommand);
  const client = new AcpClient(probe.path, spec.spawnArgs(), cwd, environmentFor(spec));
  try {
    client.start();
    const { init, session } = await initializeSession(client, cwd);
    const dynamic = collectModels(object(session.models)?.availableModels, object(init._meta)?.modelState, session.configOptions);
    const options = dynamic.length > 0 ? dynamic : spec.models.options;
    const current = object(session.models)?.currentModelId ?? object(object(init._meta)?.modelState)?.currentModelId;
    const defaultModel = typeof current === "string" && options.some((model) => model.id === current)
      ? current
      : options.some((model) => model.id === spec.models.default) ? spec.models.default : options[0]?.id ?? "";
    return { path: probe.path, version: probe.version, authenticated: Boolean(defaultModel), models: { default: defaultModel, options } };
  } finally {
    await client.dispose();
  }
}

function promptText(messages: ChatMessage[]): string {
  return messages.map((message) => {
    if (message.role === "tool") return `[tool ${message.tool_call_id}]\n${message.content}`;
    return `[${message.role}]\n${message.content}`;
  }).join("\n\n");
}

export class AcpCliProvider implements ModelProvider {
  constructor(
    private readonly cliCommand: string,
    private readonly modelId: string,
    private readonly spec: AcpCliSpec,
    private readonly cwd: string,
  ) {}

  async *run(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<ModelEvent> {
    const probe = await probeCliVersion(this.cliCommand).catch(() => null);
    if (!probe || !this.modelId) throw new AevorenBotError("MODEL_NOT_CONFIGURED");
    const client = new AcpClient(probe.path, this.spec.spawnArgs(this.modelId), this.cwd, environmentFor(this.spec));
    const queue = new AsyncEventQueue();
    let sessionId: string | null = null;
    let started = false;
    const unsubscribe = client.onNotification((message) => {
      if (message.method !== "session/update") return;
      const params = object(message.params) ?? {};
      if (sessionId && params.sessionId !== sessionId) return;
      const update = object(params.update) ?? {};
      if (update.sessionUpdate !== "agent_message_chunk") return;
      const content = object(update.content);
      if (content?.type === "text" && typeof content.text === "string" && content.text) {
        if (!started) {
          started = true;
          queue.push({ type: "started", requestId: sessionId ?? "acp" });
        }
        queue.push({ type: "delta", text: content.text });
      }
    });
    const abort = (): void => {
      if (sessionId) client.notify("session/cancel", { sessionId });
      queue.fail(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });

    void (async () => {
      try {
        client.start();
        const session = await initializeSession(client, this.cwd);
        sessionId = session.sessionId;
        if (this.spec.selectModel?.method === "session/set_model") {
          const result = await client.request("session/set_model", { sessionId, modelId: this.modelId });
          const current = selectedModel(result);
          if (current !== null && current !== this.modelId) throw new AevorenBotError("MODEL_REQUEST_REFUSED");
        } else if (this.spec.selectModel?.method === "session/set_config_option") {
          const result = await client.request("session/set_config_option", {
            sessionId,
            configId: this.spec.selectModel.configId,
            value: this.modelId,
          });
          const current = selectedModel(result, this.spec.selectModel.configId);
          if (current !== null && current !== this.modelId) throw new AevorenBotError("MODEL_REQUEST_REFUSED");
        }
        if (!started) {
          started = true;
          queue.push({ type: "started", requestId: sessionId });
        }
        const result = object(await client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: promptText(messages) }],
        }, 120_000)) ?? {};
        if (result.stopReason !== "end_turn") throw new AevorenBotError("MODEL_REQUEST_REFUSED");
        queue.push({ type: "completed", finishReason: "end_turn" });
        queue.end();
      } catch (error) {
        queue.fail(error);
      } finally {
        unsubscribe();
        signal.removeEventListener("abort", abort);
        await client.dispose();
      }
    })();

    yield* queue.iterate();
  }

  async testConnection(_signal: AbortSignal): Promise<void> {
    const inspection = await inspectAcpCli(this.cliCommand, this.spec, this.cwd);
    if (!inspection.authenticated || !inspection.models.default) {
      throw new AevorenBotError("MODEL_PROVIDER_UNAVAILABLE", undefined, false, { reason: "authentication" });
    }
  }
}
