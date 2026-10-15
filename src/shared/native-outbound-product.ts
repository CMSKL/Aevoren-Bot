import type { z } from "zod";
import type { ProductOperationDefinition } from "./product-operations";
import { environmentScopeSchema } from "./environment-schemas";
import { connectorIdSchema } from "./native-connector-schemas";
import { NATIVE_OUTBOUND_CHANNELS } from "./native-outbound-channels";
import { nativeWriteGrantSchema, nativeWriteRevokeSchema, nativeOutboundPrepareSchema, nativeOutboundIdSchema } from "./native-outbound-schemas";
const scope = { sessionId: true, executorBotId: true } as const;
export const NATIVE_OUTBOUND_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "outbound.writeGrants": environmentScopeSchema.partial(scope).optional(), "outbound.grantWrite": nativeWriteGrantSchema.partial(scope),
  "outbound.revokeWrite": nativeWriteRevokeSchema.partial(scope), "outbound.enableSend": connectorIdSchema,
  "outbound.prepare": nativeOutboundPrepareSchema.partial(scope), "outbound.get": nativeOutboundIdSchema.partial(scope),
  "outbound.list": environmentScopeSchema.partial(scope).optional(), "outbound.send": nativeOutboundIdSchema.partial(scope),
  "outbound.reconcile": nativeOutboundIdSchema.partial(scope), "outbound.cancel": nativeOutboundIdSchema.partial(scope), "outbound.reject": nativeOutboundIdSchema.partial(scope),
};
const descriptions: Record<string, string> = { writeGrants: "列出当前会话 Bot 的具体应用写入授权，与读取授权分开",
  grantWrite: "经用户批准为固定账号、操作和目标授予写入权限，不能扩大应用本身的授权范围",
  revokeWrite: "撤销写授权并停止所属外发；已经派发的结果记为未知，不自动重发",
  enableSend: "重新完成完整 Gmail 读取和发送授权；账号或范围改变会使旧会话授权失效",
  prepare: "为固定本地草稿版本建立不可变外发意图，不发送；修改草稿后需重新准备",
  get: "查询原外发意图的真实状态和固定审批内容", list: "列出当前会话 Bot 的外发意图与结果，未知结果不能自动重发",
  send: "经本次固定内容审批派发原外发意图一次；未知或已完成意图不能重复发送",
  reconcile: "只读核验未知外发的实际第三方结果，不再次写入；查无结果仍为未知",
  cancel: "取消这项外发所属任务；派发后未核验结果记为未知，不停止兄弟任务",
  reject: "拒绝尚未派发的本地外发意图，不修改第三方资源" };
export const NATIVE_OUTBOUND_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = Object.entries(NATIVE_OUTBOUND_CHANNELS).map(([method, channel]) => ({
  name: `outbound.${method}`, channel, description: descriptions[method]!, effectClass: method === "send" ? "write-external" : method === "reconcile" || method === "enableSend" ? "read-remote"
    : ["writeGrants", "get", "list"].includes(method) ? "read-local" : "write-reversible", interaction: "none" }));
