import { afterEach, describe, expect, it } from "vitest";
import { AppRepository } from "./database";
import { GeneralSettingsService } from "./settings";

const repositories: AppRepository[] = [];

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
});

describe("GeneralSettingsService", () => {
  it("defaults to the system theme and persists an explicit appearance choice", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new GeneralSettingsService(repository);
    expect(service.getConfiguration()).toEqual({
      theme: "system", memoryCaptureEnabled: true, autoApprovePublicReadTools: false,
      launchAtLogin: false, launchAtLoginSupported: false, launchAtLoginStatus: "unsupported",
    });
    expect(service.saveConfiguration({ theme: "dark" })).toMatchObject({ theme: "dark" });
    expect(new GeneralSettingsService(repository).getConfiguration()).toMatchObject({ theme: "dark" });
    expect(repository.getSetting("appearance.theme")).toMatchObject({ value: "dark", encrypted: false });
    expect(service.saveConfiguration({ memoryCaptureEnabled: false })).toMatchObject({ memoryCaptureEnabled: false });
    expect(repository.getSetting("memory.capture.enabled")).toMatchObject({ value: "false", encrypted: false });
    expect(service.saveConfiguration({ autoApprovePublicReadTools: true })).toMatchObject({ autoApprovePublicReadTools: true });
    expect(repository.getSetting("tools.autoApprovePublicRead")).toMatchObject({ value: "true", encrypted: false });
  });

  it("falls back safely when a stored theme is unknown", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    repository.setSetting("appearance.theme", "future-theme", false);
    expect(new GeneralSettingsService(repository).getConfiguration()).toMatchObject({ theme: "system" });
  });

  it("uses the operating system as the authority for launch-at-login and never writes it to SQLite", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    let openAtLogin = false;
    let writes = 0;
    const service = new GeneralSettingsService(repository, {
      supported: true,
      get: () => ({ openAtLogin, status: openAtLogin ? "enabled" : "not-registered" }),
      set: (next) => { writes += 1; openAtLogin = next; },
    });
    expect(service.getConfiguration()).toMatchObject({ launchAtLogin: false, launchAtLoginSupported: true, launchAtLoginStatus: "not-registered" });
    expect(service.saveConfiguration({ launchAtLogin: true })).toMatchObject({ launchAtLogin: true, launchAtLoginStatus: "enabled" });
    expect(writes).toBe(1);
    expect(repository.getSetting("system.launchAtLogin")).toBeNull();
  });

  it("rejects launch-at-login changes when the current build cannot register a system login item", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new GeneralSettingsService(repository);
    expect(() => service.saveConfiguration({ launchAtLogin: true })).toThrowError(expect.objectContaining({ code: "SYSTEM_SETTING_UNAVAILABLE" }));
  });
});
