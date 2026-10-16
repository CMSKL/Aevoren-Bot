import type { TaskMcpSelection } from "@shared/task-session-contracts";
import type { AppRepository } from "./database";
import type { McpService } from "./mcp-service";
import { AevorenBotError } from "./errors";
import { mcpDigest } from "./mcp-write-repository";

/** Host-only identity. Neither encrypted credentials nor their digest enter tool metadata. */
export function taskMcpIdentity(repository: AppRepository, mcp: McpService, executorBotId: string, selection: TaskMcpSelection): { version: number; identityDigest: string } {
  const server = repository.getMcpServerConfig(selection.serverId);
  const tools = mcp.availableTools(executorBotId).filter(tool => tool.serverId === server.id);
  const selected = selection.toolNames.toSorted().map(name => {
    const tool = tools.find(candidate => candidate.name === name);
    if (!tool?.readOnly || !tool.claimedReadOnly) throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
    return { name: tool.name, inputSchema: tool.inputSchema };
  });
  if (!server.enabled || server.version !== selection.expectedVersion || selected.length !== new Set(selection.toolNames).size) throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
  return { version: server.version, identityDigest: mcpDigest({ serverId: server.id, version: server.version, credentials: mcp.scopedCredentialDigest(server.id), tools: selected }) };
}

export function registerTaskMcpAuthority(repository: AppRepository, mcp: McpService): () => void {
  repository.tasks.setMcpIdentityReader((_sessionId, executorBotId, selection) => taskMcpIdentity(repository, mcp, executorBotId, selection));
  return mcp.onScopedInvalidation(serverId => repository.tasks.retireMcpSelections(serverId));
}
