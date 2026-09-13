import { randomUUID } from "node:crypto";
import type { PromptMessage } from "./prompt";
import { MsBotError } from "./errors";

export type ChatMessage = PromptMessage;

export type ModelEvent =
  | { type: "started"; requestId: string }
  | { type: "activity" }
  | { type: "delta"; text: string }
  | {
      type: "handoff";
      toolCallId: string;
      toAgentId: string;
      task: string;
      contextRefs: string[];
      visibility: "room" | "direct";
    }
  | { type: "completed"; finishReason: string };

export type ModelRunContext = {
  executorBotId: string;
  executionKey: string;
  roomId?: string;
  sourceTurnId?: string;
  incomingHandoff?: {
    id: string;
    fromAgentId: string;
    task: string;
    contextRefs: string[];
    visibility: "room" | "direct";
    createdAt: string;
  };
};

export type ProviderTimeouts = {
  connectMs: number;
  firstEventMs: number;
  idleMs: number;
  totalMs: number;
};

export const DEFAULT_PROVIDER_TIMEOUTS: ProviderTimeouts = {
  connectMs: 30_000,
  firstEventMs: 120_000,
  idleMs: 60_000,
  totalMs: 600_000,
};

export interface ModelProvider {
  run(messages: ChatMessage[], signal: AbortSignal, context?: ModelRunContext): AsyncIterable<ModelEvent>;
  testConnection(signal: AbortSignal): Promise<void>;
}

export type ScriptedFakeInvocation = {
  callIndex: number;
  executionCallIndex: number;
  messages: ChatMessage[];
  context: ModelRunContext | undefined;
};

export type ScriptedFakeStep =
  | ModelEvent
  | { type: "delay"; milliseconds: number; ignoreAbort?: boolean }
  | { type: "failure"; error: unknown };

/** Test-only deterministic provider. Handoffs are emitted as events, never parsed from text. */
export class ScriptedFakeModelProvider implements ModelProvider {
  private callCount = 0;
  private readonly executionCalls = new Map<string, number>();

  constructor(
    private readonly script: (invocation: ScriptedFakeInvocation) => readonly ScriptedFakeStep[],
  ) {}

  async *run(
    messages: ChatMessage[],
    signal: AbortSignal,
    context?: ModelRunContext,
  ): AsyncIterable<ModelEvent> {
    const callIndex = this.callCount++;
    const executionKey = context?.executionKey ?? "unknown";
    const executionCallIndex = this.executionCalls.get(executionKey) ?? 0;
    this.executionCalls.set(executionKey, executionCallIndex + 1);
    const steps = this.script({ callIndex, executionCallIndex, messages, context });
    for (const step of steps) {
      if (signal.aborted && !("ignoreAbort" in step && step.ignoreAbort)) throw abortError();
      if (step.type === "delay") {
        if (step.ignoreAbort) await new Promise((resolve) => setTimeout(resolve, step.milliseconds));
        else await delay(step.milliseconds, signal);
        continue;
      }
      if (step.type === "failure") throw step.error;
      yield step;
    }
  }

  async testConnection(_signal: AbortSignal): Promise<void> {}
}

const FAKE_OUTPUT = [
  "## 背景\n将模糊产品想法转化为可执行需求。\n\n",
  "## 目标用户\n产品经理与创业团队。\n\n## 问题\n需求信息容易缺失或混杂。\n\n",
  "## 目标\n形成可评审的结构化需求。\n\n## 范围\n单 Bot 纯文本分析。\n\n",
  "## 非目标\n本阶段不执行外部工具。\n\n## 功能需求\n1. 接收产品想法。\n2. 输出结构化分析。\n\n",
  "## 验收标准\n输出包含约定章节。\n\n## 风险\n输入信息可能不足。\n\n## 待确认事项\n请补充业务约束与成功指标。",
];

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

export class FakeModelProvider implements ModelProvider {
  private runCount = 0;

  constructor(
    private readonly delayMs = Number(process.env.MS_BOT_FAKE_DELAY_MS ?? 20),
    private readonly output: readonly string[] = FAKE_OUTPUT,
    private readonly startDelayMs = Number(process.env.MS_BOT_FAKE_START_DELAY_MS ?? 0),
    private readonly failureMode = process.env.MS_BOT_FAKE_FAILURE ?? "",
    private readonly ignoreAbort = process.env.MS_BOT_FAKE_IGNORE_ABORT === "1",
  ) {}

  async *run(_messages: ChatMessage[], signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal.aborted) throw abortError();
    this.runCount += 1;
    if (this.failureMode === "first-run-before-start" && this.runCount === 1) {
      throw new MsBotError("MODEL_CONNECTION_FAILED");
    }
    if (this.startDelayMs > 0) {
      if (this.ignoreAbort) await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));
      else await delay(this.startDelayMs, signal);
    }
    yield { type: "started", requestId: `fake-${randomUUID()}` };
    for (const [index, text] of this.output.entries()) {
      if (this.ignoreAbort) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      else await delay(this.delayMs, signal);
      yield { type: "delta", text };
      if (index === 0 && this.failureMode === "first-run-after-delta" && this.runCount === 1) {
        throw new MsBotError("MODEL_STREAM_TRUNCATED");
      }
    }
    yield { type: "completed", finishReason: "stop" };
  }

  async testConnection(_signal: AbortSignal): Promise<void> {}
}

