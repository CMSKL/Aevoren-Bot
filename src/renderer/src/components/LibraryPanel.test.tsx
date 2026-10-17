import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bot, RoomDetail } from "@shared/contracts";
import { LibraryPanel } from "./LibraryPanel";
import { LibraryResourcePicker } from "./LibraryResourcePicker";
import { ContactDetail } from "./ContactDetail";
import { RoomInspector } from "./RoomInspector";

const bot: Bot = {
  id: "bot-one", projectId: "project-one", name: "测试 Bot", label: "", description: "", instructions: "",
  modelSelection: { providerInstanceId: "provider-one", modelId: "model-one" }, avatarShape: "rounded", avatarColor: "cobalt",
  pinnedAt: null, hiddenAt: null, hasUnread: false, version: 1, createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z",
};

describe("library surfaces", () => {
  it("explains conversation authorization rather than implying Bot membership shares resources", () => {
    const html = renderToStaticMarkup(<LibraryPanel sessionId="session-one" kind="document" onUse={() => undefined} />);
    expect(html).toContain("仅当前会话绑定的资料可供本次对话使用");
    expect(html).toContain("不会自动共享它的私聊资源");
    expect(html).toContain('aria-label="资料库"');
    expect(html).toContain('aria-label="搜索资料"');
    expect(html).not.toContain("autofocus");
    expect(html).not.toContain("示例资料");
  });

  it("retains the Skill import entry separately from document imports", () => {
    const document = renderToStaticMarkup(<LibraryPanel sessionId="session-one" kind="document" onUse={() => undefined} />);
    const skill = renderToStaticMarkup(<LibraryPanel sessionId="session-one" kind="skill" onUse={() => undefined} />);
    expect(skill).toContain("导入技能目录");
    expect(skill).toContain("添加已有Skill");
    expect(document).not.toContain("导入技能目录");
    expect(skill).not.toContain("执行脚本");
  });

  it("keeps an inactive panel hidden and removes actionable editor controls", () => {
    const html = renderToStaticMarkup(<LibraryPanel sessionId="session-one" kind="skill" active={false} onUse={() => undefined} />);
    expect(html).toContain('hidden=""');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<textarea");
  });

  it("renders the resource picker only when opened and invents no unbound resources", () => {
    expect(renderToStaticMarkup(<LibraryResourcePicker sessionId="session-one" kind="skill" open={false} onSelect={() => undefined} />)).toBe("");
    const html = renderToStaticMarkup(<LibraryResourcePicker sessionId="session-one" kind="skill" open onSelect={() => undefined} />);
    expect(html).toContain("请先在Skill中添加到当前会话");
    expect(html).not.toContain("data-library-option");
    expect(html).not.toContain("autofocus");
  });

  it("adds accessible library tabs to contacts without inventing a private session scope", () => {
    const html = renderToStaticMarkup(<ContactDetail bot={bot} rooms={[]} busy={false} workspaceIds={[]} onSend={async () => true} onBotUpdated={() => undefined} onAddToRoom={async () => true} onOpenBots={() => undefined} />);
    expect(html).toContain('id="contact-bot-one-library-tab"');
    expect(html).toContain('aria-controls="contact-bot-one-library-panel"');
    expect(html).toContain('id="contact-bot-one-skill-panel"');
    expect(html).toContain("正在读取当前 Bot 的私聊资料范围");
    expect(html).not.toContain('data-testid="library-panel"');
  });

  it("keeps group settings and both scoped library panels mounted behind accessible tabs", () => {
    const detail: RoomDetail = {
      room: { id: "room-one", projectId: "project-one", name: "群聊", description: "", version: 1, membershipVersion: 1, archivedAt: null, pinnedAt: null, hiddenAt: null, hasUnread: false, createdAt: bot.createdAt, updatedAt: bot.updatedAt },
      members: [{ roomId: "room-one", botId: bot.id, position: 1, bot }],
      session: { id: "session-group", botId: null, roomId: "room-one", kind: "MAIN", generation: 1, createdAt: bot.createdAt, updatedAt: bot.updatedAt },
    };
    const html = renderToStaticMarkup(<RoomInspector detail={detail} bots={[bot]} conversationWorkspace={{ projects: [], projectId: null, pending: false, error: null, onChange: () => undefined }} active={false} mobileOpen={false} onDetailUpdated={() => undefined} onError={() => undefined} onOpenBot={() => undefined} onMobileClose={() => undefined} />);
    expect(html).toContain('aria-label="群聊配置"');
    expect(html).toContain('aria-controls="room-room-one-library-panel"');
    expect(html).toContain('id="room-room-one-skill-panel"');
    expect(html).toContain('aria-label="群聊资料"');
    expect(html).toContain('aria-label="Skill库"');
    expect(html).toContain('aria-label="Skill 脚本执行成员"');
    expect(html).not.toContain("autofocus");
  });
});
