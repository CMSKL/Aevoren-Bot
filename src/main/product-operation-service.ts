import { normalizeProductRequest } from "./product-request";
import { createHash } from "node:crypto";
import { z } from "zod";
import { PRODUCT_OPERATIONS, productOperation } from "@shared/product-operations";
import type { ProductToolRequest, RuntimeRun, ToolInvocation } from "@shared/contracts";
import { resourceReferenceSchema } from "@shared/library-schemas";
import { AevorenBotError } from "./errors";
import { containsLikelySecret } from "./memory-safety";
import { createProductHandlers, type ProductDependencies } from "./product-handlers";
import { PRODUCT_OPERATION_SCHEMAS } from "./product-operation-schemas";

const PUBLIC_READS = new Set([
  "environments.probe", "environments.list", "environments.get", "execution.list", "execution.get", "execution.logs", "execution.wait", "execution.listFiles", "execution.readFile", "processes.list", "processes.listPorts",
  "library.list", "library.read", "library.versions", "documents.list", "documents.search", "documents.read", "documents.versions", "skills.list", "skills.read", "skills.load", "skills.readFile",
  "userProfile.get", "settings.getGeneral", "providers.list", "bots.list", "rooms.list",
  "tasks.getResult", "tasks.waitResult", "tasks.getRoomResult", "tasks.waitRoomResult", "projects.list", "workspaces.list", "updates.getState", "sessions.getMain", "capabilities.getSnapshot",
]);
const PINNED_LIBRARY_READS = new Set(["library.read", "documents.read", "skills.read", "skills.load", "skills.readFile", "library.export", "documents.export", "skills.export"]);
const environmentOperation = (operation: string): boolean => /^(environments|execution|processes)\./.test(operation);

/** Both transports use these handlers; only the host can supply execution identity. */
export class ProductOperationService {
  private readonly inFlight = new Map<string, Promise<{ content: string; metadata: Record<string, string | number | boolean | null> }>>();
  readonly handlers: ReturnType<typeof createProductHandlers>;

  constructor(private readonly dependencies: ProductDependencies) {
    this.handlers = createProductHandlers(dependencies);
    for (const channel of this.handlers.keys()) {
      if (!PRODUCT_OPERATIONS.some((operation) => operation.channel === channel)) throw new Error(`Unregistered product handler: ${channel}`);
    }
    for (const operation of PRODUCT_OPERATIONS) {
      if (!this.handlers.has(operation.channel) || !PRODUCT_OPERATION_SCHEMAS[operation.name]) {
        throw new Error(`Missing product operation: ${operation.name}`);
      }
    }
  }

  preview(tool: ProductToolRequest): string {
    if (tool.action !== "execute") return tool.action === "catalog" ? "产品功能目录" : `产品操作说明 · ${tool.operation}`;
    const repository = this.dependencies.repository;
    const input = tool.input;
    const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
    if (tool.operation === "view.request" && typeof value.action === "string") return `界面操作 · ${value.action}`;
    const id = typeof input === "string" ? input : typeof value.id === "string" ? value.id : undefined;
    const label = productOperation(tool.operation)?.description ?? tool.operation;
    if (["execution.run", "processes.start"].includes(tool.operation) && typeof value.command === "string") {
      return `${label} · ${value.cwd ?? "."}\n${value.command}`.slice(0, 2_048);
    }
    if (tool.operation === "approvals.resolve" && typeof value.id === "string") {
      const approval = repository.getApprovalRequest(value.id);
      const target = repository.getToolInvocation(approval.toolInvocationId);
      return `${value.resolution === "deny" ? "拒绝" : "批准一次"} · ${repository.getBot(approval.executorBotId).name} · ${target.targetPath}`.slice(0, 2_048);
    }
    if (tool.operation.startsWith("bots.") && (id || typeof value.botId === "string")) return `${label} · ${repository.getBot(id ?? value.botId as string).name}`;
    if (tool.operation.startsWith("rooms.") && (id || typeof value.roomId === "string")) return `${label} · ${repository.getRoom(id ?? value.roomId as string).name}`;
    if (tool.operation.startsWith("mcp.") && id) {
      const server = repository.getMcpServerConfig(id);
      return `${label} · ${server.name}${tool.operation === "mcp.setEnabled" && value.enabled === true ? " · 将启动已配置的连接程序" : ""}`;
    }
    if (tool.operation === "providers.saveCli") return `${label} · 将运行所选 CLI 进行连接探测`;
    return label;
  }

