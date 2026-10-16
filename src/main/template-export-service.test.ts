import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync,readFileSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach,describe,expect,it } from "vitest";
import type { TemplateCaptureInput,OfflineExportInput } from "@shared/template-export-contracts";
import type { TaskExecutorSelection } from "@shared/task-session-contracts";
import type { PromptManifest } from "@shared/contracts";
import { TEMPLATE_MAX_JSON_BYTES } from "@shared/template-export-schemas";
import { AppRepository } from "./database";
import { LibraryBlobStore,libraryBytesDigest } from "./library-blob-store";
import { LibraryService } from "./library-service";
import { MediaBlobStore } from "./media-blob-store";
import { MediaService } from "./media-service";
import { TEMPLATE_EXPORT_MIGRATION,TemplateExportRepository } from "./template-export-repository";
import { TemplateExportService } from "./template-export-service";
const cleanup:Array<()=>Promise<void>>=[];
async function open(root?:string,initialize=true){
  const directory=root??mkdtempSync(join(tmpdir(),"aevoren-template-export-")),app=new AppRepository(join(directory,"app.sqlite")),database=Reflect.get(app,"database") as DatabaseSync;
  if(initialize&&!database.prepare("SELECT 1 FROM sqlite_master WHERE name='portable_templates'").get()){database.exec(TEMPLATE_EXPORT_MIGRATION.sql);database.prepare("INSERT INTO schema_migrations VALUES(48,?)").run(new Date().toISOString());}
  const paths={templateBlobRoot:join(directory,"templates"),libraryBlobRoot:join(directory,"library")},mediaRoot=join(directory,"media"),library=new LibraryService(app,paths.libraryBlobRoot);
  const media=new MediaService(app,mediaRoot,{async parse(){throw new Error("No parsing during export");},async renderPdfPage(){throw new Error("No rendering during export");},async shutdown(){}});
  const templates=new TemplateExportRepository(database),service=new TemplateExportService(app,templates,library,media,paths);
  let closed=false;const close=async()=>{if(closed)return;closed=true;await media.shutdown();app.close();};if(!root)cleanup.push(async()=>rmSync(directory,{recursive:true,force:true}));
  cleanup.push(close);
  return {directory,app,database,paths,mediaRoot,library,media,templates,service,close};
}
async function fixture(){const f=await open(),owner=f.app.createBot(),other=f.app.createBot(),bytes=Buffer.from([0,255,128,7,19,32,91]),omitted=Buffer.from("UNSELECTED_FILE_SECRET");
  const blobs=new LibraryBlobStore(f.paths.libraryBlobRoot),sha=await blobs.put(bytes),otherSha=await blobs.put(omitted);
  const skill=f.app.library.create({sessionId:owner.session.id,kind:"skill",name:"portable-skill",description:"Fixed instructions",body:"---\nname: portable-skill\ndescription: A test Skill\n---\nSelected instructions",files:[{relativePath:"assets/value.bin",size:bytes.length,mimeType:"application/octet-stream",sha256:sha},{relativePath:"references/private.txt",size:omitted.length,mimeType:"text/plain",sha256:otherSha}]});
  f.app.setSetting("private.connector.token","DO_NOT_EXPORT_CREDENTIAL",true);f.app.createMemory(owner.bot.id,"DO_NOT_EXPORT_MEMORY");
  const input:TemplateCaptureInput={sessionId:owner.session.id,name:"Portable team",bots:[{id:owner.bot.id,expectedVersion:owner.bot.version}],resources:[{reference:skill.reference,filePaths:["assets/value.bin"]}]};
  return {...f,owner,other,bytes,skill,input};
}
async function saved(f:Awaited<ReturnType<typeof fixture>>){const preview=await f.service.prepareCapture(f.input);return f.service.commitCapture({preparedId:preview.id,expectedDigest:preview.digest});}
async function exported(f:Awaited<ReturnType<typeof fixture>>){const record=await saved(f),artifact=await f.service.prepareTemplateExport({id:record.template.id});return {record,artifact};}
const object=(bytes:Uint8Array)=>JSON.parse(Buffer.from(bytes).toString("utf8"));
const taskSelection=(executorBotId:string,resourceRefs:TaskExecutorSelection["resourceRefs"]=[]):TaskExecutorSelection=>({executorBotId,resourceRefs,memories:[],history:[],workspaces:[],mcp:[],mediaRefs:[],productOperations:[],network:false,clipboard:false});
function startRuntime(f:Awaited<ReturnType<typeof open>>,sessionId:string,executorBotId:string,retryNonce?:string){const nonce=retryNonce??randomUUID();
  if(!retryNonce)f.app.prepareMessage({sessionId,clientNonce:nonce,text:"Explicit template request"});const entry=f.app.getUserMessage(nonce);
  const manifest:PromptManifest={schemaVersion:1,botId:executorBotId,profileVersion:1,sessionId,generation:entry.generation,inputSeq:entry.seq,blocks:[],digest:"template-scope"};
  return f.app.createRuntimeRun(nonce,"fake",manifest,{executorBotId});
}

