import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_TIMEOUTS,
  OpenAiCompatibleProvider,
  parseOpenAiStream,
  selectDeterministicRoomOwner,
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
      { type: "workspace-tool", toolCallId: "read-1", tool: { kind: "workspace-read", workspaceId, path: "docs/spec.md", maxBytes: 4096 } },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("fails closed for out-of-scope and mixed workspace tool calls", async () => {
    const allowedWorkspaceId = crypto.randomUUID();
    const outsideWorkspaceId = crypto.randomUUID();
    const target = crypto.randomUUID();
    const cases = [
      [{ index: 0, id: "read", type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ workspaceId: outsideWorkspaceId, path: "secret", maxBytes: 10 }) } }],
      [
        { index: 0, id: "read", type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ workspaceId: allowedWorkspaceId, path: "safe", maxBytes: 10 }) } },
        { index: 1, id: "handoff", type: "function", function: { name: "handoff_to_agent", arguments: JSON.stringify({ toAgentId: target, task: "review", contextRefs: [], visibility: "room" }) } },
      ],
    ];
    for (const toolCalls of cases) {
      const stream = streamFrom([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: "tool_calls" }] })}\n\n`,
      ]);
      await expect(collect(parseOpenAiStream(
        stream,
        new AbortController().signal,
        DEFAULT_PROVIDER_TIMEOUTS,
        new Set([target]),
        new Set([allowedWorkspaceId]),
      ))).rejects.toMatchObject({ code: "MODEL_WORKSPACE_TOOL_INVALID" });
    }
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

  it.each([
    ["missing id", [{ index: 0, type: "function", function: { name: "handoff_to_agent", arguments: "{}" } }]],
    ["unknown function", [{ index: 0, id: "call", type: "function", function: { name: "other_tool", arguments: "{}" } }]],
    ["invalid json", [{ index: 0, id: "call", type: "function", function: { name: "handoff_to_agent", arguments: "{" } }]],
    ["too many calls", Array.from({ length: 3 }, (_, index) => ({ index, id: `call-${index}`, type: "function", function: { name: "handoff_to_agent", arguments: "{}" } }))],
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
    ["nonmember target", () => ({ toAgentId: crypto.randomUUID(), task: "task", contextRefs: [], visibility: "room" })],
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
    expect(request.tools?.[0]?.function.description).not.toContain("评审员");
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
      workspaces: [{ id: workspaceId, name: "private-local-name" }],
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
      tool_choice: "auto",
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
      tool_choice: string;
      thinking: unknown;
    };
    expect(request.tools.map((tool) => tool.function.name)).toEqual(["select_room_continuation"]);
    expect(request.tool_choice).toBe("auto");
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
            task: "",
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
