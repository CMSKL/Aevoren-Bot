import { taskCreateSchema } from "@shared/task-session-schemas";
import { TASK_SESSION_OPERATION_SCHEMAS } from "@shared/task-session-product";
import { realtimeInputSchema } from "@shared/realtime-schemas";
import { mcpWriteIdSchema } from "@shared/mcp-write-schemas";
import { MCP_WRITE_PRODUCT_OPERATIONS } from "@shared/mcp-write-product";
import { nativeOutboundIdSchema } from "@shared/native-outbound-schemas";
import { normalizeProductRequest } from "./product-request";
import { createHash } from "node:crypto";
import { z } from "zod";
import { PRODUCT_OPERATIONS, productOperation } from "@shared/product-operations";
import type { ProductToolRequest, RuntimeRun, ToolInvocation } from "@shared/contracts";
import { resourceReferenceSchema } from "@shared/library-schemas";
import { skillRunSchema } from "@shared/skill-execution-schemas";
import { AevorenBotError } from "./errors";
import { containsLikelySecret } from "./memory-safety";
import { createProductHandlers, type ProductDependencies } from "./product-handlers";
import { PRODUCT_OPERATION_SCHEMAS } from "./product-operation-schemas";
import type { ModelImageAttachment, ModelTextAttachment } from "./model-image";

const PUBLIC_READS = new Set([
  "search.query","search.open",
  "sessions.taskOptions", "sessions.listTasks", "sessions.getTask", "voice.realtime.snapshot", "voice.configurations", "voice.get", "voice.list", "voice.audio",
  "media.list", "media.metadata", "media.read", "media.preview",
  "mcp.toolCatalog", "mcp.toolGrants", "mcp.toolResult", "mcp.listToolIntents",
  "demonstrations.status", "demonstrations.drafts", "demonstrations.readDraft",
  "outbound.writeGrants", "outbound.get", "outbound.list", "outbound.reconcile",
  "connectors.list", "connectors.bindings", "connectors.search", "connectors.read", "drafts.list", "drafts.read", "drafts.versions",
  "approvals.review", "skills.scripts", "skills.executionGrants", "skills.scriptExecution",
  "browser.get", "browser.tabs", "browser.read", "browser.observe", "browser.downloads", "computer.view", "computer.screenshot", "preview.list",
  "environments.probe", "environments.list", "environments.get", "execution.list", "execution.get", "execution.logs", "execution.wait", "execution.listFiles", "execution.readFile", "processes.list", "processes.listPorts",
  "library.list", "library.read", "library.readFile", "library.versions", "documents.list", "documents.search", "documents.read", "documents.versions", "skills.list", "skills.read", "skills.load", "skills.readFile",
  "userProfile.get", "settings.getGeneral", "providers.list", "bots.list", "rooms.list",
  "tasks.getResult", "tasks.waitResult", "tasks.getRoomResult", "tasks.waitRoomResult", "projects.list", "workspaces.list", "updates.getState", "sessions.getMain", "capabilities.getSnapshot",
]);
const PINNED_LIBRARY_READS = new Set(["library.read", "library.readFile", "documents.read", "skills.read", "skills.load", "skills.readFile", "library.export", "documents.export", "skills.export"]);
const environmentOperation = (operation: string): boolean => /^(environments|execution|processes)\./.test(operation);
const browserOperation = (operation: string): boolean => /^(browser|computer|preview)\./.test(operation);
const scriptOperation = (operation: string): boolean => ["skills.scripts", "skills.executionGrants", "skills.grantExecution", "skills.revokeExecution", "skills.runScript", "skills.scriptExecution", "approvals.review"].includes(operation);
const nativeScopedOperation = (operation: string): boolean => operation.startsWith("outbound.") && operation !== "outbound.enableSend" || operation.startsWith("drafts.") || ["connectors.bindings", "connectors.bind", "connectors.unbind", "connectors.search", "connectors.read"].includes(operation);
const mcpWriteOperation = (operation: string): boolean => MCP_WRITE_PRODUCT_OPERATIONS.some(item => item.name === operation);
const mediaOperation = (operation: string): boolean => operation.startsWith("media.");
const voiceOperation = (operation: string): boolean => operation.startsWith("voice.");
const scopedOperation = (operation: string): boolean => voiceOperation(operation) || mediaOperation(operation) || environmentOperation(operation) || browserOperation(operation) || scriptOperation(operation) || nativeScopedOperation(operation) || mcpWriteOperation(operation) || operation.startsWith("demonstrations.");
type ProductExecutionResult = { content: string; metadata: Record<string, string | number | boolean | null>; images?: ModelImageAttachment[]; modelText?: ModelTextAttachment };

