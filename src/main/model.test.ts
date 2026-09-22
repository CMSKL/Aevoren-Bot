import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_TIMEOUTS,
  OpenAiCompatibleProvider,
  parseOpenAiStream,
  parseStructuredModelToolCall,
  selectDeterministicRoomOwner,
  structuredModelToolDefinitions,
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

  it("reassembles interleaved text and fragmented handoff tool calls by index", async () => {
    const targetA = crypto.randomUUID();
    const targetB = crypto.randomUUID();
    const stream = streamFrom([
      `data: {"choices":[{"index":1,"delta":{"content":"ignored"}},{"index":0,"delta":{"content":"先分析。","tool_calls":[{"index":1,"id":"call-","type":"function","function":{"name":"handoff_","arguments":"{\\"toAgentId\\":\\"${targetB}"}},{"index":0,"id":"call-","type":"function","function":{"name":"handoff_","arguments":"{\\"toAgentId\\":\\"${targetA}"}}]}}]}\n\n`,
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"to_agent","arguments":"\\",\\"task\\":\\"复核 A\\",\\"contextRefs\\":[],\\"visibility\\":\\"room\\"}"}},{"index":1,"id":"b","function":{"name":"to_agent","arguments":"\\",\\"task\\":\\"复核 B\\",\\"contextRefs\\":[],\\"visibility\\":\\"room\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await collect(parseOpenAiStream(
      stream,
      new AbortController().signal,
      DEFAULT_PROVIDER_TIMEOUTS,
      new Set([targetA, targetB]),
    ))).toEqual([
      { type: "delta", text: "先分析。" },
      { type: "activity" },
      { type: "handoff", toolCallId: "call-a", toAgentId: targetA, task: "复核 A", contextRefs: [], visibility: "room" },
      { type: "handoff", toolCallId: "call-b", toAgentId: targetB, task: "复核 B", contextRefs: [], visibility: "room" },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("parses one bounded workspace read for an explicitly registered workspace", async () => {
    const workspaceId = crypto.randomUUID();
    const args = JSON.stringify({ workspaceId, path: "docs/spec.md", maxBytes: 4096 });
    const stream = streamFrom([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "read-1", type: "function", function: { name: "workspace_read", arguments: args } }] }, finish_reason: "tool_calls" }] })}\n\n`,
    ]);
    expect(await collect(parseOpenAiStream(
      stream,
      new AbortController().signal,
      DEFAULT_PROVIDER_TIMEOUTS,
      undefined,
      new Set([workspaceId]),
    ))).toEqual([
      { type: "workspace-tool", toolCallId: "read-1", tool: { kind: "workspace-read", workspaceId, path: "docs/spec.md", maxBytes: 4096 }, providerToolName: "workspace_read" },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("normalizes bounded defaults for a root workspace list", async () => {
    const workspaceId = crypto.randomUUID();
    const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: "list-root", type: "function", function: { name: "workspace_list", arguments: JSON.stringify({ workspaceId }) },
    }] }, finish_reason: "tool_calls" }] })}\n\n`;
    expect(await collect(parseOpenAiStream(
      streamFrom([payload]), new AbortController().signal, DEFAULT_PROVIDER_TIMEOUTS,
      undefined, new Set([workspaceId]),
    ))).toEqual([
      { type: "workspace-tool", toolCallId: "list-root", tool: { kind: "workspace-list", workspaceId, path: "", maxEntries: 100 }, providerToolName: "workspace_list" },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("parses one bounded network tool only when the provider context enables it", async () => {
    const args = JSON.stringify({ location: "上海" });
    const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "weather-1", type: "function", function: { name: "weather_current", arguments: args } }] }, finish_reason: "tool_calls" }] })}\n\n`;
    expect(await collect(parseOpenAiStream(
      streamFrom([payload]),
      new AbortController().signal,
      DEFAULT_PROVIDER_TIMEOUTS,
      undefined,
      undefined,
      true,
    ))).toEqual([
      { type: "network-tool", toolCallId: "weather-1", tool: { kind: "weather-current", location: "上海" }, providerToolName: "weather_current" },
      { type: "completed", finishReason: "tool_calls" },
    ]);
    await expect(collect(parseOpenAiStream(streamFrom([payload])))).rejects.toMatchObject({ code: "MODEL_NETWORK_TOOL_INVALID" });
  });

  it("maps one namespaced read-only MCP tool to its stable server and tool identity", async () => {
    const serverId = crypto.randomUUID();
    const definition = {
      serverId,
      serverName: "fixture",
      name: "lookup",
      namespacedName: "mcp__fixture__lookup",
      description: "read-only lookup",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      claimedReadOnly: true,
      readOnly: true,
    };
    const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "mcp-1", type: "function", function: { name: definition.namespacedName, arguments: JSON.stringify({ query: "hello" }) } }] }, finish_reason: "tool_calls" }] })}\n\n`;
    expect(await collect(parseOpenAiStream(
      streamFrom([payload]),
      new AbortController().signal,
      DEFAULT_PROVIDER_TIMEOUTS,
      undefined,
      undefined,
      false,
      new Map([[definition.namespacedName, definition]]),
    ))).toEqual([
      {
        type: "mcp-tool",
        toolCallId: "mcp-1",
        tool: { kind: "mcp-call", serverId, toolName: "lookup", arguments: { query: "hello" }, readOnly: true },
        providerToolName: "mcp__fixture__lookup",
      },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("parses a bounded clipboard read only when device tools are enabled", async () => {
    const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "clipboard-1", type: "function", function: { name: "clipboard_read", arguments: JSON.stringify({ maxCharacters: 500 }) } }] }, finish_reason: "tool_calls" }] })}\n\n`;
    expect(await collect(parseOpenAiStream(
      streamFrom([payload]), new AbortController().signal, DEFAULT_PROVIDER_TIMEOUTS,
      undefined, undefined, false, undefined, true,
    ))).toEqual([
      { type: "device-tool", toolCallId: "clipboard-1", tool: { kind: "clipboard-read", maxCharacters: 500 }, providerToolName: "clipboard_read" },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("fails closed for out-of-scope workspace calls and accepts a validated mixed batch", async () => {
    const allowedWorkspaceId = crypto.randomUUID();
    const outsideWorkspaceId = crypto.randomUUID();
    const target = crypto.randomUUID();
    const outside = streamFrom([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "read", type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ workspaceId: outsideWorkspaceId, path: "secret", maxBytes: 10 }) } }] }, finish_reason: "tool_calls" }] })}\n\n`,
    ]);
    await expect(collect(parseOpenAiStream(
      outside, new AbortController().signal, DEFAULT_PROVIDER_TIMEOUTS,
      new Set([target]), new Set([allowedWorkspaceId]),
    ))).rejects.toMatchObject({ code: "MODEL_WORKSPACE_TOOL_INVALID" });

    const mixed = streamFrom([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "read", type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ workspaceId: allowedWorkspaceId, path: "safe", maxBytes: 10 }) } },
        { index: 1, id: "handoff", type: "function", function: { name: "handoff_to_agent", arguments: JSON.stringify({ toAgentId: target, task: "review", contextRefs: [], visibility: "room" }) } },
      ] }, finish_reason: "tool_calls" }] })}\n\n`,
    ]);
    expect(await collect(parseOpenAiStream(
      mixed, new AbortController().signal, DEFAULT_PROVIDER_TIMEOUTS,
      new Set([target]), new Set([allowedWorkspaceId]),
    ))).toEqual([
      { type: "workspace-tool", toolCallId: "read", tool: { kind: "workspace-read", workspaceId: allowedWorkspaceId, path: "safe", maxBytes: 10 }, providerToolName: "workspace_read" },
      { type: "handoff", toolCallId: "handoff", toAgentId: target, task: "review", contextRefs: [], visibility: "room" },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("normalizes a provider limit alias for bounded workspace tools", async () => {
    const workspaceId = crypto.randomUUID();
    const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{
      index: 0,
      id: "search-with-limit",
      type: "function",
      function: { name: "workspace_search", arguments: JSON.stringify({ workspaceId, query: "handoff", limit: 12 }) },
    }] }, finish_reason: "tool_calls" }] })}\n\n`;
    expect(await collect(parseOpenAiStream(
      streamFrom([payload]),
      new AbortController().signal,
      DEFAULT_PROVIDER_TIMEOUTS,
      undefined,
      new Set([workspaceId]),
    ))).toEqual([
      {
        type: "workspace-tool",
        toolCallId: "search-with-limit",
        tool: { kind: "workspace-search", workspaceId, path: "", query: "handoff", maxMatches: 12 },
        providerToolName: "workspace_search",
      },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("normalizes the observed maxResults alias for workspace search", async () => {
    const workspaceId = crypto.randomUUID();
    const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{
      index: 0,
      id: "search-with-max-results",
      type: "function",
      function: { name: "workspace_search", arguments: JSON.stringify({ workspaceId, query: "approval", maxResults: 7 }) },
    }] }, finish_reason: "tool_calls" }] })}\n\n`;
    expect(await collect(parseOpenAiStream(
      streamFrom([payload]),
      new AbortController().signal,
      DEFAULT_PROVIDER_TIMEOUTS,
      undefined,
      new Set([workspaceId]),
    ))).toEqual([
      {
        type: "workspace-tool",
        toolCallId: "search-with-max-results",
        tool: { kind: "workspace-search", workspaceId, path: "", query: "approval", maxMatches: 7 },
        providerToolName: "workspace_search",
      },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("ignores a validated expectedSha256 hint without changing create-only workspace write semantics", async () => {
    const workspaceId = crypto.randomUUID();
    const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{
      index: 0,
      id: "write-with-digest-hint",
      type: "function",
      function: { name: "workspace_write", arguments: JSON.stringify({ workspaceId, path: "brief.md", content: "real content", expectedSha256: "a".repeat(64) }) },
    }] }, finish_reason: "tool_calls" }] })}\n\n`;
    expect(await collect(parseOpenAiStream(
      streamFrom([payload]),
      new AbortController().signal,
      DEFAULT_PROVIDER_TIMEOUTS,
      undefined,
      new Set([workspaceId]),
    ))).toEqual([
      {
        type: "workspace-tool",
        toolCallId: "write-with-digest-hint",
        tool: { kind: "workspace-write", workspaceId, path: "brief.md", content: "real content" },
        providerToolName: "workspace_write",
      },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("accepts a bounded text_measure countMode hint while returning the canonical computation request", async () => {
    const workspaceId = crypto.randomUUID();
    const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{
      index: 0,
      id: "measure-with-mode",
      type: "function",
      function: { name: "text_measure", arguments: JSON.stringify({ text: "真实文本", countMode: "all", mode: "nonWhitespaceCharacters", nonWhitespaceOnly: true, workspaceId }) },
    }] }, finish_reason: "tool_calls" }] })}\n\n`;
    expect(await collect(parseOpenAiStream(
      streamFrom([payload]),
      new AbortController().signal,
      DEFAULT_PROVIDER_TIMEOUTS,
      undefined,
      new Set([workspaceId]),
    ))).toEqual([
      {
        type: "computation-tool",
        toolCallId: "measure-with-mode",
        tool: { kind: "text-measure", text: "真实文本" },
        providerToolName: "text_measure",
      },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("ignores usage-only and nonzero-choice events", async () => {
    const stream = streamFrom([
      'data: {"choices":[],"usage":{"completion_tokens":1}}\n\n',
      'data: {"choices":[{"index":1,"delta":{"content":"not choice zero"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"choice zero"},"finish_reason":"stop"}]}\n\n',
    ]);
    expect(await collect(parseOpenAiStream(stream))).toEqual([
      { type: "activity" },
      { type: "activity" },
      { type: "delta", text: "choice zero" },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("treats a textual @Agent mention as ordinary content and never as a handoff", async () => {
    const stream = streamFrom([
      'data: {"choices":[{"index":0,"delta":{"content":"请 @评审员 继续"},"finish_reason":"stop"}]}\n\n',
    ]);
    expect(await collect(parseOpenAiStream(stream))).toEqual([
      { type: "delta", text: "请 @评审员 继续" },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("maps one exact unique Room member name to its authoritative Bot id", async () => {
    const target = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const fromAgentId = crypto.randomUUID();
    const stream = streamFrom([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{
        index: 0,
        id: "handoff-by-name",
        type: "function",
        function: { name: "handoff_to_agent", arguments: JSON.stringify({ fromAgentId, toAgentId: "内容主笔", targetRole: "内容主笔", workspaceId, content: "撰写批准后的草稿" }) },
      }] }, finish_reason: "tool_calls" }] })}\n\n`,
    ]);
    expect(await collect(parseOpenAiStream(
      stream,
      new AbortController().signal,
      DEFAULT_PROVIDER_TIMEOUTS,
      new Set([target]),
      new Set([workspaceId]),
      false,
      undefined,
      false,
      new Map([["内容主笔", target]]),
    ))).toEqual([
      { type: "handoff", toolCallId: "handoff-by-name", toAgentId: target, task: "撰写批准后的草稿", contextRefs: [], visibility: "room" },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it.each([
    ["missing id", [{ index: 0, type: "function", function: { name: "handoff_to_agent", arguments: "{}" } }]],
    ["unknown function", [{ index: 0, id: "call", type: "function", function: { name: "other_tool", arguments: "{}" } }]],
    ["invalid json", [{ index: 0, id: "call", type: "function", function: { name: "handoff_to_agent", arguments: "{" } }]],
    ["too many calls", Array.from({ length: 9 }, (_, index) => ({ index, id: `call-${index}`, type: "function", function: { name: "handoff_to_agent", arguments: "{}" } }))],
  ])("fails closed for %s", async (_name, toolCalls) => {
    const stream = streamFrom([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: "tool_calls" }] })}\n\n`,
    ]);
    await expect(collect(parseOpenAiStream(
      stream,
      new AbortController().signal,
      DEFAULT_PROVIDER_TIMEOUTS,
      new Set([crypto.randomUUID()]),
    ))).rejects.toMatchObject({ code: "MODEL_HANDOFF_INVALID" });
  });

  it.each([
    ["extra key", (target: string) => ({ toAgentId: target, task: "task", contextRefs: [], visibility: "room", extra: true })],
    ["bad visibility", (target: string) => ({ toAgentId: target, task: "task", contextRefs: [], visibility: "direct" })],
    ["non-string refs", (target: string) => ({ toAgentId: target, task: "task", contextRefs: [1], visibility: "room" })],
    ["duplicate refs", (target: string) => ({ toAgentId: target, task: "task", contextRefs: ["entry", "entry"], visibility: "room" })],
    ["too many refs", (target: string) => ({ toAgentId: target, task: "task", contextRefs: Array.from({ length: 65 }, (_, index) => `entry-${index}`), visibility: "room" })],
    ["oversized ref", (target: string) => ({ toAgentId: target, task: "task", contextRefs: ["e".repeat(201)], visibility: "room" })],
  ])("rejects malformed handoff arguments: %s", async (_name, makeArguments) => {
    const target = crypto.randomUUID();
    const stream = streamFrom([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "handoff_to_agent", arguments: JSON.stringify(makeArguments(target)) } }] }, finish_reason: "tool_calls" }] })}\n\n`,
    ]);
    await expect(collect(parseOpenAiStream(
      stream,
      new AbortController().signal,
      DEFAULT_PROVIDER_TIMEOUTS,
      new Set([target]),
    ))).rejects.toMatchObject({ code: "MODEL_HANDOFF_INVALID" });
  });

  it("returns a structured tool rejection for a nonmember Handoff target without accepting it", async () => {
    const allowedTarget = crypto.randomUUID();
    const rejectedTarget = crypto.randomUUID();
    const argumentsValue = JSON.stringify({ toAgentId: rejectedTarget, task: "继续处理", contextRefs: [], visibility: "room" });
    const stream = streamFrom([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "bad-target", type: "function", function: { name: "handoff_to_agent", arguments: argumentsValue } }] }, finish_reason: "tool_calls" }] })}\n\n`,
    ]);
    expect(await collect(parseOpenAiStream(
      stream,
      new AbortController().signal,
      DEFAULT_PROVIDER_TIMEOUTS,
      new Set([allowedTarget]),
    ))).toEqual([
      {
        type: "tool-rejection",
        toolCallId: "bad-target",
        providerToolName: "handoff_to_agent",
        arguments: argumentsValue,
        code: "HANDOFF_TARGET_INVALID",
        safeMessage: expect.stringContaining("toAgentId"),
      },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("rejects any tool call when no coordinated-room roster was supplied", async () => {
    const stream = streamFrom([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "handoff_to_agent", arguments: JSON.stringify({ toAgentId: crypto.randomUUID(), task: "task", contextRefs: [], visibility: "room" }) } }] }, finish_reason: "tool_calls" }] })}\n\n`,
    ]);
    await expect(collect(parseOpenAiStream(stream))).rejects.toMatchObject({ code: "MODEL_HANDOFF_INVALID" });
  });

  it("rejects invalid JSON without exposing its payload", async () => {
    await expect(collect(parseOpenAiStream(streamFrom(["data: not-json\n\n"])))).rejects.toMatchObject({
      code: "MODEL_STREAM_INVALID",
    });
  });

  it.each(["null", "[]", '{"choices":{}}', '{"choices":[null]}'])(
    "classifies a malformed SSE envelope as an invalid model stream: %s",
    async (payload) => {
      await expect(collect(parseOpenAiStream(streamFrom([`data: ${payload}\n\n`])))).rejects.toMatchObject({
        code: "MODEL_STREAM_INVALID",
      });
    },
  );

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
    const directBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(directBody).not.toHaveProperty("tools");
    expect(directBody).not.toHaveProperty("tool_choice");
  });

  it("tests an API Provider with one minimal real chat request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "OK" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "test-model", "test-key");

    await expect(provider.testConnection(new AbortController().signal)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/v1/chat/completions",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(request).toMatchObject({ model: "test-model", stream: false, max_tokens: 1 });
  });

  it.each([
    [401, "MODEL_AUTHENTICATION_FAILED"],
    [429, "MODEL_QUOTA_EXCEEDED"],
    [404, "MODEL_SELECTED_MODEL_UNAVAILABLE"],
  ])("maps API connection status %i to %s", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "test-model", "test-key");
    await expect(provider.testConnection(new AbortController().signal)).rejects.toMatchObject({ code });
  });

  it("advertises only bounded read-only network tools when the runtime enables them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      streamFrom(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n']),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "test-model", "test-key");
    const context = {
      executorBotId: crypto.randomUUID(),
      executionKey: "network-tools",
      networkTools: true,
    };
    await collect(provider.run([{ role: "user", content: "查询实时信息" }], new AbortController().signal, context));
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      tools: Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
    };
    expect(request.tools.map((tool) => tool.function.name)).toEqual(["web_search", "web_fetch", "weather_current", "time_now"]);
    expect(request.tools.map((tool) => tool.function.name)).toEqual(structuredModelToolDefinitions(context).map((tool) => tool.name));
    expect(request.tools.every((tool) => tool.function.parameters.additionalProperties === false)).toBe(true);
    expect(JSON.stringify(request)).not.toContain("write");
    expect(JSON.stringify(request)).not.toContain("browser");
  });

  it("parses one host dynamic MCP tool call only from the exact reviewed catalog", () => {
    const serverId = crypto.randomUUID();
    const context = {
      executorBotId: crypto.randomUUID(),
      executionKey: "dynamic-mcp",
      mcpTools: [{
        serverId,
        serverName: "search",
        name: "lookup",
        namespacedName: "mcp__search__lookup",
        description: "fixture",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        claimedReadOnly: true,
        readOnly: true,
      }],
    };
    expect(parseStructuredModelToolCall("call-1", "mcp__search__lookup", { query: "news" }, context)).toMatchObject({
      type: "mcp-tool",
      toolCallId: "call-1",
      tool: { kind: "mcp-call", serverId, toolName: "lookup", arguments: { query: "news" }, readOnly: true },
    });
    expect(() => parseStructuredModelToolCall("call-2", "mcp__search__write", { value: "x" }, context))
      .toThrowError(expect.objectContaining({ code: "MODEL_NETWORK_TOOL_INVALID" }));
    expect(() => parseStructuredModelToolCall("x".repeat(201), "mcp__search__lookup", { query: "news" }, context))
      .toThrowError(expect.objectContaining({ code: "MODEL_NETWORK_TOOL_INVALID" }));
    expect(() => parseStructuredModelToolCall("call-3", "mcp__search__lookup", { query: "x".repeat(13_000) }, context))
      .toThrowError(expect.objectContaining({ code: "MODEL_NETWORK_TOOL_INVALID" }));
  });

  it("adds one bounded handoff function schema only for a coordinated Room without leaking agent instructions", async () => {
    const executorBotId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const body = streamFrom(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n']);
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "test-model", "test-key");
    await collect(provider.run(
      [{ role: "user", content: "hello" }],
      new AbortController().signal,
      {
        executorBotId,
        executionKey: "room-run",
        roomId: crypto.randomUUID(),
        sourceTurnId: crypto.randomUUID(),
        roomRoster: [
          { id: executorBotId, name: "策划师", label: "策划", description: "负责规划" },
          { id: targetId, name: "评审员", label: "评审角色", description: "负责复核" },
        ],
      },
    ));
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      tools?: Array<{ function: { description: string; parameters: { properties: { toAgentId: { enum: string[] }; contextRefs: { maxItems: number } }; additionalProperties: boolean } } }>;
    };
    expect(request.tools).toHaveLength(1);
    expect(request.tools?.[0]).toMatchObject({
      function: {
        parameters: {
          additionalProperties: false,
          properties: { toAgentId: { enum: [targetId] }, contextRefs: { maxItems: 0 } },
        },
      },
    });
    expect(request.tools?.[0]?.function.description).toContain(targetId);
    expect(request.tools?.[0]?.function.description).toContain("评审员");
    expect(request).not.toHaveProperty("thinking");
    expect(JSON.stringify(request)).not.toContain("SECRET_AGENT_INSTRUCTIONS");
  });

  it("disables DeepSeek thinking only for coordinated requests with tools", async () => {
    const executorBotId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      streamFrom(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n']),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://api.deepseek.com/v1", "deepseek-model", "test-key");

    await collect(provider.run(
      [{ role: "user", content: "hello" }],
      new AbortController().signal,
      {
        executorBotId,
        executionKey: "room-run",
        roomId: crypto.randomUUID(),
        sourceTurnId: crypto.randomUUID(),
        roomRoster: [
          { id: executorBotId, name: "策划师", label: "策划", description: "负责规划" },
          { id: targetId, name: "评审员", label: "评审", description: "负责复核" },
        ],
      },
    ));

    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(request).toMatchObject({
      tools: expect.any(Array),
      thinking: { type: "disabled" },
    });
  });

  it("does not add DeepSeek thinking extensions to requests without tools", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      streamFrom(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n']),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://api.deepseek.com/v1", "deepseek-model", "test-key");

    await collect(provider.run([{ role: "user", content: "hello" }], new AbortController().signal));

    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(request).toEqual({
      model: "deepseek-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
  });

  it("does not add tools to a legacy Room context without a coordinated roster", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      streamFrom(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n']),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "test-model", "test-key");
    await collect(provider.run([], new AbortController().signal, {
      executorBotId: crypto.randomUUID(),
      executionKey: "legacy-room",
      roomId: crypto.randomUUID(),
      sourceTurnId: crypto.randomUUID(),
    }));
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(request).not.toHaveProperty("tools");
  });

  it("advertises only bounded read-only workspace tools with stable workspace IDs", async () => {
    const workspaceId = crypto.randomUUID();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      streamFrom(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n']),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "test-model", "test-key");
    await collect(provider.run([{ role: "user", content: "inspect" }], new AbortController().signal, {
      executorBotId: crypto.randomUUID(),
      executionKey: "workspace-run",
      workspaces: [{ id: workspaceId, name: "private-local-name", writeEnabled: false, automationEnabled: false }],
    }));
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      tools: Array<{ function: { name: string; parameters: unknown } }>;
    };
    expect(request.tools.map((tool) => tool.function.name)).toEqual(["workspace_list", "workspace_read", "workspace_search"]);
    expect(JSON.stringify(request.tools)).toContain(workspaceId);
    expect(JSON.stringify(request.tools)).not.toContain("private-local-name");
    expect(JSON.stringify(request)).toContain("UNTRUSTED_WORKSPACE_LABEL_DATA");
    expect(JSON.stringify(request)).toContain("private-local-name");
    expect(JSON.stringify(request.tools)).not.toContain("workspace-write");
  });

  it("advertises create-only Markdown writing only for an explicitly writable Workspace", async () => {
    const workspaceId = crypto.randomUUID();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      streamFrom(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n']),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "test-model", "test-key");
    await collect(provider.run([{ role: "user", content: "write" }], new AbortController().signal, {
      executorBotId: crypto.randomUUID(),
      executionKey: "workspace-write-run",
      workspaces: [{ id: workspaceId, name: "content-team", writeEnabled: true, automationEnabled: true }],
    }));
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      tools: Array<{ function: { name: string; parameters: unknown } }>;
    };
    expect(request.tools.map((tool) => tool.function.name)).toContain("workspace_write");
    expect(JSON.stringify(request.tools.find((tool) => tool.function.name === "workspace_write"))).toContain(workspaceId);
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

describe("Room owner selector", () => {
  const roster = [
    { id: crypto.randomUUID(), name: "策划师", label: "规划", description: "负责产品方案" },
    { id: crypto.randomUUID(), name: "评审员", label: "风险审查", description: "负责质量复核" },
  ];

  it("selects deterministically by public profile fields and otherwise uses roster order", () => {
    expect(selectDeterministicRoomOwner("请做风险审查", roster)).toMatchObject({ ownerAgentId: roster[1]!.id });
    expect(selectDeterministicRoomOwner("一个没有角色提示的问题", roster)).toEqual({
      ownerAgentId: roster[0]!.id,
      reason: "未发现明确匹配，按群聊成员顺序选择。",
    });
  });

  it("uses one structured selector tool without private instructions or credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{
        type: "function",
        function: {
          name: "select_room_owner",
          arguments: JSON.stringify({ ownerAgentId: roster[1]!.id, reason: "与风险审查职责匹配。" }),
        },
      }] } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "test-model", "SECRET_API_KEY");
    await expect(provider.selectRoomOwner("检查风险", roster, new AbortController().signal)).resolves.toEqual({
      ownerAgentId: roster[1]!.id,
      reason: "与风险审查职责匹配。",
    });
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(request).toMatchObject({
      stream: false,
      tool_choice: { type: "function", function: { name: "select_room_owner" } },
    });
    expect(JSON.stringify(request)).not.toContain("SECRET_API_KEY");
    expect(JSON.stringify(request)).not.toContain("instructions");
  });

  it("disables DeepSeek thinking for the structured selector tool", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{
        type: "function",
        function: {
          name: "select_room_owner",
          arguments: JSON.stringify({ ownerAgentId: roster[0]!.id, reason: "职责匹配。" }),
        },
      }] } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://api.deepseek.com/v1", "deepseek-model", "test-key");

    await provider.selectRoomOwner("检查风险", roster, new AbortController().signal);

    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(request).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("reports a refused selector request with only the safe HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider-private-body", { status: 422 })));
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "model", "key");
    await expect(provider.selectRoomOwner("message", roster, new AbortController().signal)).rejects.toMatchObject({
      code: "MODEL_ROUTER_FAILED",
      retryable: false,
      details: { status: 422 },
      message: "无法选择群聊响应 Bot，请重试。",
    });
  });

  it.each([
    ["missing tool", { choices: [{ message: {} }] }],
    ["null choice", { choices: [null] }],
    ["array choice", { choices: [[]] }],
    ["string message", { choices: [{ message: "bad" }] }],
    ["null call", { choices: [{ message: { tool_calls: [null] } }] }],
    ["string function", { choices: [{ message: { tool_calls: [{ type: "function", function: "bad" }] } }] }],
    ["array function", { choices: [{ message: { tool_calls: [{ type: "function", function: [] }] } }] }],
    ["multiple choices", { choices: [{ message: {} }, { message: {} }] }],
    ["multiple tools", { choices: [{ message: { tool_calls: [{}, {}] } }] }],
    ["unknown function", { choices: [{ message: { tool_calls: [{ type: "function", function: { name: "other", arguments: "{}" } }] } }] }],
    ["extra argument", { choices: [{ message: { tool_calls: [{ type: "function", function: { name: "select_room_owner", arguments: JSON.stringify({ ownerAgentId: roster[0]!.id, reason: "ok", extra: true }) } }] } }] }],
    ["nonmember", { choices: [{ message: { tool_calls: [{ type: "function", function: { name: "select_room_owner", arguments: JSON.stringify({ ownerAgentId: crypto.randomUUID(), reason: "ok" }) } }] } }] }],
  ])("fails closed for an invalid selector result: %s", async (_name, payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "model", "key");
    await expect(provider.selectRoomOwner("message", roster, new AbortController().signal)).rejects.toMatchObject({
      code: "MODEL_ROUTER_INVALID",
    });
  });
});

