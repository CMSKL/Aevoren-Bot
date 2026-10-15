import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bot, RoomDetail } from "@shared/contracts";
import { ConnectorPanel } from "./ConnectorPanel";
import { ConnectorSettingsPanel } from "./ConnectorSettingsPanel";
import { ContactDetail } from "./ContactDetail";
import { RoomInspector } from "./RoomInspector";

const bot: Bot = { id: "bot-1", projectId: "project-1", name: "应用成员", label: "", description: "", instructions: "", modelSelection: { providerInstanceId: "provider-1", modelId: "model-1" }, avatarShape: "rounded", avatarColor: "cobalt", pinnedAt: null, hiddenAt: null, hasUnread: false, version: 1, createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z" };

describe("native connector UI surfaces", () => {
  it("does not claim auth or external delivery without a host reply", () => {
    const html = renderToStaticMarkup(<ConnectorPanel sessionId="private" executorBotId="bot-1" ownerName="当前 Bot" />);
    expect(html).toContain("尚未授权读取");
    expect(html).toContain("加入群聊不会带入私聊授权");
    expect(html).toContain("保存仅写入本机");
    expect(html).not.toContain("发送邮件</button>");
    expect(html).not.toContain("已连接");
    expect(html).not.toContain("autofocus");
    expect(html).toContain('aria-label="当前聊天的应用连接"');
  });

  it("hides inactive application controls", () => {
    const html = renderToStaticMarkup(<ConnectorPanel sessionId="private" executorBotId="bot-1" active={false} />);
    expect(html).toContain('hidden=""');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
  });

  it("requires explicit desktop OAuth config and separate Gmail/Drive authorization", () => {
    const html = renderToStaticMarkup(<ConnectorSettingsPanel active />);
    expect(html).toContain('aria-label="Google 桌面 OAuth Client ID"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Gmail 与 Drive 分别授权");
    expect(html).toContain("尚未配置应用连接");
    expect(html).not.toContain("登录 Aevoren");
  });

  it("uses the contact private MAIN scope and group members only", () => {
    const contact = renderToStaticMarkup(<ContactDetail bot={bot} rooms={[]} busy={false} workspaceIds={[]} librarySessionId="private-main" onSend={async () => true} onBotUpdated={() => undefined} onAddToRoom={async () => true} onOpenBots={() => undefined} />);
    expect(contact).toContain('aria-controls="contact-bot-1-apps-panel"');
    const detail: RoomDetail = { room: { id: "room-1", projectId: "project-1", name: "应用群", description: "", version: 1, membershipVersion: 1, archivedAt: null, pinnedAt: null, hiddenAt: null, hasUnread: false, createdAt: bot.createdAt, updatedAt: bot.updatedAt }, members: [{ roomId: "room-1", botId: bot.id, position: 0, bot }], session: { id: "room-main", botId: null, roomId: "room-1", kind: "MAIN", generation: 1, createdAt: bot.createdAt, updatedAt: bot.updatedAt } };
    const room = renderToStaticMarkup(<RoomInspector detail={detail} bots={[bot, { ...bot, id: "private-only" }]} conversationWorkspace={{ projects: [], projectId: null, pending: false, error: null, onChange: () => undefined }} active={false} mobileOpen={false} onDetailUpdated={() => undefined} onError={() => undefined} onOpenBot={() => undefined} onMobileClose={() => undefined} />);
    const selector = room.match(/<select aria-label="应用执行成员"[\s\S]*?<\/select>/)?.[0];
    expect(selector).toContain('value="bot-1"');
    expect(selector).not.toContain("private-only");
    expect(room).toContain('aria-controls="room-room-1-apps-panel"');
  });
});