/** Both transports use these handlers; only the host can supply execution identity. */
export class ProductOperationService {
  private readonly inFlight = new Map<string, Promise<ProductExecutionResult>>();
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
    if (tool.operation === "demonstrations.publish" && typeof value.id === "string" && typeof value.sessionId === "string" && typeof value.executorBotId === "string") {
      const saved = repository.demonstrations.assertPublish(value as unknown as import("@shared/demonstration-contracts").DemonstrationPublishInput);
      return `${label} · ${saved.name} · v${saved.version}\nSHA-256 ${saved.digest}\n初始停用；不授予脚本权限或自动执行。\n${saved.body}`.slice(0, 2048);
    }
    if (tool.operation === "roomRuntime.cancelMember" && typeof input === "string") {
      const run = repository.getRuntimeRun(input);
      return `${label} · ${repository.getBot(run.executorBotId).name} · ${run.id}`;
    }
    if (tool.operation === "approvals.resolve" && typeof value.id === "string") {
      const approval = repository.getApprovalRequest(value.id);
      const target = repository.getToolInvocation(approval.toolInvocationId);
      return `${value.resolution === "deny" ? "拒绝" : "批准一次"} · ${repository.getBot(approval.executorBotId).name} · ${target.targetPath}`.slice(0, 2_048);
    }
    if (tool.operation.startsWith("bots.") && (id || typeof value.botId === "string")) return `${label} · ${repository.getBot(id ?? value.botId as string).name}`;
    if (tool.operation.startsWith("rooms.") && (id || typeof value.roomId === "string")) return `${label} · ${repository.getRoom(id ?? value.roomId as string).name}`;
    if (tool.operation.startsWith("mcp.") && !mcpWriteOperation(tool.operation) && id) {
      const server = repository.getMcpServerConfig(id);
      return `${label} · ${server.name}${tool.operation === "mcp.setEnabled" && value.enabled === true ? " · 将启动已配置的连接程序" : ""}`;
    }
    if (tool.operation === "providers.saveCli") return `${label} · 将运行所选 CLI 进行连接探测`;
    return label;
  }

  requiresApproval(tool: ProductToolRequest, runtimeRunId?: string): boolean {
    if (tool.action === "execute" && tool.operation === "voice.configure" && runtimeRunId) {
      this.validate(tool, runtimeRunId);
      const runtime = this.dependencies.repository.getRuntimeRun(runtimeRunId);
      if (this.dependencies.repository.findProductOperationResult(runtime.clientNonce, tool, runtime.executorBotId)) return false;
    }
    if (tool.action === "execute" && tool.operation === "mcp.executeTool" && runtimeRunId) {
      this.validate(tool, runtimeRunId); const runtime = this.dependencies.repository.getRuntimeRun(runtimeRunId);
      const input = mcpWriteIdSchema.parse(this.libraryInput(tool.operation, tool.input, runtime));
      if (!this.dependencies.mcpWriteService) throw new AevorenBotError("MCP_SERVER_UNAVAILABLE");
      return this.dependencies.mcpWriteService.ledger.current(input, input.id).state === "prepared";
    }
    if (tool.action === "execute" && tool.operation === "outbound.send" && runtimeRunId) {
      this.validate(tool, runtimeRunId);
      const runtime = this.dependencies.repository.getRuntimeRun(runtimeRunId);
      const input = nativeOutboundIdSchema.parse(this.libraryInput(tool.operation, tool.input, runtime));
      return this.dependencies.repository.outbound.current(input, input.id).state === "prepared";
    }
    return tool.action === "execute" && !PUBLIC_READS.has(tool.operation);
  }

  approvalReview(tool: ProductToolRequest, runtimeRunId: string): import("@shared/skill-execution-contracts").ApprovalReviewSnapshot | undefined {
    if (tool.action === "execute" && tool.operation === "mcp.executeTool") {
      if (!this.dependencies.mcpWriteService) throw new AevorenBotError("MCP_SERVER_UNAVAILABLE");
      const runtime = this.dependencies.repository.getRuntimeRun(runtimeRunId);
      const input = mcpWriteIdSchema.parse(this.libraryInput(tool.operation, tool.input, runtime));
      return this.dependencies.mcpWriteService.approvalReview(input);
    }
    if (tool.action !== "execute") return undefined;
    if (tool.operation === "demonstrations.publish") { const runtime = this.dependencies.repository.getRuntimeRun(runtimeRunId); return this.dependencies.repository.demonstrations.approvalReview(this.libraryInput(tool.operation, tool.input, runtime) as import("@shared/demonstration-contracts").DemonstrationPublishInput); }
    if (tool.operation === "outbound.send") {
      if (!this.dependencies.nativeOutboundService) throw new AevorenBotError("CONNECTOR_UNAVAILABLE");
      const runtime = this.dependencies.repository.getRuntimeRun(runtimeRunId);
      const input = nativeOutboundIdSchema.parse(this.libraryInput(tool.operation,tool.input,runtime));
      const intent = this.dependencies.repository.outbound.current(input, input.id);
      return intent.state === "prepared" ? this.dependencies.nativeOutboundService.approvalReview(input) : undefined;
    }
    if (tool.operation !== "skills.runScript") return undefined;
    const runtime = this.dependencies.repository.getRuntimeRun(runtimeRunId);
    if (!this.dependencies.skillExecutionService) throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
    const input = skillRunSchema.omit({ clientNonce: true }).parse(this.libraryInput(tool.operation, tool.input, runtime));
    return this.dependencies.skillExecutionService.approvalReview(input, { sessionId: runtime.sessionId, executorBotId: runtime.executorBotId });
  }

  validate(tool: ProductToolRequest, runtimeRunId: string): void {
    const { repository } = this.dependencies;
    const runtime = repository.getRuntimeRun(runtimeRunId);
    repository.assertSessionExecutor(runtime.sessionId, runtime.executorBotId);
    if (!["running", "streaming"].includes(runtime.state)) throw new AevorenBotError("TOOL_EXECUTION_CANCELLED");
    repository.tasks.assertToolAllowed(runtimeRunId,tool);
    if (tool.action !== "execute") return;
    const definition = productOperation(tool.operation);
    if (!definition) throw new AevorenBotError("INVALID_REQUEST", "产品操作不存在，请先查询功能目录。");
    const schema = PRODUCT_OPERATION_SCHEMAS[tool.operation]!;
    const input = schema.parse(this.libraryInput(tool.operation, tool.input, runtime));
    const taskPolicy=repository.tasks.runtimeTaskPolicy(runtimeRunId);
    if(taskPolicy){
      const record=input&&typeof input==="object"&&!Array.isArray(input)?input as Record<string,unknown>:null;
      if(record?.sessionId!==undefined&&record.sessionId!==runtime.sessionId&&!tool.operation.startsWith("sessions."))throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
      let targetSession:string|undefined;
      if(["transcript.list","runtime.getSessionSnapshot","conversations.clear"].includes(tool.operation))targetSession=input as string;
      if(["messages.retry","messages.cancel","messages.getStatus"].includes(tool.operation))targetSession=repository.getSendOrThrow(input as string).sessionId;
      if(["runtime.cancel","runtime.retry","roomRuntime.cancelMember"].includes(tool.operation))targetSession=repository.getRuntimeRun(input as string).sessionId;
      if(["roomRuntime.cancel","roomRuntime.continue"].includes(tool.operation))targetSession=repository.getRoomBatch(input as string).sessionId;
      if(tool.operation==="roomRuntime.retryTurn")targetSession=repository.getRoomBatch(repository.getRoomTurn(input as string).batchId).sessionId;
      if(tool.operation==="roomRuntime.getSnapshot")targetSession=typeof input==="string"?repository.getRoomMainSession(input).id:(input as {sessionId:string}).sessionId;
      if(targetSession!==undefined&&targetSession!==runtime.sessionId)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
      if(tool.operation==="memories.list"&&(record?.botId!==undefined&&record.botId!==runtime.executorBotId||record?.scope==="bot"&&record.scopeKey!==runtime.executorBotId))throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
      if(["memories.update","memories.delete","memories.restore"].includes(tool.operation)&&!taskPolicy.selection.memories.some(memory=>memory.id===record?.id))throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
      if(tool.operation==="memories.create"&&(record?.botId!==runtime.executorBotId&&!(record?.scope==="bot"&&record.scopeKey===runtime.executorBotId)))throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
      if(["memories.acceptProposal","memories.rejectProposal"].includes(tool.operation))throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
    }
    if (voiceOperation(tool.operation)) {
      if (!this.dependencies.voiceService) throw new AevorenBotError("VOICE_UNSUPPORTED");
      repository.voice.assertScope(runtime.sessionId, { executorBotId: runtime.executorBotId, runtimeRunId: runtime.id });
    }
    if (mediaOperation(tool.operation)) {
      if (!this.dependencies.mediaService) throw new AevorenBotError("MEDIA_PARSER_UNAVAILABLE");
      const scope = { sessionId: runtime.sessionId, executorBotId: runtime.executorBotId, runtimeRunId: runtime.id };
      repository.media.assertRuntime(scope);
      if (["media.metadata", "media.read", "media.preview"].includes(tool.operation)) {
        const read = input as import("@shared/media-contracts").MediaReadInput;
        repository.media.resolveRuntimeRead(scope, read.id, read.reference);
      }
    }
    if (mcpWriteOperation(tool.operation)) {
      if (!this.dependencies.mcpWriteService) throw new AevorenBotError("MCP_SERVER_UNAVAILABLE");
      this.dependencies.mcpWriteService.ledger.assertRuntime({ sessionId: runtime.sessionId, executorBotId: runtime.executorBotId }, runtime.id);
      if (tool.operation === "mcp.executeTool") this.approvalReview({ ...tool, input }, runtimeRunId);
    }
    if (tool.operation === "demonstrations.publish") repository.demonstrations.assertPublish(input as import("@shared/demonstration-contracts").DemonstrationPublishInput);
    if (nativeScopedOperation(tool.operation)) repository.connectors.assertRuntimeCurrent(runtime.id, { sessionId: runtime.sessionId, executorBotId: runtime.executorBotId });
    if (["connectors.search", "connectors.read"].includes(tool.operation)) repository.connectors.access(input as import("@shared/native-connector-contracts").ConnectorAccessInput);
    if (tool.operation === "skills.runScript") this.approvalReview({ ...tool, input }, runtimeRunId);
    if (tool.operation === "outbound.send") {
      const selection = input as import("@shared/native-outbound-contracts").NativeOutboundIdInput;
      const intent = repository.outbound.current(selection, selection.id);
      if (intent.state === "prepared") this.approvalReview({ ...tool, input }, runtimeRunId);
    }
    if (tool.operation === "roomRuntime.cancelMember") {
      const target = repository.getRuntimeRun(input as string);
      if (target.sessionId !== runtime.sessionId || !repository.getSession(target.sessionId).roomId || !target.promptManifest.sourceTurnId) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    }
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

  execute(tool: ProductToolRequest, invocation: ToolInvocation, signal: AbortSignal = new AbortController().signal): Promise<ProductExecutionResult> {
    tool = normalizeProductRequest(tool);
    const mutating = tool.action === "execute" && !["read-local", "read-remote", "pure"].includes(productOperation(tool.operation)?.effectClass ?? "irreversible");
    if (!mutating) return this.executeOnce(tool, invocation, signal);
    const runtime = this.dependencies.repository.getRuntimeRun(invocation.runtimeRunId);
    const key = `${runtime.clientNonce}:${tool.action === "execute" && scopedOperation(tool.operation) ? runtime.executorBotId : "shared"}:${JSON.stringify(tool)}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.executeOnce(tool, invocation, signal).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async executeOnce(tool: ProductToolRequest, invocation: ToolInvocation, signal: AbortSignal): Promise<ProductExecutionResult> {
    this.validate(tool, invocation.runtimeRunId);
    const runtime = this.dependencies.repository.getRuntimeRun(invocation.runtimeRunId);
    if(tool.action==="execute"&&["search.query","search.open"].includes(tool.operation)){
      const service=this.dependencies.searchService;if(!service)throw new AevorenBotError("INVALID_REQUEST");
      const input=PRODUCT_OPERATION_SCHEMAS[tool.operation]!.parse(tool.input),context={sessionId:runtime.sessionId,executorBotId:runtime.executorBotId,runtimeRunId:runtime.id};
      const result=tool.operation==="search.query"?service.query(input as import("@shared/search-contracts").SearchQueryInput,context):service.open(input as import("@shared/search-contracts").SearchOpenInput,context);
      this.validate(tool,runtime.id);
      if(tool.operation==="search.open")return this.result({status:"completed",operation:tool.operation,result});
      const page=result as import("@shared/search-contracts").SearchPage;
      return {...this.result({status:"completed",operation:tool.operation,result:{count:page.items.length,nextCursor:page.nextCursor,queryDigest:page.queryDigest,sources:page.items.map(item=>item.source)}}),modelText:{text:JSON.stringify(page),isAuthorized:()=>{try{this.validate(tool,runtime.id);for(const item of page.items)service.open({source:item.source},context);return true;}catch{return false;}}}};
    }
    if(tool.action==="execute"&&Object.hasOwn(TASK_SESSION_OPERATION_SCHEMAS,tool.operation)){
      const service=this.dependencies.taskSessionService;if(!service)throw new AevorenBotError("INVALID_REQUEST");
      const input=PRODUCT_OPERATION_SCHEMAS[tool.operation]!.parse(this.libraryInput(tool.operation,tool.input,runtime));
      const actor=runtime.executorBotId;
      const value=await (tool.operation==="sessions.taskOptions"?service.options(input as import("@shared/task-session-contracts").TaskScopeInput,actor,runtime.id)
        :tool.operation==="sessions.createTask"?service.create(input as import("@shared/task-session-contracts").TaskCreateInput,actor)
        :tool.operation==="sessions.listTasks"?service.list(input as import("@shared/task-session-contracts").TaskListInput,actor)
        :tool.operation==="sessions.getTask"?service.get(input as import("@shared/task-session-contracts").TaskScopeInput,actor)
        :tool.operation==="sessions.updateTask"?service.update(input as import("@shared/task-session-contracts").TaskUpdateInput,actor)
        :tool.operation==="sessions.reviseTaskSelection"?service.revise(input as import("@shared/task-session-contracts").TaskSelectionUpdateInput,actor)
        :tool.operation==="sessions.cancelTask"?service.cancel(input as import("@shared/task-session-contracts").TaskCancelInput,actor)
        :service.delete(input as import("@shared/task-session-contracts").TaskCancelInput,actor));
      return this.result({status:"completed",operation:tool.operation,result:value});
    }
    if (tool.action === "execute" && tool.operation.startsWith("voice.realtime.")) {
      const service = this.dependencies.realtimeService;
      if (!service) throw new AevorenBotError("VOICE_UNSUPPORTED");
      const input = realtimeInputSchema.parse(this.libraryInput(tool.operation, tool.input, runtime));
      const context = { executorBotId: runtime.executorBotId, runtimeRunId: runtime.id, signal };
      const snapshot = tool.operation.endsWith("snapshot") ? service.snapshot(input, context)
        : tool.operation.endsWith("stopTask") ? await service.stopTask(input, context) : await service.stop(input, context);
      // Transcript text is already the task's human input; catalog receipts retain status only.
      return this.result({ status: "completed", operation: tool.operation, result: { session: snapshot.session,
        turns: snapshot.turns.map(({ transcript: _text, ...turn }) => turn) } });
    }
    if (tool.action === "execute" && voiceOperation(tool.operation) && tool.operation !== "voice.configure") {
      const service = this.dependencies.voiceService!;
      const input = PRODUCT_OPERATION_SCHEMAS[tool.operation]!.parse(this.libraryInput(tool.operation, tool.input, runtime));
      const context = { executorBotId: runtime.executorBotId, runtimeRunId: runtime.id, signal, assertCurrent: () => this.validate(tool, runtime.id) };
      if (tool.operation === "voice.configurations") return this.result({ status: "completed", operation: tool.operation, result: service.configurations() });
      if (tool.operation === "voice.list") {
        const result = service.list(input as import("@shared/voice-contracts").VoiceTaskListInput, context).map(({ transcript: _text, ...task }) => task);
        return this.result({ status: "completed", operation: tool.operation, result });
      }
      if (tool.operation === "voice.audio") {
        const { reference, task } = await service.audio(input as import("@shared/voice-contracts").VoiceTaskInput, context);
        return this.result({ status: "completed", operation: tool.operation, result: { reference, taskId: task.id, audioTransfer: "not_supported_by_model_transport" } });
      }
      let task: import("@shared/voice-contracts").VoiceTask;
      if (tool.operation === "voice.transcribe" || tool.operation === "voice.speak") {
        const hash = createHash("sha256").update(`${runtime.clientNonce}:${runtime.executorBotId}:${JSON.stringify({ operation: tool.operation, input })}`).digest("hex");
        const clientNonce = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        task = tool.operation === "voice.transcribe"
          ? await service.transcribe({ ...(input as import("@shared/voice-contracts").VoiceTranscribeInput), clientNonce }, context)
          : await service.speak({ ...(input as import("@shared/voice-contracts").VoiceSpeechInput), clientNonce }, context);
        task = await service.wait({ sessionId: runtime.sessionId, id: task.id }, context);
      } else task = tool.operation === "voice.stop" ? service.stop(input as import("@shared/voice-contracts").VoiceTaskInput, context) : service.get(input as import("@shared/voice-contracts").VoiceTaskInput, context);
      const { transcript, ...metadata } = task;
      const result = this.result({ status: task.state === "prepared" ? "running" : task.state, operation: tool.operation, result: metadata, transcriptAvailable: transcript !== null });
      return { ...result, ...(transcript !== null ? { modelText: { text: transcript, isAuthorized: () => {
        try { this.validate(tool, runtime.id); return service.get({ sessionId: runtime.sessionId, id: task.id }, context).transcript === transcript; } catch { return false; }
      } } } : {}) };
    }
    if (tool.action === "execute" && tool.operation === "mcp.executeTool") {
      if (!this.dependencies.mcpWriteService) throw new AevorenBotError("MCP_SERVER_UNAVAILABLE");
      const input = mcpWriteIdSchema.parse(this.libraryInput(tool.operation, tool.input, runtime));
      const result = await this.dependencies.mcpWriteService.executeTool(input, invocation.approvalRequestId, { signal, runtimeRunId: runtime.id }, runtime.route === "host-mcp" ? "user" : "model");
      this.dependencies.mcpWriteService.ledger.assertRuntime(input, runtime.id);
      return this.result({ status: result.state === "unknown" ? "interrupted_unknown" : result.state, operation: tool.operation, result });
    }
    if (tool.action === "execute" && tool.operation === "outbound.send") {
      this.validate(tool, invocation.runtimeRunId);
      if (!this.dependencies.nativeOutboundService) throw new AevorenBotError("CONNECTOR_UNAVAILABLE");
      const input=nativeOutboundIdSchema.parse(this.libraryInput(tool.operation,tool.input,runtime));
      const result=await this.dependencies.nativeOutboundService.send(input,invocation.approvalRequestId,{signal,
        assertCurrent:()=>this.dependencies.repository.connectors.assertRuntimeCurrent(runtime.id,{sessionId:runtime.sessionId,executorBotId:runtime.executorBotId})});
      return this.result({status:result.state==="unknown"?"interrupted_unknown":result.state,operation:tool.operation,result});
    }
    if (tool.action === "catalog") {
      const query = tool.query?.trim().toLocaleLowerCase() ?? "";
      const policy=this.dependencies.repository.tasks.runtimeTaskPolicy(runtime.id);
      const operations = PRODUCT_OPERATIONS.filter((item) => (!policy||policy.selection.productOperations.includes(item.name)&&!["messages.send","roomRuntime.send","bots.create","bots.duplicate","teams.createContentTeam","rooms.create","approvals.resolve"].includes(item.name))&&(!query || `${item.name} ${item.description}`.toLocaleLowerCase().includes(query)));
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
    if (tool.operation === "approvals.resolve") {
      const current = this.dependencies.repository.getApprovalRequest(invocation.approvalRequestId);
      const requested = tool.input as { id: string };
      const target = this.dependencies.repository.getApprovalRequest(requested.id);
      const targetTool = this.dependencies.repository.getToolInvocation(target.toolInvocationId).arguments;
      if (current.state !== "allowed" || current.argumentsDigest !== invocation.commandDigest || target.id === current.id ||
          targetTool.kind === "product-call" && targetTool.action === "execute" && targetTool.operation === "approvals.resolve") throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
      const result = await this.handlers.get(definition.channel)!(tool.input);
      return this.result({ status: "completed", operation: tool.operation, result });
    }
    if (tool.operation === "skills.runScript") {
      const approval = this.dependencies.repository.getApprovalRequest(invocation.approvalRequestId);
      const scope = { sessionId: runtime.sessionId, executorBotId: runtime.executorBotId };
      const review = this.dependencies.repository.getApprovalReview({ ...scope, id: approval.id, expectedVersion: approval.version });
      if (review.snapshot?.kind !== "skill-script" || !this.dependencies.skillExecutionService) throw new AevorenBotError("APPROVAL_REVIEW_INVALID");
      this.dependencies.skillExecutionService.assertApprovalReview(review.snapshot, scope);
    }
    if (tool.operation === "demonstrations.publish") {
      const approval = this.dependencies.repository.getApprovalRequest(invocation.approvalRequestId), scope = { sessionId: runtime.sessionId, executorBotId: runtime.executorBotId };
      const review = this.dependencies.repository.getApprovalReview({ ...scope, id: approval.id, expectedVersion: approval.version });
      if (review.snapshot?.kind !== "demonstration-skill") throw new AevorenBotError("APPROVAL_REVIEW_INVALID");
      this.dependencies.repository.demonstrations.assertApprovalReview(review.snapshot, scope);
    }
    if (!PUBLIC_READS.has(tool.operation) && !mcpWriteOperation(tool.operation) && tool.operation !== "media.available") {
      const previous = this.dependencies.repository.findProductOperationResult(runtime.clientNonce, tool, scopedOperation(tool.operation) ? runtime.executorBotId : undefined);
      if (previous) {
        if (tool.operation === "voice.configure") return this.result({ status: "previously_completed", operation: tool.operation, reused: true,
          result: this.dependencies.voiceService!.configurations().find(item => item.kind === (tool.input as { kind: string }).kind),
          receiptNotice: "原配置变更未再次执行；返回当前公开配置状态，不恢复旧密钥或启停状态。" });
        if (mediaOperation(tool.operation)) {
          const receipt = JSON.parse(previous) as { status?: string; result?: import("@shared/media-contracts").MediaImportResult };
          if (["media.importPath", "media.pickImport"].includes(tool.operation) && receipt.result) {
            for (const item of receipt.result.imported) this.dependencies.repository.media.resolveRuntimeRead({ sessionId: runtime.sessionId,
              executorBotId: runtime.executorBotId, runtimeRunId: runtime.id }, item.reference.mediaId, item.reference);
          }
          return this.result({ status: receipt.status === "cancelled" ? "cancelled" : "previously_completed", operation: tool.operation, reused: true,
            receiptNotice: "原操作未重复执行，也未刷新旧任务授权；请重新查询当前媒体状态。" });
        }
        if (["drafts.create", "drafts.update"].includes(tool.operation)) {
          if (!this.dependencies.nativeConnectorService) throw new AevorenBotError("CONNECTOR_UNAVAILABLE");
          const receipt = JSON.parse(previous) as { result?: import("@shared/native-connector-contracts").ConnectorDraftResult };
          if (!receipt.result?.draft.id || !receipt.result.revision.id) throw new AevorenBotError("CONNECTOR_DRAFT_CONFLICT");
          const result = this.dependencies.nativeConnectorService.readDraft({ sessionId: runtime.sessionId, executorBotId: runtime.executorBotId,
            id: receipt.result.draft.id, revisionId: receipt.result.revision.id });
          return this.result({ status: "previously_completed", operation: tool.operation, reused: true, result,
            receiptNotice: "未再次创建或修改草稿；返回原保存版本并重新核验当前授权，本地草稿尚未外发。" });
        }
        if (["connectors.authorize", "connectors.revoke", "connectors.cancelAuthorization"].includes(tool.operation)) {
          const id = (tool.input as { id: string }).id;
          return this.result({ status: "previously_completed", operation: tool.operation, reused: true,
            result: this.dependencies.repository.connectors.get(id), receiptNotice: "原操作未重跑；已重新查询当前连接状态，旧会话授权仍需单独核验。" });
        }
        if (["connectors.bind", "connectors.unbind"].includes(tool.operation)) {
          const receipt = JSON.parse(previous) as { result?: { id?: string } };
          const result = this.dependencies.repository.connectors.bindings({ sessionId: runtime.sessionId, executorBotId: runtime.executorBotId, includeRevoked: true }).find(binding => binding.id === receipt.result?.id);
          if (!result) throw new AevorenBotError("CONNECTOR_NOT_GRANTED");
          return this.result({ status: "previously_completed", operation: tool.operation, reused: true, result,
            receiptNotice: "原授权操作未重跑；返回当前绑定状态，撤销后不会自动恢复。" });
        }
        if (tool.operation === "skills.runScript") {
          const receipt = JSON.parse(previous) as { result?: import("@shared/skill-execution-contracts").SkillScriptExecution };
          if (!receipt.result?.execution.id || !this.dependencies.skillExecutionService) throw new AevorenBotError("SKILL_EXECUTION_CONFLICT");
          const result = await this.dependencies.skillExecutionService.scriptExecution({ sessionId: runtime.sessionId, executorBotId: runtime.executorBotId, id: receipt.result.execution.id });
          return this.result({ status: "previously_completed", operation: tool.operation, reused: true, result,
            receiptNotice: "未再次执行脚本；已查询原任务的实际状态和固定版本来源。" });
        }
        if (tool.operation === "demonstrations.publish") {
          const receipt = JSON.parse(previous) as { result?: import("@shared/library-contracts").LibraryContent };
          if (!receipt.result?.resource.id || !receipt.result.revision.id) throw new AevorenBotError("APPROVAL_REVIEW_INVALID");
          const result = this.dependencies.repository.library.read({ sessionId: runtime.sessionId, id: receipt.result.resource.id,
            revisionId: receipt.result.revision.id, includeDisabled: true }, runtime.executorBotId);
          return this.result({ status: "previously_completed", operation: tool.operation, reused: true, result,
            receiptNotice: "未再次发布或启用 Skill；已核验原发布版本的当前会话授权与状态。" });
        }
        if (tool.operation.startsWith("demonstrations.")) { const receipt = JSON.parse(previous) as { status?: string; result?: unknown }; return this.result({ ...receipt, status: receipt.status === "waiting_user" ? "waiting_user" : "previously_completed", reused: true, receiptNotice: "返回首次已保存操作回执；当前示范草稿或 Skill 状态请重新查询。" }); }
        if (browserOperation(tool.operation)) {
          const scope = { sessionId: runtime.sessionId, executorBotId: runtime.executorBotId };
          const supplied = tool.input as { expectedEpoch?: number } | undefined;
          if (supplied?.expectedEpoch !== undefined) this.dependencies.repository.browsers.assertAccess(scope, supplied.expectedEpoch, "ai");
          else this.dependencies.repository.assertSessionExecutor(scope.sessionId, scope.executorBotId);
          const receipt = JSON.parse(previous) as { status?: string; result?: unknown };
          return this.result({ ...receipt, status: ["cancelled", "waiting_user"].includes(receipt.status ?? "") ? receipt.status : "previously_completed",
            reused: true, receiptNotice: "原操作未重复执行；返回首次回执，请查询页面、控制状态或原输出位置确认当前结果。" });
        }
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
    const taskPolicy=this.dependencies.repository.tasks.runtimeTaskPolicy(runtime.id);
    if(taskPolicy&&tool.operation==="memories.list"){
      const filter=PRODUCT_OPERATION_SCHEMAS[tool.operation]!.parse(tool.input) as {botId?:string;scope?:string;scopeKey?:string};
      const result=taskPolicy.memories.map(item=>item.memory).filter(memory=>filter.botId?memory.botId===filter.botId:memory.scope===filter.scope&&memory.scopeKey===filter.scopeKey);
      return this.result({status:"completed",operation:tool.operation,result});
    }
    if(taskPolicy&&tool.operation==="memories.listProposals")return this.result({status:"completed",operation:tool.operation,result:[]});
    if(taskPolicy&&tool.operation==="library.available")return this.result({status:"completed",operation:tool.operation,result:this.dependencies.repository.library.list({...tool.input as object,sessionId:runtime.sessionId},runtime.executorBotId,runtime.id)});
    if(taskPolicy&&tool.operation==="media.available")return this.result({status:"completed",operation:tool.operation,result:this.dependencies.repository.media.listRuntimeItems({sessionId:runtime.sessionId,executorBotId:runtime.executorBotId,runtimeRunId:runtime.id},tool.input as import("@shared/media-contracts").MediaAvailableInput)});
    let input = PRODUCT_OPERATION_SCHEMAS[tool.operation]!.parse(this.libraryInput(tool.operation, tool.input, runtime));
    if (["media.read", "media.preview"].includes(tool.operation)) {
      const service = this.dependencies.mediaService!;
      const context = { sessionId: runtime.sessionId, executorBotId: runtime.executorBotId, runtimeRunId: runtime.id, signal,
        assertCurrent: () => this.validate(tool, runtime.id) };
      const media = tool.operation === "media.read"
        ? await service.read(input as import("@shared/media-contracts").MediaReadInput, context)
        : await service.preview(input as import("@shared/media-contracts").MediaPreviewInput, context);
      const supported = runtime.route !== "fake" && this.dependencies.providers.getCapabilities({ providerInstanceId: runtime.providerInstanceId, modelId: runtime.providerModelId }).toolImageInput === true;
      const output = this.result({ status: "completed", operation: tool.operation, result: media.metadata,
        ...(media.images.length ? { imageTransfer: supported ? "prepared_real_pixels" : "adapter_unsupported",
          imageNotice: supported ? "实际像素随本次工具结果传输；所选模型的图像能力仍需按真实响应确认。" : "当前适配器不能传递工具图片；可以读取已解析文字，不能声称已看见图片。" } : {}) });
      return { ...output, ...(supported && media.images.length ? { images: media.images } : {}),
        ...("modelText" in media && media.modelText ? { modelText: media.modelText } : {}) };
    }
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
    this.dependencies.repository.assertProductReplaySafe(runtime.clientNonce, tool, scopedOperation(tool.operation) ? runtime.executorBotId : undefined);
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
    if (tool.operation === "mcp.openApp") return this.result({ ...result as { status: string; reason: string }, operation: tool.operation });
    let images: ModelImageAttachment[] | undefined;
    if (tool.operation === "computer.screenshot") {
      const shot = result as import("@shared/browser-contracts").ComputerScreenshot;
      const supported = runtime.route !== "fake" && this.dependencies.providers.getCapabilities({ providerInstanceId: runtime.providerInstanceId, modelId: runtime.providerModelId }).toolImageInput === true;
      result = { media: shot.media, imageTransfer: supported ? "prepared_real_pixels" : "adapter_unsupported", ...(supported ? {} : { reason: "当前模型来源未接入工具图片传输；DOM 操作仍可用，不能声称已理解这张画面。" }) };
      if (supported) {
        const attachment = await this.dependencies.browserService!.imageAttachment({ sessionId: runtime.sessionId, executorBotId: runtime.executorBotId }, shot.media.id, shot.media.controlEpoch);
        const allowed = attachment.isAuthorized;
        attachment.isAuthorized = () => allowed() && ["running", "streaming"].includes(this.dependencies.repository.getRuntimeRun(runtime.id).state);
        images = [attachment];
      }
    }
    if (tool.operation === "view.request") return this.result(result);
    if (["userProfile.get", "userProfile.update"].includes(tool.operation)) result = { name: (result as import("@shared/contracts").UserProfile).name, hasAvatar: Boolean((result as import("@shared/contracts").UserProfile).avatarUrl) };
    if (tool.operation === "bots.list") result = (result as import("@shared/contracts").Bot[]).map(({ id, name, label, description, version, modelSelection }) => ({ id, name, label, description, version, modelSelection }));
    if (tool.operation === "rooms.list") result = (result as import("@shared/contracts").Room[]).map(({ id, name, description, version, membershipVersion, leadBotId, archivedAt }) => ({ id, name, description, version, membershipVersion, leadBotId, archivedAt }));
    if (tool.operation === "workspaces.list") result = this.dependencies.repository.listSessionWorkspaces(runtime.sessionId, runtime.executorBotId).flatMap(({ id, name, writeEnabled, automationEnabled, version }) => {const limit=taskPolicy?.selection.workspaces.find(item=>item.id===id);return taskPolicy&&!limit?.read?[]:[{id,name,version,writeEnabled:writeEnabled&&(!taskPolicy||limit!.write),automationEnabled:automationEnabled&&(!taskPolicy||limit!.automation)}];});
    if (definition.effectClass === "write-reversible" || definition.effectClass === "irreversible") this.dependencies.productChanged?.();
    const output = this.result({ status: result && typeof result === "object" && "status" in result && result.status === "waiting_user" ? "waiting_user" : result === null && definition.interaction === "native" ? "cancelled" :
      ["execution.run", "processes.start"].includes(tool.operation) && (result as { state?: string } | null)?.state === "running" ? "running" : "completed", operation: tool.operation, result: result ?? null });
    return { ...output, ...(images ? { images } : {}) };
  }

  private result(value: unknown) {
    const content = JSON.stringify({ ok: true, ...(value as object) });
    const receipt = value as { status?: string; operation?: string; result?: { runId?: string; state?: string } };
    return { content, metadata: { status: receipt.status ?? "completed", ...(receipt.operation ? { operation: receipt.operation } : {}), ...(receipt.result?.runId ? { targetRunId: receipt.result.runId } : {}), ...(receipt.result?.state ? { taskState: receipt.result.state } : {}) } };
  }

  private libraryInput(operation: string, value: unknown, runtime: Pick<RuntimeRun, "id" | "sessionId" | "clientNonce" | "executorBotId">): unknown {
    const input = value === null ? undefined : value;
    const taskPolicy=this.dependencies.repository.tasks.runtimeTaskPolicy(runtime.id);
    if(Object.hasOwn(TASK_SESSION_OPERATION_SCHEMAS,operation)){
      if(input!==undefined&&(!input||typeof input!=="object"||Array.isArray(input)))throw new AevorenBotError("INVALID_REQUEST");
      const supplied=(input??{}) as Record<string,unknown>;
      if(["sessions.createTask","sessions.listTasks"].includes(operation)){
        if(supplied.parentSessionId!==undefined&&supplied.parentSessionId!==runtime.sessionId)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
        const scoped={...supplied,parentSessionId:runtime.sessionId};
        if(operation==="sessions.createTask"&&taskPolicy){
          const requested=taskCreateSchema.parse(scoped),ceiling=taskPolicy.selection;
          for(const item of requested.selections){
            const sameRef=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);
            if(item.executorBotId!==runtime.executorBotId||item.network&&!ceiling.network||item.clipboard&&!ceiling.clipboard
              ||item.productOperations.some(name=>!ceiling.productOperations.includes(name))
              ||item.memories.some(memory=>!ceiling.memories.some(value=>value.id===memory.id&&value.version===memory.version&&value.digest===memory.digest))
              ||item.resourceRefs.some(ref=>!ceiling.resourceRefs.some(value=>sameRef(value,ref)))
              ||item.mediaRefs.some(ref=>!ceiling.mediaRefs.some(value=>sameRef(value,ref)))
              ||item.workspaces.some(workspace=>!ceiling.workspaces.some(value=>value.id===workspace.id&&value.read&&(!workspace.write||value.write)&&(!workspace.automation||value.automation)))
              ||item.mcp.some(server=>!ceiling.mcp.some(value=>value.serverId===server.serverId&&value.expectedVersion===server.expectedVersion&&server.toolNames.every(name=>value.toolNames.includes(name)))))throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
          }
        }
        return scoped;
      }
      if(operation==="sessions.taskOptions"){
        if(supplied.sessionId!==undefined&&supplied.sessionId!==runtime.sessionId)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
        return {...supplied,sessionId:runtime.sessionId};
      }
      return input;
    }

    if(taskPolicy&&operation==="roomRuntime.getSnapshot"){
      const session=this.dependencies.repository.getSession(runtime.sessionId);
      if(!session.roomId)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
      const supplied=typeof input==="string"?{roomId:input}:input as {roomId?:string;sessionId?:string}|undefined;
      if(supplied?.roomId!==undefined&&supplied.roomId!==session.roomId||supplied?.sessionId!==undefined&&supplied.sessionId!==runtime.sessionId)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
      return {roomId:session.roomId,sessionId:runtime.sessionId};
    }
    if (voiceOperation(operation) || mediaOperation(operation)) {
      if (operation === "media.available" || ["voice.configurations", "voice.configure"].includes(operation)) return input;
      if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new AevorenBotError("INVALID_REQUEST");
      const supplied = (input ?? {}) as Record<string, unknown>;
      if (supplied.sessionId !== undefined && supplied.sessionId !== runtime.sessionId) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
      return { ...supplied, sessionId: runtime.sessionId };
    }
    if (scopedOperation(operation) && !["environments.probe", "environments.initialize"].includes(operation)) {
      if (input !== undefined && (typeof input !== "object" || Array.isArray(input))) throw new AevorenBotError("INVALID_REQUEST");
      const supplied = (input ?? {}) as { sessionId?: string; executorBotId?: string };
      if (supplied.sessionId !== undefined && supplied.sessionId !== runtime.sessionId || supplied.executorBotId !== undefined && supplied.executorBotId !== runtime.executorBotId) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
      return { ...supplied, sessionId: runtime.sessionId, executorBotId: runtime.executorBotId };
    }
    if (!/^(library|documents|skills)\./.test(operation) || operation === "library.available") return input;
    if (input !== undefined && (typeof input !== "object" || Array.isArray(input))) throw new AevorenBotError("INVALID_REQUEST");
    const scoped = input as { sessionId?: string; id?: string; revisionId?: string } | undefined;
    if (scoped?.sessionId !== undefined && scoped.sessionId !== runtime.sessionId) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    const selected=taskPolicy&&scoped?.id?taskPolicy.selection.resourceRefs.find(item=>item.resourceId===scoped.id):undefined;
    if(taskPolicy&&scoped?.id&&(!selected||scoped.revisionId!==undefined&&scoped.revisionId!==selected.revisionId))throw new AevorenBotError("LIBRARY_NOT_BOUND");
    const reference = selected??(PINNED_LIBRARY_READS.has(operation) && scoped?.revisionId === undefined
      ? this.dependencies.repository.getUserMessage(runtime.clientNonce).resourceRefs?.find((item) => item.resourceId === scoped?.id)
      : undefined);
    if (reference) this.dependencies.repository.library.assertReferences(runtime.sessionId, [reference], runtime.executorBotId, runtime.id);
    return { ...scoped, sessionId: runtime.sessionId, ...(reference && PINNED_LIBRARY_READS.has(operation) ? { revisionId: reference.revisionId } : {}) };
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
    if (references.length) this.dependencies.repository.library.assertReferences(runtime.sessionId, references, runtime.executorBotId, runtime.id);
  }
}
