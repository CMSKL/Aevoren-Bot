import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskExecutorSelection } from "@shared/task-session-contracts";
import type { PromptManifest } from "@shared/contracts";
import { AppRepository, MIGRATIONS } from "./database";
import { captureRealtimeAdmission } from "./realtime-admission";
import { mediaExtractionDigest } from "./media-repository";
const repositories:AppRepository[]=[],directories:string[]=[];
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
function fixture(filename=":memory:"){const repository=new AppRepository(filename);repositories.push(repository);return {repository,...repository.createBot()};}
function selection(executorBotId:string,patch:Partial<TaskExecutorSelection>={}):TaskExecutorSelection{return {executorBotId,memories:[],history:[],workspaces:[],mcp:[],resourceRefs:[],mediaRefs:[],productOperations:[],network:false,clipboard:false,...patch};}
function task(f:ReturnType<typeof fixture>,patch:Partial<TaskExecutorSelection>={}){return f.repository.tasks.create({parentSessionId:f.session.id,expectedScopeVersion:f.repository.tasks.scopeVersion(f.session.id),clientNonce:randomUUID(),title:"Independent task",selections:[selection(f.bot.id,patch)]});}
function runtime(f:ReturnType<typeof fixture>,sessionId:string){const nonce=randomUUID();f.repository.prepareMessage({sessionId,clientNonce:nonce,text:"A real task message"});const entry=f.repository.getUserMessage(nonce);const manifest:PromptManifest={schemaVersion:1,botId:f.bot.id,profileVersion:1,sessionId,generation:entry.generation,inputSeq:entry.seq,blocks:[],digest:"task-test"};return f.repository.createRuntimeRun(nonce,"fake",manifest,{executorBotId:f.bot.id});}
afterEach(()=>{for(const repository of repositories.splice(0))repository.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
describe("explicit task context and immutable runtime admission",()=>{
  it("allows one MAIN and multiple TASK chats without sharing user transcript or implicit permissions",()=>{
    const f=fixture(),first=task(f),second=task(f);
    expect(first.session.kind).toBe("TASK");expect(first.session.id).not.toBe(second.session.id);
    expect(f.repository.getMainSession(f.bot.id).id).toBe(f.session.id);
    const run=runtime(f,first.session.id),policy=f.repository.tasks.runtimeTaskPolicy(run.id)!;
    expect(policy.selection).toEqual(selection(f.bot.id));expect(policy.memories).toEqual([]);expect(policy.history).toEqual([]);
    expect(f.repository.listTranscript(second.session.id)).toEqual([]);
    expect(f.repository.tasks.taskSessionPolicy(f.session.id,f.bot.id)).toBeNull();
    expect(f.repository.tasks.list({parentSessionId:f.session.id})).toHaveLength(2);
  });
  it("uses a nonce receipt and rejects a changed request or stale parent scope atomically",()=>{
    const f=fixture(),input={parentSessionId:f.session.id,expectedScopeVersion:1,clientNonce:randomUUID(),title:"One",selections:[selection(f.bot.id)]};
    const first=f.repository.tasks.create(input);expect(f.repository.tasks.create(input).session.id).toBe(first.session.id);
    expect(()=>f.repository.tasks.create({...input,title:"Changed"})).toThrowError(expect.objectContaining({code:"MESSAGE_NONCE_CONFLICT"}));
    expect(()=>f.repository.tasks.create({...input,clientNonce:randomUUID(),expectedScopeVersion:2})).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
    expect(f.repository.tasks.list({parentSessionId:f.session.id})).toHaveLength(1);
  });
  it("copies only selected memory versions and quoted history and survives source edits without consuming user authority",()=>{
    const f=fixture(),memory=f.repository.createMemory(f.bot.id,"Private original fact"),nonce=randomUUID();
    f.repository.prepareMessage({sessionId:f.session.id,clientNonce:nonce,text:"Original human request"});const entry=f.repository.getUserMessage(nonce);
    const child=task(f,{memories:[{id:memory.id,version:memory.version,digest:memory.contentDigest}],history:[{entryId:entry.id,generation:entry.generation,digest:hash(entry.body)}]});
    const run=runtime(f,child.session.id);f.repository.updateMemory(memory.id,memory.version,"Edited source fact");
    expect(f.repository.tasks.runtimeTaskPolicy(run.id)!.memories[0]!.memory.content).toBe("Private original fact");
    expect(f.repository.listRuntimeMemories(f.bot.id,child.session.id).map(item=>item.content)).toEqual(["Private original fact"]);
    expect(f.repository.tasks.runtimeTaskPolicy(run.id)!.history).toEqual([{entryId:entry.id,generation:entry.generation,digest:hash(entry.body),role:"user",body:"Original human request"}]);
    expect(f.repository.listTranscript(child.session.id).map(item=>item.body)).not.toContain(entry.body);
    const current=f.repository.getMemory(memory.id);const removed=f.repository.deleteMemory(memory.id,current.version);f.repository.restoreMemory(memory.id,removed.version);
    expect(()=>f.repository.tasks.runtimeTaskPolicy(run.id)).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
  });
  it("pins the original selection, including empty context, and never lazily admits an unpinned Runtime",()=>{
    const f=fixture(),child=task(f),run=runtime(f,child.session.id),memory=f.repository.createMemory(f.bot.id,"Later explicit fact");
    const updated=f.repository.tasks.reviseSelection({sessionId:child.session.id,expectedVersion:child.version,selections:[selection(f.bot.id,{memories:[{id:memory.id,version:memory.version,digest:memory.contentDigest}]})]});
    expect(updated.selectionDigests[0]!.version).toBe(2);
    expect(f.repository.tasks.runtimeTaskPolicy(run.id)!.selectionVersion).toBe(1);expect(f.repository.tasks.runtimeTaskPolicy(run.id)!.memories).toEqual([]);
    const database=(f.repository as unknown as {database:DatabaseSync}).database;database.prepare("UPDATE runtime_session_scopes SET task_selection_version=NULL WHERE runtime_run_id=?").run(run.id);
    expect(()=>f.repository.tasks.assertTaskRuntime(run.id)).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
  });
  it("never expands a descendant task beyond its parent's explicit permission ceiling",()=>{
    const f=fixture(),parent=task(f);
    expect(()=>f.repository.tasks.create({parentSessionId:parent.session.id,expectedScopeVersion:parent.scopeVersion,clientNonce:randomUUID(),title:"Escalation",selections:[selection(f.bot.id,{network:true})]})).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
    expect(()=>task(f,{memories:[{id:randomUUID(),version:1,digest:"a".repeat(64)}]})).toThrowError();
    expect(f.repository.tasks.list({parentSessionId:parent.session.id})).toEqual([]);
  });
  it("revokes old member incarnations across remove/re-add and scopes room details to admitted members",()=>{
    const f=fixture(),second=f.repository.createBot(),third=f.repository.createBot();const room=f.repository.createRoom({memberBotIds:[f.bot.id,second.bot.id,third.bot.id]});
    const child=f.repository.tasks.create({parentSessionId:room.session.id,expectedScopeVersion:1,clientNonce:randomUUID(),title:"Subset",selections:[selection(f.bot.id),selection(second.bot.id)]});
    expect(f.repository.getRoomDetail(room.room.id,child.session.id).members.map(item=>item.botId).sort()).toEqual([f.bot.id,second.bot.id].sort());
    f.repository.removeRoomMember(room.room.id,second.bot.id,room.room.membershipVersion);const current=f.repository.getRoom(room.room.id);
    f.repository.addRoomMember(room.room.id,second.bot.id,current.membershipVersion);
    expect(()=>f.repository.assertSessionExecutor(child.session.id,second.bot.id)).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
    expect(()=>f.repository.assertSessionExecutor(child.session.id,third.bot.id)).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
    expect(()=>f.repository.getRoomDetail(randomUUID(),child.session.id)).toThrowError();
  });
  it("copies workspace ceilings without project auto-grants and keeps revoked bits disabled after re-enable",()=>{
    const f=fixture(),registration=f.repository.registerWorkspaceRoot("/controlled/root","Work"),workspace=f.repository.updateWorkspacePermissions(registration.workspace.id,registration.workspace.version,{writeEnabled:true,automationEnabled:true});
    f.repository.setConversationProject(f.session.id,registration.project.id,f.repository.getConversation(f.session.id).version);
    const child=task(f,{workspaces:[{id:workspace.id,read:true,write:false,automation:false}]});
    expect(f.repository.listSessionWorkspaces(child.session.id,f.bot.id)[0]).toMatchObject({id:workspace.id,writeEnabled:false,automationEnabled:false});
    expect(()=>f.repository.assertSessionWorkspaceAccess(child.session.id,f.bot.id,workspace.id,"write")).toThrowError();
    const empty=task(f);f.repository.setConversationProject(empty.session.id,registration.project.id,empty.version);expect(f.repository.listSessionWorkspaces(empty.session.id,f.bot.id)).toEqual([]);
    const writable=task(f,{workspaces:[{id:workspace.id,read:true,write:true,automation:true}]});
    const disabled=f.repository.updateWorkspacePermissions(workspace.id,workspace.version,{writeEnabled:false,automationEnabled:false});f.repository.updateWorkspacePermissions(workspace.id,disabled.version,{writeEnabled:true,automationEnabled:true});
    expect(f.repository.listSessionWorkspaces(writable.session.id,f.bot.id)[0]).toMatchObject({writeEnabled:false,automationEnabled:false});
  });
  it("requires an exact captured MCP identity on every policy read and defaults to no MCP",()=>{
    const f=fixture(),serverId=randomUUID(),mcp=[{serverId,expectedVersion:1,toolNames:["read_document"]}];
    expect(()=>task(f,{mcp})).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
    let identity="original-credential-and-schema";f.repository.tasks.setMcpIdentityReader(()=>({version:1,identityDigest:hash(identity)}));
    const child=task(f,{mcp}),run=runtime(f,child.session.id);expect(f.repository.tasks.runtimeTaskPolicy(run.id)!.mcpIdentities[serverId]!.identityDigest).toBe(hash(identity));
    identity="different-credential";expect(()=>f.repository.tasks.runtimeTaskPolicy(run.id)).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
  });
  it("copies independent fixed resource/media grants and excludes every unselected runtime media item",()=>{
    const f=fixture(),document=f.repository.library.create({sessionId:f.session.id,kind:"document",name:"Selected",body:"Original body"});
    const firstId=randomUUID(),secondId=randomUUID();
    const media=f.repository.media.publishImport(f.session.id,[firstId,secondId].map(id=>({asset:{reference:{id,name:"image.png",mimeType:"image/png",sha256:hash(id),size:100},kind:"image" as const,width:1,height:1,durationMs:null},extraction:null})));
    const child=task(f,{resourceRefs:[document.reference],mediaRefs:[media[0]!.reference]});
    f.repository.library.unbind({sessionId:f.session.id,id:document.resource.id});f.repository.media.unbind({sessionId:f.session.id,id:firstId});
    expect(f.repository.tasks.taskSessionPolicy(child.session.id,f.bot.id)!.selection.resourceRefs).toEqual([document.reference]);
    f.repository.media.bind({sessionId:child.session.id,id:secondId});const run=runtime(f,child.session.id);
    const scope={sessionId:child.session.id,executorBotId:f.bot.id,runtimeRunId:run.id};
    expect(f.repository.media.listRuntimeItems(scope).map(item=>item.asset.reference.id)).toEqual([firstId]);
    expect(()=>f.repository.media.resolveRuntimeRead(scope,secondId)).toThrowError();
    const disabled=f.repository.library.setEnabled({sessionId:child.session.id,id:document.resource.id,expectedVersion:document.resource.version,enabled:false});
    f.repository.library.setEnabled({sessionId:child.session.id,id:document.resource.id,expectedVersion:disabled.version,enabled:true});
    expect(()=>f.repository.tasks.runtimeTaskPolicy(run.id)).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
  });
  it("keeps a retry on its first runtime selection after an explicit newer selection",()=>{
    const f=fixture(),child=task(f),first=runtime(f,child.session.id),memory=f.repository.createMemory(f.bot.id,"New selection fact");
    f.repository.tasks.reviseSelection({sessionId:child.session.id,expectedVersion:child.version,selections:[selection(f.bot.id,{memories:[{id:memory.id,version:memory.version,digest:memory.contentDigest}]})]});
    f.repository.transitionRuntimeRun(first.id,"failed");
    const entry=f.repository.getUserMessage(first.clientNonce),manifest:PromptManifest={schemaVersion:1,botId:f.bot.id,profileVersion:1,sessionId:child.session.id,generation:entry.generation,inputSeq:entry.seq,blocks:[],digest:"retry"};
    const retry=f.repository.createRuntimeRun(first.clientNonce,"fake",manifest);
    expect(f.repository.tasks.runtimeTaskPolicy(retry.id)!.selectionVersion).toBe(1);expect(f.repository.tasks.runtimeTaskPolicy(retry.id)!.memories).toEqual([]);
  });
  it("filters another member's tasks from actor listings and rejects direct unselected tool preparation",()=>{
    const f=fixture(),second=f.repository.createBot(),room=f.repository.createRoom({memberBotIds:[f.bot.id,second.bot.id]});
    const hidden=f.repository.tasks.create({parentSessionId:room.session.id,expectedScopeVersion:1,clientNonce:randomUUID(),title:"Other member",selections:[selection(second.bot.id)]});
    expect(f.repository.tasks.list({parentSessionId:room.session.id},f.bot.id)).toEqual([]);expect(()=>f.repository.tasks.get(hidden.session.id,f.bot.id)).toThrowError();
    const child=task(f),run=runtime(f,child.session.id);f.repository.transitionRuntimeRun(run.id,"dispatching");f.repository.transitionRuntimeRun(run.id,"running");
    expect(()=>f.repository.prepareToolInvocation({runtimeRunId:run.id,toolCallId:"network",idempotencyKey:randomUUID(),tool:{kind:"web-search",query:"private task",maxResults:5}})).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
  });
  it("permanently retires a narrowed Bot MCP selection while permitting an explicit new grant",()=>{
    const f=fixture(),server=f.repository.createMcpServerConfig("Read only","streamable-http",{url:"https://example.com/mcp"}),mcp=[{serverId:server.id,expectedVersion:server.version,toolNames:["read"]}];
    f.repository.tasks.setMcpIdentityReader(()=>({version:server.version,identityDigest:hash("same-credential-schema")}));
    const child=task(f,{mcp}),run=runtime(f,child.session.id);
    const narrowed=f.repository.updateBot(f.bot.id,f.bot.version,{mcpServerIds:[]});f.repository.updateBot(f.bot.id,narrowed.version,{mcpServerIds:null});
    expect(()=>f.repository.tasks.runtimeTaskPolicy(run.id)).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
    f.repository.tasks.reviseSelection({sessionId:child.session.id,expectedVersion:child.version,selections:[selection(f.bot.id,{mcp})]});
    expect(f.repository.tasks.taskSessionPolicy(child.session.id,f.bot.id)!.selection.mcp).toEqual(mcp);
    expect(()=>f.repository.tasks.runtimeTaskPolicy(run.id)).toThrowError();
  });
  it("isolates two members' media within one TASK session and excludes an unselected parent member",()=>{
    const f=fixture(),second=f.repository.createBot(),third=f.repository.createBot(),room=f.repository.createRoom({memberBotIds:[f.bot.id,second.bot.id,third.bot.id]});
    const media=f.repository.media.publishImport(room.session.id,[randomUUID(),randomUUID()].map(id=>({asset:{reference:{id,name:"private.png",mimeType:"image/png",sha256:hash(id),size:100},kind:"image" as const,width:1,height:1,durationMs:null},extraction:null})));
    const child=f.repository.tasks.create({parentSessionId:room.session.id,expectedScopeVersion:1,clientNonce:randomUUID(),title:"Two members",selections:[selection(f.bot.id,{mediaRefs:[media[0]!.reference]}),selection(second.bot.id,{mediaRefs:[media[1]!.reference]})]});
    const firstRun=runtime(f,child.session.id),firstScope={sessionId:child.session.id,executorBotId:f.bot.id,runtimeRunId:firstRun.id};
    expect(f.repository.media.listRuntimeItems(firstScope).map(item=>item.asset.reference.id)).toEqual([media[0]!.reference.mediaId]);
    expect(()=>f.repository.media.resolveRuntimeRead(firstScope,media[1]!.reference.mediaId)).toThrowError();f.repository.transitionRuntimeRun(firstRun.id,"failed");
    const secondRun=runtime({...f,bot:second.bot},child.session.id),secondScope={sessionId:child.session.id,executorBotId:second.bot.id,runtimeRunId:secondRun.id};
    expect(f.repository.media.listRuntimeItems(secondScope).map(item=>item.asset.reference.id)).toEqual([media[1]!.reference.mediaId]);
    expect(()=>f.repository.media.resolveRuntimeRead(secondScope,media[0]!.reference.mediaId)).toThrowError();
    f.repository.transitionRuntimeRun(secondRun.id,"failed");f.repository.removeRoomMember(room.room.id,second.bot.id,room.room.membershipVersion);const current=f.repository.getRoom(room.room.id);f.repository.addRoomMember(room.room.id,second.bot.id,current.membershipVersion);
    expect(()=>f.repository.media.listRuntimeItems(secondScope)).toThrowError();
  });
  it("pins an original extraction after later parsing and never revives a child media grant",()=>{
    const f=fixture(),id=randomUUID(),sha=hash(id),parsed={sourceSha256:sha,parserName:"fixture",parserVersion:"1",text:"Original parsed text",spans:[{kind:"page" as const,index:0,start:0,end:20}],warningCodes:[]};
    const item=f.repository.media.publishImport(f.session.id,[{asset:{reference:{id,name:"fixed.pdf",mimeType:"application/pdf",sha256:sha,size:100},kind:"pdf",width:null,height:null,durationMs:null},extraction:{id:randomUUID(),mediaId:id,...parsed,digest:mediaExtractionDigest(parsed)}}])[0]!;
    const child=task(f,{mediaRefs:[item.reference]}),database=(f.repository as unknown as {database:DatabaseSync}).database,newer={...parsed,parserVersion:"2",text:"Later parsed content"},newId=randomUUID(),newDigest=mediaExtractionDigest(newer);
    database.prepare("INSERT INTO media_extractions VALUES(?,?,?,?,?,?,?,?,?,?)").run(newId,id,sha,newer.parserName,newer.parserVersion,newDigest,newer.text,JSON.stringify(newer.spans),"[]","2099-01-01T00:00:00.000Z");
    const run=runtime(f,child.session.id),scope={sessionId:child.session.id,executorBotId:f.bot.id,runtimeRunId:run.id};
    expect(f.repository.media.resolveRuntimeRead(scope,id).extraction!.text).toBe(parsed.text);
    expect(()=>f.repository.media.resolveRuntimeRead(scope,id,{mediaId:id,sha256:sha,extraction:{id:newId,digest:newDigest}})).toThrowError();
    f.repository.media.unbind({sessionId:child.session.id,id});f.repository.media.bind({sessionId:child.session.id,id});
    expect(()=>f.repository.tasks.runtimeTaskPolicy(run.id)).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));
  });
  it("keeps owner-wide room mutations blocked by active TASK work without blocking sibling private MAIN chats",()=>{
    const f=fixture(),second=f.repository.createBot(),third=f.repository.createBot(),room=f.repository.createRoom({memberBotIds:[f.bot.id,second.bot.id,third.bot.id]});
    const child=f.repository.tasks.create({parentSessionId:room.session.id,expectedScopeVersion:1,clientNonce:randomUUID(),title:"Active",selections:[selection(f.bot.id)]}),run=runtime(f,child.session.id);
    expect(()=>f.repository.archiveRoom(room.room.id,true)).toThrowError(expect.objectContaining({code:"ROOM_BUSY"}));
    expect(()=>f.repository.removeRoomMember(room.room.id,second.bot.id,room.room.membershipVersion)).toThrowError(expect.objectContaining({code:"ROOM_BUSY"}));
    expect(()=>f.repository.deleteRoom(room.room.id)).toThrowError(expect.objectContaining({code:"ROOM_DELETE_BUSY"}));
    expect(()=>f.repository.tasks.delete({sessionId:child.session.id,expectedVersion:child.version})).toThrowError();
    expect(f.repository.clearConversation(f.session.id).id).toBe(f.session.id);f.repository.transitionRuntimeRun(run.id,"failed");
    expect(f.repository.archiveRoom(room.room.id,true).archivedAt).not.toBeNull();
  });
  it("retains a creation nonce tombstone after deleting the Task instead of silently recreating it",()=>{
    const f=fixture(),input={parentSessionId:f.session.id,expectedScopeVersion:1,clientNonce:randomUUID(),title:"Delete once",selections:[selection(f.bot.id)]};
    const child=f.repository.tasks.create(input);f.repository.tasks.delete({sessionId:child.session.id,expectedVersion:child.version});
    expect(()=>f.repository.tasks.create(input)).toThrowError(expect.objectContaining({code:"SESSION_NOT_FOUND"}));
    expect(f.repository.tasks.list({parentSessionId:f.session.id})).toEqual([]);
    expect(f.repository.tasks.create({...input,clientNonce:randomUUID()}).session.id).not.toBe(child.session.id);
  });
  it("retains task snapshots across restart, title conflicts and independent deletion",()=>{
    const directory=mkdtempSync(join(tmpdir(),"aevoren-task-restart-"));directories.push(directory);const filename=join(directory,"app.sqlite"),f=fixture(filename),first=task(f),second=task(f);
    const renamed=f.repository.tasks.update({sessionId:first.session.id,expectedVersion:first.version,title:"Renamed"});expect(renamed.version).toBeGreaterThan(first.version);
    expect(()=>f.repository.tasks.update({sessionId:first.session.id,expectedVersion:first.version,title:"Stale draft"})).toThrowError();
    f.repository.close();repositories.splice(repositories.indexOf(f.repository),1);const reopened=new AppRepository(filename);repositories.push(reopened);
    expect(reopened.tasks.get({sessionId:first.session.id}).title).toBe("Renamed");expect(reopened.tasks.getSelections(first.session.id)).toEqual([selection(f.bot.id)]);
    reopened.tasks.delete({sessionId:first.session.id,expectedVersion:renamed.version});expect(reopened.getMainSession(f.bot.id).id).toBe(f.session.id);expect(reopened.tasks.get(second.session.id).session.id).toBe(second.session.id);
  });
});

