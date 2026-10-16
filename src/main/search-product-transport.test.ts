import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest } from "@shared/contracts";
import { AppRepository } from "./database";
import { SearchService } from "./search-service";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";
import { SendWorker } from "./send-worker";
import { RoomCoordinator } from "./room-coordinator";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { GeneralSettingsService } from "./settings";
import { toolImageResponse } from "./model-image";
vi.mock("electron",()=>({clipboard:{writeText:vi.fn()}}));
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
function fixture(){
  const repository=new AppRepository(":memory:"),owner=repository.createBot(),workspaceService=new WorkspaceService(repository),executor=new WorkspaceToolExecutor(repository,workspaceService),tools=new WorkspaceToolCoordinator(repository,executor,()=>{});
  const worker=new SendWorker(repository,null,{transcript:()=>{},sendState:()=>{},runtime:()=>{}}),rooms=new RoomCoordinator(repository,worker.executor,{transcript:()=>{},roomRuntime:()=>{}});
  cleanup.push(async()=>{await worker.shutdown();await rooms.shutdown();repository.close();});
  const service=new ProductOperationService({repository,workspaceService,workspaceToolCoordinator:tools,sendWorker:worker,roomCoordinator:rooms,generalSettings:new GeneralSettingsService(repository),providers:{list:async()=>[],isSupported:()=>true},updateService:{},searchService:new SearchService(repository,repository.search)} as unknown as ProductDependencies);executor.setProductOperations(service);
  const start=(sessionId=owner.session.id)=>{const nonce=randomUUID();repository.prepareMessage({sessionId,clientNonce:nonce,text:"检索当前授权的灯塔资料"});const entry=repository.getUserMessage(nonce);const run=repository.createRuntimeRun(nonce,"fake",{schemaVersion:1,botId:owner.bot.id,profileVersion:1,sessionId,generation:entry.generation,inputSeq:entry.seq,blocks:[],digest:"search-transport"},{executorBotId:owner.bot.id});repository.transitionRuntimeRun(run.id,"dispatching");repository.transitionRuntimeRun(run.id,"running");return run;};
  const query=async(runId:string,input:unknown={query:"灯塔",kinds:["document"]})=>{const tool:ProductToolRequest={kind:"product-call",action:"execute",operation:"search.query",input};const prepared=repository.prepareToolInvocation({runtimeRunId:runId,toolCallId:randomUUID(),idempotencyKey:randomUUID(),tool});if(prepared.approval.state==="pending")repository.resolveToolApproval(prepared.approval.id,prepared.approval.version,"allow-once");return executor.execute(prepared.invocation.id);};
  return{repository,owner,query,start};
}
describe("private search result model transport",()=>{
  it("keeps titles and snippets out of durable receipts and revokes cached model text before serialization",async()=>{
    const f=fixture(),content=f.repository.library.create({sessionId:f.owner.session.id,kind:"document",name:"私有灯塔文档",body:"灯塔未公开正文"}),run=f.start(),result=await f.query(run.id);
    expect(result.content).not.toContain("私有灯塔文档");expect(result.content).not.toContain("灯塔未公开正文");
    expect(toolImageResponse(result.content,[],result.modelText).text).toContain("灯塔未公开正文");
    f.repository.library.unbind({sessionId:f.owner.session.id,id:content.resource.id});
    const wire=toolImageResponse(result.content,[],result.modelText).text;expect(wire).not.toContain("灯塔未公开正文");expect(wire).not.toContain("私有灯塔文档");
    f.repository.library.bind({sessionId:f.owner.session.id,id:content.resource.id});expect(result.modelText?.isAuthorized()).toBe(false);
  });
  it("uses the Runtime's Task document revision and denies global or sibling scope",async()=>{
    const f=fixture(),content=f.repository.library.create({sessionId:f.owner.session.id,kind:"document",name:"灯塔资料",body:"灯塔固定版本"});
    const task=f.repository.tasks.create({parentSessionId:f.owner.session.id,expectedScopeVersion:f.repository.tasks.scopeVersion(f.owner.session.id),clientNonce:randomUUID(),title:"Private search",selections:[{executorBotId:f.owner.bot.id,memories:[],history:[],workspaces:[],mcp:[],resourceRefs:[content.reference],mediaRefs:[],productOperations:["search.query","search.open"],network:false,clipboard:false}]});
    const run=f.start(task.session.id);f.repository.library.update({sessionId:f.owner.session.id,id:content.resource.id,expectedVersion:1,body:"灯塔未选择的新版本"});
    const result=await f.query(run.id);expect(result.modelText?.text).toContain("灯塔固定版本");expect(result.modelText?.text).not.toContain("灯塔未选择的新版本");
    await expect(f.query(run.id,{query:"灯塔",scope:{kind:"all"}})).rejects.toMatchObject({code:"RUNTIME_CONTROL_SCOPE_INVALID"});
    await expect(f.query(run.id,{query:"灯塔",scope:{kind:"session",sessionId:f.owner.session.id}})).rejects.toMatchObject({code:"RUNTIME_CONTROL_SCOPE_INVALID"});
  });
});
