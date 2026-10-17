import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult, Bot, RoomDetail } from "@shared/contracts";
import type { BrowserDownloadsPage, BrowserEpochInput } from "@shared/browser-contracts";
import { ComputerPanel } from "./ComputerPanel";
import { pollBrowserDownloads } from "./browser-download-poller";
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

describe("scoped asynchronous download receipts", () => {
  const input: BrowserEpochInput = { sessionId: "private-a", executorBotId: "bot-1", expectedEpoch: 2 };
  const failed: BrowserDownloadsPage = { items: [], errors: [{ id: "failure-1", pageId: "page-1", name: "too-large.bin", errorCode: "BROWSER_DOWNLOAD_TOO_LARGE", createdAt: bot.createdAt }] };
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("publishes a failure completed after the initial post-click snapshot", async () => {
    vi.useFakeTimers();
    const read = vi.fn<(input: BrowserEpochInput) => Promise<ApiResult<BrowserDownloadsPage>>>()
      .mockResolvedValueOnce({ ok: true, data: { items: [], errors: [] } }).mockResolvedValue({ ok: true, data: failed });
    const receipts = vi.fn(); const errors = vi.fn();
    const dispose = pollBrowserDownloads(input, read, receipts, errors);
    await vi.advanceTimersByTimeAsync(0);
    expect(receipts).toHaveBeenLastCalledWith({ items: [], errors: [] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(receipts).toHaveBeenLastCalledWith(failed);
    expect(read).toHaveBeenLastCalledWith(input);
    expect(errors).not.toHaveBeenCalled();
    dispose();
  });

  it("does not overlap reads or publish a late reply after switching member scope", async () => {
    vi.useFakeTimers();
    let resolveOld!: (result: ApiResult<BrowserDownloadsPage>) => void;
    const oldRead = vi.fn<(input: BrowserEpochInput) => Promise<ApiResult<BrowserDownloadsPage>>>(() => new Promise(resolve => { resolveOld = resolve; }));
    const oldReceipts = vi.fn(); const oldErrors = vi.fn();
    const disposeOld = pollBrowserDownloads(input, oldRead, oldReceipts, oldErrors);
    await vi.advanceTimersByTimeAsync(9000);
    expect(oldRead).toHaveBeenCalledTimes(1);
    disposeOld();
    const nextInput = { ...input, sessionId: "group-a", executorBotId: "bot-2", expectedEpoch: 8 };
    const newRead = vi.fn<(input: BrowserEpochInput) => Promise<ApiResult<BrowserDownloadsPage>>>().mockResolvedValue({ ok: true, data: failed });
    const newReceipts = vi.fn(); const newErrors = vi.fn();
    const disposeNew = pollBrowserDownloads(nextInput, newRead, newReceipts, newErrors);
    await vi.advanceTimersByTimeAsync(0);
    expect(newReceipts).toHaveBeenLastCalledWith(failed);
    resolveOld({ ok: true, data: { items: [], errors: [] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(oldReceipts).not.toHaveBeenCalled(); expect(oldErrors).not.toHaveBeenCalled();
    expect(newReceipts).toHaveBeenCalledTimes(1);
    disposeNew();
    await vi.advanceTimersByTimeAsync(6000);
    expect(newRead).toHaveBeenCalledTimes(1); expect(newErrors).not.toHaveBeenCalled();
  });

  it("reports a live connection failure without inventing an empty successful download list", async () => {
    vi.useFakeTimers();
    const read = vi.fn<(input: BrowserEpochInput) => Promise<ApiResult<BrowserDownloadsPage>>>().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValue({ ok: true, data: failed });
    const receipts = vi.fn(); const errors = vi.fn();
    const dispose = pollBrowserDownloads(input, read, receipts, errors);
    await vi.advanceTimersByTimeAsync(0);
    expect(receipts).not.toHaveBeenCalled(); expect(errors).toHaveBeenCalledWith("无法更新下载状态，请刷新实际连接。");
    await vi.advanceTimersByTimeAsync(3000);
    expect(receipts).toHaveBeenLastCalledWith(failed);
    dispose();
  });
});
