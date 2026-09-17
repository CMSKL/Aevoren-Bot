import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChatMessage, ModelEvent, ModelProvider } from "../model";
import { AevorenBotError } from "../errors";
import { cliEnvironment, isolatedCodexEnvironment, probeCliVersion, readCodexConfiguredSelection, resolveCliPath } from "./cli-utils";

const DISABLED_CODEX_FEATURES = [
  "plugins",
  "apps",
  "browser_use",
  "computer_use",
  "hooks",
  "shell_tool",
  "unified_exec",
  "image_generation",
  "view_image",
  "skill_search",
  "sleep_tool",
  "workspace_dependencies",
  "goals",
  "multi_agent",
] as const;

type JsonObject = Record<string, unknown>;

type CodexModelCatalog = {
  default: string;
  options: Array<{ id: string; label: string; provider?: string; custom?: boolean }>;
};

export type CodexCliInspection = {
  path: string;
  version: string;
  authenticated: boolean;
  accountLabel: string | null;
  models: CodexModelCatalog;
};

const FALLBACK_CODEX_MODELS: CodexModelCatalog = {
  default: "gpt-6-astra",
  options: [
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.5", label: "GPT-5.5" },
  ],
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

class CodexRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationListeners = new Set<(message: JsonObject) => void>();
  private closed = false;

  constructor(
    private readonly cliPath: string,
    private readonly cwd: string,
  ) {}

  start(): void {
    if (this.child) return;
    mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.cliPath, [
        "app-server",
        "--stdio",
        ...DISABLED_CODEX_FEATURES.flatMap((feature) => ["--disable", feature]),
      ], {
        cwd: this.cwd,
        env: isolatedCodexEnvironment(join(this.cwd, ".codex-home")),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw new AevorenBotError("MODEL_CLI_INVALID");
    }
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.on("error", () => this.failAll(new AevorenBotError("MODEL_CLI_INVALID")));
    child.on("close", () => {
      this.closed = true;
      this.failAll(new AevorenBotError("MODEL_TRANSPORT_ERROR"));
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "aevoren-bot", title: "Aevoren Bot", version: "1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, 10_000);
    this.notify("initialized", {});
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
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
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AevorenBotError("MODEL_TRANSPORT_ERROR"));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child || this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  onNotification(listener: (message: JsonObject) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
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
    if (id !== null) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new AevorenBotError("MODEL_REQUEST_REFUSED"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    for (const listener of this.notificationListeners) listener(message);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class AsyncModelEventQueue {
  private values: ModelEvent[] = [];
  private waiters: Array<(result: IteratorResult<ModelEvent>) => void> = [];
  private terminalError: unknown = null;
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
    if (this.ended) return;
    this.terminalError = error;
    this.end();
  }

  async *iterate(): AsyncIterable<ModelEvent> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.ended) {
        if (this.terminalError) throw this.terminalError;
        return;
      }
      const result = await new Promise<IteratorResult<ModelEvent>>((resolve) => this.waiters.push(resolve));
      if (result.done) {
        if (this.terminalError) throw this.terminalError;
        return;
      }
      yield result.value;
    }
  }
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function codexSelection(id: string): { model: string; modelProvider: string } {
  const separator = id.indexOf("::");
  if (separator > 0) return { modelProvider: id.slice(0, separator), model: id.slice(separator + 2) };
  return { modelProvider: "openai", model: id };
}

function promptParts(messages: ChatMessage[]): { developerInstructions: string; input: string } {
  const developerInstructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const input = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") return `[tool ${message.tool_call_id}]\n${message.content}`;
      return `[${message.role}]\n${message.content}`;
    })
    .join("\n\n");
  return {
    developerInstructions: [
      developerInstructions,
      "Respond to the latest user request using only the supplied conversation. Do not run shell commands, edit files, browse, or call tools.",
    ].filter(Boolean).join("\n\n"),
    input,
  };
}

