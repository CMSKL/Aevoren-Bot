import { afterEach, describe, expect, it } from "vitest";
import { AppRepository } from "./database";
import { GeneralSettingsService, ModelSettingsService, type SecretCodec } from "./settings";

const repositories: AppRepository[] = [];

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
});

const codec: SecretCodec = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(value, "utf8").toString("base64"),
  decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
};

describe("ModelSettingsService", () => {
  it("stores only an encrypted API key and never returns it to the renderer contract", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new ModelSettingsService(repository, codec);
    const configuration = service.saveConfiguration({
      baseUrl: "https://example.com/v1/",
      modelId: "test-model",
      apiKey: "secret-value",
    });
    expect(configuration).toEqual({
      baseUrl: "https://example.com/v1",
      modelId: "test-model",
      apiKeyConfigured: true,
    });
    expect(repository.getSetting("model.apiKey")?.value).not.toContain("secret-value");
    expect(service.getApiKey()).toBe("secret-value");
  });

  it("fails closed when secure storage is unavailable", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new ModelSettingsService(repository, { ...codec, isAvailable: () => false });
    expect(() =>
      service.saveConfiguration({ baseUrl: "https://example.com/v1", modelId: "test", apiKey: "secret" }),
    ).toThrowError(expect.objectContaining({ code: "SECURE_STORAGE_UNAVAILABLE" }));
    expect(repository.getSetting("model.apiKey")).toBeNull();
  });

  it("maps safeStorage decryption failures to a stable storage error", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    new ModelSettingsService(repository, codec).saveConfiguration({
      baseUrl: "https://example.com/v1",
      modelId: "test",
      apiKey: "secret",
    });
    const service = new ModelSettingsService(repository, {
      ...codec,
      decrypt: () => { throw new Error("native decryption failed"); },
    });
    expect(() => service.getApiKey()).toThrowError(expect.objectContaining({ code: "SECURE_STORAGE_UNAVAILABLE" }));
  });
});

describe("GeneralSettingsService", () => {
  it("defaults to the system theme and persists an explicit appearance choice", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new GeneralSettingsService(repository);
    expect(service.getConfiguration()).toEqual({ theme: "system" });
    expect(service.saveConfiguration({ theme: "dark" })).toEqual({ theme: "dark" });
    expect(new GeneralSettingsService(repository).getConfiguration()).toEqual({ theme: "dark" });
    expect(repository.getSetting("appearance.theme")).toMatchObject({ value: "dark", encrypted: false });
  });

  it("falls back safely when a stored theme is unknown", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    repository.setSetting("appearance.theme", "future-theme", false);
    expect(new GeneralSettingsService(repository).getConfiguration()).toEqual({ theme: "system" });
  });
});
