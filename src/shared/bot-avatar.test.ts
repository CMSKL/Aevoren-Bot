import { describe, expect, it } from "vitest";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  DEFAULT_BOT_AVATAR_COLOR,
  DEFAULT_BOT_AVATAR_SHAPE,
  normalizeBotAvatarColor,
  normalizeBotAvatarShape,
} from "./bot-avatar";

describe("bot avatar catalog", () => {
  it("keeps the selected option 2 catalog stable", () => {
    expect(BOT_AVATAR_SHAPES).toHaveLength(12);
    expect(new Set(BOT_AVATAR_SHAPES).size).toBe(12);
    expect(BOT_AVATAR_COLORS).toHaveLength(8);
    expect(new Set(BOT_AVATAR_COLORS).size).toBe(8);
  });

  it("falls back safely for legacy or malformed values", () => {
    expect(normalizeBotAvatarShape("crest")).toBe("crest");
    expect(normalizeBotAvatarColor("coral")).toBe("coral");
    expect(normalizeBotAvatarShape("unknown")).toBe(DEFAULT_BOT_AVATAR_SHAPE);
    expect(normalizeBotAvatarColor(null)).toBe(DEFAULT_BOT_AVATAR_COLOR);
  });
});
