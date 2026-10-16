import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptManifest } from "@shared/contracts";
import type { ResourceReference } from "@shared/library-contracts";
import { taskExecutorSelectionSchema } from "@shared/task-session-schemas";
import { LIBRARY_PRODUCT_OPERATIONS } from "@shared/library-product";
import { AppRepository } from "./database";
import { LibraryService } from "./library-service";
import { addLibraryProductHandlers } from "./library-product-handlers";
const repositories:AppRepository[]=[],directories:string[]=[];
function fixture(){const repository=new AppRepository(":memory:");repositories.push(repository);const first=repository.createBot(),second=repository.createBot(),third=repository.createBot();
  const room=repository.createRoom({memberBotIds:[first.bot.id,second.bot.id,third.bot.id]});
  const a=repository.library.create({sessionId:room.session.id,kind:"skill",name:"old-skill",description:"Selected description",body:"ORIGINAL_SELECTED_NEEDLE"});
  const b=repository.library.create({sessionId:room.session.id,kind:"document",name:"Other member",body:"OTHER_MEMBER_SECRET"});
  const child=repository.tasks.create({parentSessionId:room.session.id,expectedScopeVersion:1,clientNonce:randomUUID(),title:"Separate context",selections:[selected(first.bot.id,[a.reference]),selected(second.bot.id,[b.reference])]});
  return {repository,first,second,third,room,a,b,child};
}
function selected(executorBotId:string,resourceRefs:ResourceReference[]=[]){return taskExecutorSelectionSchema.parse({executorBotId,resourceRefs});}
function start(f:ReturnType<typeof fixture>,actor=f.first.bot.id){const sessionId=f.child.session.id,nonce=randomUUID();f.repository.prepareMessage({sessionId,clientNonce:nonce,text:"Task request"});const entry=f.repository.getUserMessage(nonce);
  const manifest:PromptManifest={schemaVersion:1,botId:actor,profileVersion:1,sessionId,generation:entry.generation,inputSeq:entry.seq,blocks:[],digest:"task-library"};
  return f.repository.createRuntimeRun(nonce,"fake",manifest,{executorBotId:actor});}
