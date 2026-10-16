import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest } from "@shared/contracts";
import { AppRepository } from "./database";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";
import { GeneralSettingsService } from "./settings";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { SendWorker } from "./send-worker";
import { RoomCoordinator } from "./room-coordinator";
import { RoutineService } from "./routine-service";
vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const schedule={type:"interval",everyMinutes:60,anchorAt:Date.now()+60_000} as const;
const call=(operation:string,input?:unknown):ProductToolRequest=>({kind:"product-call",action:"execute",operation,...(input===undefined?{}:{input})});
function fixture(){
  const repository=new AppRepository(":memory:"),owner=repository.createBot(),other=repository.createBot(),workspaceService=new WorkspaceService(repository);
  const executor=new WorkspaceToolExecutor(repository,workspaceService),tools=new WorkspaceToolCoordinator(repository,executor,()=>{}),worker=new SendWorker(repository,null,{transcript:()=>{},sendState:()=>{},runtime:()=>{}}),rooms=new RoomCoordinator(repository,worker.executor,{transcript:()=>{},roomRuntime:()=>{}}),routines=new RoutineService(repository,worker,()=>{},undefined,rooms);
  cleanup.push(async()=>{await routines.shutdown();await worker.shutdown();await rooms.shutdown();repository.close();});
  const product=new ProductOperationService({repository,workspaceService,workspaceToolCoordinator:tools,sendWorker:worker,roomCoordinator:rooms,routineService:routines,generalSettings:new GeneralSettingsService(repository),providers:{list:async()=>[],isSupported:()=>true},updateService:{},productChanged:()=>{}} as unknown as ProductDependencies);executor.setProductOperations(product);
  const runtime=(sessionId=owner.session.id)=>{const nonce=randomUUID();repository.prepareMessage({sessionId,clientNonce:nonce,text:"Manage this conversation's saved automation"});const entry=repository.getUserMessage(nonce),run=repository.createRuntimeRun(nonce,"fake",{schemaVersion:1,botId:owner.bot.id,profileVersion:owner.bot.version,sessionId,generation:entry.generation,inputSeq:entry.seq,blocks:[],digest:"routine-product"});repository.transitionRuntimeRun(run.id,"dispatching");return repository.transitionRuntimeRun(run.id,"running");};
  const run=runtime(),context={sessionId:owner.session.id,executorBotId:owner.bot.id,runtimeRunId:run.id};
  const prepare=(tool:ProductToolRequest)=>{product.validate(tool,run.id);const value=repository.prepareToolInvocation({runtimeRunId:run.id,toolCallId:randomUUID(),idempotencyKey:randomUUID(),tool});repository.resolveToolApproval(value.approval.id,value.approval.version,"allow-once");return value;};
  const execute=(tool:ProductToolRequest)=>executor.execute(prepare(tool).invocation.id);
  return {repository,owner,other,routines,product,executor,run,context,runtime,prepare,execute};
}
describe("Routine UI/AI shared business and approval scope",()=>{
  it("creates through approved shared handlers and returns only the current session's definitions",async()=>{
    const f=fixture();f.routines.create({name:"Other private rule",prompt:"OTHER_PRIVATE_PROMPT",botId:f.other.bot.id,schedule});
    expect(f.product.requiresApproval(call("routines.create",{}))).toBe(true);
    const created=JSON.parse((await f.execute(call("routines.create",{name:"Current",prompt:"Approved instruction",botId:f.owner.bot.id,schedule}))).content).result;
    expect(created.target).toMatchObject({kind:"bot",sessionId:f.owner.session.id,botId:f.owner.bot.id});
    const listed=await f.execute(call("routines.list"));expect(listed.content).toContain("Approved instruction");expect(listed.content).not.toContain("OTHER_PRIVATE_PROMPT");
  });
  it("rejects every foreign definition/run control before preparing an approval",()=>{
    const f=fixture(),routine=f.routines.create({name:"Foreign",prompt:"Other",botId:f.other.bot.id,schedule}),run=f.repository.routineTargets.createTrigger({routineId:routine.id,expectedVersion:routine.version,triggerKey:"foreign-pending",trigger:"manual"},Date.now());
    for(const tool of [call("routines.listRuns",routine.id),call("routines.runNow",{id:routine.id,expectedVersion:routine.version}),call("routines.cancelRun",{runId:run.id,expectedVersion:run.version}),call("routines.update",{id:routine.id,expectedVersion:routine.version,patch:{name:"Changed"}}),call("routines.create",{name:"Foreign copy",prompt:"No",botId:f.other.bot.id,schedule})])expect(()=>f.product.validate(tool,f.run.id)).toThrowError(expect.objectContaining({code:"RUNTIME_CONTROL_SCOPE_INVALID"}));
    expect(f.repository.listToolInvocations(f.owner.session.id)).toEqual([]);expect(f.repository.getRoutineRun(run.id).state).toBe("queued");
  });
  it("does not run a definition changed after its exact version was approved",async()=>{
    const f=fixture(),routine=f.routines.create({name:"Current",prompt:"Original",botId:f.owner.bot.id,schedule}),prepared=f.prepare(call("routines.runNow",{id:routine.id,expectedVersion:routine.version}));
    f.routines.update(routine.id,routine.version,{prompt:"Unapproved later instruction"});await expect(f.executor.execute(prepared.invocation.id)).rejects.toMatchObject({code:"ROUTINE_VERSION_CONFLICT"});expect(f.routines.listRuns(routine.id)).toEqual([]);
  });
  it("keeps a model run-now receipt stable while waiting and cancels only that accepted run",async()=>{
    const f=fixture(),routine=f.routines.create({name:"Current",prompt:"Saved",botId:f.owner.bot.id,schedule}),input={id:routine.id,expectedVersion:routine.version};
    const first=await f.routines.runNow(input,f.context),again=await f.routines.runNow(input,f.context);expect(again.id).toBe(first.id);expect(first.state).toBe("waiting");expect(f.routines.listRuns(routine.id)).toHaveLength(1);
    const cancelled=JSON.parse((await f.execute(call("routines.cancelRun",{runId:first.id,expectedVersion:again.version}))).content).result;expect(cancelled.state).toBe("cancelled");expect(f.repository.getRuntimeRun(f.run.id).state).toBe("running");
  });
  it("rejects a stale reviewed room membership even if its selected member IDs are unchanged",()=>{
    const f=fixture(),room=f.repository.createRoom({memberBotIds:[f.owner.bot.id,f.other.bot.id]}),third=f.repository.createBot(),target={kind:"room" as const,roomId:room.room.id,sessionId:room.session.id,routingMode:"everyone" as const,targetBotIds:[f.owner.bot.id,f.other.bot.id],expectedMembershipVersion:room.room.membershipVersion};
    const added=f.repository.addRoomMember(room.room.id,third.bot.id,room.room.membershipVersion);f.repository.removeRoomMember(room.room.id,third.bot.id,added.room.membershipVersion);
    expect(()=>f.routines.create({name:"Stale review",prompt:"No implicit new review",target,schedule})).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));expect(f.routines.list()).toEqual([]);
  });
});
