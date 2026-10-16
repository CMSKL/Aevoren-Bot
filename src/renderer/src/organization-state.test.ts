import { describe, expect, it } from "vitest";
import type { Bot, ConversationSummary } from "@shared/contracts";
import type { OrganizationPreferences, OrganizationSnapshot } from "@shared/organization-contracts";
import { defaultAssistantFallback, groupSidebarConversations, organizationPreferencesPatch, rebaseOrganizationPreferences, rebaseSectionNames } from "./organization-state";

const preferences: OrganizationPreferences = { defaultAssistantBotId: "original", notifications: { approvals: true, taskCompletion: false, taskFailure: false, routines: true }, sound: true };
function conversation(sessionId: string, kind: "MAIN" | "TASK" = "MAIN"): ConversationSummary { return { sessionId, kind, botId: "same-owner", roomId: null, projectId: null, workspaceIds: [], pinnedAt: null, hiddenAt: null, hasUnread: false, lastMessage: null, lastActivityAt: "2026-10-15T00:00:00Z", version: 1 }; }
function snapshot(): OrganizationSnapshot { return { version: 1, preferences: structuredClone(preferences), sections: [{ id: "one", name: "一", position: 1 }, { id: "two", name: "二", position: 0 }], assignments: [{ sessionId: "main", sectionId: "one", position: 0 }, { sessionId: "task", sectionId: "two", position: 2 }, { sessionId: "task-first", sectionId: "two", position: 0 }, { sessionId: "unknown-section", sectionId: "removed", position: 0 }] }; }

describe("personal organization UI state", () => {
  it("groups actual session identities rather than combining tasks with their shared Bot", () => {
    const state = snapshot(), original = structuredClone(state), items = [conversation("main"), conversation("task", "TASK"), conversation("task-first", "TASK"), conversation("unassigned"), conversation("unknown-section")];
    const result = groupSidebarConversations(items, state);
    expect(result.sections.map(group => group.section.id)).toEqual(["two", "one"]);
    expect(result.sections[0]!.items.map(item => item.sessionId)).toEqual(["task-first", "task"]);
    expect(result.sections[1]!.items.map(item => item.sessionId)).toEqual(["main"]);
    expect(result.unassigned.map(item => item.sessionId)).toEqual(["unassigned", "unknown-section"]);
    expect(state).toEqual(original);
    expect(groupSidebarConversations(items).unassigned).toEqual(items);
  });
  it("preserves dirty preferences while adopting only untouched fields from an explicitly reviewed baseline", () => {
    const draft = { ...structuredClone(preferences), defaultAssistantBotId: "typed-choice", sound: false, notifications: { ...preferences.notifications, approvals: false } };
    const latest = { ...structuredClone(preferences), defaultAssistantBotId: "remote-choice", notifications: { approvals: true, taskCompletion: true, taskFailure: true, routines: false } };
    const rebased = rebaseOrganizationPreferences(preferences, draft, latest);
    expect(rebased).toEqual({ defaultAssistantBotId: "typed-choice", sound: false, notifications: { approvals: false, taskCompletion: true, taskFailure: true, routines: false } });
    expect(organizationPreferencesPatch(latest, rebased)).toEqual({ defaultAssistantBotId: "typed-choice", sound: false, notifications: { approvals: false } });
    expect(organizationPreferencesPatch(latest, latest)).toEqual({});
    expect(draft.notifications.taskCompletion).toBe(false);
  });
  it("retains edited and deleted section-name drafts without restoring the removed section", () => {
    const base = snapshot().sections, draft = { one: "用户正在编辑", two: "二" }, latest = [{ id: "two", name: "远端的新名称", position: 0 }, { id: "new", name: "新分区", position: 1 }];
    expect(rebaseSectionNames(base, draft, latest)).toEqual({ two: "远端的新名称", new: "新分区", one: "用户正在编辑" });
    expect(groupSidebarConversations([conversation("main")], { ...snapshot(), sections: latest }).unassigned.map(item => item.sessionId)).toEqual(["main"]);
  });
  it("uses a default assistant only after the caller rejects all remembered session identities", () => {
    const bots = [{ id: "original" }, { id: "default" }] as Bot[];
    expect(defaultAssistantFallback(bots, "default", true)).toBeNull();
    expect(defaultAssistantFallback(bots, "default", false)).toBe(bots[1]);
    expect(defaultAssistantFallback(bots, "deleted", false)).toBeNull();
    expect(defaultAssistantFallback(bots, null, false)).toBeNull();
  });
});
