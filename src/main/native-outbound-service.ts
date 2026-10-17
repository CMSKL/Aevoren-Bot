import { randomUUID } from "node:crypto";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { ConnectorIdInput } from "@shared/native-connector-contracts";
import type { ExternalDraftReviewSnapshot, NativeOutboundIdInput, NativeOutboundPrepareInput, NativeWriteGrantInput, NativeWriteRevokeInput } from "@shared/native-outbound-contracts";
import { nativeOutboundPrepareSchema } from "@shared/native-outbound-schemas";
import type { ToolPrepareResult } from "@shared/contracts";
import type { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import type { AppRepository } from "./database";
import type { ConnectorExecutionContext, NativeConnectorService } from "./native-connector-service";
import { NativeOutboundAdapter, outboundTargetDigest } from "./native-connectors/outbound";
import { NativeConnectorError, type NativeOutboundRequest, type NativeWriteAuthorization, type NativeWriteOutcome, type NativeReconcileHint } from "./native-connectors/types";
import { ConnectorStateError } from "./native-connector-repository";
import { approvalReviewDigest } from "./skill-execution-repository";
import { AevorenBotError } from "./errors";
export class NativeOutboundService {
  private closed=false;
  private readonly auxiliary=new Map<Promise<unknown>,AbortController>();
  private track<T>(context:ConnectorExecutionContext,work:(context:ConnectorExecutionContext)=>Promise<T>):Promise<T>{
    const controller=new AbortController(),abort=()=>controller.abort(context.signal?.reason);context.signal?.addEventListener("abort",abort,{once:true});if(context.signal?.aborted||this.closed)abort();
    const promise=work({...context,signal:controller.signal});this.auxiliary.set(promise,controller);void promise.finally(()=>{context.signal?.removeEventListener("abort",abort);this.auxiliary.delete(promise);}).catch(()=>{});return promise;
  }
  private readonly uiTasks=new Map<string,{controller:AbortController;runtimeId:string;promise:Promise<unknown>}>();
  private readonly pending = new Map<string, { scope: EnvironmentScope; grantId: string; controller: AbortController; promise: Promise<unknown> }>();
  constructor(private readonly repository: AppRepository, private readonly connectors: NativeConnectorService, private readonly adapter = new NativeOutboundAdapter()) { repository.outbound.recover(); }
  writeGrants(scope:EnvironmentScope){return this.repository.outbound.grants(scope);}
  grantWrite(input:NativeWriteGrantInput){return this.repository.outbound.grant(input);}
  revokeWrite(input:NativeWriteRevokeInput){const result=this.repository.outbound.revoke(input);for(const job of this.pending.values())if(job.grantId===result.id)job.controller.abort();return result;}
  enableSend(input:ConnectorIdInput,context:ConnectorExecutionContext={}){return this.connectors.authorize(input,context,true);}
  get(input:NativeOutboundIdInput){return this.repository.outbound.get(input);}
  list(scope:EnvironmentScope){return this.repository.outbound.list(scope);}
  reject(input:NativeOutboundIdInput){return this.repository.outbound.reject(input);}
  private request(value:ReturnType<AppRepository["outbound"]["current"]>,attemptId:string):NativeOutboundRequest{return {operation:value.operation,draftDigest:value.revisionDigest,content:value.review.content,identity:{intentId:value.id,dispatchAttemptId:attemptId,...(value.messageId?{messageId:value.messageId}:{}),...(value.reservedResourceId?{reservedResourceId:value.reservedResourceId}:{})},...(value.review.observedTargetVersion?{observedDriveVersion:value.review.observedTargetVersion}:{}),...(value.review.observedNotionTarget?{observedNotionTarget:value.review.observedNotionTarget}:{})};}
  private auth(base:import("./native-connectors/types").NativeAuthorization,value:{account:ExternalDraftReviewSnapshot["account"];authVersion:number;grantVersion:number;review:{targetIds:string[]}},dispatchBoundary:NativeWriteAuthorization["dispatchBoundary"]):NativeWriteAuthorization{return {...base,accountId:value.account.accountId,...(value.account.email?{accountEmail:value.account.email}:{}),authVersion:value.authVersion,writeGrantVersion:value.grantVersion,allowedResourceIds:value.review.targetIds,dispatchBoundary};}
  prepare(input:NativeOutboundPrepareInput,context:ConnectorExecutionContext={}){return this.track(context,current=>this.prepareOnce(input,current));}
  private async prepareOnce(input:NativeOutboundPrepareInput,context:ConnectorExecutionContext={}){
    if(this.closed)throw new NativeConnectorError("AUTH_CANCELLED");
    const parsed=nativeOutboundPrepareSchema.parse(input),scope={sessionId:parsed.sessionId,executorBotId:parsed.executorBotId},grant=this.repository.outbound.assertGrant(scope,parsed.grantId,parsed.expectedGrantVersion);
    const existing=this.repository.outbound.byRevision(scope,parsed.revisionId);if(existing)return existing;
    const draft=this.repository.connectors.readDraft({...scope,id:parsed.draftId,revisionId:parsed.revisionId}),connection=this.repository.connectors.get(grant.connectionId);const id=randomUUID();
    if(draft.draft.version!==parsed.expectedDraftVersion||draft.draft.latestRevisionId!==parsed.revisionId)throw new ConnectorStateError("CONNECTOR_DRAFT_VERSION_CONFLICT",draft.draft.version);
    if(draft.draft.connectionId!==grant.connectionId||draft.draft.authVersion!==connection.authVersion||draft.draft.accountId!==connection.account?.accountId)throw new ConnectorStateError("CONNECTOR_AUTH_CHANGED");
    return this.connectors.withConnectionAuthorization({...scope,connectionId:connection.id,authVersion:connection.authVersion,accountId:connection.account!.accountId},context,async base=>{
      const placeholder={account:connection.account!,authVersion:connection.authVersion,grantVersion:grant.version,review:{targetIds:grant.targetIds}},auth=this.auth(base,placeholder,async()=>{throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");});
      let reservedResourceId:string|undefined,observedTargetVersion:string|undefined,observedNotionTarget:ExternalDraftReviewSnapshot["observedNotionTarget"];
      if(grant.operation==="drive-create-text")reservedResourceId=await this.adapter.reserveDriveId(auth);
      if(grant.operation==="drive-update-text"&&draft.revision.content.kind==="drive-text"&&draft.revision.content.targetFileId)observedTargetVersion=await this.adapter.observeDriveVersion(auth,draft.revision.content.targetFileId);
      if((grant.operation==="notion-update-page-title"&&draft.revision.content.kind==="notion-page-title"||grant.operation==="notion-append-page"&&draft.revision.content.kind==="notion-page-append"))observedNotionTarget=await this.adapter.observeNotionTarget(auth,draft.revision.content.pageId);
      base.assertCurrent();context.assertCurrent?.();
      return this.repository.outbound.prepare(parsed,{id,reservedResourceId,observedTargetVersion,observedNotionTarget},review=>outboundTargetDigest(auth,{operation:review.operation,draftDigest:review.revisionDigest,content:review.content,identity:{intentId:id,dispatchAttemptId:id,...(review.operation==="gmail-send"?{messageId:`<${id}@aevoren.local>`}:{}),...(reservedResourceId?{reservedResourceId}:{})},...(observedNotionTarget?{observedNotionTarget}:{})}));
    });
  }
  approvalReview(input:NativeOutboundIdInput):ExternalDraftReviewSnapshot{const intent=this.repository.outbound.get(input);if(intent.state!=="prepared")throw new ConnectorStateError("CONNECTOR_DRAFT_CONFLICT");this.repository.outbound.assertReview(input,intent.review);return intent.review;}
  assertApprovalReview(review:ExternalDraftReviewSnapshot,scope:EnvironmentScope):void{const intent=this.repository.outbound.assertReview(scope,review);if(intent.state!=="prepared"||intent.version!==review.expectedIntentVersion)throw new ConnectorStateError("CONNECTOR_DRAFT_CONFLICT");}
  async send(input:NativeOutboundIdInput,approvalId:string,context:ConnectorExecutionContext={}){
    if(this.closed)throw new NativeConnectorError("AUTH_CANCELLED");
    const previous=this.repository.outbound.current(input,input.id);if(previous.state!=="prepared")return previous;
    const existing=this.pending.get(previous.id);if(existing)return existing.promise as Promise<typeof previous>;
    const scope={sessionId:input.sessionId,executorBotId:input.executorBotId},controller=new AbortController(),abort=()=>controller.abort(context.signal?.reason);context.signal?.addEventListener("abort",abort,{once:true});if(context.signal?.aborted)abort();
    const promise=(async()=>{
      let dispatched=false;const attemptId=randomUUID();
      try{
        this.assertApprovalReview(previous.review,scope);
        const approval=this.repository.getApprovalRequest(approvalId),invocation=this.repository.getToolInvocation(approval.toolInvocationId);
        if(approval.state!=="allowed"||approval.runtimeRunId!==invocation.runtimeRunId||approval.targetDigest!==approvalReviewDigest(previous.review)||invocation.sessionId!==scope.sessionId||invocation.executorBotId!==scope.executorBotId)throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
        return await this.connectors.withConnectionAuthorization({...scope,connectionId:previous.connectionId,authVersion:previous.authVersion,accountId:previous.account.accountId},{signal:controller.signal,assertCurrent:context.assertCurrent},async base=>{
          const auth=this.auth(base,previous,async proof=>{
            base.assertCurrent();context.assertCurrent?.();this.assertApprovalReview(previous.review,scope);
            if(proof.operation!==previous.operation||proof.draftDigest!==previous.revisionDigest||proof.targetDigest!==previous.review.targetDigest)throw new NativeConnectorError("RESPONSE_INVALID");
            const currentApproval=this.repository.getApprovalRequest(approvalId);if(currentApproval.state!=="allowed"||currentApproval.targetDigest!==approvalReviewDigest(previous.review))throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
            this.repository.outbound.dispatch(scope,previous.id,input.expectedVersion,proof.wireDigest,attemptId);dispatched=true;
          });
          const outcome=await this.adapter.execute(auth,this.request(previous,attemptId));
          return this.settle(previous.id,outcome,dispatched);
        },true);
      }catch(error){if(dispatched)return this.repository.outbound.settle(previous.id,"unknown",{code:"INTERRUPTED_AFTER_DISPATCH"});throw error;}
      finally{context.signal?.removeEventListener("abort",abort);this.pending.delete(previous.id);}
    })();this.pending.set(previous.id,{scope,grantId:previous.grantId,controller,promise});void promise.finally(()=>this.pending.delete(previous.id)).catch(()=>{});return promise;
  }
  private settle(id:string,outcome:NativeWriteOutcome,dispatched:boolean){
    if(outcome.state==="confirmed"){
      const prior=this.repository.outbound.listInternal(id);
      if(prior.operation==="drive-create-text")try{this.repository.connectors.registerCreatedFileId(prior.connectionId,prior.authVersion,prior.account.accountId,outcome.resourceId);}catch{/* A revoked connection keeps the durable receipt; a fresh grant can register the proven owned file later. */}
    }
    if(!dispatched&&outcome.state!=="rejected")throw new NativeConnectorError("RESPONSE_INVALID");return outcome.state==="confirmed"?this.repository.outbound.settle(id,"confirmed",{resourceId:outcome.resourceId,proofDigest:outcome.proofDigest,...(outcome.confirmationEvidence==="target-state"?{code:"TARGET_STATE_MATCH"}:{})}):outcome.state==="rejected"?this.repository.outbound.settle(id,"rejected",{code:outcome.code}):this.repository.outbound.settle(id,"unknown",{code:outcome.reason,hint:outcome.hint});}
  reconcile(input:NativeOutboundIdInput,context:ConnectorExecutionContext={}){return this.track(context,current=>this.reconcileOnce(input,current));}
  private async reconcileOnce(input:NativeOutboundIdInput,context:ConnectorExecutionContext={}){if(this.closed)throw new NativeConnectorError("AUTH_CANCELLED");const intent=this.repository.outbound.current(input,input.id);if(intent.state!=="unknown")return intent;const scope={sessionId:input.sessionId,executorBotId:input.executorBotId},connection=this.repository.connectors.get(intent.connectionId);if(connection.state!=="connected"||connection.account?.accountId!==intent.account.accountId)throw new ConnectorStateError("CONNECTOR_AUTH_CHANGED");
    const binding=this.repository.connectors.bindings(scope).find(item=>item.connectionId===connection.id);if(!binding)throw new ConnectorStateError("CONNECTOR_NOT_GRANTED");this.repository.connectors.access({...scope,connectionId:connection.id,expectedAuthVersion:connection.authVersion,expectedBindingVersion:binding.version});
    const resourceId=intent.operation==="drive-update-text"&&intent.review.content.kind==="drive-text"?intent.review.content.targetFileId:intent.resultResourceId??intent.reservedResourceId;
    if(connection.provider==="drive"&&(!resourceId||!binding.allowedResourceIds.includes(resourceId)))throw new ConnectorStateError("CONNECTOR_NOT_GRANTED");
    return this.connectors.withConnectionAuthorization({...scope,connectionId:connection.id,authVersion:connection.authVersion,accountId:intent.account.accountId},{...context,assertCurrent:()=>{context.assertCurrent?.();this.repository.connectors.access({...scope,connectionId:connection.id,expectedAuthVersion:connection.authVersion,expectedBindingVersion:binding.version});}},async base=>{const auth=this.auth(base,intent,async()=>{throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");}),outcome=await this.adapter.reconcile(auth,this.request(intent,intent.dispatchAttemptId!),this.repository.outbound.hint(intent.id) as NativeReconcileHint|undefined);return outcome.state==="confirmed"?this.settle(intent.id,outcome,true):this.repository.outbound.current(scope,intent.id);});}
  cancel(input:NativeOutboundIdInput){
    const value=this.repository.outbound.current(input,input.id);this.pending.get(value.id)?.controller.abort();this.uiTasks.get(value.id)?.controller.abort();
    return value.state==="prepared"?this.repository.outbound.settle(value.id,"rejected",{code:"USER_CANCELLED"}):value.state==="dispatching"?this.repository.outbound.settle(value.id,"unknown",{code:"CANCELLED_AFTER_DISPATCH"}):value;
  }
  cancelRuntime(runId:string){
    const runtime=this.repository.getRuntimeRun(runId),entry=[...this.uiTasks.entries()].find(([,job])=>job.runtimeId===runId);
    if(runtime.route!=="host-outbound"||!entry)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    const scope={sessionId:runtime.sessionId,executorBotId:runtime.executorBotId},intent=this.repository.outbound.current(scope,entry[0]);
    if(runtime.providerRequestId!==`host-outbound:${intent.id}`||runtime.promptManifest.digest!==intent.revisionDigest)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    this.cancel({...scope,id:intent.id,expectedVersion:intent.version});
    if(["created","dispatching","running","streaming"].includes(runtime.state))this.repository.transitionRuntimeRun(runId,"cancel-requested");
    if(this.repository.getRuntimeRun(runId).state==="cancel-requested")this.repository.transitionRuntimeRun(runId,"cancelled");
    return this.repository.getRuntimeRun(runId);
  }
  async requestApproval(input:NativeOutboundIdInput,coordinator:WorkspaceToolCoordinator):Promise<ToolPrepareResult>{
    if(this.closed)throw new NativeConnectorError("AUTH_CANCELLED");const intent=this.repository.outbound.get(input);this.assertApprovalReview(intent.review,input);
    const existing=this.uiTasks.get(intent.id);if(existing){const approval=this.repository.listPendingApprovalRequests(intent.sessionId).find(item=>item.runtimeRunId===existing.runtimeId);if(approval)return {disposition:"duplicate",approval,invocation:this.repository.getToolInvocation(approval.toolInvocationId)};throw new ConnectorStateError("CONNECTOR_DRAFT_CONFLICT");}
    const nonce=randomUUID(),controller=new AbortController();this.repository.prepareHostOutboundMessage({sessionId:intent.sessionId,clientNonce:nonce,text:`提交本地草稿 ${intent.review.revisionNumber}：${intent.operation}`},intent.executorBotId);this.repository.acknowledgeUserMessage(nonce);
    const message=this.repository.getUserMessage(nonce),session=this.repository.getSession(intent.sessionId);
    const run=this.repository.createRuntimeRun(nonce,"host-outbound",{schemaVersion:1,botId:intent.executorBotId,profileVersion:this.repository.getBot(intent.executorBotId).version,
      sessionId:intent.sessionId,generation:session.generation,inputSeq:message.seq,blocks:[],digest:intent.revisionDigest},{executorBotId:intent.executorBotId});
    this.repository.transitionRuntimeRun(run.id,"dispatching");this.repository.transitionRuntimeRun(run.id,"running",{providerRequestId:`host-outbound:${intent.id}`});
    let waiting:ReturnType<WorkspaceToolCoordinator["requestAndWait"]>;
    try{waiting=coordinator.requestAndWait(run.id,randomUUID(),{kind:"product-call",action:"execute",operation:"outbound.send",input:{id:intent.id,expectedVersion:intent.version}},controller.signal);}
    catch(error){controller.abort();this.repository.transitionRuntimeRun(run.id,"cancel-requested");this.repository.transitionRuntimeRun(run.id,"cancelled");throw error;}
    const task=waiting
      .then(result=>{const current=this.repository.outbound.current(input,intent.id);if(current.state==="prepared")this.repository.outbound.settle(intent.id,"rejected",{code:"APPROVAL_REJECTED"});const runtime=this.repository.getRuntimeRun(run.id);if(["running","streaming"].includes(runtime.state))this.repository.transitionRuntimeRun(run.id,"completed");return result;},error=>{const current=this.repository.outbound.current(input,intent.id);if(current.state==="prepared")this.repository.outbound.settle(intent.id,"rejected",{code:"APPROVAL_CANCELLED"});const runtime=this.repository.getRuntimeRun(run.id);if(["running","streaming"].includes(runtime.state))this.repository.transitionRuntimeRun(run.id,"cancel-requested");if(this.repository.getRuntimeRun(run.id).state==="cancel-requested")this.repository.transitionRuntimeRun(run.id,"cancelled");throw error;}).finally(()=>this.uiTasks.delete(intent.id));
    void task.catch(()=>{});this.uiTasks.set(intent.id,{controller,runtimeId:run.id,promise:task});
    const approval=this.repository.listPendingApprovalRequests(intent.sessionId).find(item=>item.runtimeRunId===run.id);if(!approval){controller.abort();throw new NativeConnectorError("RESPONSE_INVALID");}
    return {disposition:"prepared",approval,invocation:this.repository.getToolInvocation(approval.toolInvocationId)};
  }
  async shutdown():Promise<void>{this.closed=true;for(const job of this.pending.values())job.controller.abort();for(const job of this.uiTasks.values())job.controller.abort();for(const controller of this.auxiliary.values())controller.abort();await Promise.allSettled([...this.pending.values(),...this.uiTasks.values()].map(job=>job.promise).concat([...this.auxiliary.keys()]));}
}