afterEach(async()=>{for(const work of cleanup.splice(0).reverse())await work();});
describe("versioned portable templates with real SQLite and owned CAS",()=>{
  it("copies only selected immutable profiles/resources/files and remains exportable after originals disappear",async()=>{
    const f=await fixture(),{record,artifact}=await exported(f),bundle=object(artifact.bytes);
    expect(bundle.bots).toHaveLength(1);expect(bundle.resources[0].files).toHaveLength(1);expect(bundle.files).toHaveLength(1);expect(Buffer.from(bundle.files[0].dataBase64,"base64")).toEqual(f.bytes);
    expect(JSON.stringify(bundle)).not.toMatch(/DO_NOT_EXPORT|mcpServerIds|modelSelection|workspace|UNSELECTED_FILE_SECRET/u);
    expect(f.database.prepare("SELECT manifest_json FROM portable_template_revisions").get()).not.toHaveProperty("dataBase64");
    const raw=(f.database.prepare("SELECT manifest_json FROM portable_template_revisions").get() as {manifest_json:string}).manifest_json;expect(raw).not.toContain(f.bytes.toString("base64"));
    f.app.library.delete({sessionId:f.owner.session.id,id:f.skill.resource.id,expectedVersion:1});rmSync(f.paths.libraryBlobRoot,{recursive:true,force:true});
    const independent=await f.service.prepareTemplateExport({id:record.template.id});expect(Buffer.from(independent.bytes)).toEqual(Buffer.from(artifact.bytes));independent.assertCurrent();
  });
  it("keeps previous template revisions and rejects conflicting saves without publishing another revision",async()=>{
    const f=await fixture(),first=await saved(f),preview=await f.service.prepareCapture({...f.input,name:"Second revision"});
    const second=await f.service.commitCapture({preparedId:preview.id,expectedDigest:preview.digest,id:first.template.id,expectedVersion:1});expect(second.template.version).toBe(2);
    expect(f.service.read({id:first.template.id,revisionId:first.revision.id}).revision.manifest.name).toBe("Portable team");
    await expect(f.service.commitCapture({preparedId:preview.id,expectedDigest:preview.digest,id:first.template.id,expectedVersion:1})).rejects.toThrowError(expect.objectContaining({code:"LIBRARY_VERSION_CONFLICT"}));expect(f.service.versions(first.template.id)).toHaveLength(2);
  });
  it("preflights strict bundles and imports fresh disabled resources without copying grants or replaying a nonce",async()=>{
    const f=await fixture(),{artifact}=await exported(f),preview=await f.service.preflightImport(artifact.bytes),input={preparedId:preview.id,expectedDigest:preview.digest,clientNonce:randomUUID()};
    const result=await f.service.commitImport(input),again=await f.service.commitImport(input);expect(again).toEqual(result);expect(result.botIds).toHaveLength(1);expect(result.botIds[0]).not.toBe(f.owner.bot.id);
    const bot=f.app.getBot(result.botIds[0]!);expect(bot.mcpServerIds).toEqual([]);expect(bot.memoryWorkspaceIds).toEqual([]);expect(f.app.listRuntimeMemories(bot.id,result.targetSessionId!)).toEqual([]);expect(f.app.listSessionWorkspaces(result.targetSessionId!,bot.id)).toEqual([]);
    const resource=f.app.library.read({sessionId:result.targetSessionId!,id:result.resourceRefs[0]!.resourceId,includeDisabled:true});expect(resource.resource.enabled).toBe(false);expect(resource.revision.body).toBe(f.skill.revision.body);
    await expect(f.library.readResourceBytes({sessionId:result.targetSessionId!,id:resource.resource.id,revisionId:resource.revision.id,path:"assets/value.bin"})).rejects.toMatchObject({code:"LIBRARY_DISABLED"});
    const file=resource.revision.files[0]!,bytes=await new LibraryBlobStore(f.paths.libraryBlobRoot).read(file.sha256,file.size);expect(bytes).toEqual(f.bytes);expect(f.app.skillExecutions.list({sessionId:result.targetSessionId!,executorBotId:bot.id})).toEqual([]);
    await expect(f.service.commitImport({...input,expectedDigest:"f".repeat(64)})).rejects.toMatchObject({code:"MESSAGE_NONCE_CONFLICT"});
  });
  it("supports document-only bundles with an explicit existing destination and no created contacts",async()=>{
    const f=await fixture(),preview=await f.service.prepareCapture({...f.input,bots:[]}),record=await f.service.commitCapture({preparedId:preview.id,expectedDigest:preview.digest}),artifact=await f.service.prepareTemplateExport({id:record.template.id}),imported=await f.service.preflightImport(artifact.bytes),input={preparedId:imported.id,expectedDigest:imported.digest,clientNonce:randomUUID()};
    await expect(f.service.commitImport(input)).rejects.toThrowError();const count=f.app.listBots().length,result=await f.service.commitImport({...input,targetSessionId:f.other.session.id});
    expect(result.botIds).toEqual([]);expect(result.targetSessionId).toBe(f.other.session.id);expect(f.app.listBots()).toHaveLength(count);expect(f.app.library.read({sessionId:f.other.session.id,id:result.resourceRefs[0]!.resourceId,includeDisabled:true}).resource.enabled).toBe(false);
  });
  it("round-trips an exact Room roster into newly created members without sharing the original session",async()=>{
    const f=await fixture(),room=f.app.createRoom({memberBotIds:[f.owner.bot.id,f.other.bot.id],name:"Roster",leadBotId:f.owner.bot.id});
    const preview=await f.service.prepareCapture({sessionId:room.session.id,name:"Team",bots:[f.owner,f.other].map(item=>({id:item.bot.id,expectedVersion:item.bot.version})),room:{id:room.room.id,expectedVersion:room.room.version,expectedMembershipVersion:room.room.membershipVersion,memberBotIds:[f.other.bot.id,f.owner.bot.id]},resources:[]});
    const record=await f.service.commitCapture({preparedId:preview.id,expectedDigest:preview.digest}),artifact=await f.service.prepareTemplateExport({id:record.template.id}),imported=await f.service.preflightImport(artifact.bytes),result=await f.service.commitImport({preparedId:imported.id,expectedDigest:imported.digest,clientNonce:randomUUID()});
    expect(result.roomId).not.toBe(room.room.id);const recreated=f.app.getRoomDetail(result.roomId!);expect(recreated.members.map(member=>member.bot.name)).toEqual([f.other.bot.name,f.owner.bot.name]);expect(recreated.room.leadBotId).toBe(result.botIds[0]);expect(f.app.listTranscript(recreated.session.id)).toEqual([]);
  });
  it("rejects unsafe paths, digest substitutions, unknown credential fields, invalid encoding and oversized input before publication",async()=>{
    const f=await fixture(),{artifact}=await exported(f),original=object(artifact.bytes),count=f.app.listBots().length;
    const invalids=[{...original,schemaVersion:2},{...original,credentials:{token:"secret"}},{...original,bots:[{...original.bots[0],mcpServerIds:[randomUUID()]}]},{...original,files:[{...original.files[0],dataBase64:Buffer.from("tampered").toString("base64")}]},{...original,resources:[{...original.resources[0],files:[{...original.resources[0].files[0],relativePath:"../escape"}]}]}];
    for(const invalid of invalids)await expect(f.service.preflightImport(Buffer.from(JSON.stringify(invalid)))).rejects.toThrowError();
    await expect(f.service.preflightImport(new Uint8Array([0xff,0xfe,0x80]))).rejects.toThrowError();await expect(f.service.preflightImport(new Uint8Array(TEMPLATE_MAX_JSON_BYTES+1))).rejects.toMatchObject({code:"LIBRARY_IMPORT_TOO_LARGE"});expect(f.app.listBots()).toHaveLength(count);
  });
  it("rolls back created Bots/resources if recording the import receipt fails and retries only after a confirmed rollback",async()=>{
    const f=await fixture(),{artifact}=await exported(f),preview=await f.service.preflightImport(artifact.bytes),input={preparedId:preview.id,expectedDigest:preview.digest,clientNonce:randomUUID()},bots=f.app.listBots(),resources=f.app.library.available();
    f.database.exec("CREATE TRIGGER reject_template_receipt BEFORE INSERT ON portable_template_imports BEGIN SELECT RAISE(ABORT,'receipt rejected'); END;");await expect(f.service.commitImport(input)).rejects.toThrowError(/receipt rejected/u);
    expect(f.app.listBots()).toEqual(bots);expect(f.app.library.available()).toEqual(resources);expect(f.database.prepare("SELECT COUNT(*) AS count FROM portable_template_imports").get()).toEqual({count:0});f.database.exec("DROP TRIGGER reject_template_receipt;");expect((await f.service.commitImport(input)).botIds).toHaveLength(1);
  });
  it("preserves cancellation and revocation tombstones without publishing half a template",async()=>{
    const f=await fixture(),context={sessionId:f.owner.session.id,executorBotId:f.owner.bot.id},preview=await f.service.prepareCapture(f.input,context);
    const disabled=f.app.library.setEnabled({sessionId:f.owner.session.id,id:f.skill.resource.id,expectedVersion:1,enabled:false});f.app.library.setEnabled({sessionId:f.owner.session.id,id:f.skill.resource.id,expectedVersion:disabled.version,enabled:true});
    await expect(f.service.commitCapture({preparedId:preview.id,expectedDigest:preview.digest},context)).rejects.toThrowError();expect(f.service.list()).toEqual([]);
    const controller=new AbortController();controller.abort();await expect(f.service.prepareCapture(f.input,{...context,signal:controller.signal})).rejects.toMatchObject({code:"TOOL_EXECUTION_CANCELLED"});expect(f.service.list()).toEqual([]);
  });
  it("verifies staged owned bytes again before publishing and honors trusted UI cancellation without an AI context",async()=>{
    const f=await fixture(),preview=await f.service.prepareCapture(f.input),file=f.skill.revision.files[0]!;
    writeFileSync(join(f.paths.templateBlobRoot,file.sha256.slice(0,2),file.sha256),"changed staged bytes");
    await expect(f.service.commitCapture({preparedId:preview.id,expectedDigest:preview.digest})).rejects.toThrowError();expect(f.service.list()).toEqual([]);
    const controller=new AbortController();controller.abort();await expect(f.service.preflightImport(Buffer.from("{}"),undefined,controller.signal)).rejects.toMatchObject({code:"TOOL_EXECUTION_CANCELLED"});
  });
  it("keeps template contents private to the creating AI session while permitting explicit trusted-user reuse",async()=>{
    const f=await fixture(),record=await saved(f),other={sessionId:f.other.session.id,executorBotId:f.other.bot.id};expect(f.service.list(other)).toEqual([]);expect(()=>f.service.read({id:record.template.id},other)).toThrowError();expect(f.service.read({id:record.template.id}).revision.digest).toBe(record.revision.digest);
  });
  it("hides a shared TASK template and its files from a member lacking the original selected resource",async()=>{
    const f=await fixture(),room=f.app.createRoom({memberBotIds:[f.owner.bot.id,f.other.bot.id]}),a=f.app.library.create({sessionId:room.session.id,kind:"document",name:"A document",body:"A selected body"}),b=f.app.library.create({sessionId:room.session.id,kind:"document",name:"B private document",body:"B private body",files:[f.skill.revision.files[0]!]});
    const child=f.app.tasks.create({parentSessionId:room.session.id,expectedScopeVersion:f.app.tasks.scopeVersion(room.session.id),clientNonce:randomUUID(),title:"Independent members",selections:[taskSelection(f.owner.bot.id,[a.reference]),taskSelection(f.other.bot.id,[b.reference])]});
    const preview=await f.service.prepareCapture({sessionId:child.session.id,name:"B secret template",bots:[],resources:[{reference:b.reference,filePaths:["assets/value.bin"]}]}),record=await f.service.commitCapture({preparedId:preview.id,expectedDigest:preview.digest});
    const profile=await f.service.prepareCapture({sessionId:child.session.id,name:"Profile only",bots:[{id:f.owner.bot.id,expectedVersion:f.owner.bot.version}],resources:[]}),profileRecord=await f.service.commitCapture({preparedId:profile.id,expectedDigest:profile.digest});
    const runA=startRuntime(f,child.session.id,f.owner.bot.id),contextA={sessionId:child.session.id,executorBotId:f.owner.bot.id,runtimeRunId:runA.id};
    expect(f.service.list(contextA).map(item=>item.id)).toEqual([profileRecord.template.id]);expect(()=>f.service.read({id:record.template.id},contextA)).toThrowError();expect(()=>f.service.versions(record.template.id,contextA)).toThrowError();await expect(f.service.prepareTemplateExport({id:record.template.id},contextA)).rejects.toThrowError();
    expect(f.service.list({sessionId:child.session.id,executorBotId:f.owner.bot.id}).map(item=>item.id)).toEqual([profileRecord.template.id]);
    await expect(f.service.prepareCapture({sessionId:child.session.id,name:"Forbidden capture",bots:[],resources:[{reference:b.reference,filePaths:[]}]},contextA)).rejects.toThrowError();
    f.app.transitionRuntimeRun(runA.id,"failed");const runB=startRuntime(f,child.session.id,f.other.bot.id),contextB={sessionId:child.session.id,executorBotId:f.other.bot.id,runtimeRunId:runB.id};
    expect(f.service.read({id:record.template.id},contextB).revision.manifest.resources[0]!.body).toBe("B private body");const exported=object((await f.service.prepareTemplateExport({id:record.template.id},contextB)).bytes);expect(Buffer.from(exported.files[0].dataBase64,"base64")).toEqual(f.bytes);
    expect(f.service.list()).toHaveLength(2);expect(f.service.read({id:record.template.id}).revision.manifest.resources[0]!.body).toBe("B private body");
  });
  it("keeps an original empty template admission empty after publication and across retry",async()=>{
    const f=await fixture(),run=startRuntime(f,f.owner.session.id,f.owner.bot.id),context={sessionId:f.owner.session.id,executorBotId:f.owner.bot.id,runtimeRunId:run.id},record=await saved(f);
    expect(f.service.list(context)).toEqual([]);expect(()=>f.service.read({id:record.template.id},context)).toThrowError();expect(()=>f.service.versions(record.template.id,context)).toThrowError();await expect(f.service.prepareTemplateExport({id:record.template.id},context)).rejects.toThrowError();
    f.app.transitionRuntimeRun(run.id,"failed");const retry=startRuntime(f,f.owner.session.id,f.owner.bot.id,run.clientNonce);expect(f.service.list({...context,runtimeRunId:retry.id})).toEqual([]);
    f.app.transitionRuntimeRun(retry.id,"failed");const fresh=startRuntime(f,f.owner.session.id,f.owner.bot.id);expect(f.service.list({...context,runtimeRunId:fresh.id})).toHaveLength(1);
  });
  it("returns only original template metadata and bytes when the definition changes before a retry",async()=>{
    const f=await fixture(),first=await saved(f),run=startRuntime(f,f.owner.session.id,f.owner.bot.id),context={sessionId:f.owner.session.id,executorBotId:f.owner.bot.id,runtimeRunId:run.id},preview=await f.service.prepareCapture({...f.input,name:"Later private title"});
    const second=await f.service.commitCapture({preparedId:preview.id,expectedDigest:preview.digest,id:first.template.id,expectedVersion:1});
    expect(f.service.list(context)[0]).toMatchObject({name:"Portable team",version:1,currentRevisionId:first.revision.id});expect(f.service.versions(first.template.id,context).map(item=>item.id)).toEqual([first.revision.id]);expect(()=>f.service.read({id:first.template.id,revisionId:second.revision.id},context)).toThrowError();expect(object((await f.service.prepareTemplateExport({id:first.template.id},context)).bytes).name).toBe("Portable team");
    f.app.transitionRuntimeRun(run.id,"failed");const retry=startRuntime(f,f.owner.session.id,f.owner.bot.id,run.clientNonce);expect(f.service.read({id:first.template.id},{...context,runtimeRunId:retry.id}).revision.id).toBe(first.revision.id);
  });
  it("never lazily admits templates to an old Runtime missing its migration snapshot",async()=>{
    const f=await fixture(),record=await saved(f),run=startRuntime(f,f.owner.session.id,f.owner.bot.id);f.database.prepare("DELETE FROM portable_runtime_admissions WHERE runtime_run_id=?").run(run.id);const context={sessionId:f.owner.session.id,executorBotId:f.owner.bot.id,runtimeRunId:run.id};
    expect(()=>f.service.list(context)).toThrowError(expect.objectContaining({code:"APPROVAL_SCOPE_INVALID"}));expect(()=>f.service.read({id:record.template.id},context)).toThrowError();f.app.transitionRuntimeRun(run.id,"failed");const retry=startRuntime(f,f.owner.session.id,f.owner.bot.id,run.clientNonce);expect(f.service.list({...context,runtimeRunId:retry.id})).toEqual([]);
  });
  it("keeps a prepared trusted-user review token out of AI commits and binds AI previews to their original Runtime",async()=>{
    const f=await fixture(),trusted=await f.service.prepareCapture(f.input),run=startRuntime(f,f.owner.session.id,f.owner.bot.id),context={sessionId:f.owner.session.id,executorBotId:f.owner.bot.id,runtimeRunId:run.id};
    await expect(f.service.commitCapture({preparedId:trusted.id,expectedDigest:trusted.digest},context)).rejects.toMatchObject({code:"APPROVAL_SCOPE_INVALID"});
    const own=await f.service.prepareCapture(f.input,context);f.app.transitionRuntimeRun(run.id,"failed");const retry=startRuntime(f,f.owner.session.id,f.owner.bot.id,run.clientNonce);
    await expect(f.service.commitCapture({preparedId:own.id,expectedDigest:own.digest},{...context,runtimeRunId:retry.id})).rejects.toMatchObject({code:"APPROVAL_SCOPE_INVALID"});expect(f.service.list()).toEqual([]);
    expect(f.service.reviewPrepared(trusted.id,trusted.digest).name).toBe("Portable team");
  });
  it("binds an import nonce receipt to its originating executor within a shared Room",async()=>{
    const f=await fixture(),{artifact}=await exported(f),room=f.app.createRoom({memberBotIds:[f.owner.bot.id,f.other.bot.id]}),contextA={sessionId:room.session.id,executorBotId:f.owner.bot.id},contextB={sessionId:room.session.id,executorBotId:f.other.bot.id};
    const preview=await f.service.preflightImport(artifact.bytes,contextA),input={preparedId:preview.id,expectedDigest:preview.digest,clientNonce:randomUUID()},result=await f.service.commitImport(input,contextA);
    expect(await f.service.commitImport(input,contextA)).toEqual(result);await expect(f.service.commitImport(input,contextB)).rejects.toMatchObject({code:"APPROVAL_SCOPE_INVALID"});expect(await f.service.commitImport(input)).toEqual(result);
  });
  it("reopens saved CAS files and persistent import receipts without a live preflight cache",async()=>{
    const f=await fixture(),{record,artifact}=await exported(f),preview=await f.service.preflightImport(artifact.bytes),input={preparedId:preview.id,expectedDigest:preview.digest,clientNonce:randomUUID()},result=await f.service.commitImport(input);await f.close();
    const reopened=await open(f.directory,false);expect(await reopened.service.commitImport(input)).toEqual(result);expect(Buffer.from((await reopened.service.prepareTemplateExport({id:record.template.id})).bytes)).toEqual(Buffer.from(artifact.bytes));
  });
});

