import { randomUUID } from "node:crypto";
import type { TranscriptRole } from "@shared/contracts";
import { MsBotError } from "./errors";

export type ChatMessage = {
  role: "system" | TranscriptRole;
  content: string;
};

export type ModelStream = {
  requestId: string;
  chunks: AsyncIterable<string>;
};

export interface ModelProvider {
  start(messages: ChatMessage[], signal: AbortSignal): Promise<ModelStream>;
  testConnection(signal: AbortSignal): Promise<void>;
}

async function* fakeChunks(): AsyncIterable<string> {
  const output = [
    "## 背景\n将模糊产品想法转化为可执行需求。\n\n",
    "## 目标用户\n产品经理与创业团队。\n\n## 问题\n需求信息容易缺失或混杂。\n\n",
    "## 目标\n形成可评审的结构化需求。\n\n## 范围\n单 Bot 纯文本分析。\n\n",
    "## 非目标\n本阶段不执行外部工具。\n\n## 功能需求\n1. 接收产品想法。\n2. 输出结构化分析。\n\n",
    "## 验收标准\n输出包含约定章节。\n\n## 风险\n输入信息可能不足。\n\n## 待确认事项\n请补充业务约束与成功指标。",
  ];
  for (const chunk of output) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    yield chunk;
  }
}

export class FakeModelProvider implements ModelProvider {
  async start(_messages: ChatMessage[], signal: AbortSignal): Promise<ModelStream> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return { requestId: `fake-${randomUUID()}`, chunks: fakeChunks() };
  }

  async testConnection(_signal: AbortSignal): Promise<void> {}
}

export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly modelId: string,
    private readonly apiKey: string,
  ) {}

  async start(messages: ChatMessage[], signal: AbortSignal): Promise<ModelStream> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.modelId, messages, stream: true }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new MsBotError(
        "MODEL_REQUEST_REFUSED",
        `模型服务拒绝了请求（HTTP ${response.status}）。`,
        response.status >= 500,
      );
    }
    return {
      requestId: response.headers.get("x-request-id") ?? randomUUID(),
      chunks: parseOpenAiStream(response.body),
    };
  }

  async testConnection(signal: AbortSignal): Promise<void> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal,
    });
    if (!response.ok) {
      throw new MsBotError(
        "MODEL_CONNECTION_FAILED",
        `无法连接模型服务（HTTP ${response.status}）。`,
        response.status >= 500,
      );
    }
  }
}

function decodeSseEvent(event: string): { done: boolean; content: string | null } {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data) return { done: false, content: null };
  if (data === "[DONE]") return { done: true, content: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new MsBotError("MODEL_STREAM_INVALID", "模型返回了无法解析的流式数据。", true);
  }
  const content = (parsed as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0]?.delta?.content;
  return { done: false, content: typeof content === "string" && content.length > 0 ? content : null };
}

export async function* parseOpenAiStream(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const decoded = decodeSseEvent(event);
        if (decoded.done) return;
        if (decoded.content) yield decoded.content;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const decoded = decodeSseEvent(buffer);
      if (decoded.content) yield decoded.content;
    }
  } finally {
    reader.releaseLock();
  }
}
