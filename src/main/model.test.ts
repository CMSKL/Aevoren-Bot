import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_TIMEOUTS,
  FakeModelProvider,
  isDirectLeadConversationRequest,
  OpenAiCompatibleProvider,
  parseOpenAiStream,
  parseStructuredModelToolCall,
  selectDeterministicRoomOwner,
  structuredModelToolDefinitions,
  type ChatMessage,
  type ModelEvent,
  type ModelRunContext,
  type RoomLeadPlanInput,
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

describe("direct lead conversation requests", () => {
  it.each([
    "你好", "Hi!", "Hello", "大家好。", "你好，产品顾问", "产品顾问，你好！", "Hello 产品顾问!",
    "请介绍一下你自己", "你是谁？", "简单介绍一下你的职责。", "请简短介绍一下你的角色", "请只介绍你自己。",
    "产品顾问，请介绍一下你自己，简洁回答。", "你好，请介绍一下你自己，不代替其他人回答。",
    "你好，请用你配置中的 Bot 名称和负责的领域简短介绍你自己，不介绍其他成员。",
    "Who are you?", "Please introduce yourself.", "Can you briefly introduce yourself?", "Describe your responsibilities.",
    "Hi, please introduce yourself, do not introduce other members.",
  ])("recognizes only the lead's own greeting or introduction: %s", (request) => {
    expect(isDirectLeadConversationRequest(request, "产品顾问")).toBe(true);
  });

  it.each([
    "", "产品顾问", "你好，预算顾问", "请让预算顾问介绍自己。", "介绍一下你和预算顾问。",
    "请介绍其他成员。", "大家分别介绍一下自己。", "请全部成员介绍自己。", "请两位成员分别自我介绍。",
    "你好，请读取 file。", "请介绍一下你自己，然后读取 LICENSE.md。", "你好，/tmp/report", "Hi, C:\\work\\notes",
    "请介绍一下你自己，参考 https://example.com。", "你好，report.csv", "Hi, please call workspace_read.",
    "你好，请联网核验你的介绍。", "你是谁？请安排后续工作。", "请介绍一下你自己；转交预算顾问。",
    "简单介绍一下你的职责，并给出预算建议。", "请介绍一下你自己，再写一篇自我介绍。",
    "一个十人内部会议记录工具准备上线，首月预算有限。先用你配置中的 Bot 名称说明你负责的领域，再给出一条费用控制建议及理由；只介绍你自己，简洁回答。",
    "我们下周上线十人内部使用的会议记录工具。每人先用自己配置中的 Bot 名称说明负责的领域，再各自从本职角度提一条本周能落实的改进建议。只介绍自己，不代替其他人回答，每人简洁回答。",
    "Hello, everyone introduce yourselves.", "Please introduce yourself and the budget adviser.", "Introduce the other members.",
    "Who are you? Then analyze our budget.", "Please introduce yourself, then delegate the task.", "Hi, summarize this report.",
    "Please introduce yourself using the file profile.json.",
  ])("keeps real work, resources and other-member requests out of the direct path: %s", (request) => {
    expect(isDirectLeadConversationRequest(request, "产品顾问")).toBe(false);
  });

  it("uses an exact supplied lead name without interpreting it as a pattern", () => {
    expect(isDirectLeadConversationRequest("Hi, Lead.*", "Lead.*")).toBe(true);
    expect(isDirectLeadConversationRequest("Hi, LeadXYZ", "Lead.*")).toBe(false);
    expect(isDirectLeadConversationRequest("Hello, Lead One", "Lead One")).toBe(true);
    expect(isDirectLeadConversationRequest("Hello, Lead One")).toBe(false);
    expect(isDirectLeadConversationRequest("请介绍一下你自己")).toBe(true);
  });
});

