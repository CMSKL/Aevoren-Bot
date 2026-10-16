import { z } from "zod";
import type { ProductOperationDefinition } from "./product-operations";
import { AUTOMATION_EVENT_CHANNELS } from "./event-channels";
import { eventCreateSchema, eventUpdateSchema, eventVersionSchema } from "./event-schemas";
export const AUTOMATION_EVENT_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "automationEvents.snapshot": z.undefined(), "automationEvents.create": eventCreateSchema, "automationEvents.update": eventUpdateSchema,
  "automationEvents.revoke": eventVersionSchema, "automationEvents.cancel": eventVersionSchema,
};
const descriptions = {
  snapshot: "查看当前 MAIN 会话的事件订阅和幂等回执，仅元数据，无载荷或密钥",
  create: "为当前 MAIN 会话保存固定 Routine 版本的事件订阅，外部数据只作为不可信 JSON 附件",
  update: "按版本修改或暂停当前 MAIN 会话的事件订阅，旧 URL 失效并停止所属运行",
  revoke: "立即撤销当前 MAIN 会话的订阅，禁用旧密钥并停止所属运行",
  cancel: "按回执版本取消一次事件所属运行，不重放结果未知的事件",
};
/** Listener control and token rotation deliberately have no AI operation definition. */
export const AUTOMATION_EVENT_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = Object.entries(descriptions).map(([method, description]) => ({
  name: `automationEvents.${method}`, channel: AUTOMATION_EVENT_CHANNELS[method as keyof typeof descriptions], description,
  effectClass: method === "snapshot" ? "read-local" : "write-reversible", interaction: "none",
}));