  requiresApproval(tool: ProductToolRequest): boolean {
    return tool.action === "execute" && !PUBLIC_READS.has(tool.operation);
  }

  validate(tool: ProductToolRequest, runtimeRunId: string): void {
    const { repository } = this.dependencies;
    const runtime = repository.getRuntimeRun(runtimeRunId);
    repository.assertSessionExecutor(runtime.sessionId, runtime.executorBotId);
    if (!["running", "streaming"].includes(runtime.state)) throw new AevorenBotError("TOOL_EXECUTION_CANCELLED");
    if (tool.action !== "execute") return;
    const definition = productOperation(tool.operation);
    if (!definition) throw new AevorenBotError("INVALID_REQUEST", "产品操作不存在，请先查询功能目录。");
    const schema = PRODUCT_OPERATION_SCHEMAS[tool.operation]!;
    const input = schema.parse(this.libraryInput(tool.operation, tool.input, runtime));
    if (tool.operation === "providers.saveOpenAiCompatible" && input && typeof input === "object" && "apiKey" in input) {
      throw new AevorenBotError("INVALID_REQUEST", "请在模型设置的可信入口填写密钥，AI 只能使用连接引用。");
    }
    if (["bots.update", "mcp.save"].includes(tool.operation) && containsLikelySecret(JSON.stringify(input))) {
      throw new AevorenBotError("PROJECT_PROFILE_SENSITIVE");
    }
    if (tool.operation === "tasks.getResult" || tool.operation === "tasks.waitResult") {
      const target = repository.getRuntimeRun((input as { runId: string }).runId);
      const origin = repository.getUserMessage(target.clientNonce).origin;
      if (target.sessionId !== runtime.sessionId && !(origin?.fromSessionId === runtime.sessionId && origin.fromBotId === runtime.executorBotId)) {
        throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
      }
    }
    if (tool.operation === "tasks.getRoomResult" || tool.operation === "tasks.waitRoomResult") {
      const target = repository.getRoomBatch((input as { batchId: string }).batchId);
      const origin = repository.getUserMessage(target.clientNonce).origin;
      if (target.sessionId !== runtime.sessionId && !(origin?.fromSessionId === runtime.sessionId && origin.fromBotId === runtime.executorBotId)) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    }
    // Directory reads never return another chat's messages or an unrestricted folder grant.
    if (tool.operation === "capabilities.getSnapshot" && input && typeof input === "object") {
      const selection = input as { botId?: string; sessionId?: string };
      if (selection.botId && selection.botId !== runtime.executorBotId || selection.sessionId && selection.sessionId !== runtime.sessionId) {
        throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
      }
    }
  }

