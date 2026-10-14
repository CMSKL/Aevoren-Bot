import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bot, RoomDetail } from "@shared/contracts";
import { ComputerPanel } from "./ComputerPanel";
import { ContactDetail } from "./ContactDetail";
import { RoomInspector } from "./RoomInspector";

const bot: Bot = { id: "bot-1", projectId: "project-1", name: "电脑成员", label: "", description: "", instructions: "",
  modelSelection: { providerInstanceId: "provider-1", modelId: "model-1" }, avatarShape: "rounded", avatarColor: "cobalt",
  pinnedAt: null, hiddenAt: null, hasUnread: false, version: 1, createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z" };

describe("browser and computer surfaces", () => {
  it("requires real host state before showing ownership, a screen or usable mutation controls", () => {
    const html = renderToStaticMarkup(<ComputerPanel sessionId="session-main" executorBotId="bot-1" ownerName="电脑成员" />);
    expect(html).toContain('aria-label="电脑"');
    expect(html).toContain("状态未确认");
    expect(html).toContain("当前聊天和执行成员隔离");
    expect(html).toContain("私聊、群聊与其他成员分别授权");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>启动浏览器与电脑<\/button>/);
    expect(html).not.toContain("AI 持有控制权");
    expect(html).not.toContain("你持有控制权");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain("autofocus");
  });

  it("does not render hidden controls or create a noVNC client while inactive", () => {
    const html = renderToStaticMarkup(<ComputerPanel sessionId="session-main" executorBotId="bot-1" active={false} />);
    expect(html).toContain('hidden=""');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<canvas");
  });

  it("exposes browser and computer tabs using the existing private MAIN session", () => {
    const props = { bot, rooms: [], busy: false, workspaceIds: [], onSend: async () => true, onBotUpdated: () => undefined, onAddToRoom: async () => true, onOpenBots: () => undefined };
    const noScope = renderToStaticMarkup(<ContactDetail {...props} />);
    for (const mode of ["browser", "computer"]) expect(noScope).toContain(`aria-controls="contact-bot-1-${mode}-panel"`);
    expect(noScope).toContain("正在读取当前 Bot 的私聊浏览器范围");
    const scoped = renderToStaticMarkup(<ContactDetail {...props} librarySessionId="session-main" />);
    expect(scoped).not.toContain("正在读取当前 Bot 的私聊浏览器范围");
    expect(scoped).not.toContain("ws://");
    expect(scoped).not.toContain("adminToken");
  });

  it("limits both group selectors to actual members, independently of unrelated private bots", () => {
    const second = { ...bot, id: "bot-2", name: "另一成员" };
    const detail: RoomDetail = { room: { id: "room-1", projectId: "project-1", name: "浏览器群", description: "", version: 1, membershipVersion: 1, archivedAt: null, pinnedAt: null, hiddenAt: null, hasUnread: false, createdAt: bot.createdAt, updatedAt: bot.updatedAt },
      members: [{ roomId: "room-1", botId: bot.id, position: 0, bot }, { roomId: "room-1", botId: second.id, position: 1, bot: second }],
      session: { id: "session-room", botId: null, roomId: "room-1", kind: "MAIN", generation: 1, createdAt: bot.createdAt, updatedAt: bot.updatedAt } };
    const html = renderToStaticMarkup(<RoomInspector detail={detail} bots={[bot, second, { ...bot, id: "private-bot", name: "私聊成员" }]} conversationWorkspace={{ projects: [], projectId: null, pending: false, error: null, onChange: () => undefined }} active={false} mobileOpen={false} onDetailUpdated={() => undefined} onError={() => undefined} onOpenBot={() => undefined} onMobileClose={() => undefined} />);
    for (const mode of ["浏览器", "电脑"]) {
      const selector = html.match(new RegExp(`<select aria-label="${mode}成员"[\\s\\S]*?<\\/select>`))?.[0];
      expect(selector).toContain('value="bot-1"');
      expect(selector).toContain('value="bot-2"');
      expect(selector).not.toContain("private-bot");
    }
  });
});
