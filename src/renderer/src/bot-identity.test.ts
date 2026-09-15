import { describe, expect, it } from "vitest";
import { buildBotIdentityMap, buildSnapshotIdentityMap } from "./bot-identity";

describe("Bot identity labels", () => {
  it("preserves the existing display for unique names", () => {
    const identities = buildBotIdentityMap([{ id: "unique", name: "研究员", label: "调研" }]);
    expect(identities.get("unique")).toEqual({
      primary: "研究员",
      secondary: "调研",
      inline: "研究员",
      disambiguated: false,
    });
  });

  it("uses labels when duplicate names already have distinct labels", () => {
    const identities = buildBotIdentityMap([
      { id: "first", name: "助手", label: "研究" },
      { id: "second", name: "助手", label: "评审" },
    ]);
    expect(identities.get("first")?.inline).toBe("助手 · 研究");
    expect(identities.get("second")?.inline).toBe("助手 · 评审");
  });

  it("adds a stable unique suffix when both name and label are duplicated", () => {
    const identities = buildBotIdentityMap([
      { id: "abcdef-1111", name: "助手", label: "分析" },
      { id: "abcdef-2222", name: "助手", label: "分析" },
    ]);
    expect(identities.get("abcdef-1111")?.inline).toMatch(/^助手 · 分析 · #abcdef-1/);
    expect(identities.get("abcdef-2222")?.inline).toMatch(/^助手 · 分析 · #abcdef-2/);
    expect(identities.get("abcdef-1111")?.inline).not.toBe(identities.get("abcdef-2222")?.inline);
  });

  it("only disambiguates historical speakers when different Bot ids share a snapshot name", () => {
    expect(buildSnapshotIdentityMap([
      { id: "one", name: "助手" },
      { id: "one", name: "助手" },
    ]).get("one")).toBe("助手");
    const identities = buildSnapshotIdentityMap([
      { id: "one-111", name: "助手" },
      { id: "two-222", name: "助手" },
    ]);
    expect(identities.get("one-111")).not.toBe(identities.get("two-222"));
  });
});
