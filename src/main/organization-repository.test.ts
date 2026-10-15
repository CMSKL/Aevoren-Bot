import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import { OrganizationRepository } from "./organization-repository";
import { OrganizationService } from "./organization-service";
import { taskExecutorSelectionSchema } from "@shared/task-session-schemas";

const repositories:AppRepository[]=[],directories:string[]=[];
function open(filename=":memory:"){
  const app=new AppRepository(filename);repositories.push(app);const database=Reflect.get(app,"database") as DatabaseSync;
  const repository=new OrganizationRepository(database,{assertSession:id=>{app.getSession(id);},assertBot:id=>{app.getBot(id);},assertContext:context=>{
    app.assertSessionExecutor(context.sessionId,context.executorBotId);
    if(context.runtimeRunId){const run=app.getRuntimeRun(context.runtimeRunId);if(run.sessionId!==context.sessionId||run.executorBotId!==context.executorBotId||!["created","dispatching","running","streaming"].includes(run.state))throw new AevorenBotError("APPROVAL_SCOPE_INVALID");}
  }});
  return {app,database,repository,service:new OrganizationService(repository)};
}
function directory(){const value=mkdtempSync(join(tmpdir(),"aevoren-organization-"));directories.push(value);return value;}
afterEach(()=>{for(const app of repositories.splice(0))app.close();for(const value of directories.splice(0))rmSync(value,{recursive:true,force:true});});
describe("personal organization uses real scoped sessions without changing authority",()=>{
  it("creates, renames and reorders the full bounded section set with global version CAS",()=>{
    const f=open(),initial=f.service.snapshot();expect(initial).toEqual({version:1,sections:[],assignments:[],preferences:{defaultAssistantBotId:null,notifications:{approvals:true,taskCompletion:false,taskFailure:false,routines:true},sound:true}});
    const first=f.service.createSection({expectedVersion:1,name:"  Research  "});expect(first.sections[0]!.name).toBe("Research");expect(first.version).toBe(2);
    const second=f.service.createSection({expectedVersion:first.version,name:"Writing"});const ids=second.sections.map(item=>item.id);
    const ordered=f.service.reorderSections({expectedVersion:second.version,sectionIds:ids.toReversed()});expect(ordered.sections.map(item=>item.id)).toEqual(ids.toReversed());
    const renamed=f.service.renameSection({expectedVersion:ordered.version,id:ids[0]!,name:"Findings"});expect(renamed.sections.map(item=>item.position)).toEqual([0,1]);
    expect(renamed.sections.find(item=>item.id===ids[0])!.name).toBe("Findings");
  });
  it("retains the user's stale draft and rolls back invalid names, IDs and incomplete reorders",()=>{
    const f=open(),snapshot=f.service.createSection({expectedVersion:1,name:"Original"}),draft={expectedVersion:1,id:snapshot.sections[0]!.id,name:"Unsaved draft"};
    expect(()=>f.service.renameSection(draft)).toThrowError(expect.objectContaining({code:"ORG_VERSION_CONFLICT"}));expect(draft.name).toBe("Unsaved draft");
    expect(()=>f.service.reorderSections({expectedVersion:snapshot.version,sectionIds:[]})).toThrowError();
    expect(()=>f.service.createSection({expectedVersion:snapshot.version,name:" "})).toThrowError();
    expect(()=>f.service.renameSection({expectedVersion:snapshot.version,id:randomUUID(),name:"Missing"})).toThrowError();
    expect(f.service.snapshot()).toEqual(snapshot);
  });
  it("moves MAIN and TASK by session ID, restores deleted-section assignments to default, and never copies history or grants",()=>{
    const f=open(),owner=f.app.createBot(),second=f.app.createBot(),memory=f.app.createMemory(owner.bot.id,"Private source memory");
    const task=f.app.tasks.create({parentSessionId:owner.session.id,expectedScopeVersion:1,clientNonce:randomUUID(),title:"Independent",selections:[taskExecutorSelectionSchema.parse({executorBotId:owner.bot.id})]});
    const sourceBefore=f.database.prepare("SELECT * FROM memory_items WHERE id=?").get(memory.id);
    let state=f.service.createSection({expectedVersion:1,name:"Projects"});const id=state.sections[0]!.id;
    state=f.service.moveSession({expectedVersion:state.version,sessionId:owner.session.id,sectionId:null});
    state=f.service.moveSession({expectedVersion:state.version,sessionId:task.session.id,sectionId:id});
    state=f.service.moveSession({expectedVersion:state.version,sessionId:second.session.id,sectionId:id,position:0});
    expect(state.assignments.filter(item=>item.sectionId===id).map(item=>item.sessionId)).toEqual([second.session.id,task.session.id]);
    state=f.service.deleteSection({expectedVersion:state.version,id});expect(state.sections).toEqual([]);
    expect(state.assignments.map(item=>item.sessionId)).toEqual([owner.session.id,second.session.id,task.session.id]);expect(state.assignments.map(item=>item.position)).toEqual([0,1,2]);
    expect(f.database.prepare("SELECT * FROM memory_items WHERE id=?").get(memory.id)).toEqual(sourceBefore);
    expect(f.app.listRuntimeMemories(owner.bot.id,task.session.id)).toEqual([]);expect(f.app.listTranscript(task.session.id)).toEqual([]);expect(f.app.listSessionWorkspaces(task.session.id,owner.bot.id)).toEqual([]);
  });
  it("compacts default positions after owner cleanup before appending a deleted section",()=>{
    const f=open(),bots=Array.from({length:4},()=>f.app.createBot());let state=f.service.createSection({expectedVersion:1,name:"To remove"});const sectionId=state.sections[0]!.id;
    for(const bot of bots.slice(0,3))state=f.service.moveSession({expectedVersion:state.version,sessionId:bot.session.id,sectionId:null});
    f.service.moveSession({expectedVersion:state.version,sessionId:bots[3]!.session.id,sectionId});f.app.deleteBot(bots[1]!.bot.id);
    state=f.service.deleteSection({expectedVersion:f.service.snapshot().version,id:sectionId});
    expect(state.assignments.map(item=>item.position)).toEqual([0,1,2]);expect(state.assignments.map(item=>item.sessionId)).toEqual([bots[0]!.session.id,bots[2]!.session.id,bots[3]!.session.id]);
  });
  it("limits AI assignment snapshots and moves to the exact current session",()=>{
    const f=open(),first=f.app.createBot(),second=f.app.createBot();let state=f.service.createSection({expectedVersion:1,name:"Current"});const sectionId=state.sections[0]!.id;
    state=f.service.moveSession({expectedVersion:state.version,sessionId:first.session.id,sectionId});state=f.service.moveSession({expectedVersion:state.version,sessionId:second.session.id,sectionId});
    const context={sessionId:first.session.id,executorBotId:first.bot.id};expect(f.service.snapshot(context).assignments.map(item=>item.sessionId)).toEqual([first.session.id]);
    expect(()=>f.service.moveSession({expectedVersion:state.version,sessionId:second.session.id,sectionId:null},context)).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
    expect(f.service.snapshot().version).toBe(state.version);
    const moved=f.service.moveSession({expectedVersion:state.version,sessionId:first.session.id,sectionId:null},context);expect(moved.assignments).toEqual([{sessionId:first.session.id,sectionId:null,position:0}]);
    expect(()=>f.service.snapshot({sessionId:first.session.id,executorBotId:second.bot.id})).toThrowError();
  });
  it("persists independent notification categories and a valid optional default assistant without changing Bot settings",()=>{
    const f=open(),owner=f.app.createBot(),original=f.app.getBot(owner.bot.id);
    let state=f.service.savePreferences({expectedVersion:1,patch:{defaultAssistantBotId:owner.bot.id,notifications:{approvals:false,taskFailure:false},sound:true}});
    expect(state.preferences).toEqual({defaultAssistantBotId:owner.bot.id,notifications:{approvals:false,taskCompletion:false,taskFailure:false,routines:true},sound:true});
    state=f.service.savePreferences({expectedVersion:state.version,patch:{notifications:{routines:false}}});expect(state.preferences.notifications.approvals).toBe(false);expect(state.preferences.sound).toBe(true);
    expect(()=>f.service.savePreferences({expectedVersion:state.version,patch:{defaultAssistantBotId:randomUUID()}})).toThrowError();expect(f.service.snapshot()).toEqual(state);expect(f.app.getBot(owner.bot.id)).toEqual(original);
    expect(f.service.savePreferences({expectedVersion:state.version,patch:{defaultAssistantBotId:null}}).preferences.defaultAssistantBotId).toBeNull();
  });
  it("cleans assignments and the default assistant when real owners are retired or deleted, invalidating stale versions",()=>{
    const f=open(),owner=f.app.createBot();let state=f.service.moveSession({expectedVersion:1,sessionId:owner.session.id,sectionId:null});
    state=f.service.savePreferences({expectedVersion:state.version,patch:{defaultAssistantBotId:owner.bot.id}});const stale=state.version;
    f.app.deleteBot(owner.bot.id);const current=f.service.snapshot();expect(current.assignments).toEqual([]);expect(current.preferences.defaultAssistantBotId).toBeNull();expect(current.version).toBeGreaterThan(stale);
    expect(()=>f.service.createSection({expectedVersion:stale,name:"Delayed change"})).toThrowError(expect.objectContaining({code:"ORG_VERSION_CONFLICT"}));expect(f.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("persists actual SQLite state across close/reopen and detects two-connection stale writes",()=>{
    const filename=join(directory(),"app.sqlite"),first=open(filename),owner=first.app.createBot();let state=first.service.createSection({expectedVersion:1,name:"Persistent"});
    state=first.service.moveSession({expectedVersion:state.version,sessionId:owner.session.id,sectionId:state.sections[0]!.id});
    const second=open(filename),observed=second.service.snapshot();expect(observed).toEqual(state);
    const updated=first.service.savePreferences({expectedVersion:state.version,patch:{sound:true}});
    expect(()=>second.service.renameSection({expectedVersion:observed.version,id:observed.sections[0]!.id,name:"Stale peer"})).toThrowError(expect.objectContaining({code:"ORG_VERSION_CONFLICT"}));
    second.app.close();repositories.splice(repositories.indexOf(second.app),1);first.app.close();repositories.splice(repositories.indexOf(first.app),1);
    expect(open(filename).service.snapshot()).toEqual(updated);
  });
  it("does not publish partial mutations when an outer product receipt transaction rolls back",()=>{
    const f=open();expect(()=>f.app.demonstrationsTransaction(()=>{f.service.createSection({expectedVersion:1,name:"Must roll back"});throw new Error("Receipt rejected");})).toThrow("Receipt rejected");
    expect(f.service.snapshot().version).toBe(1);expect(f.service.snapshot().sections).toEqual([]);
  });
});