describe("Room continuation selector", () => {
  const executorBotId = crypto.randomUUID();
  const target = { id: crypto.randomUUID(), name: "评审员", label: "质量复核", description: "负责复核交付物" };
  const roster = [
    { id: executorBotId, name: "总控", label: "任务编排", description: "负责分配任务" },
    target,
  ];

  it("turns an explicit immediate assignment into one structured Handoff decision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{
        type: "function",
        function: {
          name: "select_room_continuation",
          arguments: JSON.stringify({
            action: "handoff",
            toAgentId: target.id,
            task: "复核当前交付物。",
            reason: "草稿明确要求评审员现在继续。",
          }),
        },
      }] } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://api.deepseek.com/v1", "test-model", "SECRET_API_KEY");

    await expect(provider.selectRoomContinuation(
      "ASSIGN：请评审员立即复核。",
      executorBotId,
      roster,
      new AbortController().signal,
    )).resolves.toEqual({
      action: "handoff",
      toAgentId: target.id,
      task: "复核当前交付物。",
      contextRefs: [],
      visibility: "room",
      reason: "草稿明确要求评审员现在继续。",
    });

    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      messages: Array<{ content: string }>;
      tools: Array<{ function: { name: string } }>;
      tool_choice: { type: string; function: { name: string } };
      thinking: unknown;
    };
    expect(request.tools.map((tool) => tool.function.name)).toEqual(["select_room_continuation"]);
    expect(request.tool_choice).toEqual({ type: "function", function: { name: "select_room_continuation" } });
    expect(request.thinking).toEqual({ type: "disabled" });
    expect(request.messages[0]!.content).toContain("等待用户批准/输入");
    expect(JSON.stringify(request)).not.toContain("SECRET_API_KEY");
  });

  it("keeps a human approval gate complete without creating a target", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{
        type: "function",
        function: {
          name: "select_room_continuation",
          arguments: JSON.stringify({
            action: "complete",
            toAgentId: "__complete__",
            task: " ",
            reason: "必须先等待用户批准。",
          }),
        },
      }] } }],
    }), { status: 200 })));
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "model", "key");

    await expect(provider.selectRoomContinuation(
      "用户批准后再交给评审员，当前先停止。",
      executorBotId,
      roster,
      new AbortController().signal,
    )).resolves.toEqual({ action: "complete", reason: "必须先等待用户批准。" });
  });

  it("rejects actual task content when a completed route is claimed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{
        type: "function",
        function: {
          name: "select_room_continuation",
          arguments: JSON.stringify({
            action: "complete",
            toAgentId: "__complete__",
            task: "稍后继续执行",
            reason: "当前结束。",
          }),
        },
      }] } }],
    }), { status: 200 })));
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "model", "key");

    await expect(provider.selectRoomContinuation(
      "当前先结束。",
      executorBotId,
      roster,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "MODEL_ROUTER_INVALID" });
  });

  it("fails closed when the selector returns a nonmember target", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{
        type: "function",
        function: {
          name: "select_room_continuation",
          arguments: JSON.stringify({
            action: "handoff",
            toAgentId: crypto.randomUUID(),
            task: "复核",
            reason: "立即复核",
          }),
        },
      }] } }],
    }), { status: 200 })));
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "model", "key");

    await expect(provider.selectRoomContinuation(
      "请评审员立即复核。",
      executorBotId,
      roster,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "MODEL_ROUTER_INVALID" });
  });
});