export async function inspectCodexCli(cliCommand: string, cwd: string): Promise<CodexCliInspection> {
  const probe = await probeCliVersion(cliCommand);
  const client = new CodexRpcClient(probe.path, cwd);
  try {
    client.start();
    await client.initialize();
    const accountResult = object(await client.request("account/read", { refreshToken: false }, 10_000));
    const account = object(accountResult?.account);
    const models: Array<{ id: string; label: string; isDefault: boolean; provider?: string; custom?: boolean }> = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const result = object(await client.request("model/list", { cursor, limit: 100, includeHidden: false }, 10_000));
      const rows = Array.isArray(result?.data) ? result.data : [];
      for (const row of rows) {
        const model = object(row);
        if (!model || model.hidden === true || typeof model.id !== "string" || !model.id.trim()) continue;
        if (models.some((candidate) => candidate.id === model.id)) continue;
        models.push({
          id: model.id,
          label: typeof model.displayName === "string" && model.displayName.trim() ? model.displayName : model.id,
          isDefault: model.isDefault === true,
        });
      }
      const nextCursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (!nextCursor || seenCursors.has(nextCursor)) cursor = null;
      else {
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    } while (cursor);
    const configured = readCodexConfiguredSelection();
    if (configured) {
      const id = configured.provider === "openai" ? configured.model : `${configured.provider}::${configured.model}`;
      if (!models.some((candidate) => candidate.id === id)) {
        models.push({
          id,
          label: configured.provider === "openai" ? configured.model : configured.model,
          isDefault: true,
          ...(configured.provider !== "openai" ? { provider: configured.provider, custom: true } : {}),
        });
      } else if (configured.provider === "openai") {
        const match = models.find((candidate) => candidate.id === id);
        if (match) match.isDefault = true;
      }
    }
    const fallbackModel = models[0]?.id ?? "";
    return {
      path: probe.path,
      version: probe.version,
      authenticated: account !== null,
      accountLabel: typeof account?.email === "string" ? account.email : account ? String(account.type ?? "connected") : null,
      models: {
        default: models.find((model) => model.isDefault)?.id ?? fallbackModel,
        options: models.map(({ id, label, provider, custom }) => ({ id, label, ...(provider ? { provider } : {}), ...(custom ? { custom } : {}) })),
      },
    };
  } finally {
    await client.dispose();
  }
}

export async function inspectCodexCliFallback(cliCommand: string): Promise<CodexCliInspection> {
  const probe = await probeCliVersion(cliCommand);
  const sourceHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const configured = readCodexConfiguredSelection();
  const options = FALLBACK_CODEX_MODELS.options.map((model) => ({ ...model }));
  let defaultModel = FALLBACK_CODEX_MODELS.default;
  if (configured) {
    const id = configured.provider === "openai" ? configured.model : `${configured.provider}::${configured.model}`;
    if (!options.some((model) => model.id === id)) {
      options.push({ id, label: configured.model, ...(configured.provider !== "openai" ? { provider: configured.provider, custom: true } : {}) });
    }
    defaultModel = id;
  }
  return {
    path: probe.path,
    version: probe.version,
    authenticated: existsSync(join(sourceHome, "auth.json")),
    accountLabel: null,
    models: { default: defaultModel, options },
  };
}

class CodexExecProvider implements ModelProvider {
  constructor(
    private readonly cliCommand: string,
    private readonly modelId: string,
    private readonly cwd: string,
  ) {}

