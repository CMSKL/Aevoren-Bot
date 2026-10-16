import type { z } from "zod";
import type { ProductOperationDefinition } from "./product-operations";
import { environmentScopeSchema } from "./environment-schemas";
import { MCP_WRITE_CHANNELS } from "./mcp-write-channels";
import { mcpAppCloseSchema, mcpToolCatalogSchema, mcpToolGrantSchema, mcpWriteIdSchema, mcpWritePrepareSchema } from "./mcp-write-schemas";
const scope = { sessionId: true, executorBotId: true } as const;
export const MCP_WRITE_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "mcp.toolCatalog": mcpToolCatalogSchema.partial(scope),
  "mcp.toolGrants": environmentScopeSchema.partial(scope).optional(),
  "mcp.grantTool": mcpToolGrantSchema.partial(scope),
  "mcp.revokeTool": mcpWriteIdSchema.partial(scope),
  "mcp.prepareTool": mcpWritePrepareSchema.omit({ clientNonce: true }).partial(scope),
  "mcp.executeTool": mcpWriteIdSchema.partial(scope),
  "mcp.toolResult": mcpWriteIdSchema.partial(scope),
  "mcp.listToolIntents": environmentScopeSchema.partial(scope).optional(),
  "mcp.cancelTool": mcpWriteIdSchema.partial(scope),
  "mcp.openApp": mcpWriteIdSchema.partial(scope),
  "mcp.closeApp": mcpAppCloseSchema.partial(scope),
};
const descriptions: Record<string, string> = {
  toolCatalog: "读取当前连接的真实工具与格式；元信息与只读声明不能代替会话授权",
  toolGrants: "列出当前会话 Bot 对固定连接版本、凭据与工具格式的授权",
  grantTool: "经用户批准，为当前会话 Bot 授予固定 MCP 工具权限；调用仍需逐次审批",
  revokeTool: "撤销工具授权，停止所属调用并关闭关联 App；已派发的未知结果不自动重发",
  prepareTool: "保存固定 MCP 参数、具体目标和格式的不可变调用意图，不调用远端工具",
  executeTool: "经本次审批执行固定意图一次；结果未知或已结束时仅查询原回执，不重发",
  toolResult: "读取原 MCP 调用的实际持久状态与未受信任的服务器回执",
  listToolIntents: "列出当前会话 Bot 的 MCP 调用意图，不跨会话读取参数或结果",
  cancelTool: "仅取消所属 MCP 调用；派发后的不确定结果保留为未知",
  openApp: "请求用户在应用面板打开原工具结果绑定的隔离 MCP App；AI 返回等待用户处理，不取得本机视图地址",
  closeApp: "关闭指定 epoch 的 MCP App 并终止该视图尚未完成的请求",
};
export const MCP_WRITE_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = Object.entries(MCP_WRITE_CHANNELS)
  .filter(([method]) => method !== "requestToolApproval")
  .map(([method, channel]) => ({ name: `mcp.${method}`, channel, description: descriptions[method]!,
    effectClass: method === "executeTool" ? "write-external" : method === "toolCatalog" ? "read-remote" :
      ["toolGrants", "toolResult", "listToolIntents"].includes(method) ? "read-local" : "write-reversible", interaction: "none" }));
