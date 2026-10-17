import { afterEach, describe, expect, it } from "vitest";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES } from "@shared/bot-avatar";
import { AppRepository } from "./database";

const repositories: AppRepository[] = [];

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
});

describe("content team template", () => {
  it("creates the five-role team and Room atomically and is idempotent", () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);

    const created = repository.createContentTeamTemplate();
    expect(created.disposition).toBe("created");
    expect(created.bots.map((bot) => bot.name)).toEqual([
      "情报侦察员",
      "选题策划师",
      "内容主笔",
      "事实编辑",
      "数据复盘师",
    ]);
    expect(created.room.room).toMatchObject({ name: "自媒体内容团队" });
    expect(created.room.room.description).toContain("成功工具记录");
    expect(created.bots.find((bot) => bot.name === "数据复盘师")?.instructions).toContain("禁止虚构");
    expect(created.bots.every((bot) => BOT_AVATAR_SHAPES.includes(bot.avatarShape))).toBe(true);
    expect(created.bots.every((bot) => BOT_AVATAR_COLORS.includes(bot.avatarColor))).toBe(true);
    expect(repository.listBots()).toHaveLength(5);
    expect(repository.listRooms()).toHaveLength(1);

    const duplicate = repository.createContentTeamTemplate();
    expect(duplicate).toMatchObject({ disposition: "existing", room: { room: { id: created.room.room.id } } });
    expect(repository.listBots()).toHaveLength(5);
    expect(repository.listRooms()).toHaveLength(1);
  });
});
