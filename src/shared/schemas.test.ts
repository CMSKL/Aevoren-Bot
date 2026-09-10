import { describe, expect, it } from "vitest";
import { modelConfigurationSchema } from "./schemas";

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
