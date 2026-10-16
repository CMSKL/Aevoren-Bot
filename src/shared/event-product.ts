import { z } from "zod";
import type { ProductOperationDefinition } from "./product-operations";
import { AUTOMATION_EVENT_CHANNELS } from "./event-channels";
import { eventCreateSchema, eventUpdateSchema, eventVersionSchema, eventListenerAiStartSchema, eventListenerStopSchema } from "./event-schemas";
export const AUTOMATION_EVENT_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "automationEvents.snapshot": z.undefined(), "automationEvents.create": eventCreateSchema, "automationEvents.update": eventUpdateSchema,
  "automationEvents.revoke": eventVersionSchema, "automationEvents.cancel": eventVersionSchema,
  "automationEvents.startListener": eventListenerAiStartSchema, "automationEvents.stopListener": eventListenerStopSchema,
};
const descriptions = {
  snapshot: "查看当前 MAIN 会话的事件订阅和幂等回执，仅元数据，无载荷或密钥",
  create: "为当前 MAIN 会话保存固定 Routine 版本的事件订阅，外部数据只作为不可信 JSON 附件",
  update: "按版本修改或暂停当前 MAIN 会话的事件订阅，旧 URL 失效并停止所属运行",
  revoke: "立即撤销当前 MAIN 会话的订阅，禁用旧密钥并停止所属运行",
  cancel: "按回执版本取消一次事件所属运行，不重放结果未知的事件",
  startListener: "经审批在固定端口启动应用级 127.0.0.1 Webhook 入站监听，影响全部会话；不返回密钥",
  stopListener: "经审批停止固定端口的应用级 Webhook 入站监听，影响全部会话；不取消已交给 Routine 的任务",
};
/** Credential rotation and internal event emission stay outside the AI catalog. */
export const AUTOMATION_EVENT_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = Object.entries(descriptions).map(([method, description]) => ({
  name: `automationEvents.${method}`, channel: AUTOMATION_EVENT_CHANNELS[method as keyof typeof descriptions], description,
  effectClass: method === "snapshot" ? "read-local" : "write-reversible", interaction: "none",
}));
