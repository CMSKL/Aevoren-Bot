import { describe, expect, it } from "vitest";
import {
  botHiddenSchema,
  botPinnedSchema,
  botUnreadSchema,
  conversationBatchDeleteSchema,
  approvalResolutionSchema,
  generalSettingsSchema,
  memoryCreateSchema,
  memoryListSchema,
  memoryMutationSchema,
  memoryUpdateSchema,
  modelSelectionSchema,
  roomCreateSchema,
  roomHiddenSchema,
  roomPinnedSchema,
  roomSendCommandSchema,
  roomUnreadSchema,
  saveCliProviderSchema,
  saveOpenAiCompatibleProviderSchema,
  toolInvocationCommandSchema,
  toolSessionScopeSchema,
  workspaceRelativePathSchema,
} from "./schemas";

describe("General settings schema", () => {
  it("accepts only declared appearance themes", () => {
    expect(generalSettingsSchema.parse({ theme: "system" })).toEqual({ theme: "system" });
    expect(generalSettingsSchema.safeParse({ theme: "sepia" }).success).toBe(false);
    expect(generalSettingsSchema.safeParse({ theme: "dark", extra: true }).success).toBe(false);
  });
});

describe("Bot sidebar action schemas", () => {
  const id = crypto.randomUUID();

  it("accepts a UUID with an explicit boolean and rejects malformed action inputs", () => {
    for (const [schema, key] of [
      [botPinnedSchema, "pinned"],
      [botUnreadSchema, "unread"],
      [botHiddenSchema, "hidden"],
    ] as const) {
      expect(schema.safeParse({ id, [key]: true }).success).toBe(true);
      expect(schema.safeParse({ id: "not-a-uuid", [key]: true }).success).toBe(false);
      expect(schema.safeParse({ id, [key]: "true" }).success).toBe(false);
      expect(schema.safeParse({ id }).success).toBe(false);
    }
  });
});

describe("Conversation batch delete schema", () => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();

  it("accepts unique mixed targets and rejects single, duplicate, malformed, or undeclared inputs", () => {
    expect(conversationBatchDeleteSchema.parse({ botIds: [first], roomIds: [second] })).toEqual({
      botIds: [first],
      roomIds: [second],
    });
    expect(conversationBatchDeleteSchema.safeParse({ botIds: [first], roomIds: [] }).success).toBe(false);
    expect(conversationBatchDeleteSchema.safeParse({ botIds: [first, first], roomIds: [] }).success).toBe(false);
    expect(conversationBatchDeleteSchema.safeParse({ botIds: ["bad", second], roomIds: [] }).success).toBe(false);
    expect(conversationBatchDeleteSchema.safeParse({ botIds: [first], roomIds: [second], force: true }).success).toBe(false);
  });
});

describe("Memory schemas", () => {
  const botId = crypto.randomUUID();
  const id = crypto.randomUUID();

  it("accepts valid inputs and rejects undeclared policy fields", () => {
    expect(memoryListSchema.parse({ botId, includeDeleted: true })).toEqual({ botId, includeDeleted: true });
    expect(memoryCreateSchema.parse({ botId, content: "  可核验事实  " })).toEqual({ botId, content: "可核验事实" });
    expect(memoryUpdateSchema.parse({ id, expectedVersion: 1, content: "更新事实" })).toEqual({ id, expectedVersion: 1, content: "更新事实" });
    expect(memoryMutationSchema.parse({ id, expectedVersion: 2 })).toEqual({ id, expectedVersion: 2 });
    expect(memoryListSchema.safeParse({ botId, includeOtherBots: true }).success).toBe(false);
    expect(memoryCreateSchema.safeParse({ botId, content: "事实", autoSynthesize: true }).success).toBe(false);
    expect(memoryUpdateSchema.safeParse({ id, expectedVersion: 1, content: "事实", force: true }).success).toBe(false);
    expect(memoryMutationSchema.safeParse({ id, expectedVersion: 2, hardDelete: true }).success).toBe(false);
  });

  it("rejects empty, oversized and malformed inputs", () => {
    expect(memoryCreateSchema.safeParse({ botId, content: "   " }).success).toBe(false);
    expect(memoryCreateSchema.safeParse({ botId, content: "x".repeat(4001) }).success).toBe(false);
    expect(memoryCreateSchema.safeParse({ botId: "bad", content: "事实" }).success).toBe(false);
    expect(memoryUpdateSchema.safeParse({ id, expectedVersion: 0, content: "事实" }).success).toBe(false);
    expect(memoryMutationSchema.safeParse({ id: "bad", expectedVersion: 1 }).success).toBe(false);
  });
});

