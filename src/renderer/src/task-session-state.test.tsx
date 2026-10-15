import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bot, ConversationSummary } from "@shared/contracts";
import { emptyTaskSelection, mainConversationSummaries, taskConversationKey, toggleTaskItem } from "./task-session-state";
import { Sidebar } from "./components/Sidebar";
import type { OrganizationSnapshot } from "@shared/organization-contracts";

const bot: Bot = { id: "bot-one", projectId: "project-one", name: "分析助手", label: "", description: "", instructions: "", modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "fixture" }, avatarShape: "rounded", avatarColor: "teal", pinnedAt: null, hiddenAt: null, hasUnread: false, version: 1, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z" };
function summary(sessionId: string, kind: "MAIN" | "TASK", title?: string): ConversationSummary {
  return { sessionId, kind, title, botId: bot.id, roomId: null, projectId: null, workspaceIds: [], pinnedAt: null, hiddenAt: null, hasUnread: false, lastMessage: kind === "MAIN" ? "私聊记录" : "任务记录", lastActivityAt: "2026-10-15T00:00:00Z", version: 1 };
}
function renderSidebar(conversations: ConversationSummary[], selectedSessionId = "task-one", organization?: OrganizationSnapshot): string {
  const noop = (): void => undefined, yes = async (): Promise<boolean> => true;
  return renderToStaticMarkup(<Sidebar bots={[bot]} rooms={[]} conversations={conversations} organization={organization} tab="chats" selectedContactId={null} selectedBotId={null} selectedRoomId={null} selectedSessionId={selectedSessionId}
    projects={[]} activeProjectId="project-one" workspaces={[]} busy={false} addingWorkspace={false} workspaceError={null} creationError={null} mobileOpen={false} createButtonRef={{ current: null }} restoreStates={{}}
    onTabChange={noop} onSelectContact={noop} onHideBatch={yes} onClearConversation={noop} onCreateProject={noop} onBindProject={noop} onSelectProject={noop} onOpenWorkspaces={noop} onCreate={noop} onCreateBot={noop} onCreateRoom={noop} onOpenSettings={noop} onMobileClose={noop} onSelectBot={noop} onSelectRoom={noop} onSelectTask={noop}
    onRestoreRoom={async () => undefined} onOpenRestoredRoom={async () => undefined} onDismissRestore={noop} onRenameRoom={yes} onCopyRoomId={yes} onArchiveRoom={yes} onPinRoom={yes} onMarkRoomUnread={yes} onHideRoom={yes} onDeleteRoom={yes} onDeleteBatch={yes} onPinBot={yes} onMarkBotUnread={yes} onRenameBot={yes} onEditBot={noop} onDuplicateBot={yes} onCopyBotId={yes} onHideBot={yes} onDeleteBot={yes} />);
}

describe("Task thread UI authority and identity", () => {
  it("starts each explicitly admitted executor with independent empty authority and context", () => {
    const first = emptyTaskSelection("one"), second = emptyTaskSelection("two");
    expect(first).toEqual({ executorBotId: "one", memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: [], network: false, clipboard: false });
    first.resourceRefs.push({ resourceId: "private", revisionId: "v1", digest: "fixed" });
    first.network = true;
    expect(second).toEqual(emptyTaskSelection("two"));
  });
  it("retains exact selected revisions without aliasing the list or selecting sibling resources", () => {
    const reference = { resourceId: "doc", revisionId: "v1", digest: "original" };
    const selected = toggleTaskItem([], reference, item => item.resourceId);
    const revised = toggleTaskItem(selected, { resourceId: "other", revisionId: "v3", digest: "other" }, item => item.resourceId);
    expect(selected).toEqual([reference]);
    expect(revised[0]).toEqual(reference);
    expect(toggleTaskItem(revised, reference, item => item.resourceId)).toEqual([revised[1]]);
  });
  it("keeps MAIN metadata separate when several task sessions share one Bot", () => {
    const main = summary("main", "MAIN"), one = summary("task-one", "TASK", "任务甲"), two = summary("task-two", "TASK", "任务乙");
    expect(mainConversationSummaries([one, main, two])).toEqual([main]);
    expect(taskConversationKey(one.sessionId)).not.toBe(taskConversationKey(two.sessionId));
    const html = renderSidebar([one, main, two]);
    expect(html).toContain('aria-label="任务：任务甲" aria-current="true"');
    expect(html).toContain('aria-label="任务：任务乙"');
    expect(html.match(/aria-label="分析助手"/gu)).toHaveLength(1);
    expect(html).toContain("私聊记录");
    expect(html).toContain('aria-label="独立任务线程"');
  });
  it("never hides the MAIN row using a hidden sibling task or exposes a hidden task", () => {
    const hidden = { ...summary("task-hidden", "TASK", "隐藏任务"), hiddenAt: "2026-10-15T01:00:00Z" };
    const html = renderSidebar([summary("main", "MAIN"), hidden], "main");
    expect(html).toContain('aria-label="分析助手"');
    expect(html).not.toContain('aria-label="任务：隐藏任务"');
    expect(html).not.toContain("已移除的聊天");
  });
  it("renders custom sections in saved order while keeping a Task and its MAIN owner in separate rows", () => {
    const organization: OrganizationSnapshot = { version: 1, sections: [{ id: "research", name: "研究分区", position: 1 }, { id: "work", name: "工作分区", position: 0 }], assignments: [{ sessionId: "main", sectionId: "research", position: 0 }, { sessionId: "task-one", sectionId: "work", position: 0 }], preferences: { defaultAssistantBotId: null, notifications: { approvals: true, taskCompletion: false, taskFailure: false, routines: true }, sound: true } };
    const html = renderSidebar([summary("main", "MAIN"), summary("task-one", "TASK", "任务甲")], "task-one", organization);
    expect(html.indexOf('aria-label="聊天分区 工作分区"')).toBeLessThan(html.indexOf('aria-label="聊天分区 研究分区"'));
    expect(html.match(/aria-label="任务：任务甲"/gu)).toHaveLength(1);
    expect(html.match(/aria-label="分析助手"/gu)).toHaveLength(1);
    expect(html).toContain('aria-label="任务：任务甲" aria-current="true"');
    expect(html).not.toContain('aria-label="独立任务线程"');
  });
});