describe("parseOpenAiStream", () => {
  it("limits definitions and rejects tools outside an explicit host allowlist", () => {
    const context = { executorBotId: crypto.randomUUID(), executionKey: "limited", networkTools: true, deviceTools: true, projectTools: true, textMeasureTools: true, supportedToolNames: ["web_search", "web_fetch"] };
    expect(structuredModelToolDefinitions(context).map(tool => tool.name)).toEqual(["web_search", "web_fetch"]);
    expect(() => parseStructuredModelToolCall("forged-time", "time_now", {}, context)).toThrow();
    expect(() => parseStructuredModelToolCall("forged-clipboard", "clipboard_read", { maxCharacters: 10 }, context)).toThrow();
    expect(parseStructuredModelToolCall("allowed-search", "web_search", { query: "public docs" }, context)).toMatchObject({ type: "network-tool", tool: { kind: "web-search", query: "public docs" } });
  });

  it("preserves an explicit Unicode output path and rejects a different filename", () => {
    const workspaceId = crypto.randomUUID();
    const context = { executorBotId: crypto.randomUUID(), executionKey: "unicode-path", workspaces: [{ id: workspaceId, name: "公开资料", writeEnabled: true, automationEnabled: false }], requestedWritePaths: ["01-inbox/个人网站调研.md"] };
    const definition = structuredModelToolDefinitions(context).find(tool => tool.name === "workspace_write")!;
    expect(JSON.stringify(definition.inputSchema)).toContain("01-inbox/个人网站调研.md");
    expect(parseStructuredModelToolCall("unicode-write", "workspace_write", { workspaceId, path: "01-inbox/个人网站调研.md", content: "公开调研结果" }, context)).toMatchObject({ type: "workspace-tool", tool: { path: "01-inbox/个人网站调研.md" } });
    expect(() => parseStructuredModelToolCall("wrong-write", "workspace_write", { workspaceId, path: "  .md", content: "公开结果" }, context)).toThrow();
  });

  it("exposes project creation to supported contexts and rejects forged project or credential fields", async () => {
    const context = { executorBotId: crypto.randomUUID(), executionKey: "project", projectTools: true };
    expect(structuredModelToolDefinitions(context).map((tool) => tool.name)).toEqual(["project_list_bots", "bot_create", "room_create"]);
    expect(parseStructuredModelToolCall("create", "bot_create", { name: "审阅助手" }, context)).toMatchObject({ type: "project-tool", tool: { kind: "bot-create", name: "审阅助手" } });
    expect(() => parseStructuredModelToolCall("create", "bot_create", { name: "审阅助手" }, { ...context, projectTools: false })).toThrow();
    expect(() => parseStructuredModelToolCall("create", "bot_create", { name: "审阅助手", projectId: crypto.randomUUID() }, context)).toThrow();
    expect(() => parseStructuredModelToolCall("create", "bot_create", { name: "审阅助手", apiKey: "not-permitted" }, context)).toThrow();
    const calls = streamFrom([`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "create", type: "function", function: { name: "bot_create", arguments: JSON.stringify({ name: "审阅助手" }) } }] }, finish_reason: "tool_calls" }] })}\n\n`]);
    expect(await collect(parseOpenAiStream(calls, undefined, undefined, undefined, undefined, false, undefined, false, undefined, true))).toContainEqual(expect.objectContaining({ type: "project-tool", tool: expect.objectContaining({ kind: "bot-create" }) }));
  });
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
    expect(await collect(parseOpenAiStream(
      outside, new AbortController().signal, DEFAULT_PROVIDER_TIMEOUTS,
      new Set([target]), new Set([allowedWorkspaceId]),
    ))).toEqual([
      {
        type: "tool-rejection",
        toolCallId: "read",
        providerToolName: "workspace_read",
        arguments: JSON.stringify({ workspaceId: outsideWorkspaceId, path: "secret", maxBytes: 10 }),
        code: "WORKSPACE_SCOPE_INVALID",
        safeMessage: "目标工作区不在当前 Runtime 的授权范围内。请从函数定义提供的 workspaceId 中选择后重试。",
      },
      { type: "completed", finishReason: "tool_calls" },
    ]);

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

  it("returns a corrective tool result for malformed workspace arguments without discarding valid calls", async () => {
    const workspaceId = crypto.randomUUID();
    const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "fetch", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://example.com", maxCharacters: 1000 }) } },
      { index: 1, id: "write", type: "function", function: { name: "workspace_write", arguments: JSON.stringify({ workspaceId, path: "result.md" }) } },
    ] }, finish_reason: "tool_calls" }] })}\n\n`;
    expect(await collect(parseOpenAiStream(
      streamFrom([payload]), new AbortController().signal, DEFAULT_PROVIDER_TIMEOUTS,
      undefined, new Set([workspaceId]), true,
    ))).toEqual([
      {
        type: "network-tool",
        toolCallId: "fetch",
        tool: { kind: "web-fetch", url: "https://example.com", maxCharacters: 1000 },
        providerToolName: "web_fetch",
      },
      {
        type: "tool-rejection",
        toolCallId: "write",
        providerToolName: "workspace_write",
        arguments: JSON.stringify({ workspaceId, path: "result.md" }),
        code: "WORKSPACE_TOOL_ARGUMENTS_INVALID",
        safeMessage: "工作区工具参数不符合函数 Schema。请仅使用声明的字段、类型和边界后重试。",
      },
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

  it("keeps Handoff out of Provider tools so only the Host orchestrator can create another turn", async () => {
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
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("thinking");
    expect(JSON.stringify(request)).not.toContain("SECRET_AGENT_INSTRUCTIONS");
    expect(JSON.stringify(request)).not.toContain("handoff_to_agent");
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
        workspaces: [{ id: crypto.randomUUID(), name: "content", writeEnabled: false, automationEnabled: false }],
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

describe("Room lead plan selector", () => {
  afterEach(() => vi.unstubAllEnvs());
  const executorBotId = crypto.randomUUID();
  const roster = [
    { id: executorBotId, name: "协调者", label: "协调", description: "负责分配和汇总" },
    { id: crypto.randomUUID(), name: "作者", label: "写作", description: "负责写作" },
    { id: crypto.randomUUID(), name: "审阅员", label: "审阅", description: "负责复核" },
  ];
  const assignments = [
    { toAgentId: roster[1]!.id, task: "撰写报告。", dependsOnPrevious: false },
    { toAgentId: roster[2]!.id, task: "审阅上一位作者的报告。", dependsOnPrevious: true },
  ];
  const responsePayload = (args: unknown): unknown => ({
    choices: [{ message: { tool_calls: [{ type: "function", function: {
      name: "select_room_lead_plan", arguments: JSON.stringify(args),
    } }] } }],
  });
  const stubPayload = (payload: unknown): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const provider = (): OpenAiCompatibleProvider => new OpenAiCompatibleProvider("https://api.deepseek.com/v1", "test-model", "SECRET_API_KEY");

  it("returns a bounded ordered decision without dispatching or exposing business tools", async () => {
    const fetchMock = stubPayload(responsePayload({ assignments, reason: "先写作，再审阅。", incompleteReason: null }));
    await expect(provider().selectLeadPlan("请作者先写报告，审阅员随后根据报告复核。", executorBotId, roster, 8, new AbortController().signal))
      .resolves.toEqual({ assignments, reason: "先写作，再审阅。", incompleteReason: null });
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(request).toMatchObject({
      stream: false,
      tool_choice: { type: "function", function: { name: "select_room_lead_plan" } },
      thinking: { type: "disabled" },
    });
    expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(["select_room_lead_plan"]);
    expect(request.tools[0].function.parameters.properties.assignments).toMatchObject({ maxItems: 2 });
    expect(request.tools[0].function.parameters.required).toContain("incompleteReason");
    expect(request.tools[0].function.parameters.properties.incompleteReason).toMatchObject({ type: ["string", "null"], maxLength: 1_000 });
    expect(request.tools[0].function.parameters.properties.assignments.items.properties.toAgentId.enum).toEqual(roster.slice(1).map((peer) => peer.id));
    expect(request.messages[0].content).toContain("必须返回至少一项具体任务");
    expect(request.messages[0].content).toContain("不可信数据");
    expect(request.messages[0].content).toContain("不分发任务");
    expect(JSON.stringify(request)).not.toContain("SECRET_API_KEY");
    expect(JSON.stringify(request)).not.toContain("handoff_to_agent");
  });

  it("sends separate request and draft fields for two workers plus a Host-reserved final summary", async () => {
    const input: RoomLeadPlanInput = {
      rootRequest: "请作者写报告，审阅员读取报告并审阅，最后由协调者汇总两个成员的结果。",
      coordinationDraft: "作者先写报告。\n审阅员随后复核，成员完成后我再汇总。",
    };
    const fetchMock = stubPayload(responsePayload({ assignments, reason: "两项成员任务完整覆盖业务要求，最后汇总由 Host 负责。", incompleteReason: null }));
    await expect(provider().selectLeadPlan(input, executorBotId, roster, 2, new AbortController().signal))
      .resolves.toEqual({ assignments, reason: "两项成员任务完整覆盖业务要求，最后汇总由 Host 负责。", incompleteReason: null });
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(JSON.parse(request.messages[1].content)).toEqual({
      executorBotId, maxAssignments: 2, candidates: roster.slice(1),
      rootRequest: input.rootRequest, coordinationDraft: input.coordinationDraft,
    });
    expect(request.messages[0].content).toContain("协调者最终汇总已由 Host 预留并自动安排，不占 assignments 容量");
    expect(request.messages[0].content).toContain("任务尚未执行不代表计划不完整");
    expect(request.messages[0].content).toContain("不得作为额外任务分配给协调者或其他成员");
    expect(request.tools[0].function.parameters.properties.assignments).toMatchObject({ maxItems: 2, description: expect.stringContaining("Worker business tasks only") });
    expect(request.tools[0].function.parameters.properties.assignments.items.properties.toAgentId.enum).not.toContain(executorBotId);
    expect(request.tools[0].function.parameters.properties.incompleteReason.description).toContain("Use JSON null");
  });

  it("rejects a genuine third worker assignment instead of truncating it as a final summary", async () => {
    const third = { id: crypto.randomUUID(), name: "数据员", label: "数据", description: "负责数据检查" };
    const oversized = [...assignments, { toAgentId: third.id, task: "独立完成用户要求的数据检查。", dependsOnPrevious: false }];
    stubPayload(responsePayload({ assignments: oversized, reason: "三位成员分别执行任务。", incompleteReason: null }));
    await expect(provider().selectLeadPlan({ rootRequest: "请写作、审阅、检查数据，三项完成后协调者汇总。", coordinationDraft: "安排三位成员。" }, executorBotId, [...roster, third], 2, new AbortController().signal))
      .rejects.toMatchObject({ code: "MODEL_ROUTER_INVALID" });
  });

  it("preserves a genuine uncovered-work reason even when two returned assignments fit", async () => {
    const incompleteReason = "另有独立数据检查工作，无法纳入这两项成员任务。";
    stubPayload(responsePayload({ assignments, reason: "完整业务计划超过容量。", incompleteReason }));
    await expect(provider().selectLeadPlan({ rootRequest: "写作、审阅、检查数据三项均须完成。", coordinationDraft: "目前只能安排写作和审阅。" }, executorBotId, roster, 2, new AbortController().signal))
      .resolves.toEqual({ assignments, reason: "完整业务计划超过容量。", incompleteReason });
  });

  it.each(["null", " NULL ", "none", "无"])("rejects the incompleteReason sentinel %j rather than treating it as completion", async (incompleteReason) => {
    stubPayload(responsePayload({ assignments, reason: "两项计划。", incompleteReason }));
    await expect(provider().selectLeadPlan({ rootRequest: "请写作并审阅。", coordinationDraft: "作者先写，审阅员后审。" }, executorBotId, roster, 2, new AbortController().signal))
      .rejects.toMatchObject({ code: "MODEL_ROUTER_INVALID" });
  });

  it.each([
    { rootRequest: "你好", coordinationDraft: "你好！" },
    JSON.stringify({ userRequest: "你好", coordinationDraft: "你好！" }),
    "你好",
  ])("retains no-assignment greetings for typed and legacy inputs: %j", async (input) => {
    const fetchMock = stubPayload(responsePayload({ assignments: [], reason: "问候已回复。", incompleteReason: null }));
    await expect(provider().selectLeadPlan(input, executorBotId, roster, 0, new AbortController().signal))
      .resolves.toEqual({ assignments: [], reason: "问候已回复。", incompleteReason: null });
    await expect(new FakeModelProvider(0).selectLeadPlan(input, executorBotId, roster, 0, new AbortController().signal))
      .resolves.toMatchObject({ assignments: [], incompleteReason: null });
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    const payload = JSON.parse(request.messages[1].content);
    expect(payload).not.toHaveProperty("assistantDraft");
    expect(payload).toMatchObject(input === "你好" ? { rootRequest: "", coordinationDraft: "你好" } : { rootRequest: "你好", coordinationDraft: "你好！" });
  });

  it("allows an empty plan for a response with no member work", async () => {
    stubPayload(responsePayload({ assignments: [], reason: "  只需文字答复。  ", incompleteReason: null }));
    await expect(provider().selectLeadPlan("这条消息无需成员执行。", executorBotId, roster, 2, new AbortController().signal))
      .resolves.toEqual({ assignments: [], reason: "只需文字答复。", incompleteReason: null });
  });

  it("allows a greeting at zero capacity and advertises a zero-item plan schema", async () => {
    const fetchMock = stubPayload(responsePayload({ assignments: [], reason: "问候已直接回复。", incompleteReason: null }));
    await expect(provider().selectLeadPlan(JSON.stringify({ userRequest: "你好", coordinationDraft: "你好！" }), executorBotId, roster, 0, new AbortController().signal))
      .resolves.toEqual({ assignments: [], reason: "问候已直接回复。", incompleteReason: null });
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(request.tools[0].function.parameters.properties.assignments.maxItems).toBe(0);
    expect(request.messages[0].content).toContain("有实际待执行工作则必须返回非空 incompleteReason");
  });

  it.each([0, 1])("reports the missing work when capacity %i cannot cover the full plan", async (capacity) => {
    const incompleteReason = `必须分别写作和审阅，但当前容量只有 ${capacity} 个成员任务；两项工作均未执行。`;
    const fetchMock = stubPayload(responsePayload({ assignments: [], reason: "容量不足，交由 Host 标记未完成。", incompleteReason: `  ${incompleteReason}  ` }));
    await expect(provider().selectLeadPlan("请作者先写报告，审阅员根据报告复核；两项都必须完成。", executorBotId, roster, capacity, new AbortController().signal))
      .resolves.toEqual({ assignments: [], reason: "容量不足，交由 Host 标记未完成。", incompleteReason });
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(request.messages[0].content).toContain("禁止静默截断计划或声称完成");
    expect(request.messages[0].content).toContain("Host 将拒绝执行整个不完整计划");
  });

  it.each([
    ["unknown target", [{ ...assignments[0], toAgentId: crypto.randomUUID() }]],
    ["lead target", [{ ...assignments[0], toAgentId: executorBotId }]],
    ["duplicate target", [assignments[0], assignments[0]]],
    ["first dependency", [{ ...assignments[0], dependsOnPrevious: true }]],
    ["missing dependency", [{ toAgentId: roster[1]!.id, task: "write" }]],
    ["nonboolean dependency", [{ ...assignments[0], dependsOnPrevious: "false" }]],
    ["empty task", [{ ...assignments[0], task: " \n " }]],
    ["oversized task", [{ ...assignments[0], task: "x".repeat(20_001) }]],
    ["extra credential field", [{ ...assignments[0], apiKey: "sensitive" }]],
    ["null assignment", [null]],
    ["missing array", null],
  ])("rejects an invalid plan: %s", async (_name, invalidAssignments) => {
    stubPayload(responsePayload({ assignments: invalidAssignments, reason: "plan", incompleteReason: null }));
    await expect(provider().selectLeadPlan("请执行分工。", executorBotId, roster, 2, new AbortController().signal))
      .rejects.toMatchObject({ code: "MODEL_ROUTER_INVALID" });
  });

  it.each([0, 1])("enforces the caller's assignment budget %i in both schema and parser", async (capacity) => {
    const fetchMock = stubPayload(responsePayload({ assignments, reason: "plan", incompleteReason: null }));
    await expect(provider().selectLeadPlan("请两位执行。", executorBotId, roster, capacity, new AbortController().signal))
      .rejects.toMatchObject({ code: "MODEL_ROUTER_INVALID" });
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(request.tools[0].function.parameters.properties.assignments.maxItems).toBe(capacity);
  });

  it.each([
    ["null payload", null],
    ["missing tool", { choices: [{ message: {} }] }],
    ["multiple choices", { choices: [{ message: {} }, { message: {} }] }],
    ["null choice", { choices: [null] }],
    ["multiple calls", { choices: [{ message: { tool_calls: [{}, {}] } }] }],
    ["wrong function", { choices: [{ message: { tool_calls: [{ type: "function", function: { name: "workspace_read", arguments: "{}" } }] } }] }],
    ["invalid JSON", { choices: [{ message: { tool_calls: [{ type: "function", function: { name: "select_room_lead_plan", arguments: "{" } }] } }] }],
    ["extra plan field", responsePayload({ assignments: [], reason: "plan", incompleteReason: null, dispatched: true })],
    ["empty reason", responsePayload({ assignments: [], reason: " ", incompleteReason: null })],
    ["missing incomplete reason", responsePayload({ assignments: [], reason: "plan" })],
    ["nonstring incomplete reason", responsePayload({ assignments: [], reason: "plan", incompleteReason: false })],
    ["empty incomplete reason", responsePayload({ assignments: [], reason: "plan", incompleteReason: " " })],
    ["oversized incomplete reason", responsePayload({ assignments: [], reason: "plan", incompleteReason: "x".repeat(1_001) })],
  ])("rejects malformed structured response: %s", async (_name, payload) => {
    stubPayload(payload);
    await expect(provider().selectLeadPlan("计划工作。", executorBotId, roster, 2, new AbortController().signal))
      .rejects.toMatchObject({ code: "MODEL_ROUTER_INVALID" });
  });

  it.each([-1, 1.5, NaN])("rejects an invalid assignment limit before contacting the provider: %s", async (limit) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().selectLeadPlan("计划工作。", executorBotId, roster, limit, new AbortController().signal))
      .rejects.toMatchObject({ code: "MODEL_ROUTER_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(new FakeModelProvider(0).selectLeadPlan("你好", executorBotId, roster, limit, new AbortController().signal))
      .rejects.toMatchObject({ code: "MODEL_ROUTER_INVALID" });
  });

  it.each(["coordinate", "summary"] as const)("advertises no tools for a %s turn with empty runtime capabilities", async (roomTurnPurpose) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(streamFrom(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const context: ModelRunContext = {
      executorBotId, executionKey: roomTurnPurpose, roomTurnPurpose, roomLeadBotId: executorBotId,
      roomRoster: roster, workspaces: [], mcpTools: [], networkTools: false, deviceTools: false,
      projectTools: false, textMeasureTools: false,
    };
    expect(structuredModelToolDefinitions(context)).toEqual([]);
    await collect(provider().run([], new AbortController().signal, context));
    const request = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("tool_choice");
  });

  it("provides deterministic fake assignments and keeps coordination away from fake tools and handoffs", async () => {
    vi.stubEnv("AEVOREN_BOT_FAKE_HANDOFF", "first-other");
    vi.stubEnv("AEVOREN_BOT_FAKE_WORKSPACE_TOOL", "read");
    const fake = new FakeModelProvider(0);
    await expect(fake.selectLeadPlan("计划", executorBotId, roster, 1, new AbortController().signal)).resolves.toMatchObject({
      assignments: [{ toAgentId: roster[1]!.id, dependsOnPrevious: false }],
      incompleteReason: null,
    });
    const events = await collect(fake.run([], new AbortController().signal, {
      executorBotId, executionKey: "coordinate", roomTurnPurpose: "coordinate", roomRoster: roster,
      workspaces: [{ id: "workspace", name: "fixture", writeEnabled: true, automationEnabled: true }],
    }));
    expect(events.map((event) => event.type)).toEqual(["started", "delta", "completed"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "delta", text: expect.stringContaining("待 Host 分发") }));
  });

  it("answers simple greetings directly and returns no fake assignments for the JSON root request", async () => {
    const fake = new FakeModelProvider(0);
    for (const userRequest of ["你好", "hi!"]) {
      const events = await collect(fake.run([{ role: "user", content: userRequest }], new AbortController().signal, {
        executorBotId, executionKey: `greeting-${userRequest}`, roomTurnPurpose: "coordinate", roomRoster: roster,
      }));
      expect(events).toContainEqual({ type: "delta", text: "你好！有什么我可以帮忙的？" });
      expect(events.map((event) => event.type)).toEqual(["started", "delta", "completed"]);
      await expect(fake.selectLeadPlan(JSON.stringify({ userRequest, coordinationDraft: "问候已回复。" }), executorBotId, roster, 2, new AbortController().signal))
        .resolves.toMatchObject({ assignments: [], incompleteReason: null });
    }
    const plan = await fake.selectLeadPlan(JSON.stringify({ userRequest: "你好，请读取数据文件。", coordinationDraft: "你好！" }), executorBotId, roster, 2, new AbortController().signal);
    expect(plan.assignments).toHaveLength(2);
  });

  it("uses the root self-introduction request even when the draft mentions or proposes another member", async () => {
    const fake = new FakeModelProvider(0);
    const rootRequest = "你好，请用你配置中的 Bot 名称和负责的领域简短介绍你自己，不介绍其他成员。";
    await expect(fake.selectLeadPlan({ rootRequest, coordinationDraft: "我是协调者。请审阅员接着介绍自己的职责。" }, executorBotId, roster, 2, new AbortController().signal))
      .resolves.toMatchObject({ assignments: [], incompleteReason: null });
    await expect(fake.selectLeadPlan({ rootRequest: "你好，协调者", coordinationDraft: "作者负责写作。" }, executorBotId, roster, 0, new AbortController().signal))
      .resolves.toMatchObject({ assignments: [], incompleteReason: null });
    const events = await collect(fake.run([{ role: "user", content: rootRequest }], new AbortController().signal, {
      executorBotId, executionKey: "lead-introduction", roomTurnPurpose: "coordinate", roomRoster: roster,
    }));
    expect(events).toContainEqual({ type: "delta", text: "我是协调者，负责分配和汇总" });
    expect(events.some((event) => event.type === "handoff")).toBe(false);
  });

  it("does not infer a direct conversation from the draft when the root asks for work or is unavailable", async () => {
    const fake = new FakeModelProvider(0);
    for (const rootRequest of ["你好，请读取文件并形成报告。", "请每位成员分别介绍自己。", ""]) {
      const plan = await fake.selectLeadPlan({ rootRequest, coordinationDraft: "你好！我是协调者。" }, executorBotId, roster, 2, new AbortController().signal);
      expect(plan.assignments).toHaveLength(2);
    }
  });

  it("keeps fake greetings complete at zero capacity while reporting unexecuted member work", async () => {
    const fake = new FakeModelProvider(0);
    await expect(fake.selectLeadPlan(JSON.stringify({ userRequest: "hi", coordinationDraft: "你好！" }), executorBotId, roster, 0, new AbortController().signal))
      .resolves.toMatchObject({ assignments: [], incompleteReason: null });
    await expect(fake.selectLeadPlan(JSON.stringify({ userRequest: "读取文件并写报告。", coordinationDraft: "计划工作。" }), executorBotId, roster, 0, new AbortController().signal))
      .resolves.toMatchObject({ assignments: [], incompleteReason: "当前容量为零，用户请求中的成员工作尚未执行。" });
  });

  it("uses actual Host result states in the fake summary", async () => {
    vi.stubEnv("AEVOREN_BOT_FAKE_HANDOFF", "first-other");
    vi.stubEnv("AEVOREN_BOT_FAKE_WORKSPACE_TOOL", "read");
    const fake = new FakeModelProvider(0);
    const events = await collect(fake.run([], new AbortController().signal, {
      executorBotId, executionKey: "summary", roomTurnPurpose: "summary", roomRoster: roster,
      workspaces: [{ id: "workspace", name: "fixture", writeEnabled: true, automationEnabled: true }],
      roomRunSummary: {
        runId: "run", leadBotId: executorBotId, request: { entryId: "request", text: "完成报告" }, coordinationErrorCode: "PLAN_FAILED",
        results: [{ turnId: "turn", logicalTurnId: "logical", agentId: roster[1]!.id, agentName: "作者", turnPurpose: "work", state: "failed", errorCode: "WORKSPACE_SCOPE_INVALID", outcome: null, body: "", assistantEntryId: null, artifacts: [] }],
      },
    }));
    expect(events.map((event) => event.type)).toEqual(["started", "delta", "completed"]);
    expect(events).toContainEqual({ type: "delta", text: expect.stringContaining("作者：未完成") });
    expect(events).toContainEqual({ type: "delta", text: expect.stringContaining("任务安排未完成") });
    expect(JSON.stringify(events)).not.toMatch(/WORKSPACE_SCOPE_INVALID|PLAN_FAILED|Host|Runtime/);
  });
});

describe("fixed-plan work handoff correction", () => {
  const call = (name: string, args: string, id = "call-extra") => ({ index: 0, id, type: "function", function: { name, arguments: args } });
  const parsePlanned = (stream: ReadableStream<Uint8Array>): AsyncIterable<ModelEvent> => parseOpenAiStream(
    stream, undefined, undefined, undefined, undefined, false, undefined, false, undefined, false, true,
  );
  const toolResponse = (name: string, args: unknown, id: string): Response => new Response(streamFrom([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call(name, JSON.stringify(args), id)] }, finish_reason: "tool_calls" }] })}\n\n`,
  ]), { status: 200 });

  it.each(["finish-reason", "done", "buffered-finish"])("corrects an out-of-plan legacy handoff at the %s boundary without dispatching", async (terminal) => {
    const args = JSON.stringify({ agentId: "outside-member", message: "继续执行", contextRefs: { legacy: true }, visibility: "direct" });
    const data = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call("handoff_to_agent", args)] }, ...(terminal === "done" ? {} : { finish_reason: "tool_calls" }) }] })}`;
    const wire = terminal === "done" ? `${data}\n\ndata: [DONE]\n\n` : `${data}${terminal === "buffered-finish" ? "" : "\n\n"}`;
    const split = Math.floor(wire.length / 2);
    const events = await collect(parsePlanned(streamFrom([wire.slice(0, split), wire.slice(split)])));
    expect(events).toContainEqual({
      type: "tool-rejection", toolCallId: "call-extra", providerToolName: "handoff_to_agent", arguments: args,
      code: "ROOM_HANDOFF_DISABLED", safeMessage: "后续成员已由应用安排。请完成当前成员自己的回复，不要执行或声称额外转交。",
    });
    expect(events.at(-1)).toEqual({ type: "completed", finishReason: terminal === "done" ? "done" : "tool_calls" });
    expect(events.some((event) => event.type === "handoff")).toBe(false);
  });

  it.each([
    ["unknown function", call("invented_tool", "{}"), "MODEL_HANDOFF_INVALID"],
    ["invalid JSON", call("handoff_to_agent", "{"), "MODEL_HANDOFF_INVALID"],
    ["array arguments", call("handoff_to_agent", "[]"), "MODEL_HANDOFF_INVALID"],
    ["null arguments", call("handoff_to_agent", "null"), "MODEL_HANDOFF_INVALID"],
    ["missing arguments", call("handoff_to_agent", ""), "MODEL_HANDOFF_INVALID"],
    ["missing call ID", call("handoff_to_agent", "{}", ""), "MODEL_HANDOFF_INVALID"],
    ["oversized call ID", call("handoff_to_agent", "{}", "x".repeat(201)), "MODEL_HANDOFF_INVALID"],
    ["oversized JSON", call("handoff_to_agent", JSON.stringify({ message: "x".repeat(300_000) })), "MODEL_HANDOFF_INVALID"],
    ["wrong call type", { ...call("handoff_to_agent", "{}"), type: "other" }, "MODEL_HANDOFF_INVALID"],
    ["disabled network tool", call("web_fetch", "{}"), "MODEL_NETWORK_TOOL_INVALID"],
  ])("preserves strict validation for %s in planned work", async (_name, toolCall, code) => {
    const stream = streamFrom([`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: "tool_calls" }] })}\n\n`]);
    await expect(collect(parsePlanned(stream))).rejects.toMatchObject({ code });
  });

  it.each([
    { roomTurnPurpose: "work" as const },
    { roomTurnPurpose: "summary" as const, roomLeadBotId: "lead" },
    { roomTurnPurpose: "coordinate" as const, roomLeadBotId: "lead" },
    { roomLeadBotId: "lead" },
  ])("does not enable retired handoff correction outside fixed-plan work: %j", async (scope) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResponse("handoff_to_agent", { toAgentId: "peer", task: "继续" }, "handoff")));
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "model", "key");
    await expect(collect(provider.run([], new AbortController().signal, { executorBotId: "worker", executionKey: "scope", ...scope })))
      .rejects.toMatchObject({ code: "MODEL_HANDOFF_INVALID" });
  });

  it("continues after successful read/write tool results and a retired handoff decoded from API SSE", async () => {
    const workspaceId = crypto.randomUUID();
    const retiredArgs = { recipient: "retired-agent-outside-roster", instructions: "继续发布编辑任务。", contextRefs: "legacy-format" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(toolResponse("workspace_read", { workspaceId, path: "LICENSE.md", maxBytes: 65_536 }, "read-license"))
      .mockResolvedValueOnce(toolResponse("workspace_write", { workspaceId, path: "license-note.md", content: "# Apache License 2.0\n许可证摘要。" }, "write-note"))
      .mockResolvedValueOnce(toolResponse("handoff_to_agent", retiredArgs, "retired-handoff"))
      .mockResolvedValueOnce(new Response(streamFrom(['data: {"choices":[{"index":0,"delta":{"content":"已读取 LICENSE.md，并保存 license-note.md。"},"finish_reason":"stop"}]}\n\n']), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatibleProvider("https://example.com/v1", "model", "key");
    const context: ModelRunContext = {
      executorBotId: crypto.randomUUID(), executionKey: "planned-license-work", roomLeadBotId: crypto.randomUUID(), roomTurnPurpose: "work",
      workspaces: [{ id: workspaceId, name: "fixture", writeEnabled: true, automationEnabled: true }],
    };
    const messages: ChatMessage[] = [{ role: "user", content: "读取 LICENSE.md 并写入 license-note.md，后续成员已由应用安排。" }];
    const allEvents: ModelEvent[] = [];
    for (let round = 0; round < 4; round += 1) {
      const events = await collect(provider.run(messages, new AbortController().signal, context));
      allEvents.push(...events);
      const event = events.find((candidate) => candidate.type === "workspace-tool" || candidate.type === "tool-rejection");
      if (event?.type === "workspace-tool") {
        const { kind, ...args } = event.tool;
        messages.push({ role: "assistant", content: "", tool_calls: [{ id: event.toolCallId, type: "function", function: { name: event.providerToolName!, arguments: JSON.stringify(args) } }] });
        messages.push({ role: "tool", tool_call_id: event.toolCallId, content: JSON.stringify(kind === "workspace-read"
          ? { ok: true, content: "Apache License 2.0", truncated: false }
          : { ok: true, path: "license-note.md", created: true }) });
      } else if (event?.type === "tool-rejection") {
        messages.push({ role: "assistant", content: "", tool_calls: [{ id: event.toolCallId, type: "function", function: { name: event.providerToolName, arguments: event.arguments } }] });
        messages.push({ role: "tool", tool_call_id: event.toolCallId, content: JSON.stringify({ ok: false, code: event.code, safeMessage: event.safeMessage }) });
      }
    }
    expect(allEvents.filter((event) => event.type === "workspace-tool").map((event) => event.tool.kind)).toEqual(["workspace-read", "workspace-write"]);
    expect(allEvents.filter((event) => event.type === "tool-rejection")).toEqual([expect.objectContaining({ code: "ROOM_HANDOFF_DISABLED", arguments: JSON.stringify(retiredArgs) })]);
    expect(allEvents.some((event) => event.type === "handoff")).toBe(false);
    expect(allEvents.at(-2)).toEqual({ type: "delta", text: "已读取 LICENSE.md，并保存 license-note.md。" });
    expect(allEvents.at(-1)).toEqual({ type: "completed", finishReason: "stop" });
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as { messages: ChatMessage[]; tools: Array<{ function: { name: string } }> });
    expect(requests.every((request) => request.tools.every((tool) => tool.function.name !== "handoff_to_agent"))).toBe(true);
    expect(requests[3]!.messages.filter((message) => message.role === "tool")).toEqual([
      expect.objectContaining({ tool_call_id: "read-license", content: expect.stringContaining('"ok":true') }),
      expect.objectContaining({ tool_call_id: "write-note", content: expect.stringContaining('"created":true') }),
      expect.objectContaining({ tool_call_id: "retired-handoff", content: expect.stringContaining("ROOM_HANDOFF_DISABLED") }),
    ]);
  });
});