function legacy44(filename:string){
  const migrations=MIGRATIONS as unknown as Array<(typeof MIGRATIONS)[number]>,latest=migrations.pop()!;
  try{expect(latest.version).toBe(45);return fixture(filename);}finally{migrations.push(latest);}
}
describe("real v44 task migration",()=>{
  it("preserves populated v44 incoming foreign keys, triggers, media, voice and runtime data",()=>{
    const directory=mkdtempSync(join(tmpdir(),"aevoren-task-migration-"));directories.push(directory);const filename=join(directory,"app.sqlite"),f=legacy44(filename);
    const memory=f.repository.createMemory(f.bot.id,"Preserve reviewed memory"),run=runtime(f,f.session.id);
    const document=f.repository.library.create({sessionId:f.session.id,kind:"document",name:"Retained",body:"Pre-upgrade body"});
    const config=f.repository.voice.configuration("tts").configuration;
    const voice=f.repository.voice.prepare({sessionId:f.session.id,kind:"speech",clientNonce:randomUUID(),intentDigest:hash("speech"),source:{kind:"text",digest:hash("speech")},sourceText:"speech",configuration:config}).record.task;
    const realtimeConfig=f.repository.voice.configuration("realtime").configuration;
    const input={sessionId:f.session.id,executorBotId:f.bot.id,expectedConfigVersion:realtimeConfig.version,routingMode:"automatic" as const,targetBotIds:[]};
    const realtime=f.repository.realtime.create(input,randomUUID(),realtimeConfig,captureRealtimeAdmission(f.repository,input));
    const database=(f.repository as unknown as {database:DatabaseSync}).database;
    const tables=database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string}[];
    const incoming=tables.filter(table=>(database.prepare(`PRAGMA foreign_key_list("${table.name}")`).all() as {table:string}[]).some(fk=>fk.table==="sessions"));
    expect(incoming).toHaveLength(20);
    const incomingKeys=tables.flatMap(table=>database.prepare(`PRAGMA foreign_key_list("${table.name}")`).all() as {table:string}[]).filter(key=>key.table==="sessions");
    expect(incomingKeys).toHaveLength(20);
    const triggers=database.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name NOT IN('initialize_conversation','initialize_runtime_scope','capture_runtime_media') ORDER BY name").all() as {name:string;sql:string}[];
    const cursor=database.prepare("SELECT generation,transcript_cursor FROM sessions WHERE id=?").get(f.session.id),transcript=f.repository.listTranscript(f.session.id);
    f.repository.close();repositories.splice(repositories.indexOf(f.repository),1);
    const repository=new AppRepository(filename);repositories.push(repository);const inspected=new DatabaseSync(filename);
    for(const row of incoming)expect(inspected.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(row.name)).toEqual({sql:row.sql});
    for(const row of triggers)expect(inspected.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(row.name)).toEqual({sql:row.sql});
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);expect(inspected.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({version:45});
    expect(inspected.prepare("SELECT generation,transcript_cursor FROM sessions WHERE id=?").get(f.session.id)).toEqual(cursor);
    expect(readdirSync(join(directory,"Backups")).filter(name=>name.endsWith(".sqlite"))).toHaveLength(1);inspected.close();
    expect(repository.getMemory(memory.id)).toEqual(memory);expect(repository.getRuntimeRun(run.id)).toEqual(run);expect(repository.listTranscript(f.session.id)).toEqual(transcript);
    expect(repository.library.read({sessionId:f.session.id,id:document.resource.id}).revision.body).toBe("Pre-upgrade body");
    expect(repository.voice.internal(voice.id).task).toEqual(voice);expect(repository.realtime.internal(realtime.session.id).session).toEqual(realtime.session);
  });
  it("does not consume a lazy legacy MAIN snapshot when a TASK is created first",()=>{
    const directory=mkdtempSync(join(tmpdir(),"aevoren-task-legacy-"));directories.push(directory);const filename=join(directory,"app.sqlite"),f=legacy44(filename);
    const database=(f.repository as unknown as {database:DatabaseSync}).database;
    database.prepare("DELETE FROM sessions WHERE id=?").run(f.session.id);
    database.prepare("INSERT INTO legacy_session_scopes VALUES('bot',?,?,?,?)").run(f.bot.id,f.bot.projectId,"[]","[]");
    f.repository.close();repositories.splice(repositories.indexOf(f.repository),1);const repository=new AppRepository(filename);repositories.push(repository);
    const current=(repository as unknown as {database:DatabaseSync}).database,id=randomUUID(),at=new Date().toISOString();
    current.prepare("INSERT INTO sessions(id,bot_id,kind,generation,created_at,updated_at,task_title) VALUES(?,?,'TASK',1,?,?,?)").run(id,f.bot.id,at,at,"Before MAIN");
    expect(current.prepare("SELECT owner_id FROM legacy_session_scopes WHERE owner_id=?").get(f.bot.id)).toEqual({owner_id:f.bot.id});
    const main=repository.getMainSession(f.bot.id);expect(main.id).not.toBe(id);expect(main.kind).toBe("MAIN");
    expect(current.prepare("SELECT owner_id FROM legacy_session_scopes WHERE owner_id=?").get(f.bot.id)).toBeUndefined();
  });
  it("backs up and rolls back the entire v45 migration on a pre-existing foreign-key violation",()=>{
    const directory=mkdtempSync(join(tmpdir(),"aevoren-task-fk-"));directories.push(directory);const filename=join(directory,"app.sqlite"),f=legacy44(filename);
    f.repository.close();repositories.splice(repositories.indexOf(f.repository),1);const corrupt=new DatabaseSync(filename);
    corrupt.exec("PRAGMA foreign_keys=OFF;");corrupt.prepare("INSERT INTO session_workspace_grants VALUES(?,?)").run(f.session.id,randomUUID());corrupt.close();
    expect(()=>new AppRepository(filename)).toThrow(/foreign-key violations/u);
    const inspected=new DatabaseSync(filename);expect(inspected.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({version:44});
    expect((inspected.prepare("PRAGMA table_info(sessions)").all() as {name:string}[]).map(row=>row.name)).not.toContain("task_title");
    expect(inspected.prepare("SELECT name FROM sqlite_master WHERE name='sessions_v45'").get()).toBeUndefined();inspected.close();
    expect(readdirSync(join(directory,"Backups")).filter(name=>name.endsWith(".sqlite"))).toHaveLength(1);
  });
});
