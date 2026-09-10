import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider, parseOpenAiStream } from "./model";

afterEach(() => vi.unstubAllGlobals());

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("parseOpenAiStream", () => {
  it("parses SSE deltas split across transport chunks", async () => {
    const stream = streamFrom([
      'data: {"choices":[{"delta":{"content":"第一"}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"段"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const output: string[] = [];
    for await (const chunk of parseOpenAiStream(stream)) output.push(chunk);
    expect(output).toEqual(["第一", "段"]);
  });

  it("returns a safe structured error for invalid JSON", async () => {
    const stream = streamFrom(["data: not-json\n\n"]);
    await expect(async () => {
      for await (const chunk of parseOpenAiStream(stream)) void chunk;
    }).rejects.toMatchObject({ code: "MODEL_STREAM_INVALID" });
  });

  it("parses a final SSE event even when the stream has no blank-line terminator", async () => {
    const stream = streamFrom(['data: {"choices":[{"delta":{"content":"尾段"}}]}']);
    const output: string[] = [];
    for await (const chunk of parseOpenAiStream(stream)) output.push(chunk);
    expect(output).toEqual(["尾段"]);
  });

  it("uses the OpenAI-compatible streaming contract without exposing provider details", async () => {
    const body = streamFrom(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n']);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { "x-request-id": "request-1" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "test-model", "test-key");
    const stream = await provider.start([{ role: "user", content: "hello" }], new AbortController().signal);
    const output: string[] = [];
    for await (const chunk of stream.chunks) output.push(chunk);

    expect(stream.requestId).toBe("request-1");
    expect(output).toEqual(["ok"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/v1/chat/completions",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });
});
