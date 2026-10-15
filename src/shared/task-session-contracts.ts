import type { ApiResult, ConversationSummary, Session, MemoryItem } from "./contracts";
import type { ResourceReference } from "./library-contracts";
import type { MessageMediaReference } from "./media-contracts";
export type TaskMemoryReference = { id: string; version: number; digest: string };
export type TaskHistoryReference = { entryId: string; generation: number; digest: string };
export type TaskWorkspaceSelection = { id: string; read: boolean; write: boolean; automation: boolean };
export type TaskMcpSelection = { serverId: string; expectedVersion: number; toolNames: string[] };
/** Every array/flag is an explicit ceiling. Omitted context never inherits the parent. */
export type TaskExecutorSelection = {
  executorBotId: string; memories: TaskMemoryReference[]; history: TaskHistoryReference[];
  workspaces: TaskWorkspaceSelection[]; mcp: TaskMcpSelection[];
  resourceRefs: ResourceReference[]; mediaRefs: MessageMediaReference[];
  productOperations: string[]; network: boolean; clipboard: boolean;
};
export type TaskCreateInput = {
  parentSessionId: string; expectedScopeVersion: number; clientNonce: string; title: string;
  selections: TaskExecutorSelection[];
};
export type TaskUpdateInput = { sessionId: string; expectedVersion: number; title: string };
export type TaskSelectionUpdateInput = { sessionId: string; expectedVersion: number; selections: TaskExecutorSelection[] };
export type TaskDetail = {
  session: Session; conversation: ConversationSummary; title: string; parentSessionId: string | null;
  version: number; scopeVersion: number; admittedExecutorBotIds: string[];
  selectionDigests: { executorBotId: string; version: number; digest: string }[];
};
export type TaskListInput = { parentSessionId: string; limit?: number };
export type TaskScopeInput = { sessionId: string };
export type TaskCancelInput = TaskScopeInput & { expectedVersion: number };
export type TaskMemorySnapshot = { source: TaskMemoryReference; memory: MemoryItem };
export type TaskSessionApi = {
  createTask(input: TaskCreateInput): Promise<ApiResult<TaskDetail>>;
  listTasks(input: TaskListInput): Promise<ApiResult<TaskDetail[]>>;
  getTask(input: TaskScopeInput): Promise<ApiResult<TaskDetail>>;
  updateTask(input: TaskUpdateInput): Promise<ApiResult<TaskDetail>>;
  reviseTaskSelection(input: TaskSelectionUpdateInput): Promise<ApiResult<TaskDetail>>;
  cancelTask(input: TaskCancelInput): Promise<ApiResult<TaskDetail>>;
  deleteTask(input: TaskCancelInput): Promise<ApiResult<void>>;
};