type DecodedSse = {
  events: ModelEvent[];
  terminal: boolean;
};

function decodeSseEvent(event: string): DecodedSse {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data) return { events: [{ type: "activity" }], terminal: false };
  if (data === "[DONE]") {
    return { events: [{ type: "completed", finishReason: "done" }], terminal: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new MsBotError("MODEL_STREAM_INVALID");
  }
  const choice = (parsed as {
    choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
  }).choices?.[0];
  const events: ModelEvent[] = [];
  const content = choice?.delta?.content;
  if (typeof content === "string" && content.length > 0) events.push({ type: "delta", text: content });
  if (typeof choice?.finish_reason === "string" && choice.finish_reason.length > 0) {
    events.push({ type: "completed", finishReason: choice.finish_reason });
    return { events, terminal: true };
  }
  if (events.length === 0) events.push({ type: "activity" });
  return { events, terminal: false };
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  milliseconds: number,
  timeoutCode: "MODEL_FIRST_EVENT_TIMEOUT" | "MODEL_STREAM_IDLE_TIMEOUT" | "MODEL_RUN_TIMEOUT",
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new MsBotError(timeoutCode)), milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function* parseOpenAiStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal = new AbortController().signal,
  timeouts: Pick<ProviderTimeouts, "firstEventMs" | "idleMs" | "totalMs"> = DEFAULT_PROVIDER_TIMEOUTS,
): AsyncIterable<ModelEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = "";
  let sawEvent = false;
  let terminal = false;
  try {
    while (!terminal) {
      const remaining = timeouts.totalMs - (Date.now() - startedAt);
      if (remaining <= 0) throw new MsBotError("MODEL_RUN_TIMEOUT");
      const timeoutMs = Math.min(remaining, sawEvent ? timeouts.idleMs : timeouts.firstEventMs);
      const timeoutCode = remaining <= (sawEvent ? timeouts.idleMs : timeouts.firstEventMs)
        ? "MODEL_RUN_TIMEOUT"
        : sawEvent
          ? "MODEL_STREAM_IDLE_TIMEOUT"
          : "MODEL_FIRST_EVENT_TIMEOUT";
      const { done, value } = await readWithTimeout(reader, timeoutMs, timeoutCode, signal);
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const rawEvent of events) {
        sawEvent = true;
        const decoded = decodeSseEvent(rawEvent);
        for (const modelEvent of decoded.events) yield modelEvent;
        if (decoded.terminal) {
          terminal = true;
          break;
        }
      }
      if (done) break;
    }
    if (!terminal && buffer.trim()) {
      sawEvent = true;
      const decoded = decodeSseEvent(buffer);
      for (const modelEvent of decoded.events) yield modelEvent;
      terminal = decoded.terminal;
    }
    if (!terminal) throw new MsBotError("MODEL_STREAM_TRUNCATED");
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof MsBotError) throw error;
    throw new MsBotError("MODEL_TRANSPORT_ERROR");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly modelId: string,
    private readonly apiKey: string,
    private readonly timeouts: ProviderTimeouts = DEFAULT_PROVIDER_TIMEOUTS,
  ) {}

  async *run(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<ModelEvent> {
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", relayAbort, { once: true });
    const connectTimer = setTimeout(
      () => controller.abort(new MsBotError("MODEL_CONNECTION_TIMEOUT")),
      this.timeouts.connectMs,
    );
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.modelId, messages, stream: true }),
        signal: controller.signal,
      });
    } catch {
      if (signal.aborted) throw abortError();
      if (controller.signal.reason instanceof MsBotError) throw controller.signal.reason;
      throw new MsBotError("MODEL_TRANSPORT_ERROR");
    } finally {
      clearTimeout(connectTimer);
      signal.removeEventListener("abort", relayAbort);
    }
    if (!response.ok || !response.body) {
      throw new MsBotError(
        "MODEL_REQUEST_REFUSED",
        `模型服务拒绝了请求（HTTP ${response.status}）。`,
        response.status >= 500,
        { status: response.status },
      );
    }
    yield { type: "started", requestId: response.headers.get("x-request-id") ?? randomUUID() };
    yield* parseOpenAiStream(response.body, signal, this.timeouts);
  }

  async testConnection(signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal,
      });
    } catch {
      if (signal.aborted) throw abortError();
      throw new MsBotError("MODEL_CONNECTION_FAILED");
    }
    if (!response.ok) {
      throw new MsBotError(
        "MODEL_CONNECTION_FAILED",
        `无法连接模型服务（HTTP ${response.status}）。`,
        response.status >= 500,
        { status: response.status },
      );
    }
  }
}
