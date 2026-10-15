import { createHash } from "node:crypto";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { McpToolGrantInput, McpWriteIdInput, McpWritePrepareInput } from "@shared/mcp-write-contracts";
import { MCP_WRITE_PRODUCT_OPERATIONS, MCP_WRITE_OPERATION_SCHEMAS } from "@shared/mcp-write-product";
import { mcpWritePrepareSchema } from "@shared/mcp-write-schemas";
import type { AppRepository } from "./database";
import type { McpWriteService } from "./mcp-write-service";
import type { McpAppsBridge } from "./mcp-apps-bridge";
import type { LibraryExecutionContext } from "./library-product-handlers";
import { canonicalMcpJson } from "./mcp-write-repository";
import { AevorenBotError } from "./errors";
export type McpWriteProductDependencies = { repository: AppRepository; mcpWriteService?: McpWriteService; mcpAppsBridge?: McpAppsBridge };
export function addMcpWriteProductHandlers(handlers: Map<string, (input?: unknown) => unknown>, dependencies: McpWriteProductDependencies, context?: LibraryExecutionContext): void {
  for (const definition of MCP_WRITE_PRODUCT_OPERATIONS) handlers.set(definition.channel, async input => {
    const service = dependencies.mcpWriteService;
    if (!service) throw new AevorenBotError("MCP_SERVER_UNAVAILABLE");
    const supplied = (input ?? {}) as Record<string, unknown>;
    const assertCurrent = () => { context?.signal?.throwIfAborted(); if (context) service.ledger.assertRuntime(context, context.runtimeRunId); };
    assertCurrent();
    if (context && (supplied.sessionId !== undefined && supplied.sessionId !== context.sessionId || supplied.executorBotId !== undefined && supplied.executorBotId !== context.executorBotId)) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    const scoped = context ? { ...supplied, sessionId: context.sessionId, executorBotId: context.executorBotId } : input;
    // A UI nonce is not exposed to model callers. Its identity comes from the saved root message.
    const parsed = definition.name === "mcp.prepareTool" && !context ? mcpWritePrepareSchema.parse(scoped) : MCP_WRITE_OPERATION_SCHEMAS[definition.name]!.parse(scoped);
    const execution = { signal: context?.signal, runtimeRunId: context?.runtimeRunId, assertCurrent }, actor = context ? "model" as const : "user" as const;
    switch (definition.name) {
      case "mcp.toolCatalog": return service.toolCatalog(parsed as EnvironmentScope & { serverId: string; expectedServerVersion: number }, execution, actor);
      case "mcp.toolGrants": return service.toolGrants(parsed as EnvironmentScope);
      case "mcp.grantTool": return service.grantTool(parsed as McpToolGrantInput, execution, actor);
      case "mcp.revokeTool": return service.revokeTool(parsed as McpWriteIdInput);
      case "mcp.prepareTool": {
        let clientNonce = (parsed as McpWritePrepareInput).clientNonce;
        if (context) {
          const runtime = dependencies.repository.getRuntimeRun(context.runtimeRunId), root = dependencies.repository.getUserMessage(runtime.clientNonce).origin?.rootClientNonce ?? runtime.clientNonce;
          const digest = createHash("sha256").update(`${root}:${context.sessionId}:${context.executorBotId}:${canonicalMcpJson(parsed)}`).digest("hex");
          clientNonce = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        }
        return service.prepareTool({ ...parsed as McpWritePrepareInput, clientNonce }, execution, actor);
      }
      case "mcp.toolResult": return service.toolResult(parsed as McpWriteIdInput);
      case "mcp.listToolIntents": return service.listToolIntents(parsed as EnvironmentScope);
      case "mcp.cancelTool": return service.cancelTool(parsed as McpWriteIdInput);
      case "mcp.openApp": if (!dependencies.mcpAppsBridge) throw new AevorenBotError("MCP_SERVER_UNAVAILABLE"); return dependencies.mcpAppsBridge.openApp(parsed as McpWriteIdInput);
      case "mcp.closeApp": return dependencies.mcpAppsBridge?.closeApp(parsed as EnvironmentScope & { id: string; expectedEpoch: number });
      case "mcp.executeTool": throw new AevorenBotError("APPROVAL_REVIEW_INVALID");
    }
  });
}
