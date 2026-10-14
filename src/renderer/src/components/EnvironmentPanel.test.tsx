import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bot, RoomDetail } from "@shared/contracts";
import { DockerStatusCard, EnvironmentPanel } from "./EnvironmentPanel";
import { ContactDetail } from "./ContactDetail";
import { RoomInspector } from "./RoomInspector";

const bot: Bot = { id: "bot-1", projectId: "project-1", name: "执行成员", label: "", description: "", instructions: "",
  modelSelection: { providerInstanceId: "provider-1", modelId: "model-1" }, avatarShape: "rounded", avatarColor: "cobalt",
  pinnedAt: null, hiddenAt: null, hasUnread: false, version: 1, createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z" };

describe("execution environment surfaces", () => {
  it("does not claim Docker or an environment is ready before a host response", () => {
    const html = renderToStaticMarkup(<EnvironmentPanel sessionId="session-1" executorBotId="bot-1" ownerName="当前成员" />);
    expect(html).toContain("状态未确认");
    expect(html).toContain("命令、进程和文件按当前聊天与执行成员隔离");
    expect(html).toContain("点击运行才执行");
    expect(html).not.toContain("Docker 与 Linux 镜像可用");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("autofocus");
    for (const label of ["运行命令", "前台任务", "后台进程", "环境文件", "登记服务端口"]) expect(html).toContain(`aria-label="${label}"`);
  });

  it("hides an inactive environment without leaving visible execution controls", () => {
    const html = renderToStaticMarkup(<EnvironmentPanel sessionId="session-1" executorBotId="bot-1" active={false} />);
    expect(html).toContain('hidden=""');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<textarea");
  });

  it("keeps global Docker diagnostics separate from a member's environment", () => {
    const html = renderToStaticMarkup(<DockerStatusCard />);
    expect(html).toContain('aria-label="Docker 执行环境"');
    expect(html).toContain("尚未读取本机状态");
    expect(html).toContain("检查 Docker");
    expect(html).not.toContain("启动环境");
    expect(html).not.toContain("containerId");
    expect(html).not.toContain("encryptedToken");
  });

  it("uses the existing contact MAIN scope instead of creating an unrelated environment target", () => {
    const props = { bot, rooms: [], busy: false, workspaceIds: [], onSend: async () => true, onBotUpdated: () => undefined, onAddToRoom: async () => true, onOpenBots: () => undefined };
    const noScope = renderToStaticMarkup(<ContactDetail {...props} />);
    expect(noScope).toContain('aria-controls="contact-bot-1-environment-panel"');
    expect(noScope).toContain("正在读取当前 Bot 的私聊执行范围");
    const scoped = renderToStaticMarkup(<ContactDetail {...props} librarySessionId="session-main" />);
    expect(scoped).toContain('id="contact-bot-1-environment-panel"');
    expect(scoped).not.toContain("正在读取当前 Bot 的私聊执行范围");
  });

  it("offers only real group members in the environment selector", () => {
    const second = { ...bot, id: "bot-2", name: "另一成员" };
    const detail: RoomDetail = { room: { id: "room-1", projectId: "project-1", name: "执行群", description: "", version: 1, membershipVersion: 1, archivedAt: null, pinnedAt: null, hiddenAt: null, hasUnread: false, createdAt: bot.createdAt, updatedAt: bot.updatedAt },
      members: [{ roomId: "room-1", botId: bot.id, position: 0, bot }, { roomId: "room-1", botId: second.id, position: 1, bot: second }],
      session: { id: "session-room", botId: null, roomId: "room-1", kind: "MAIN", generation: 1, createdAt: bot.createdAt, updatedAt: bot.updatedAt } };
    const html = renderToStaticMarkup(<RoomInspector detail={detail} bots={[bot, second, { ...bot, id: "nonmember", name: "私聊成员" }]} conversationWorkspace={{ projects: [], projectId: null, pending: false, error: null, onChange: () => undefined }} active={false} mobileOpen={false} onDetailUpdated={() => undefined} onError={() => undefined} onOpenBot={() => undefined} onMobileClose={() => undefined} />);
    const selector = html.match(/<select aria-label="执行环境成员"[\s\S]*?<\/select>/)?.[0];
    expect(selector).toContain('value="bot-1"');
    expect(selector).toContain('value="bot-2"');
    expect(selector).not.toContain("nonmember");
    expect(html).toContain('aria-controls="room-room-1-environment-panel"');
  });
});
