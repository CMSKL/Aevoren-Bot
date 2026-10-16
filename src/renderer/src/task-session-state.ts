import type { ConversationSummary } from "@shared/contracts";
import type { TaskExecutorSelection } from "@shared/task-session-contracts";

/** Checking an executor never copies its parent chat's context or permissions. */
export function emptyTaskSelection(executorBotId: string): TaskExecutorSelection {
  return { executorBotId, memories: [], history: [], workspaces: [], mcp: [], resourceRefs: [], mediaRefs: [], productOperations: [], network: false, clipboard: false };
}

export function mainConversationSummaries(conversations: readonly ConversationSummary[]): ConversationSummary[] {
  return conversations.filter(item => item.kind !== "TASK");
}

export function taskConversationKey(sessionId: string): `session:${string}` { return `session:${sessionId}`; }

export function toggleTaskItem<T>(items: readonly T[], item: T, key: (item: T) => string): T[] {
  return items.some(current => key(current) === key(item)) ? items.filter(current => key(current) !== key(item)) : [...items, item];
}
