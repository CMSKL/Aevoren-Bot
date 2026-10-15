import { z } from "zod";
import type { ProductOperationDefinition } from "./product-operations";
import { TASK_SESSION_CHANNELS } from "./task-session-channels";
import { taskCreateSchema, taskListSchema, taskScopeSchema, taskUpdateSchema, taskSelectionUpdateSchema, taskCancelSchema } from "./task-session-schemas";
export const TASK_SESSION_OPERATION_SCHEMAS: Record<string,z.ZodType>={
  "sessions.taskOptions":taskScopeSchema,"sessions.createTask":taskCreateSchema,
  "sessions.listTasks":taskListSchema,"sessions.getTask":taskScopeSchema,"sessions.updateTask":taskUpdateSchema,
  "sessions.reviseTaskSelection":taskSelectionUpdateSchema,"sessions.cancelTask":taskCancelSchema,"sessions.deleteTask":taskCancelSchema,
};
const descriptions={taskOptions:"查看当前会话可明确选择的任务上下文及授权范围版本，不自动继承",createTask:"创建独立 TASK 线程，仅复制明确选择的固定上下文和权限上限，不启动任务",
  listTasks:"列出当前父会话下已准入的独立任务线程",getTask:"读取已授权任务线程的身份、版本和准入摘要",updateTask:"按版本修改任务线程标题，不修改联系人或权限",
  reviseTaskSelection:"明确重新选择任务上下文与权限上限，原运行继续使用其原始快照",cancelTask:"只停止选中任务线程的当前运行，不停止兄弟线程",deleteTask:"删除已停止的任务线程，保留原 Bot 和群联系人"};
export const TASK_SESSION_PRODUCT_OPERATIONS:readonly ProductOperationDefinition[]=Object.entries(descriptions).map(([method,description])=>({
  name:`sessions.${method}`,channel:TASK_SESSION_CHANNELS[method as keyof typeof descriptions],description,
  effectClass:["taskOptions","listTasks","getTask"].includes(method)?"read-local":method==="deleteTask"?"irreversible":"write-reversible",interaction:"none",
}));
