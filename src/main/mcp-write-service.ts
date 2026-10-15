import { randomUUID } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
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
 revokeTool(input:McpWriteIdInput){const result=this.ledger.revoke(input);for(const job of this.jobs.values())if(job.grantId===result.id)job.controller.abort();return result;}
 private definition(session:OpenSession,review:{toolName:string;schemaDigest:string},actor:"model"|"app"|"user"){const tool=session.tools.find(value=>value.name===review.toolName);
 if(!tool||tool.schemaDigest!==review.schemaDigest||!(actor==="user"?tool.visibility.length>0:tool.visibility.includes(actor)))throw new AevorenBotError("MCP_TOOL_NOT_FOUND");return tool;}
 private validateArguments(tool:McpScopedTool,args:Record<string,unknown>){try{const validator=new AjvJsonSchemaValidator().getValidator(tool.inputSchema);if(!validator(args).valid)throw new Error("invalid");}
 catch{throw new AevorenBotError("INVALID_REQUEST","参数不符合当前 MCP 工具的输入格式。");}}
 prepareTool(input:McpWritePrepareInput,context:Context={},actor:"model"|"app"="model"){const parsed=mcpWritePrepareSchema.parse(input);return this.track(context,async signal=>{
 this.context(parsed,{...context,signal});const permission=this.ledger.assertGrant(parsed,parsed.grantId,parsed.expectedGrantVersion),session=await this.mcp.openScoped(permission.serverId,permission.serverVersion,signal);
 try{const tool=this.definition(session,permission,actor);this.validateArguments(tool,parsed.arguments);session.assertCurrent();this.context(parsed,{...context,signal});
 return this.ledger.prepare(parsed,tool,session.server.transport,session.credentialDigest);}finally{await session.close();}});}
 assertApprovalReview(review:McpWriteReview,input:EnvironmentScope){const value=this.ledger.assertReview(input,review),server=this.repository.getMcpServerConfig(review.serverId);
 if(value.state!=="prepared"||value.version!==review.expectedIntentVersion||!server.enabled||server.version!==review.serverVersion||
 this.mcp.scopedCredentialDigest(server.id)!==this.ledger.credentialForIntent(value.id))throw new AevorenBotError("APPROVAL_REVIEW_INVALID");return value;}
 approvalReview(input:McpWriteIdInput){const value=this.ledger.current(input,input.id);if(value.state!=="prepared")return undefined;
 if(value.version!==input.expectedVersion)throw new AevorenBotError("APPROVAL_REVIEW_INVALID");this.assertApprovalReview(value.review,input);return value.review;}
 executeTool(input:McpWriteIdInput,approvalId:string,context:Context={},actor:"model"|"app"="model"){
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
 if(result.isError)return this.ledger.settle(prior.id,"unknown",null,"SERVER_REPORTED_ERROR_AFTER_DISPATCH");
 return this.ledger.settle(prior.id,"confirmed",{untrusted:true,confirmation:"server-reported-only",server:prior.review.serverName,tool:tool.name,response:result});
 }catch(error){if(dispatched)return this.ledger.settle(prior.id,"unknown",null,"INTERRUPTED_AFTER_DISPATCH");throw error;}
 finally{await session?.close();context.signal?.removeEventListener("abort",abort);this.jobs.delete(prior.id);}})();
 this.jobs.set(prior.id,{controller,grantId:prior.review.grantId,promise});void promise.finally(()=>this.jobs.delete(prior.id)).catch(()=>{});return promise;}
 cancelTool(input:McpWriteIdInput){const value=this.ledger.current(input,input.id);this.jobs.get(value.id)?.controller.abort();
 return value.state==="prepared"?this.ledger.settle(value.id,"rejected",null,"USER_CANCELLED"):value.state==="dispatching"?this.ledger.settle(value.id,"unknown",null,"CANCELLED_AFTER_DISPATCH"):value;}
 async appResource(input:McpWriteIdInput,context:Context={}){this.context(input,context);const intent=this.ledger.current(input,input.id);if(intent.state!=="confirmed")throw new AevorenBotError("MCP_RESULT_INVALID");
 const permission=this.ledger.assertGrant(input,intent.review.grantId,intent.review.grantVersion),session=await this.mcp.openScoped(permission.serverId,permission.serverVersion,context.signal??new AbortController().signal);
 try{const tool=this.definition(session,permission,"user");if(!tool.uiResourceUri)throw new AevorenBotError("MCP_TOOL_NOT_FOUND");
 if(session.credentialDigest!==this.ledger.credentialForIntent(intent.id))throw new AevorenBotError("MCP_AUTH_REQUIRED");
 const result=await session.readResource(tool.uiResourceUri);this.context(input,context);const html=result.contents.find(value=>value.uri===tool.uiResourceUri&&"text" in value&&value.mimeType==="text/html;profile=mcp-app");
 if(!html||!("text" in html)||Buffer.byteLength(html.text)>384000)throw new AevorenBotError("MCP_RESULT_INVALID");
 return {intent,tool,html:html.text,resourceResult:result,viewerId:randomUUID(),epoch:1,resourceDigest:mcpDigest(html.text)};
 }finally{await session.close();}}
 async shutdown(){this.closed=true;for(const value of this.jobs.values())value.controller.abort();for(const controller of this.auxiliaries.values())controller.abort();
 await Promise.allSettled([...this.jobs.values()].map(value=>value.promise).concat([...this.auxiliaries.keys()]));}
}
