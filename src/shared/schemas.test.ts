import { describe, expect, it } from "vitest";
import { modelConfigurationSchema, roomCreateSchema, roomSendCommandSchema } from "./schemas";

describe("modelConfigurationSchema", () => {
  const validModel = { modelId: "model" };

  it.each([
    "https://api.example.com/v1",
    "http://localhost:8080/v1",
    "http://127.0.0.1:8080/v1",
    "http://[::1]:8080/v1",
  ])("accepts the allowed provider URL %s", (baseUrl) => {
    expect(modelConfigurationSchema.safeParse({ ...validModel, baseUrl }).success).toBe(true);
  });

  it.each([
    "http://api.example.com/v1",
    "ftp://localhost/v1",
    "https://user:password@api.example.com/v1",
    "http://user:password@localhost:8080/v1",
  ])("rejects the disallowed provider URL %s", (baseUrl) => {
    expect(modelConfigurationSchema.safeParse({ ...validModel, baseUrl }).success).toBe(false);
  });

  it("enforces URL and Model ID length boundaries", () => {
    const prefix = "https://example.com/";
    const maximumUrl = prefix + "a".repeat(2_048 - prefix.length);
    expect(maximumUrl).toHaveLength(2_048);
    expect(modelConfigurationSchema.safeParse({ baseUrl: maximumUrl, modelId: "m".repeat(200) }).success).toBe(true);
    expect(modelConfigurationSchema.safeParse({ baseUrl: maximumUrl + "a", modelId: "model" }).success).toBe(false);
    expect(modelConfigurationSchema.safeParse({ baseUrl: "https://example.com/v1", modelId: "m".repeat(201) }).success).toBe(false);
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

  it("accepts 1 to 6 unique target members and validates command identity", () => {
    const base = {
      roomId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      clientNonce: crypto.randomUUID(),
      text: "message",
    };
    expect(roomSendCommandSchema.safeParse({ ...base, targetBotIds: ids.slice(0, 1) }).success).toBe(true);
    expect(roomSendCommandSchema.safeParse({ ...base, targetBotIds: ids.slice(0, 6) }).success).toBe(true);
    expect(roomSendCommandSchema.safeParse({ ...base, targetBotIds: [] }).success).toBe(false);
    expect(roomSendCommandSchema.safeParse({ ...base, targetBotIds: ids }).success).toBe(false);
    expect(roomSendCommandSchema.safeParse({ ...base, targetBotIds: [ids[0], ids[0]] }).success).toBe(false);
  });
});