describe("Approval and Tool Journal schemas", () => {
  const runtimeRunId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();

  it.each([
    { kind: "workspace-list", workspaceId, path: "", maxEntries: 500 },
    { kind: "workspace-read", workspaceId, path: "docs/spec.md", maxBytes: 1_048_576 },
    { kind: "workspace-search", workspaceId, path: "src", query: "Memory", maxMatches: 200 },
  ])("accepts the bounded $kind request", (tool) => {
    expect(toolInvocationCommandSchema.safeParse({
      runtimeRunId,
      toolCallId: "call-1",
      idempotencyKey,
      tool,
    }).success).toBe(true);
  });

  it.each([
    "/etc/passwd",
    "../secret",
    "docs/../secret",
    "./docs",
    "docs//secret",
    "docs\\secret",
    "docs\0secret",
  ])("rejects unsafe relative path %s", (path) => {
    expect(workspaceRelativePathSchema.safeParse(path).success).toBe(false);
  });

  it("rejects limits and undeclared execution or policy fields", () => {
    expect(toolInvocationCommandSchema.safeParse({
      runtimeRunId,
      toolCallId: "call-1",
      idempotencyKey,
      tool: { kind: "workspace-read", workspaceId, path: "file", maxBytes: 0 },
    }).success).toBe(false);
    expect(toolInvocationCommandSchema.safeParse({
      runtimeRunId,
      toolCallId: "call-1",
      idempotencyKey,
      autoApprove: true,
      tool: { kind: "workspace-list", workspaceId, path: "", maxEntries: 1 },
    }).success).toBe(false);
    expect(toolInvocationCommandSchema.safeParse({
      runtimeRunId,
      toolCallId: "call-1",
      idempotencyKey,
      tool: { kind: "workspace-search", workspaceId, path: "", query: "", maxMatches: 1 },
    }).success).toBe(false);
    expect(approvalResolutionSchema.safeParse({
      sessionId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      expectedVersion: 1,
      resolution: "always-allow",
    }).success).toBe(false);
    expect(toolSessionScopeSchema.safeParse({ sessionId: crypto.randomUUID(), includeAll: true }).success).toBe(false);
  });
});

describe("Provider configuration schemas", () => {
  const providerBase = { instanceId: "openai-compatible.default", expectedVersion: 1 };

  it.each([
    "https://api.example.com/v1",
    "http://localhost:8080/v1",
    "http://127.0.0.1:8080/v1",
    "http://[::1]:8080/v1",
  ])("accepts the allowed provider URL %s", (baseUrl) => {
    expect(saveOpenAiCompatibleProviderSchema.safeParse({ ...providerBase, baseUrl }).success).toBe(true);
  });

  it.each([
    "http://api.example.com/v1",
    "ftp://localhost/v1",
    "https://user:password@api.example.com/v1",
    "http://user:password@localhost:8080/v1",
  ])("rejects the disallowed provider URL %s", (baseUrl) => {
    expect(saveOpenAiCompatibleProviderSchema.safeParse({ ...providerBase, baseUrl }).success).toBe(false);
  });

  it("enforces URL, model selection, and CLI path boundaries", () => {
    const prefix = "https://example.com/";
    const maximumUrl = prefix + "a".repeat(2_048 - prefix.length);
    expect(maximumUrl).toHaveLength(2_048);
    expect(saveOpenAiCompatibleProviderSchema.safeParse({ ...providerBase, baseUrl: maximumUrl }).success).toBe(true);
    expect(saveOpenAiCompatibleProviderSchema.safeParse({ ...providerBase, baseUrl: maximumUrl + "a" }).success).toBe(false);
    expect(modelSelectionSchema.safeParse({ providerInstanceId: "codex.default", modelId: "m".repeat(200) }).success).toBe(true);
    expect(modelSelectionSchema.safeParse({ providerInstanceId: "bad id", modelId: "model" }).success).toBe(false);
    expect(modelSelectionSchema.safeParse({ providerInstanceId: "codex.default", modelId: "m".repeat(201) }).success).toBe(false);
    expect(saveCliProviderSchema.safeParse({ instanceId: "codex.default", expectedVersion: 1, cliPath: "/opt/homebrew/bin/codex" }).success).toBe(true);
    expect(saveCliProviderSchema.safeParse({ instanceId: "codex.default", expectedVersion: 1, cliPath: "codex\nrm" }).success).toBe(false);
  });
});

