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
