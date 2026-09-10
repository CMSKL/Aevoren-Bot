import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_TIMEOUTS,
  OpenAiCompatibleProvider,
  parseOpenAiStream,
  type ModelEvent,
} from "./model";

afterEach(() => vi.unstubAllGlobals());

function streamFrom(chunks: string[], close = true): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("parseOpenAiStream", () => {
  it("parses SSE deltas split across transport chunks and an explicit done", async () => {
    const stream = streamFrom([
      'data: {"choices":[{"delta":{"content":"第一"}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"段"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await collect(parseOpenAiStream(stream))).toEqual([
      { type: "delta", text: "第一" },
      { type: "delta", text: "段" },
      { type: "completed", finishReason: "done" },
    ]);
  });

  it("accepts a non-empty finish reason as an explicit terminal signal", async () => {
    const stream = streamFrom([
      'data: {"choices":[{"delta":{"content":"尾段"},"finish_reason":"stop"}]}',
    ]);
    expect(await collect(parseOpenAiStream(stream))).toEqual([
      { type: "delta", text: "尾段" },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("rejects invalid JSON without exposing its payload", async () => {
    await expect(collect(parseOpenAiStream(streamFrom(["data: not-json\n\n"])))).rejects.toMatchObject({
      code: "MODEL_STREAM_INVALID",
    });
  });

  it("marks a clean EOF without terminal evidence as truncated", async () => {
    const stream = streamFrom(['data: {"choices":[{"delta":{"content":"部分"}}]}']);
    await expect(collect(parseOpenAiStream(stream))).rejects.toMatchObject({ code: "MODEL_STREAM_TRUNCATED" });
  });

  it("distinguishes first-event, idle and total timeouts", async () => {
    await expect(
      collect(parseOpenAiStream(streamFrom([], false), new AbortController().signal, {
        firstEventMs: 5,
        idleMs: 50,
        totalMs: 100,
      })),
    ).rejects.toMatchObject({ code: "MODEL_FIRST_EVENT_TIMEOUT" });

    await expect(
      collect(parseOpenAiStream(streamFrom(['data: {"choices":[{"delta":{"content":"A"}}]}\n\n'], false), new AbortController().signal, {
        firstEventMs: 50,
        idleMs: 5,
        totalMs: 100,
      })),
    ).rejects.toMatchObject({ code: "MODEL_STREAM_IDLE_TIMEOUT" });

    await expect(
      collect(parseOpenAiStream(streamFrom([], false), new AbortController().signal, {
        firstEventMs: 100,
        idleMs: 100,
        totalMs: 5,
      })),
    ).rejects.toMatchObject({ code: "MODEL_RUN_TIMEOUT" });
  });

  it("uses the OpenAI-compatible request without exposing provider details", async () => {
    const body = streamFrom(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n']);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { "x-request-id": "request-1" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "test-model", "test-key");
    expect(await collect(provider.run([{ role: "user", content: "hello" }], new AbortController().signal))).toEqual([
      { type: "started", requestId: "request-1" },
      { type: "delta", text: "ok" },
      { type: "completed", finishReason: "done" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/v1/chat/completions",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });

  it("uses the locked P0-B timeout defaults", () => {
    expect(DEFAULT_PROVIDER_TIMEOUTS).toEqual({
      connectMs: 30_000,
      firstEventMs: 120_000,
      idleMs: 60_000,
      totalMs: 600_000,
    });
  });

  it("classifies a request-header timeout separately from stream timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    ));
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "model", "key", {
      connectMs: 5,
      firstEventMs: 100,
      idleMs: 100,
      totalMs: 100,
    });
    await expect(collect(provider.run([], new AbortController().signal))).rejects.toMatchObject({
      code: "MODEL_CONNECTION_TIMEOUT",
    });
  });
});