function service(repository:AppRepository){const directory=mkdtempSync(join(tmpdir(),"aevoren-task-library-"));directories.push(directory);return new LibraryService(repository,directory);}
afterEach(()=>{for(const repository of repositories.splice(0))repository.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
describe("Task Library immutable executor authority",()=>{
  it("hides another member's bound resource from read, search, versions and script resolution while trusted UI keeps the union",()=>{
    const f=fixture(),sessionId=f.child.session.id,actor=f.first.bot.id;
    expect(f.repository.library.list({sessionId},actor).map(item=>item.id)).toEqual([f.a.resource.id]);
    expect(f.repository.library.list({sessionId,query:"OTHER_MEMBER_SECRET"},actor)).toEqual([]);
    expect(()=>f.repository.library.read({sessionId,id:f.b.resource.id},actor)).toThrowError();
    expect(()=>f.repository.library.versions({sessionId,id:f.b.resource.id},actor)).toThrowError();
    expect(()=>f.repository.library.resolveReferences(sessionId,[f.b.reference],actor)).toThrowError();
    expect(f.repository.library.resolveReferences(sessionId,[f.a.reference],actor)[0]!.revision.body).toBe(f.a.revision.body);
    expect(f.repository.library.read({sessionId,id:f.b.resource.id}).revision.body).toBe("OTHER_MEMBER_SECRET");
    expect(f.repository.library.list({sessionId})).toHaveLength(2);
  });
  it("pins metadata, search text, version history, file reads and export to the selected revision",async()=>{
    const f=fixture(),sessionId=f.child.session.id,actor=f.first.bot.id,library=service(f.repository);
    const newer=f.repository.library.update({sessionId:f.room.session.id,id:f.a.resource.id,expectedVersion:1,name:"Unselected title",description:"Unselected description",body:"UNSELECTED_LATER_BODY"});
    const content=f.repository.library.read({sessionId,id:f.a.resource.id},actor);
    expect(content.reference).toEqual(f.a.reference);expect(content.resource.name).toBe("old-skill");expect(content.resource.currentRevisionId).toBe(f.a.revision.id);
    expect(f.repository.library.list({sessionId,query:"ORIGINAL_SELECTED_NEEDLE"},actor).map(item=>item.id)).toEqual([f.a.resource.id]);
    expect(f.repository.library.list({sessionId,query:"UNSELECTED_LATER_BODY"},actor)).toEqual([]);
    expect(f.repository.library.list({sessionId,query:"Unselected title"},actor)).toEqual([]);
    expect(f.repository.library.versions({sessionId,id:f.a.resource.id},actor).map(item=>item.id)).toEqual([f.a.revision.id]);
    expect(()=>f.repository.library.read({sessionId,id:f.a.resource.id,revisionId:newer.revision.id},actor)).toThrowError(expect.objectContaining({code:"LIBRARY_REFERENCE_INVALID"}));
    expect(()=>f.repository.library.resolveReferences(sessionId,[newer.reference],actor)).toThrowError();
    const file=await library.readResourceFile({sessionId,id:f.a.resource.id,revisionId:f.a.revision.id,path:"SKILL.md"},undefined,actor);
    expect(file.data).toBe(f.a.revision.body);
    await expect(library.readResourceFile({sessionId,id:f.a.resource.id,revisionId:newer.revision.id,path:"SKILL.md"},undefined,actor)).rejects.toThrowError();
    const exported=await library.prepareExport({sessionId,id:f.a.resource.id},undefined,actor);
    expect(exported.revisionId).toBe(f.a.revision.id);expect(exported.files[0]!.bytes.toString()).toContain(f.a.revision.body);expect(exported.files[0]!.bytes.toString()).not.toContain("UNSELECTED");
    await expect(library.prepareExport({sessionId,id:f.b.resource.id},undefined,actor)).rejects.toThrowError();
    expect(()=>f.repository.library.update({sessionId,id:f.a.resource.id,expectedVersion:newer.resource.version,name:"Copy latest body"},actor)).toThrowError();
  });
  it("keeps an originally empty Runtime empty after later explicit selection",()=>{
    const f=fixture(),sessionId=f.child.session.id,actor=f.first.bot.id;
    f.repository.tasks.reviseSelection({sessionId,expectedVersion:f.child.version,selections:[selected(actor)]});const run=start(f);
    const version=f.repository.tasks.get(sessionId).version;
    f.repository.tasks.reviseSelection({sessionId,expectedVersion:version,selections:[selected(actor,[f.a.reference])]});
    expect(f.repository.library.read({sessionId,id:f.a.resource.id},actor).reference).toEqual(f.a.reference);
    expect(f.repository.library.list({sessionId},actor,run.id)).toEqual([]);
    expect(()=>f.repository.library.read({sessionId,id:f.a.resource.id},actor,run.id)).toThrowError();
    expect(()=>f.repository.library.resolveReferences(sessionId,[f.a.reference],actor,run.id)).toThrowError();
  });
  it("retains the original Runtime revision when the current Task selects a newer version and services forward its pin",async()=>{
    const f=fixture(),sessionId=f.child.session.id,actor=f.first.bot.id,run=start(f),library=service(f.repository);
    const newer=f.repository.library.update({sessionId:f.room.session.id,id:f.a.resource.id,expectedVersion:1,body:"NEW_SELECTED_CONTEXT"});
    f.repository.tasks.reviseSelection({sessionId,expectedVersion:f.child.version,selections:[selected(actor,[newer.reference])]});
    expect(f.repository.library.read({sessionId,id:f.a.resource.id},actor).reference).toEqual(newer.reference);
    expect(f.repository.library.read({sessionId,id:f.a.resource.id},actor,run.id).reference).toEqual(f.a.reference);
    expect(f.repository.tasks.runtimeTaskPolicy(run.id)!.selection.resourceRefs).toEqual([f.a.reference]);
    const file=await library.readResourceFile({sessionId,id:f.a.resource.id,revisionId:f.a.revision.id,path:"SKILL.md"},undefined,actor,run.id);expect(file.data).toBe(f.a.revision.body);
    const exported=await library.prepareExport({sessionId,id:f.a.resource.id},undefined,actor,run.id);expect(exported.revisionId).toBe(f.a.revision.id);
    await expect(library.prepareExport({sessionId,id:f.a.resource.id,revisionId:newer.revision.id},undefined,actor,run.id)).rejects.toThrowError();
  });
  it("uses the Runtime pin for product list, reuse metadata and Skill loading",async()=>{
    const f=fixture(),sessionId=f.child.session.id,actor=f.first.bot.id,run=start(f),handlers=new Map<string,(input?:unknown)=>unknown>();
    addLibraryProductHandlers(handlers,{repository:f.repository,libraryService:service(f.repository)},undefined,{sessionId,executorBotId:actor,runtimeRunId:run.id});
    const invoke=(name:string,input?:unknown)=>handlers.get(LIBRARY_PRODUCT_OPERATIONS.find(operation=>operation.name===name)!.channel)!(input);
    f.repository.tasks.reviseSelection({sessionId,expectedVersion:f.child.version,selections:[selected(actor,[f.b.reference])]});
    const listed=await invoke("library.list",{}) as {id:string}[];expect(listed.map(item=>item.id)).toEqual([f.a.resource.id]);
    const available=await invoke("library.available",{}) as {id:string}[];expect(available.map(item=>item.id)).toEqual([f.a.resource.id]);
    const loaded=await invoke("skills.load",{id:f.a.resource.id}) as {revision:{body:string}};expect(loaded.revision.body).toBe(f.a.revision.body);
    await expect(invoke("library.read",{id:f.b.resource.id})).rejects.toThrowError();
  });
  it("never restores an old Library grant through binding ABA, global disable/enable or member remove/re-add",()=>{
    const f=fixture(),sessionId=f.child.session.id,actor=f.first.bot.id;
    f.repository.library.unbind({sessionId,id:f.a.resource.id});f.repository.library.bind({sessionId,id:f.a.resource.id});
    expect(()=>f.repository.library.read({sessionId,id:f.a.resource.id},actor)).toThrowError();
    f.repository.tasks.reviseSelection({sessionId,expectedVersion:f.child.version,selections:[selected(actor,[f.a.reference])]});
    const disabled=f.repository.library.setEnabled({sessionId,id:f.a.resource.id,expectedVersion:1,enabled:false});f.repository.library.setEnabled({sessionId,id:f.a.resource.id,expectedVersion:disabled.version,enabled:true});
    expect(()=>f.repository.library.read({sessionId,id:f.a.resource.id,includeDisabled:true,includeDeleted:true},actor)).toThrowError();
    f.repository.tasks.reviseSelection({sessionId,expectedVersion:f.repository.tasks.get(sessionId).version,selections:[selected(actor,[f.a.reference])]});
    f.repository.removeRoomMember(f.room.room.id,actor,f.room.room.membershipVersion);const room=f.repository.getRoom(f.room.room.id);f.repository.addRoomMember(room.id,actor,room.membershipVersion);
    expect(()=>f.repository.library.read({sessionId,id:f.a.resource.id},actor)).toThrowError();
  });
});
