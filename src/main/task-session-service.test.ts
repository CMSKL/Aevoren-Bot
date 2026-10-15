import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskExecutorSelection } from "@shared/task-session-contracts";
import { AppRepository } from "./database";
import { TaskSessionService } from "./task-session-service";
import type { SendWorker } from "./send-worker";
import type { RoomCoordinator } from "./room-coordinator";
import type { EnvironmentService } from "./environment-service";
const repositories:AppRepository[]=[];
afterEach(()=>{for(const repo of repositories.splice(0))repo.close();});
const selection=(executorBotId:string,patch:Partial<TaskExecutorSelection>={}):TaskExecutorSelection=>({executorBotId,memories:[],history:[],workspaces:[],mcp:[],resourceRefs:[],mediaRefs:[],productOperations:[],network:false,clipboard:false,...patch});
function fixture(retire?:EnvironmentService["retire"]){
  const repo=new AppRepository(":memory:");repositories.push(repo);const owner=repo.createBot();
  const cancelRun=vi.fn(),cancel=vi.fn(),changed=vi.fn();
  const service=new TaskSessionService(repo,{executor:{cancelRun}} as unknown as SendWorker,{cancel} as unknown as RoomCoordinator,{availableTools:()=>[]},changed,retire?{retire}:undefined);
  const create=()=>service.create({parentSessionId:owner.session.id,expectedScopeVersion:repo.tasks.scopeVersion(owner.session.id),clientNonce:randomUUID(),title:"Focused",selections:[selection(owner.bot.id)]});
  return {repo,owner,service,cancelRun,cancel,changed,create};
}
describe("Task host lifecycle",()=>{
  it("lists real MAIN resources and restricts AI options to its selected member resources",()=>{
    const f=fixture(),other=f.repo.createBot(),room=f.repo.createRoom({memberBotIds:[f.owner.bot.id,other.bot.id]});
    const a=f.repo.library.create({sessionId:room.session.id,kind:"document",name:"Chosen A",body:"A"});
    const b=f.repo.library.create({sessionId:room.session.id,kind:"document",name:"Chosen B",body:"B"});
    expect(f.service.options({sessionId:room.session.id}).resources).toHaveLength(2);
    const child=f.service.create({parentSessionId:room.session.id,expectedScopeVersion:f.repo.tasks.scopeVersion(room.session.id),clientNonce:randomUUID(),title:"Split",selections:[selection(f.owner.bot.id,{resourceRefs:[a.reference]}),selection(other.bot.id,{resourceRefs:[b.reference]})]});
    const options=f.service.options({sessionId:child.session.id},f.owner.bot.id);
    expect(options.executors.map(value=>value.id)).toEqual([f.owner.bot.id]);
    expect(options.resources.map(value=>value.reference)).toEqual([a.reference]);
    expect(JSON.stringify(options)).not.toContain("Chosen B");
  });
  it("retires only the selected Task environments before deleting persistent metadata",async()=>{
    const retired:string[][]=[];
    const f=fixture(async(sessionIds,_bots,preflight,commit)=>{preflight();retired.push(sessionIds);return commit();});
    const child=f.create(),sibling=f.create();
    await f.service.delete({sessionId:child.session.id,expectedVersion:child.version});
    expect(retired).toEqual([[child.session.id]]);expect(f.repo.tasks.get(sibling.session.id).session.id).toBe(sibling.session.id);
    expect(f.repo.getMainSession(f.owner.bot.id).id).toBe(f.owner.session.id);
    expect(f.changed).toHaveBeenLastCalledWith({sessionId:child.session.id,deleted:true});
  });
  it("retains Task metadata on retirement failure and rechecks CAS after asynchronous cleanup",async()=>{
    const f=fixture(async()=>{throw new Error("controlled Docker cleanup failure");}),child=f.create();
    await expect(f.service.delete({sessionId:child.session.id,expectedVersion:child.version})).rejects.toThrow("cleanup failure");
    expect(f.repo.tasks.get(child.session.id).title).toBe("Focused");
    const g=fixture(async(_sessions,_bots,preflight,commit)=>{preflight();const detail=g.repo.tasks.list({parentSessionId:g.owner.session.id})[0]!;g.repo.tasks.update({sessionId:detail.session.id,expectedVersion:detail.version,title:"Concurrent edit"});return commit();}),target=g.create();
    await expect(g.service.delete({sessionId:target.session.id,expectedVersion:target.version})).rejects.toMatchObject({code:"CONVERSATION_VERSION_CONFLICT"});
    expect(g.repo.tasks.get(target.session.id).title).toBe("Concurrent edit");
  });
});
