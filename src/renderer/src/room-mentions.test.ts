import { describe, expect, it } from "vitest";
import {
  EVERYONE_MENTION_ID,
  addRoomMention,
  filterMentionItems,
  findActiveMentionQuery,
  removeMentionQuery,
  resolveRoomTargetIds,
} from "./room-mentions";

describe("room mention helpers", () => {
  it("only opens a query for the active @ token at the caret", () => {
    expect(findActiveMentionQuery("@评审", 3)).toEqual({ start: 0, end: 3, query: "评审" });
    expect(findActiveMentionQuery("请让 @review 回复", 10)).toEqual({ start: 3, end: 10, query: "review" });
    expect(findActiveMentionQuery("邮件a@b.com", 9)).toBeNull();
    expect(findActiveMentionQuery("@first @second", 14)).toEqual({ start: 7, end: 14, query: "second" });
  });

  it("matches names and aliases without changing the original labels", () => {
    const items = [
      { id: EVERYONE_MENTION_ID, label: "所有人", keywords: ["all", "everyone"] },
      { id: "bot-a", label: "产品评审", keywords: ["Reviewer", "需求"] },
    ];
    expect(filterMentionItems(items, "ALL").map((item) => item.id)).toEqual([EVERYONE_MENTION_ID]);
    expect(filterMentionItems(items, "review").map((item) => item.id)).toEqual(["bot-a"]);
    expect(filterMentionItems(items, "评审")[0]?.label).toBe("产品评审");
    expect(filterMentionItems(items, "没有")).toEqual([]);
  });

  it("supports everyone, multiple Bots, duplicate mentions, and roster ordering", () => {
    expect(resolveRoomTargetIds([], ["a", "b", "c"])).toEqual([]);
    expect(resolveRoomTargetIds([{ kind: "everyone", id: EVERYONE_MENTION_ID }], ["a", "b"])).toEqual(["a", "b"]);

    const first = addRoomMention([], { kind: "bot", id: "c", label: "C" });
    const multiple = addRoomMention(first, { kind: "bot", id: "a", label: "A" });
    expect(addRoomMention(multiple, { kind: "bot", id: "c", label: "C" })).toEqual(multiple);
    expect(resolveRoomTargetIds(multiple, ["a", "b", "c"])).toEqual(["a", "c"]);
    expect(addRoomMention(multiple, { kind: "everyone", id: EVERYONE_MENTION_ID })).toEqual([
      { kind: "everyone", id: EVERYONE_MENTION_ID },
    ]);
    expect(resolveRoomTargetIds([{ kind: "bot", id: "removed", label: "已移除" }], ["a", "b"])).toEqual([]);
    expect(addRoomMention([{ kind: "everyone", id: EVERYONE_MENTION_ID }], { kind: "bot", id: "b", label: "B" })).toEqual([
      { kind: "bot", id: "b", label: "B" },
    ]);
  });

  it("removes only the active query and preserves surrounding text", () => {
    expect(removeMentionQuery("请让 @review 处理", { start: 3, end: 10, query: "review" })).toEqual({
      text: "请让  处理",
      caret: 3,
    });
  });
});