  execute(tool: ProductToolRequest, invocation: ToolInvocation, signal: AbortSignal = new AbortController().signal): Promise<{ content: string; metadata: Record<string, string | number | boolean | null> }> {
    tool = normalizeProductRequest(tool);
    const mutating = tool.action === "execute" && !["read-local", "read-remote", "pure"].includes(productOperation(tool.operation)?.effectClass ?? "irreversible");
    if (!mutating) return this.executeOnce(tool, invocation, signal);
    const runtime = this.dependencies.repository.getRuntimeRun(invocation.runtimeRunId);
    const key = `${runtime.clientNonce}:${tool.action === "execute" && environmentOperation(tool.operation) ? runtime.executorBotId : "shared"}:${JSON.stringify(tool)}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.executeOnce(tool, invocation, signal).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async executeOnce(tool: ProductToolRequest, invocation: ToolInvocation, signal: AbortSignal): Promise<{ content: string; metadata: Record<string, string | number | boolean | null> }> {
    this.validate(tool, invocation.runtimeRunId);
    if (tool.action === "catalog") {
      const query = tool.query?.trim().toLocaleLowerCase() ?? "";
      const operations = PRODUCT_OPERATIONS.filter((item) => !query || `${item.name} ${item.description}`.toLocaleLowerCase().includes(query));
      return this.result({ status: "completed", operations: operations.map(({ channel: _channel, ...item }) => ({ ...item, approvalRequired: this.requiresApproval({ kind: "product-call", action: "execute", operation: item.name }) })) });
    }
    if (tool.action === "describe") {
      const definition = productOperation(tool.operation);
      if (!definition) throw new AevorenBotError("INVALID_REQUEST");
      const schema = PRODUCT_OPERATION_SCHEMAS[tool.operation]!;
      const description = { name: definition.name, description: definition.description, effectClass: definition.effectClass, interaction: definition.interaction };
      return this.result({ status: "completed", ...description, inputSchema: z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }), approvalRequired: this.requiresApproval({ kind: "product-call", action: "execute", operation: tool.operation }) });
    }
    const definition = productOperation(tool.operation)!;
    if (definition.interaction === "human-decision") {
      const current = this.dependencies.repository.getApprovalRequest(invocation.approvalRequestId);
      const requested = tool.input as { id: string };
      const target = this.dependencies.repository.getApprovalRequest(requested.id);
      const targetTool = this.dependencies.repository.getToolInvocation(target.toolInvocationId).arguments;
      if (current.state !== "allowed" || current.argumentsDigest !== invocation.commandDigest || target.id === current.id ||
          targetTool.kind === "product-call" && targetTool.action === "execute" && targetTool.operation === "approvals.resolve") throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
      const result = await this.handlers.get(definition.channel)!(tool.input);
      return this.result({ status: "completed", operation: tool.operation, result });
    }
    const runtime = this.dependencies.repository.getRuntimeRun(invocation.runtimeRunId);
    if (!PUBLIC_READS.has(tool.operation)) {
      const previous = this.dependencies.repository.findProductOperationResult(runtime.clientNonce, tool, environmentOperation(tool.operation) ? runtime.executorBotId : undefined);
      if (previous) {
        if (environmentOperation(tool.operation)) {
          if (!this.dependencies.environmentService) throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
          const receipt = JSON.parse(previous) as { status?: string; result?: { id?: string } };
          const scope = { sessionId: runtime.sessionId, executorBotId: runtime.executorBotId };
          let result: unknown = receipt.result;
          if (["execution.run", "execution.cancel", "processes.start", "processes.stop"].includes(tool.operation) && receipt.result?.id) result = await this.dependencies.environmentService?.getExecution({ ...scope, id: receipt.result.id });
          else if (["environments.start", "environments.stop", "environments.rebuild"].includes(tool.operation)) result = await this.dependencies.environmentService?.get(scope);
          return this.result({ status: receipt.status === "cancelled" ? "cancelled" : "previously_completed", operation: tool.operation, reused: true, result,
            receiptNotice: "原操作未重复执行；任务或环境结果已重新查询，文件传输回执仅记录首次结果。" });
        }
        this.assertLibraryReplayAccess(tool.operation, previous, runtime);
        if (/^(library|documents|skills)\./.test(tool.operation)) {
          const receipt = JSON.parse(previous) as { status?: string; result?: unknown };
          const previousExport = tool.operation.endsWith(".export") && receipt.status === "completed" && receipt.result !== null;
          const result = this.result({ ...receipt, reused: true,
            ...(previousExport ? { status: "previously_completed", outputVerification: "not_rechecked",
              receiptNotice: "返回首次导出成功回执；当前输出位置尚未重新校验。" }
              : { receiptNotice: "返回首次操作回执；当前资源状态请重新查询。" }),
          });
          return { ...result, metadata: { ...result.metadata, reused: true, ...(previousExport ? { outputVerification: "not_rechecked" } : {}) } };
        }
        return { content: previous, metadata: { operation: tool.operation, reused: true } };
      }
    }
    let input = PRODUCT_OPERATION_SCHEMAS[tool.operation]!.parse(this.libraryInput(tool.operation, tool.input, runtime));
    if (tool.operation === "userProfile.update") input = { ...(this.handlers.get(productOperation("userProfile.get")!.channel)!() as object), ...(input as object) };
    if (tool.operation === "capabilities.getSnapshot") input = { botId: runtime.executorBotId, sessionId: runtime.sessionId };
    if (["messages.send", "roomRuntime.send"].includes(tool.operation)) {
      // Generated by the host, not accepted as model-supplied provenance or identity.
      const command = input as { sessionId?: string; clientNonce: string; text: string };
      const hash = createHash("sha256").update(`${runtime.clientNonce}:${JSON.stringify(tool)}`).digest("hex");
      command.clientNonce = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      if (tool.operation === "messages.send") {
        const source = this.dependencies.repository.getUserMessage(runtime.clientNonce);
        const origin = source.origin;
        if (command.sessionId === runtime.sessionId || (origin?.depth ?? 0) >= 3) throw new AevorenBotError("TOOL_ROUND_LIMIT_EXCEEDED");
        const result = this.dependencies.sendWorker.send(command as import("@shared/contracts").SendCommand, {
          kind: "ai-delegation", fromBotNameSnapshot: this.dependencies.repository.getBot(runtime.executorBotId).name, fromBotId: runtime.executorBotId, fromSessionId: runtime.sessionId,
          fromRuntimeRunId: runtime.id, rootClientNonce: origin?.rootClientNonce ?? runtime.clientNonce,
          depth: (origin?.depth ?? 0) + 1,
        });
        return this.result({ status: "running", operation: tool.operation, result });
      }
      // Room messages carry the same durable delegation source before any member starts.
      return this.result({ status: "running", operation: tool.operation, result: await this.dependencies.roomCoordinator.routeAndSend(input as import("@shared/contracts").RoomSendCommand, { origin: {
        kind: "ai-delegation", fromBotNameSnapshot: this.dependencies.repository.getBot(runtime.executorBotId).name, fromBotId: runtime.executorBotId, fromSessionId: runtime.sessionId,
        fromRuntimeRunId: runtime.id, rootClientNonce: this.dependencies.repository.getUserMessage(runtime.clientNonce).origin?.rootClientNonce ?? runtime.clientNonce,
        depth: (this.dependencies.repository.getUserMessage(runtime.clientNonce).origin?.depth ?? 0) + 1,
      } }) });
    }
    if (tool.operation === "view.request" && (input as import("@shared/product-view").ProductViewInput).action === "app_exit") return this.result(this.dependencies.requestExitAfterRun?.(runtime.id) ?? { status: "waiting_user", reason: "退出需要用户处理当前任务。" });
    if (tool.operation === "updates.installAndRestart") return this.result(this.dependencies.requestUpdateAfterRun?.(runtime.id) ?? { status: "waiting_user", reason: "更新安装需要用户处理当前任务。" });
    if (tool.operation === "tasks.waitResult" || tool.operation === "tasks.waitRoomResult") {
      const wait = input as { runId?: string; batchId?: string; timeoutMs: number };
      const deadline = Date.now() + wait.timeoutMs;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        this.validate(tool, invocation.runtimeRunId);
        const target = wait.batchId ? this.dependencies.repository.getRoomBatch(wait.batchId) : this.dependencies.repository.getRuntimeRun(wait.runId!);
        if (["completed", "partial", "failed", "cancelled", "interrupted"].includes(target.state)) break;
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(250, deadline - Date.now()));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      const result = this.handlers.get(wait.batchId ? "product:room-task-result" : "product:task-result")!(wait.batchId ? { batchId: wait.batchId } : { runId: wait.runId });
      return this.result({ status: ["completed", "partial", "failed", "cancelled", "interrupted"].includes((result as { state: string }).state) ? "completed" : "running", result });
    }
    this.dependencies.repository.assertProductReplaySafe(runtime.clientNonce, tool, environmentOperation(tool.operation) ? runtime.executorBotId : undefined);
    const rootNonce = this.dependencies.repository.getUserMessage(runtime.clientNonce).origin?.rootClientNonce ?? runtime.clientNonce;
    const resourceCount = { "bots.create": 1, "bots.duplicate": 1, "rooms.create": 1, "teams.createContentTeam": 6, "library.create": 1, "library.importText": 1, "documents.create": 1, "skills.create": 1 }[tool.operation] ?? 0;
    let createdCount = resourceCount;
    let memorySourceEntryId: string | undefined;
    if (tool.operation === "memories.create") {
      const memory = input as { botId?: string; scope?: string; scopeKey?: string };
      const botId = memory.botId ?? (memory.scope === "bot" ? memory.scopeKey : undefined);
      if (botId) {
        const session = this.dependencies.repository.getSession(runtime.sessionId);
        if (botId === runtime.executorBotId || session.roomId && this.dependencies.repository.listRoomMembers(session.roomId).some((member) => member.bot.id === botId)) memorySourceEntryId = this.dependencies.repository.getUserMessage(runtime.clientNonce).id;
      }
    }
    const scopedHandlers = createProductHandlers(this.dependencies, (operation) => this.dependencies.repository.commitProductMutation(invocation.id, () => {
      signal.throwIfAborted();
      this.validate(tool, invocation.runtimeRunId);
      const value = operation();
      if (["library.importPath", "library.pickImport", "documents.import", "skills.import"].includes(tool.operation)) createdCount = (value as { imported: unknown[] }).imported.length;
      if (tool.operation === "teams.createContentTeam" && (value as { disposition?: string }).disposition === "existing") createdCount = 0;
      if (createdCount && this.dependencies.repository.productResourceCount(rootNonce) + createdCount > 8) throw new AevorenBotError("PROJECT_CREATION_LIMIT");
      const creator = this.dependencies.repository.getBot(runtime.executorBotId);
      if (tool.operation === "bots.create") {
        const created = value as unknown as { bot: import("@shared/contracts").Bot };
        created.bot = this.dependencies.repository.updateBot(created.bot.id, created.bot.version, { modelSelection: creator.modelSelection, mcpServerIds: creator.mcpServerIds, memoryWorkspaceIds: [] });
      }
      if (tool.operation === "teams.createContentTeam" && createdCount) {
        const team = value as unknown as import("@shared/contracts").TeamTemplateCreateResult;
        for (const bot of team.bots) this.dependencies.repository.updateBot(bot.id, bot.version, { modelSelection: creator.modelSelection, mcpServerIds: creator.mcpServerIds, memoryWorkspaceIds: [] });
        if (!this.dependencies.providers.getCapabilities?.(creator.modelSelection)?.handoff && team.room.room.leadBotId) this.dependencies.repository.updateRoom(team.room.room.id, team.room.room.version, { leadBotId: null });
        team.room = this.dependencies.repository.getRoomDetail(team.room.room.id);
        team.bots = team.room.members.map((member) => member.bot);
      }
      return value;
    }, (result) => ({
      ...this.result({ status: result === null && definition.interaction === "native" ? "cancelled" :
        ["execution.run", "processes.start"].includes(tool.operation) && (result as { state?: string } | null)?.state === "running" ? "running" : "completed", operation: tool.operation, result: tool.operation === "userProfile.update" ? { name: (result as import("@shared/contracts").UserProfile).name, hasAvatar: Boolean((result as import("@shared/contracts").UserProfile).avatarUrl) } : result ?? null }),
      metadata: { operation: tool.operation, resourceCount: createdCount },
    })), memorySourceEntryId, { runtimeRunId: runtime.id, executorBotId: runtime.executorBotId, sessionId: runtime.sessionId, signal });
    let result = await scopedHandlers.get(definition.channel)!(input);
    if (tool.operation === "view.request") return this.result(result);
    if (["userProfile.get", "userProfile.update"].includes(tool.operation)) result = { name: (result as import("@shared/contracts").UserProfile).name, hasAvatar: Boolean((result as import("@shared/contracts").UserProfile).avatarUrl) };
    if (tool.operation === "bots.list") result = (result as import("@shared/contracts").Bot[]).map(({ id, name, label, description, version, modelSelection }) => ({ id, name, label, description, version, modelSelection }));
    if (tool.operation === "rooms.list") result = (result as import("@shared/contracts").Room[]).map(({ id, name, description, version, membershipVersion, leadBotId, archivedAt }) => ({ id, name, description, version, membershipVersion, leadBotId, archivedAt }));
    if (tool.operation === "workspaces.list") result = this.dependencies.repository.listSessionWorkspaces(runtime.sessionId, runtime.executorBotId).map(({ id, name, writeEnabled, automationEnabled, version }) => ({ id, name, writeEnabled, automationEnabled, version }));
    if (definition.effectClass === "write-reversible" || definition.effectClass === "irreversible") this.dependencies.productChanged?.();
    return this.result({ status: result === null && definition.interaction === "native" ? "cancelled" :
      ["execution.run", "processes.start"].includes(tool.operation) && (result as { state?: string } | null)?.state === "running" ? "running" : "completed", operation: tool.operation, result: result ?? null });
  }

  private result(value: unknown) {
    const content = JSON.stringify({ ok: true, ...(value as object) });
    const receipt = value as { status?: string; operation?: string; result?: { runId?: string; state?: string } };
    return { content, metadata: { status: receipt.status ?? "completed", ...(receipt.operation ? { operation: receipt.operation } : {}), ...(receipt.result?.runId ? { targetRunId: receipt.result.runId } : {}), ...(receipt.result?.state ? { taskState: receipt.result.state } : {}) } };
  }

  private libraryInput(operation: string, value: unknown, runtime: Pick<RuntimeRun, "sessionId" | "clientNonce" | "executorBotId">): unknown {
    const input = value === null ? undefined : value;
    if (environmentOperation(operation) && !["environments.probe", "environments.initialize"].includes(operation)) {
      if (input !== undefined && (typeof input !== "object" || Array.isArray(input))) throw new AevorenBotError("INVALID_REQUEST");
      const supplied = (input ?? {}) as { sessionId?: string; executorBotId?: string };
      if (supplied.sessionId !== undefined && supplied.sessionId !== runtime.sessionId || supplied.executorBotId !== undefined && supplied.executorBotId !== runtime.executorBotId) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
      return { ...supplied, sessionId: runtime.sessionId, executorBotId: runtime.executorBotId };
    }
    if (!/^(library|documents|skills)\./.test(operation) || operation === "library.available") return input;
    if (input !== undefined && (typeof input !== "object" || Array.isArray(input))) throw new AevorenBotError("INVALID_REQUEST");
    const scoped = input as { sessionId?: string; id?: string; revisionId?: string } | undefined;
    if (scoped?.sessionId !== undefined && scoped.sessionId !== runtime.sessionId) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    const reference = PINNED_LIBRARY_READS.has(operation) && scoped?.revisionId === undefined
      ? this.dependencies.repository.getUserMessage(runtime.clientNonce).resourceRefs?.find((item) => item.resourceId === scoped?.id)
      : undefined;
    if (reference) this.dependencies.repository.library.assertReferences(runtime.sessionId, [reference], runtime.executorBotId);
    return { ...scoped, sessionId: runtime.sessionId, ...(reference ? { revisionId: reference.revisionId } : {}) };
  }

  private assertLibraryReplayAccess(operation: string, content: string, runtime: RuntimeRun): void {
    if (!/^(library|documents|skills)\./.test(operation)) return;
    const receipt = JSON.parse(content) as { result?: { revision?: { body?: unknown }; reference?: unknown; imported?: unknown[] } };
    const results = [receipt.result, ...(receipt.result?.imported ?? [])];
    const references = results.flatMap((result) => {
      if (!result || typeof result !== "object") return [];
      const value = result as { revision?: { body?: unknown }; reference?: unknown };
      return typeof value.revision?.body === "string" ? [resourceReferenceSchema.parse(value.reference)] : [];
    });
    if (references.length) this.dependencies.repository.library.assertReferences(runtime.sessionId, references, runtime.executorBotId);
  }
}
