import { describe, expect, it } from "vitest";
import { sanitizeRoomSpeakerOutput } from "./room-speaker-envelope";

const marker = '[room-speaker id="6afd34a0-85d8-40b9-aa67-e2334a38bbcb" name="运营师"]';

describe("sanitizeRoomSpeakerOutput", () => {
  it("removes internal attribution envelopes at the start or between visible paragraphs", () => {
    expect(sanitizeRoomSpeakerOutput(`${marker}\n我现在在整理执行表。`)).toBe("我现在在整理执行表。");
    expect(sanitizeRoomSpeakerOutput(`${marker}\n${marker}\n正文`)).toBe("正文");
    expect(sanitizeRoomSpeakerOutput(`开场说明。\n${marker} 我现在在整理执行表。`)).toBe(
      "开场说明。\n我现在在整理执行表。",
    );
  });

  it("hides a partial envelope anywhere in a streaming prefix", () => {
    expect(sanitizeRoomSpeakerOutput("[room-spea", true)).toBe("");
    expect(sanitizeRoomSpeakerOutput(`开场。\n${marker}\n正`, true)).toBe("开场。\n正");
    expect(sanitizeRoomSpeakerOutput("开场。\n[room-spea", true)).toBe("开场。\n");
    expect(sanitizeRoomSpeakerOutput("[room-spea", false)).toBe("[room-spea");
  });

  it("preserves normal prose and non-protocol marker-like text", () => {
    expect(sanitizeRoomSpeakerOutput('[room-speaker id="not-a-uuid" name="示例"]\n正文')).toBe(
      '[room-speaker id="not-a-uuid" name="示例"]\n正文',
    );
  });
});