describe("explicit offline exports",()=>{
  it("exports only selected current-generation messages/resources/media and escapes active HTML without external requests",async()=>{
    const f=await fixture(),text='</pre><script>alert("bad")</script><img src="https://private.invalid" onerror="steal()">',nonce=randomUUID();f.app.prepareMessage({sessionId:f.owner.session.id,clientNonce:nonce,text});const entry=f.app.getUserMessage(nonce);
    const otherNonce=randomUUID();f.app.prepareMessage({sessionId:f.other.session.id,clientNonce:otherNonce,text:"OTHER_CHAT_MUST_NOT_APPEAR"});
    const pixels=readFileSync(new URL("../../tests/fixtures/media-parser/red.jpg",import.meta.url)),sha=await new MediaBlobStore(f.mediaRoot).put(pixels),id=randomUUID(),media=f.app.media.publishImport(f.owner.session.id,[{asset:{reference:{id,name:"chosen.jpg",mimeType:"image/jpeg",size:pixels.length,sha256:sha},kind:"image",width:4,height:4,durationMs:null},extraction:null}])[0]!;
    const input:OfflineExportInput={format:"json",sessions:[{sessionId:f.owner.session.id,generation:1,entries:[{id:entry.id,digest:libraryBytesDigest(Buffer.from(text))}]}],resources:[{sessionId:f.owner.session.id,reference:f.skill.reference,filePaths:["assets/value.bin"]}],media:[{sessionId:f.owner.session.id,reference:media.reference}]};
    const json=await f.service.prepareExport(input),bundle=object(json.bytes);expect(bundle.sessions[0].entries[0].body).toBe(text);expect(Buffer.from(bundle.media[0].dataBase64,"base64")).toEqual(pixels);expect(Buffer.from(bundle.files[0].dataBase64,"base64")).toEqual(f.bytes);expect(Buffer.from(json.bytes).toString()).not.toMatch(/OTHER_CHAT_MUST_NOT_APPEAR|DO_NOT_EXPORT_MEMORY|DO_NOT_EXPORT_CREDENTIAL|UNSELECTED_FILE_SECRET/u);
    const html=Buffer.from((await f.service.prepareExport({...input,format:"html"})).bytes).toString();expect(html).toContain("Content-Security-Policy");expect(html).toContain("default-src 'none'");expect(html).toContain("&lt;script&gt;");expect(html).not.toMatch(/<script\b|\b(?:src|href)=["']https?:/iu);expect(html).toContain(`base64,${pixels.toString("base64")}`);json.assertCurrent();
    f.app.media.unbind({sessionId:f.owner.session.id,id});expect(()=>json.assertCurrent()).toThrowError();
  });
  it("denies cross-session message selectors and invalidates even an empty session export after generation changes",async()=>{
    const f=await fixture(),nonce=randomUUID();f.app.prepareMessage({sessionId:f.other.session.id,clientNonce:nonce,text:"Private other"});const entry=f.app.getUserMessage(nonce),input:OfflineExportInput={format:"json",sessions:[{sessionId:f.owner.session.id,generation:1,entries:[{id:entry.id,digest:libraryBytesDigest(Buffer.from(entry.body))}]}],resources:[],media:[]};
    await expect(f.service.prepareExport(input)).rejects.toThrowError();const artifact=await f.service.prepareExport({...input,sessions:[{sessionId:f.owner.session.id,generation:1,entries:[]}]});f.app.clearConversation(f.owner.session.id);expect(()=>artifact.assertCurrent()).toThrowError();
  });
  it("rejects foreign AI selectors and revocation ABA while preserving a fixed resource version across ordinary edits",async()=>{
    const f=await fixture(),context={sessionId:f.owner.session.id,executorBotId:f.owner.bot.id},input:OfflineExportInput={format:"json",sessions:[],resources:[{sessionId:f.owner.session.id,reference:f.skill.reference,filePaths:[]}],media:[]};
    const artifact=await f.service.prepareExport(input,context),updated=f.app.library.update({sessionId:f.owner.session.id,id:f.skill.resource.id,expectedVersion:1,body:"New body"});artifact.assertCurrent();expect(object(artifact.bytes).resources[0].body).toBe(f.skill.revision.body);
    const disabled=f.app.library.setEnabled({sessionId:f.owner.session.id,id:f.skill.resource.id,expectedVersion:updated.resource.version,enabled:false});f.app.library.setEnabled({sessionId:f.owner.session.id,id:f.skill.resource.id,expectedVersion:disabled.version,enabled:true});expect(()=>artifact.assertCurrent()).toThrowError();
    await expect(f.service.prepareExport({...input,resources:[{...input.resources[0]!,sessionId:f.other.session.id}]},context)).rejects.toMatchObject({code:"APPROVAL_SCOPE_INVALID"});
  });
});