describe("Room schemas", () => {
  const ids = Array.from({ length: 7 }, () => crypto.randomUUID());

  it("accepts 2 to 6 unique Room members and rejects every invalid boundary", () => {
    expect(roomCreateSchema.safeParse({ memberBotIds: ids.slice(0, 2) }).success).toBe(true);
    expect(roomCreateSchema.safeParse({ memberBotIds: ids.slice(0, 6) }).success).toBe(true);
    expect(roomCreateSchema.safeParse({ memberBotIds: [] }).success).toBe(false);
    expect(roomCreateSchema.safeParse({ memberBotIds: ids.slice(0, 1) }).success).toBe(false);
    expect(roomCreateSchema.safeParse({ memberBotIds: ids }).success).toBe(false);
    expect(roomCreateSchema.safeParse({ memberBotIds: [ids[0], ids[0]] }).success).toBe(false);
  });

  it("requires a Room UUID and explicit boolean for sidebar state changes", () => {
    const id = crypto.randomUUID();
    expect(roomPinnedSchema.safeParse({ id, pinned: true }).success).toBe(true);
    expect(roomUnreadSchema.safeParse({ id, unread: false }).success).toBe(true);
    expect(roomHiddenSchema.safeParse({ id, hidden: true }).success).toBe(true);
    expect(roomPinnedSchema.safeParse({ id: "bad", pinned: true }).success).toBe(false);
    expect(roomUnreadSchema.safeParse({ id, unread: "true" }).success).toBe(false);
    expect(roomHiddenSchema.safeParse({ id, hidden: "true" }).success).toBe(false);
  });

  it("strictly separates automatic, explicit, and everyone routing", () => {
    const base = {
      roomId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      clientNonce: crypto.randomUUID(),
      text: "message",
    };
    expect(roomSendCommandSchema.safeParse({ ...base, routingMode: "automatic", targetBotIds: [] }).success).toBe(true);
    expect(roomSendCommandSchema.safeParse({ ...base, routingMode: "explicit", targetBotIds: ids.slice(0, 1) }).success).toBe(true);
    expect(roomSendCommandSchema.safeParse({ ...base, routingMode: "everyone", targetBotIds: ids.slice(0, 6) }).success).toBe(true);
    expect(roomSendCommandSchema.safeParse({ ...base, routingMode: "automatic", targetBotIds: ids.slice(0, 1) }).success).toBe(false);
    expect(roomSendCommandSchema.safeParse({ ...base, routingMode: "explicit", targetBotIds: [] }).success).toBe(false);
    expect(roomSendCommandSchema.safeParse({ ...base, routingMode: "legacy", targetBotIds: ids.slice(0, 1) }).success).toBe(false);
    expect(roomSendCommandSchema.safeParse({ ...base, routingMode: "everyone", targetBotIds: ids }).success).toBe(false);
    expect(roomSendCommandSchema.safeParse({ ...base, routingMode: "explicit", targetBotIds: [ids[0], ids[0]] }).success).toBe(false);
    expect(roomSendCommandSchema.safeParse({ ...base, targetBotIds: ids.slice(0, 1) }).success).toBe(false);
  });

  it("does not expose coordinated-run policy controls to the Renderer", () => {
    const parsed = roomSendCommandSchema.parse({
      roomId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      clientNonce: crypto.randomUUID(),
      text: "message",
      targetBotIds: ids.slice(0, 1),
      routingMode: "explicit",
      maxTurns: 999,
      deadlineMs: Number.MAX_SAFE_INTEGER,
    });
    expect(parsed).not.toHaveProperty("maxTurns");
    expect(parsed).not.toHaveProperty("deadlineMs");
  });
});