  async *run(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<ModelEvent> {
    const path = resolveCliPath(this.cliCommand, cliEnvironment());
    if (!path || !this.modelId) throw new AevorenBotError("MODEL_NOT_CONFIGURED");
    mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    const selection = codexSelection(this.modelId);
    const prompt = promptParts(messages);
    const child = spawn(path, [
      "exec",
      "--json",
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-rules",
      "--color", "never",
      "--model", selection.model,
      "-c", `model_provider=${JSON.stringify(selection.modelProvider)}`,
      ...DISABLED_CODEX_FEATURES.flatMap((feature) => ["--disable", feature]),
      "-",
    ], {
      cwd: this.cwd,
      env: isolatedCodexEnvironment(join(this.cwd, ".codex-home")),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let processError = false;
    let started = false;
    let completed = false;
    let requestId: string = randomUUID();
    child.once("error", () => { processError = true; });
    child.stderr.resume();
    const abort = (): void => { child.kill("SIGTERM"); };
    signal.addEventListener("abort", abort, { once: true });
    child.stdin.end(`${prompt.developerInstructions}\n\n${prompt.input}`);
    const lines = createInterface({ input: child.stdout });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let event: JsonObject;
        try {
          event = JSON.parse(line) as JsonObject;
        } catch {
          continue;
        }
        if (event.type === "thread.started" && typeof event.thread_id === "string") requestId = event.thread_id;
        if ((event.type === "thread.started" || event.type === "turn.started") && !started) {
          started = true;
          yield { type: "started", requestId };
          continue;
        }
        if (event.type === "item.completed") {
          const item = object(event.item);
          if (["agent_message", "agentMessage"].includes(String(item?.type)) && typeof item?.text === "string" && item.text) {
            if (!started) {
              started = true;
              yield { type: "started", requestId };
            }
            yield { type: "delta", text: item.text };
          }
          continue;
        }
        if (event.type === "turn.completed") {
          if (!started) yield { type: "started", requestId };
          completed = true;
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        if (event.type === "turn.failed" || event.type === "error") throw new AevorenBotError("MODEL_REQUEST_REFUSED");
      }
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (processError) throw new AevorenBotError("MODEL_CLI_INVALID");
      if (!completed) throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
    } finally {
      signal.removeEventListener("abort", abort);
      lines.close();
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }

  async testConnection(_signal: AbortSignal): Promise<void> {
    const inspection = await inspectCodexCliFallback(this.cliCommand);
    if (!inspection.authenticated) throw new AevorenBotError("MODEL_PROVIDER_UNAVAILABLE", undefined, false, { reason: "authentication" });
  }
}

export class CodexCliProvider implements ModelProvider {
  constructor(
    private readonly cliCommand: string,
    private readonly modelId: string,
    private readonly cwd: string,
  ) {}

  async *run(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<ModelEvent> {
    let accepted = false;
    try {
      for await (const event of this.runAppServer(messages, signal)) {
        if (event.type === "started") accepted = true;
        yield event;
      }
    } catch (error) {
      if (accepted || signal.aborted) throw error;
      yield* new CodexExecProvider(this.cliCommand, this.modelId, this.cwd).run(messages, signal);
    }
  }

  private async *runAppServer(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<ModelEvent> {
    const path = resolveCliPath(this.cliCommand, cliEnvironment());
    if (!path || !this.modelId) throw new AevorenBotError("MODEL_NOT_CONFIGURED");
    const client = new CodexRpcClient(path, this.cwd);
    const queue = new AsyncModelEventQueue();
    let threadId: string | null = null;
    let turnId: string | null = null;
    let completed = false;
    let streamed = false;
    const early: JsonObject[] = [];
    let settleCompletion: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => { settleCompletion = resolve; });

    const consume = (message: JsonObject): void => {
      const method = message.method;
      const params = object(message.params) ?? {};
      if (!threadId || params.threadId !== threadId) return;
      const notificationTurnId = method === "turn/completed"
        ? object(params.turn)?.id
        : params.turnId;
      if (!turnId) {
        early.push(message);
        return;
      }
      if (notificationTurnId !== turnId) return;
      if (method === "item/agentMessage/delta" && typeof params.delta === "string" && params.delta) {
        streamed = true;
        queue.push({ type: "delta", text: params.delta });
        return;
      }
      if (method === "item/completed") {
        const item = object(params.item);
        if (item?.type === "agentMessage" && !streamed && typeof item.text === "string" && item.text) {
          queue.push({ type: "delta", text: item.text });
        }
        return;
      }
      if (method === "turn/completed") {
        completed = true;
        const turn = object(params.turn);
        if (turn?.status === "completed") {
          queue.push({ type: "completed", finishReason: "stop" });
          queue.end();
        } else {
          queue.fail(new AevorenBotError("MODEL_REQUEST_REFUSED"));
        }
        settleCompletion?.();
      }
    };

    const unsubscribe = client.onNotification(consume);
    const abort = (): void => {
      if (threadId && turnId) void client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      queue.fail(new DOMException("Aborted", "AbortError"));
      settleCompletion?.();
    };
    signal.addEventListener("abort", abort, { once: true });

    void (async () => {
      try {
        client.start();
        await client.initialize();
        const selection = codexSelection(this.modelId);
        const prompt = promptParts(messages);
        const startedThread = object(await client.request("thread/start", {
          model: selection.model,
          modelProvider: selection.modelProvider,
          allowProviderModelFallback: false,
          cwd: this.cwd,
          runtimeWorkspaceRoots: [],
          approvalPolicy: "never",
          sandbox: "read-only",
          developerInstructions: prompt.developerInstructions,
          ephemeral: true,
          environments: [],
          dynamicTools: [],
        }));
        const thread = object(startedThread?.thread);
        if (typeof thread?.id !== "string") throw new AevorenBotError("MODEL_CLI_PROTOCOL_ERROR");
        threadId = thread.id;
        const startedTurn = object(await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt.input, text_elements: [] }],
          model: selection.model,
          approvalPolicy: "never",
          environments: [],
          cwd: this.cwd,
        }));
        const turn = object(startedTurn?.turn);
        if (typeof turn?.id !== "string") throw new AevorenBotError("MODEL_CLI_PROTOCOL_ERROR");
        turnId = turn.id;
        queue.push({ type: "started", requestId: turnId || randomUUID() });
        for (const message of early.splice(0)) consume(message);
        await completion;
        if (!completed && !signal.aborted) throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
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
    const inspected = await inspectCodexCli(this.cliCommand, this.cwd).catch(() => inspectCodexCliFallback(this.cliCommand));
    if (!inspected.authenticated) throw new AevorenBotError("MODEL_PROVIDER_UNAVAILABLE", undefined, false, { reason: "authentication" });
  }
}
