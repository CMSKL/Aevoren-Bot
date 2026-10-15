import { randomUUID } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { ToolPrepareResult } from "@shared/contracts";
import type { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { McpScopedTool,McpToolGrantInput,McpWriteIdInput,McpWritePrepareInput,McpWriteReview } from "@shared/mcp-write-contracts";
import { mcpToolCatalogSchema,mcpToolGrantSchema,mcpWritePrepareSchema } from "@shared/mcp-write-schemas";
import type { AppRepository } from "./database";
import type { McpService } from "./mcp-service";
import { McpWriteRepository,mcpDigest,mcpReviewApprovalDigest } from "./mcp-write-repository";
import { AevorenBotError } from "./errors";
type Context={signal?:AbortSignal;runtimeRunId?:string;assertCurrent?:()=>void};
type OpenSession=Awaited<ReturnType<McpService["openScoped"]>>;
export class McpWriteService{
 private closed=false;
 private readonly invalidationListeners=new Set<(grantId:string)=>void>();
 private readonly uiTasks=new Map<string,{controller:AbortController;runtimeId:string;promise:Promise<unknown>}>();
 onGrantInvalidation(listener:(grantId:string)=>void){this.invalidationListeners.add(listener);return()=>this.invalidationListeners.delete(listener);}
 private readonly jobs=new Map<string,{controller:AbortController;grantId:string;promise:Promise<unknown>}>();
 private readonly auxiliaries=new Map<Promise<unknown>,AbortController>();
 constructor(private readonly repository:AppRepository,readonly ledger:McpWriteRepository,private readonly mcp:McpService){ledger.recover();}
 private scope(input:EnvironmentScope){return {sessionId:input.sessionId,executorBotId:input.executorBotId};}
 private context(input:EnvironmentScope,context:Context){if(this.closed)throw new AevorenBotError("TOOL_EXECUTION_CANCELLED");context.signal?.throwIfAborted();
 this.repository.assertSessionExecutor(input.sessionId,input.executorBotId);context.assertCurrent?.();if(context.runtimeRunId)this.ledger.assertRuntime(this.scope(input),context.runtimeRunId);}
 private track<T>(context:Context,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{const controller=new AbortController(),abort=()=>controller.abort(context.signal?.reason);
 context.signal?.addEventListener("abort",abort,{once:true});if(context.signal?.aborted||this.closed)abort();const promise=work(controller.signal);this.auxiliaries.set(promise,controller);
 void promise.finally(()=>{context.signal?.removeEventListener("abort",abort);this.auxiliaries.delete(promise);}).catch(()=>{});return promise;}
 toolGrants(input:EnvironmentScope){return this.ledger.grants(input);}
 toolResult(input:McpWriteIdInput){return this.ledger.current(input,input.id);}
 listToolIntents(input:EnvironmentScope){return this.ledger.list(input);}
 toolCatalog(input:EnvironmentScope&{serverId:string;expectedServerVersion:number},context:Context={},actor:"model"|"app"|"user"="model"){
 const parsed=mcpToolCatalogSchema.parse(input);return this.track(context,async signal=>{this.context(parsed,{...context,signal});const session=await this.mcp.openScoped(parsed.serverId,parsed.expectedServerVersion,signal);
 try{this.context(parsed,{...context,signal});return session.tools.filter(tool=>actor==="user"?tool.visibility.length>0:tool.visibility.includes(actor));}finally{await session.close();}});}
 grantTool(input:McpToolGrantInput,context:Context={},actor:"model"|"app"|"user"="model"){const parsed=mcpToolGrantSchema.parse(input);return this.track(context,async signal=>{
 this.context(parsed,{...context,signal});const session=await this.mcp.openScoped(parsed.serverId,parsed.expectedServerVersion,signal);
 try{const tool=session.tools.find(value=>value.name===parsed.toolName&&(actor==="user"?value.visibility.length>0:value.visibility.includes(actor)));if(!tool||tool.schemaDigest!==parsed.schemaDigest)throw new AevorenBotError("MCP_TOOL_NOT_FOUND");
 this.context(parsed,{...context,signal});session.assertCurrent();return this.ledger.grant(parsed,session.credentialDigest);}finally{await session.close();}});}
 revokeTool(input:McpWriteIdInput){const result=this.ledger.revoke(input);for(const job of this.jobs.values())if(job.grantId===result.id)job.controller.abort();for(const listener of this.invalidationListeners)listener(result.id);return result;}
 private definition(session:OpenSession,review:{toolName:string;schemaDigest:string},actor:"model"|"app"|"user"){const tool=session.tools.find(value=>value.name===review.toolName);
 if(!tool||tool.schemaDigest!==review.schemaDigest||!(actor==="user"?tool.visibility.length>0:tool.visibility.includes(actor)))throw new AevorenBotError("MCP_TOOL_NOT_FOUND");return tool;}
 private validateArguments(tool:McpScopedTool,args:Record<string,unknown>){try{const validator=new AjvJsonSchemaValidator().getValidator(tool.inputSchema);if(!validator(args).valid)throw new Error("invalid");}
 catch{throw new AevorenBotError("INVALID_REQUEST","参数不符合当前 MCP 工具的输入格式。");}}
 prepareTool(input:McpWritePrepareInput,context:Context={},actor:"model"|"app"|"user"="model"){const parsed=mcpWritePrepareSchema.parse(input);return this.track(context,async signal=>{
 this.context(parsed,{...context,signal});const permission=this.ledger.assertGrant(parsed,parsed.grantId,parsed.expectedGrantVersion),session=await this.mcp.openScoped(permission.serverId,permission.serverVersion,signal);
 try{const tool=this.definition(session,permission,actor);this.validateArguments(tool,parsed.arguments);session.assertCurrent();this.context(parsed,{...context,signal});
 return this.ledger.prepare(parsed,tool,session.server.transport,session.credentialDigest);}finally{await session.close();}});}
 assertApprovalReview(review:McpWriteReview,input:EnvironmentScope){const value=this.ledger.assertReview(input,review),server=this.repository.getMcpServerConfig(review.serverId);
 if(value.state!=="prepared"||value.version!==review.expectedIntentVersion||!server.enabled||server.version!==review.serverVersion||
 this.mcp.scopedCredentialDigest(server.id)!==this.ledger.credentialForIntent(value.id))throw new AevorenBotError("APPROVAL_REVIEW_INVALID");return value;}
 approvalReview(input:McpWriteIdInput){const value=this.ledger.current(input,input.id);if(value.state!=="prepared")return undefined;
 if(value.version!==input.expectedVersion)throw new AevorenBotError("APPROVAL_REVIEW_INVALID");this.assertApprovalReview(value.review,input);return value.review;}
 executeTool(input:McpWriteIdInput,approvalId:string,context:Context={},actor:"model"|"app"|"user"="model"){
 this.context(input,context);const prior=this.ledger.current(input,input.id);if(prior.state!=="prepared")return Promise.resolve(prior);
 const old=this.jobs.get(prior.id);if(old)return old.promise as Promise<typeof prior>;
 const controller=new AbortController(),abort=()=>controller.abort(context.signal?.reason);context.signal?.addEventListener("abort",abort,{once:true});if(context.signal?.aborted)abort();
 const promise=(async()=>{let dispatched=false,session:OpenSession|undefined;try{this.assertApprovalReview(prior.review,input);
 const approval=this.repository.getApprovalRequest(approvalId),invocation=this.repository.getToolInvocation(approval.toolInvocationId);
 if(approval.state!=="allowed"||approval.targetDigest!==mcpReviewApprovalDigest(prior.review)||invocation.sessionId!==input.sessionId||invocation.executorBotId!==input.executorBotId)
 throw new AevorenBotError("APPROVAL_REVIEW_INVALID");
 session=await this.mcp.openScoped(prior.review.serverId,prior.review.serverVersion,controller.signal);const tool=this.definition(session,prior.review,actor);this.validateArguments(tool,prior.review.arguments);
 this.context(input,{...context,signal:controller.signal});session.assertCurrent();this.assertApprovalReview(prior.review,input);
 const latest=this.repository.getApprovalRequest(approvalId);if(latest.state!=="allowed"||latest.targetDigest!==mcpReviewApprovalDigest(prior.review))throw new AevorenBotError("APPROVAL_REVIEW_INVALID");
 this.ledger.dispatch(input,prior.id,input.expectedVersion);dispatched=true;
 const result=await session.call(tool.name,prior.review.arguments);
 session.assertCurrent();this.context(input,{...context,signal:controller.signal});this.ledger.assertGrant(input,prior.review.grantId,prior.review.grantVersion);
 if(result.isError)return this.ledger.settle(prior.id,"unknown",null,"SERVER_REPORTED_ERROR_AFTER_DISPATCH");
 return this.ledger.settle(prior.id,"confirmed",{untrusted:true,confirmation:"server-reported-only",server:prior.review.serverName,tool:tool.name,response:result});
 }catch(error){if(dispatched)return this.ledger.settle(prior.id,"unknown",null,"INTERRUPTED_AFTER_DISPATCH");throw error;}
 finally{await session?.close();context.signal?.removeEventListener("abort",abort);this.jobs.delete(prior.id);}})();
 this.jobs.set(prior.id,{controller,grantId:prior.review.grantId,promise});void promise.finally(()=>this.jobs.delete(prior.id)).catch(()=>{});return promise;}
 cancelTool(input:McpWriteIdInput){const value=this.ledger.current(input,input.id);this.jobs.get(value.id)?.controller.abort();this.uiTasks.get(value.id)?.controller.abort();
 return value.state==="prepared"?this.ledger.settle(value.id,"rejected",null,"USER_CANCELLED"):value.state==="dispatching"?this.ledger.settle(value.id,"unknown",null,"CANCELLED_AFTER_DISPATCH"):value;}
 async appResource(input:McpWriteIdInput,context:Context={}){this.context(input,context);const intent=this.ledger.current(input,input.id);if(intent.state!=="confirmed")throw new AevorenBotError("MCP_RESULT_INVALID");
 const permission=this.ledger.assertGrant(input,intent.review.grantId,intent.review.grantVersion),session=await this.mcp.openScoped(permission.serverId,permission.serverVersion,context.signal??new AbortController().signal);
 try{const tool=this.definition(session,permission,"user");if(!tool.uiResourceUri)throw new AevorenBotError("MCP_TOOL_NOT_FOUND");
 if(session.credentialDigest!==this.ledger.credentialForIntent(intent.id))throw new AevorenBotError("MCP_AUTH_REQUIRED");
 const result=await session.readResource(tool.uiResourceUri);this.context(input,context);const html=result.contents.find(value=>value.uri===tool.uiResourceUri&&"text" in value&&value.mimeType==="text/html;profile=mcp-app");
 if(!html||!("text" in html)||Buffer.byteLength(html.text)>384000)throw new AevorenBotError("MCP_RESULT_INVALID");
 return {intent,tool,html:html.text,resourceResult:result,viewerId:randomUUID(),epoch:1,resourceDigest:mcpDigest(html.text)};
 }finally{await session.close();}}
 async requestApproval(input:McpWriteIdInput,coordinator:WorkspaceToolCoordinator):Promise<ToolPrepareResult>{
 const intent=this.ledger.get(input);this.assertApprovalReview(intent.review,input);
 const existing=this.uiTasks.get(intent.id);if(existing){const approval=this.repository.listPendingApprovalRequests(input.sessionId).find(value=>value.runtimeRunId===existing.runtimeId);
 if(approval)return {disposition:"duplicate",approval,invocation:this.repository.getToolInvocation(approval.toolInvocationId)};throw new AevorenBotError("TOOL_STATE_INVALID");}
 const nonce=randomUUID(),controller=new AbortController();this.repository.prepareHostOutboundMessage({sessionId:input.sessionId,clientNonce:nonce,text:`调用 MCP 工具 ${intent.review.toolName}`},input.executorBotId);this.repository.acknowledgeUserMessage(nonce);
 const message=this.repository.getUserMessage(nonce),session=this.repository.getSession(input.sessionId),runtime=this.repository.createRuntimeRun(nonce,"host-mcp",{schemaVersion:1,botId:input.executorBotId,profileVersion:this.repository.getBot(input.executorBotId).version,
 sessionId:input.sessionId,generation:session.generation,inputSeq:message.seq,blocks:[],digest:intent.review.argumentsDigest},{executorBotId:input.executorBotId});
 this.repository.transitionRuntimeRun(runtime.id,"dispatching");this.repository.transitionRuntimeRun(runtime.id,"running",{providerRequestId:`host-mcp:${intent.id}`});
 const finish=(cancelled:boolean)=>{const current=this.ledger.current(input,intent.id);if(current.state==="prepared")this.ledger.settle(intent.id,"rejected",null,cancelled?"APPROVAL_CANCELLED":"APPROVAL_REJECTED");
 const run=this.repository.getRuntimeRun(runtime.id);if(["running","streaming"].includes(run.state))this.repository.transitionRuntimeRun(run.id,cancelled?"cancel-requested":"completed");if(this.repository.getRuntimeRun(run.id).state==="cancel-requested")this.repository.transitionRuntimeRun(run.id,"cancelled");};
 let waiting:ReturnType<WorkspaceToolCoordinator["requestAndWait"]>;try{waiting=coordinator.requestAndWait(runtime.id,randomUUID(),{kind:"product-call",action:"execute",operation:"mcp.executeTool",input:{id:intent.id,expectedVersion:intent.version}},controller.signal);}
 catch(error){finish(true);throw error;}
 const task=waiting.then(result=>{finish(false);return result;},error=>{finish(true);throw error;}).finally(()=>this.uiTasks.delete(intent.id));
 void task.catch(()=>{});this.uiTasks.set(intent.id,{controller,runtimeId:runtime.id,promise:task});
 const approval=this.repository.listPendingApprovalRequests(input.sessionId).find(value=>value.runtimeRunId===runtime.id);if(!approval){controller.abort();throw new AevorenBotError("TOOL_STATE_INVALID");}
 return {disposition:"prepared",approval,invocation:this.repository.getToolInvocation(approval.toolInvocationId)};
 }
 async requestAndWait(input:McpWriteIdInput,coordinator:WorkspaceToolCoordinator,signal:AbortSignal){await this.requestApproval(input,coordinator);const task=this.uiTasks.get(input.id);
 if(!task)return this.ledger.current(input,input.id);const abort=()=>task.controller.abort(signal.reason);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
 try{await task.promise;signal.throwIfAborted();return this.ledger.current(input,input.id);}finally{signal.removeEventListener("abort",abort);}}
 cancelRuntime(runId:string){const runtime=this.repository.getRuntimeRun(runId),entry=[...this.uiTasks.entries()].find(([,job])=>job.runtimeId===runId);
 if(runtime.route!=="host-mcp"||!entry)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");const scope={sessionId:runtime.sessionId,executorBotId:runtime.executorBotId},intent=this.ledger.current(scope,entry[0]);
 if(runtime.providerRequestId!==`host-mcp:${intent.id}`||runtime.promptManifest.digest!==intent.review.argumentsDigest)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
 this.cancelTool({...scope,id:intent.id,expectedVersion:intent.version});if(["created","dispatching","running","streaming"].includes(runtime.state))this.repository.transitionRuntimeRun(runId,"cancel-requested");
 if(this.repository.getRuntimeRun(runId).state==="cancel-requested")this.repository.transitionRuntimeRun(runId,"cancelled");return this.repository.getRuntimeRun(runId);}
 async shutdown(){this.closed=true;for(const value of this.jobs.values())value.controller.abort();for(const controller of this.auxiliaries.values())controller.abort();for(const task of this.uiTasks.values())task.controller.abort();
 await Promise.allSettled([...this.jobs.values()].map(value=>value.promise).concat([...this.auxiliaries.keys()],[...this.uiTasks.values()].map(task=>task.promise)));}
}
