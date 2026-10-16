import { randomUUID } from "node:crypto";
import type { TemplateCaptureInput, TemplateCommitInput, TemplateContext, TemplateImportInput, TemplateImportResult, TemplateManifest, TemplatePreview, TemplateReadInput, TemplateResource, OfflineExportInput } from "@shared/template-export-contracts";
import { OFFLINE_MAX_BYTES,TEMPLATE_MAX_BYTES,TEMPLATE_MAX_JSON_BYTES,offlineExportSchema,templateBundleSchema,templateCaptureSchema,templateCommitSchema,templateImportSchema,templateManifestSchema,templateReadSchema } from "@shared/template-export-schemas";
import type { ResourceFileRef } from "@shared/library-contracts";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import { LibraryBlobStore,assertLibraryNotCancelled,libraryBytesDigest,MAX_LIBRARY_TEXT_BYTES } from "./library-blob-store";
import type { LibraryService } from "./library-service";
import type { MediaService } from "./media-service";
import { TemplateExportRepository,stableTemplateJson,templateDigest } from "./template-export-repository";
export type PreparedOfflineArtifact={name:string;mimeType:"application/json"|"text/html";bytes:Uint8Array;assertCurrent():void};
type Prepared={actor:Pick<TemplateContext,"executorBotId"|"runtimeRunId">|null;origins:TemplateCaptureInput["resources"][number]["reference"][];manifest:TemplateManifest;digest:string;files:Map<string,Buffer>;ownerSessionId:string|null;assertCurrent():void};
type Collected={resources:TemplateResource[];files:Map<string,Buffer>;checks:Array<()=>void>};
const invalid=()=>new AevorenBotError("LIBRARY_IMPORT_INVALID");
const escapeHtml=(value:string)=>value.replace(/[&<>"']/gu,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]!));
function wellFormed(value:unknown):void{if(typeof value==="string"&&Buffer.from(value,"utf8").toString("utf8")!==value)throw invalid();if(Array.isArray(value))value.forEach(wellFormed);else if(value&&typeof value==="object")Object.values(value).forEach(wellFormed);}
function uniqueFiles(resources:TemplateResource[]):ResourceFileRef[]{const files=resources.flatMap(resource=>resource.files);if(files.length>250)throw invalid();return files;}
export class TemplateExportService{
  private readonly blobs:LibraryBlobStore;
  private readonly libraryBlobs:LibraryBlobStore;
  private readonly prepared=new Map<string,Prepared>();
  constructor(private readonly app:AppRepository,private readonly templates:TemplateExportRepository,private readonly library:LibraryService,
    private readonly media:Pick<MediaService,"readBinary">,paths:{templateBlobRoot:string;libraryBlobRoot:string}){this.blobs=new LibraryBlobStore(paths.templateBlobRoot);this.libraryBlobs=new LibraryBlobStore(paths.libraryBlobRoot);this.templates.setResourceAuthority((sessionId,executor,runtimeId)=>runtimeId?this.app.tasks.runtimeTaskPolicy(runtimeId)?.selection.resourceRefs??null:this.app.tasks.taskSessionPolicy(sessionId,executor)?.selection.resourceRefs??null);}
  private check(context?:TemplateContext,sessionId?:string,signal?:AbortSignal):void{
    assertLibraryNotCancelled(signal);assertLibraryNotCancelled(context?.signal);if(sessionId)this.app.getSession(sessionId);if(!context)return;
    if(sessionId&&context.sessionId!==sessionId)throw new AevorenBotError("APPROVAL_SCOPE_INVALID");this.app.assertSessionExecutor(context.sessionId,context.executorBotId);
    if(context.runtimeRunId){const run=this.app.getRuntimeRun(context.runtimeRunId);if(run.sessionId!==context.sessionId||run.executorBotId!==context.executorBotId||run.inputGeneration!==this.app.getSession(context.sessionId).generation||!["created","dispatching","running","streaming"].includes(run.state))throw new AevorenBotError("APPROVAL_SCOPE_INVALID");this.app.tasks.assertTaskRuntime(run.id);}
  }
  list(context?:TemplateContext){this.check(context);return this.templates.list(context?.sessionId,context?.runtimeRunId,context?.executorBotId);}
  read(input:TemplateReadInput,context?:TemplateContext){this.check(context);return this.templates.read(templateReadSchema.parse(input),context?.sessionId,context?.runtimeRunId,context?.executorBotId);}
  versions(id:string,context?:TemplateContext){this.check(context);return this.templates.versions(id,context?.sessionId,context?.runtimeRunId,context?.executorBotId);}
  private preview(value:Prepared):TemplatePreview{
    if(this.prepared.size>=20)this.prepared.delete(this.prepared.keys().next().value!);const id=randomUUID();this.prepared.set(id,value);
    return {id,digest:value.digest,name:value.manifest.name,botNames:value.manifest.bots.map(bot=>bot.name),roomName:value.manifest.room?.name??null,
      resources:value.manifest.resources.map(resource=>({name:resource.name,kind:resource.kind,fileCount:resource.files.length})),fileCount:value.files.size,size:Buffer.byteLength(stableTemplateJson(value.manifest))+[...value.files.values()].reduce((size,bytes)=>size+bytes.length,0)};
  }
  private fromPreview(id:string,digest:string,context?:TemplateContext):Prepared{const value=this.prepared.get(id);if(!value||value.digest!==digest)throw invalid();this.check(context);if(context&&(value.ownerSessionId!==context.sessionId||value.actor?.executorBotId!==context.executorBotId||value.actor.runtimeRunId!==context.runtimeRunId))throw new AevorenBotError("APPROVAL_SCOPE_INVALID");value.assertCurrent();return value;}
  private validateFiles(manifest:TemplateManifest,files:Map<string,Buffer>,max=TEMPLATE_MAX_BYTES):void{
    wellFormed(manifest);let size=Buffer.byteLength(stableTemplateJson(manifest));const declared=new Set<string>();
    for(const file of uniqueFiles(manifest.resources)){const bytes=files.get(file.sha256);if(!bytes||bytes.length!==file.size||bytes.length>MAX_LIBRARY_TEXT_BYTES||libraryBytesDigest(bytes)!==file.sha256)throw invalid();
      if(file.mimeType.startsWith("text/")||/\/(?:json|xml|yaml|javascript)$/u.test(file.mimeType)){try{new TextDecoder("utf8",{fatal:true}).decode(bytes);}catch{throw invalid();}}
      declared.add(file.sha256);
    }
    for(const [sha,bytes]of files){if(!declared.has(sha))throw invalid();size+=bytes.length;}
    if(size>max)throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
  }
  private async collectResources(selections:{sessionId:string;reference:TemplateCaptureInput["resources"][number]["reference"];filePaths:string[]}[],context?:TemplateContext,signal?:AbortSignal,maxBytes=TEMPLATE_MAX_BYTES):Promise<Collected>{
    const resources:TemplateResource[]=[],files=new Map<string,Buffer>(),checks:Array<()=>void>=[];let size=0,fileCount=0;
    for(const selected of selections){this.check(context,selected.sessionId,signal);const content=this.app.library.resolveReferences(selected.sessionId,[selected.reference],context?.executorBotId,context?.runtimeRunId)[0]!;
      size+=Buffer.byteLength(content.revision.body);if(size>maxBytes)throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
      const epoch=this.templates.resourceEpoch(content.resource.id);
      const bindings=this.app.library.captureReferenceBindings(selected.sessionId,[selected.reference],context?.executorBotId,context?.runtimeRunId);
      const check=()=>{this.check(context,selected.sessionId,signal);if(this.templates.resourceEpoch(content.resource.id)!==epoch)throw invalid();this.app.library.assertReferenceBindings(selected.sessionId,bindings,context?.executorBotId,context?.runtimeRunId);};checks.push(check);
      const retained:ResourceFileRef[]=[];
      for(const path of selected.filePaths){const file=content.revision.files.find(file=>file.relativePath===path);if(!file||++fileCount>250)throw invalid();if(!files.has(file.sha256))size+=file.size;if(size>maxBytes)throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
        const value=await this.library.readResourceBytes({sessionId:selected.sessionId,id:content.resource.id,revisionId:content.revision.id,path},signal??context?.signal,context?.executorBotId,context?.runtimeRunId);check();files.set(file.sha256,Buffer.from(value.bytes));retained.push(structuredClone(file));}
      resources.push({key:content.resource.id,kind:content.resource.kind,name:content.revision.name,description:content.revision.description,body:content.revision.body,files:retained});
    }
    checks.forEach(check=>check());return {resources,files,checks};
  }
  async prepareCapture(input:TemplateCaptureInput,context?:TemplateContext,signal?:AbortSignal):Promise<TemplatePreview>{
    const parsed=templateCaptureSchema.parse(input);this.check(context,parsed.sessionId,signal);
    const sourceSession=this.app.getSession(parsed.sessionId),generation=sourceSession.generation;
    const bots=parsed.bots.map(selected=>{if(context)this.app.assertSessionExecutor(parsed.sessionId,selected.id);const bot=this.app.getBot(selected.id);if(bot.version!==selected.expectedVersion)throw new AevorenBotError("BOT_VERSION_CONFLICT");
      return {key:bot.id,name:bot.name,label:bot.label,description:bot.description,instructions:bot.instructions,avatarShape:bot.avatarShape,avatarColor:bot.avatarColor};});
    const room=parsed.room?this.app.getRoom(parsed.room.id):null;
    if(parsed.room&&(sourceSession.roomId!==room!.id||room!.version!==parsed.room.expectedVersion||room!.membershipVersion!==parsed.room.expectedMembershipVersion||room!.archivedAt||parsed.room.memberBotIds.some(id=>!this.app.getRoomDetail(room!.id,sourceSession.id).members.some(member=>member.botId===id))))throw invalid();
    const collected=await this.collectResources(parsed.resources.map(value=>({sessionId:parsed.sessionId,...value})),context,signal);
    const manifest=templateManifestSchema.parse({format:"aevoren-template",schemaVersion:1,name:parsed.name,description:parsed.description??"",bots,room:room?{name:room.name,description:room.description,memberKeys:parsed.room!.memberBotIds,leadBotKey:room.leadBotId&&parsed.room!.memberBotIds.includes(room.leadBotId)?room.leadBotId:null}:null,resources:collected.resources});
    this.validateFiles(manifest,collected.files);const assertCurrent=()=>{this.check(context,parsed.sessionId,signal);if(this.app.getSession(parsed.sessionId).generation!==generation)throw invalid();
      for(const selected of parsed.bots)if(this.app.getBot(selected.id).version!==selected.expectedVersion)throw new AevorenBotError("BOT_VERSION_CONFLICT");
      if(parsed.room){const current=this.app.getRoom(parsed.room.id);if(current.version!==parsed.room.expectedVersion||current.membershipVersion!==parsed.room.expectedMembershipVersion||current.archivedAt)throw invalid();}collected.checks.forEach(check=>check());};
    for(const bytes of collected.files.values()){await this.blobs.put(bytes,signal??context?.signal);assertCurrent();}assertCurrent();
    return this.preview({actor:context?{executorBotId:context.executorBotId,runtimeRunId:context.runtimeRunId}:null,origins:parsed.resources.map(value=>value.reference),manifest,digest:templateDigest(manifest),files:collected.files,ownerSessionId:parsed.sessionId,assertCurrent});
  }
  async commitCapture(input:TemplateCommitInput,context?:TemplateContext,signal?:AbortSignal){this.check(context,undefined,signal);const parsed=templateCommitSchema.parse(input),value=this.fromPreview(parsed.preparedId,parsed.expectedDigest,context);if(!value.ownerSessionId)throw invalid();
    this.check(context,value.ownerSessionId,signal);const verified=new Set<string>();for(const file of uniqueFiles(value.manifest.resources)){if(verified.has(file.sha256))continue;verified.add(file.sha256);await this.blobs.read(file.sha256,file.size,signal??context?.signal);value.assertCurrent();this.check(context,value.ownerSessionId,signal);}
    return this.templates.publish(value.manifest,value.ownerSessionId,parsed.id,parsed.expectedVersion,value.origins);}
  assertPrepared(id:string,digest:string,context?:TemplateContext):void{this.fromPreview(id,digest,context);}
  /** Trusted UI/native approval review only; this is not a model catalog operation. */
  reviewPrepared(id:string,digest:string):TemplateManifest{return structuredClone(this.fromPreview(id,digest).manifest);}
  async prepareTemplateExport(input:TemplateReadInput,context?:TemplateContext,signal?:AbortSignal):Promise<PreparedOfflineArtifact>{
    this.check(context,undefined,signal);const record=this.read(input,context),files:{sha256:string;dataBase64:string}[]=[],seen=new Set<string>();
    for(const file of uniqueFiles(record.revision.manifest.resources)){if(seen.has(file.sha256))continue;const bytes=await this.blobs.read(file.sha256,file.size,signal??context?.signal);seen.add(file.sha256);files.push({sha256:file.sha256,dataBase64:bytes.toString("base64")});}
    const bytes=Buffer.from(JSON.stringify({...record.revision.manifest,files}));if(bytes.length>TEMPLATE_MAX_JSON_BYTES)throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
    const assertCurrent=()=>{this.check(context,undefined,signal);const current=this.read({id:record.template.id,revisionId:record.revision.id},context);if(current.revision.digest!==record.revision.digest)throw invalid();};assertCurrent();
    return {name:`Aevoren-template-${record.revision.digest.slice(0,12)}.json`,mimeType:"application/json",bytes,assertCurrent};
  }
  async preflightImport(input:Uint8Array,context?:TemplateContext,signal?:AbortSignal):Promise<TemplatePreview>{
    this.check(context,undefined,signal);if(input.byteLength>TEMPLATE_MAX_JSON_BYTES)throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");let raw:unknown;
    try{raw=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(new Uint8Array(input)));}catch{throw invalid();}
    const bundle=templateBundleSchema.parse(raw),{files:payload,...candidate}=bundle,manifest=templateManifestSchema.parse(candidate),files=new Map<string,Buffer>();
    for(const file of payload){this.check(context,undefined,signal);const bytes=Buffer.from(file.dataBase64,"base64");if(libraryBytesDigest(bytes)!==file.sha256)throw invalid();files.set(file.sha256,bytes);}
    this.validateFiles(manifest,files);for(const bytes of files.values())await this.blobs.put(bytes,signal??context?.signal);this.check(context,undefined,signal);
    return this.preview({actor:context?{executorBotId:context.executorBotId,runtimeRunId:context.runtimeRunId}:null,origins:[],manifest,digest:templateDigest(manifest),files,ownerSessionId:context?.sessionId??null,assertCurrent:()=>this.check(context,undefined,signal)});
  }
  async commitImport(input:TemplateImportInput,context?:TemplateContext,signal?:AbortSignal):Promise<TemplateImportResult>{
    const parsed=templateImportSchema.parse(input);this.check(context,parsed.targetSessionId,signal);if(context&&this.app.getSession(context.sessionId).kind==="TASK")throw new AevorenBotError("APPROVAL_SCOPE_INVALID");const intent=templateDigest({digest:parsed.expectedDigest,targetSessionId:parsed.targetSessionId??null});
    const previous=this.templates.importReceipt(parsed.clientNonce,intent,context?.sessionId,context?.executorBotId);if(previous)return previous;
    const value=this.fromPreview(parsed.preparedId,parsed.expectedDigest,context);this.validateFiles(value.manifest,value.files);
    if(!value.manifest.bots.length&&!parsed.targetSessionId)throw invalid();
    for(const bytes of value.files.values()){await this.libraryBlobs.put(bytes,signal??context?.signal);value.assertCurrent();this.check(context,undefined,signal);}this.check(context,parsed.targetSessionId,signal);
    return this.app.demonstrationsTransaction(()=>this.templates.importAtomic(parsed.clientNonce,intent,value.digest,context?.sessionId??null,context?.executorBotId??null,()=>{
      value.assertCurrent();const bots=new Map<string,ReturnType<AppRepository["createBot"]>>();
      for(const profile of value.manifest.bots){const created=this.app.createBot();this.app.updateBot(created.bot.id,created.bot.version,{name:profile.name,label:profile.label,description:profile.description,instructions:profile.instructions,avatarShape:profile.avatarShape,avatarColor:profile.avatarColor,mcpServerIds:[],memoryWorkspaceIds:[]});this.app.setConversationProject(created.session.id,null,this.app.getConversation(created.session.id).version);bots.set(profile.key,created);}
      const room=value.manifest.room?this.app.createRoom({name:value.manifest.room.name,description:value.manifest.room.description,memberBotIds:value.manifest.room.memberKeys.map(key=>bots.get(key)!.bot.id),leadBotId:value.manifest.room.leadBotKey?bots.get(value.manifest.room.leadBotKey)!.bot.id:null}):null;
      const target=parsed.targetSessionId??room?.session.id??bots.values().next().value?.session.id;
      if(!target)throw invalid();
      const resourceRefs=value.manifest.resources.map(resource=>{const created=this.app.library.create({sessionId:target,kind:resource.kind,name:resource.name,description:resource.description,body:resource.body,files:resource.files});if(resource.kind==="skill")this.app.library.setEnabled({sessionId:target,id:created.resource.id,expectedVersion:created.resource.version,enabled:false});return created.reference;});
      this.check(context,undefined,signal);return {clientNonce:parsed.clientNonce,digest:value.digest,botIds:[...bots.values()].map(bot=>bot.bot.id),roomId:room?.room.id??null,sessionIds:[...bots.values()].map(bot=>bot.session.id).concat(room?[room.session.id]:[]),resourceRefs,targetSessionId:target};
    }));
  }
  async prepareExport(input:OfflineExportInput,context?:TemplateContext,signal?:AbortSignal):Promise<PreparedOfflineArtifact>{
    const parsed=offlineExportSchema.parse(input);this.check(context,undefined,signal);const checks:Array<()=>void>=[],sessions=[];let size=0;
    for(const selected of parsed.sessions){this.check(context,selected.sessionId,signal);const session=this.app.getSession(selected.sessionId);if(session.generation!==selected.generation)throw invalid();checks.push(()=>{if(this.app.getSession(session.id).generation!==selected.generation)throw invalid();});
      const entries=selected.entries.map(reference=>{const entry=this.app.getTranscriptEntry(reference.id);if(entry.sessionId!==session.id||entry.generation!==selected.generation||libraryBytesDigest(Buffer.from(entry.body))!==reference.digest)throw invalid();size+=Buffer.byteLength(entry.body);if(size>OFFLINE_MAX_BYTES)throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
        checks.push(()=>{const current=this.app.getTranscriptEntry(entry.id);if(this.app.getSession(session.id).generation!==selected.generation||current.sessionId!==session.id||current.generation!==selected.generation||current.body!==entry.body||current.status!==entry.status)throw invalid();});
        return {id:entry.id,role:entry.role,body:entry.body,status:entry.status,speaker:entry.speakerNameSnapshot,createdAt:entry.createdAt};});
      sessions.push({id:session.id,generation:session.generation,title:this.app.getConversation(session.id).title??(session.botId?this.app.getBot(session.botId).name:this.app.getRoom(session.roomId!).name),entries});
    }
    const collected=await this.collectResources(parsed.resources,context,signal,OFFLINE_MAX_BYTES-size);checks.push(...collected.checks);size+=Buffer.byteLength(stableTemplateJson(collected.resources))+[...collected.files.values()].reduce((sum,bytes)=>sum+bytes.length,0);if(size>OFFLINE_MAX_BYTES)throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");const media=[];
    for(const selected of parsed.media){this.check(context,selected.sessionId,signal);
      const metadata=context?.runtimeRunId?this.app.media.resolveRuntimeRead({sessionId:selected.sessionId,executorBotId:context.executorBotId,runtimeRunId:context.runtimeRunId},selected.reference.mediaId,selected.reference).item:this.app.media.metadata({sessionId:selected.sessionId,id:selected.reference.mediaId},context?.executorBotId);
      if(size+metadata.asset.reference.size>OFFLINE_MAX_BYTES)throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");const value=await this.media.readBinary({sessionId:selected.sessionId,id:selected.reference.mediaId,reference:selected.reference},{executorBotId:context?.executorBotId,runtimeRunId:context?.runtimeRunId,signal:signal??context?.signal});
      this.check(context,selected.sessionId,signal);if(!value.isAuthorized())throw invalid();checks.push(()=>{if(!value.isAuthorized())throw invalid();});size+=value.bytes.length;if(size>OFFLINE_MAX_BYTES)throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
      media.push({sessionId:selected.sessionId,reference:selected.reference,name:value.item.asset.reference.name,mimeType:value.item.asset.reference.mimeType,dataBase64:Buffer.from(value.bytes).toString("base64")});
    }
    const bundle={format:"aevoren-offline-export",schemaVersion:1,name:parsed.name??"Aevoren export",sessions,resources:collected.resources,files:[...collected.files].map(([sha256,bytes])=>({sha256,dataBase64:bytes.toString("base64")})),media};
    const json=JSON.stringify(bundle),digest=libraryBytesDigest(Buffer.from(json));wellFormed(bundle);
    const downloadFiles=uniqueFiles(collected.resources);
    const html=parsed.format==="html"?`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; base-uri 'none'; form-action 'none'"><title>${escapeHtml(bundle.name)}</title><style>body{max-width:900px;margin:32px auto;padding:16px;font:16px system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border-bottom:1px solid #aaa;padding:12px 0}</style></head><body><h1>${escapeHtml(bundle.name)}</h1>${sessions.map(session=>`<section><h2>${escapeHtml(session.title)}</h2>${session.entries.map(entry=>`<article><strong>${escapeHtml(entry.speaker??entry.role)}</strong><pre>${escapeHtml(entry.body)}</pre></article>`).join("")}</section>`).join("")}${collected.resources.map(resource=>`<section><h2>${escapeHtml(resource.name)}</h2><pre>${escapeHtml(resource.body)}</pre></section>`).join("")}${media.map(item=>`<section><h2>${escapeHtml(item.name)}</h2>${["image/png","image/jpeg"].includes(item.mimeType)?`<img alt="${escapeHtml(item.name)}" src="data:${item.mimeType};base64,${item.dataBase64}">`:item.mimeType.startsWith("audio/")?`<audio controls preload="none" src="data:${escapeHtml(item.mimeType)};base64,${item.dataBase64}"></audio>`:item.mimeType.startsWith("video/")?`<video controls preload="none" src="data:${escapeHtml(item.mimeType)};base64,${item.dataBase64}"></video>`:""}<a download="${escapeHtml(`Aevoren-${item.name}`)}" href="data:application/octet-stream;base64,${item.dataBase64}">Download selected media</a></section>`).join("")}${[...collected.files].map(([sha,bytes])=>`<a download="${escapeHtml(`Aevoren-${downloadFiles.find(file=>file.sha256===sha)?.relativePath.split("/").at(-1)??sha.slice(0,12)}`)}" href="data:application/octet-stream;base64,${bytes.toString("base64")}">Download selected file</a>`).join("")}<details><summary>Structured export data</summary><pre>${escapeHtml(json)}</pre></details></body></html>`:"";
    const bytes=Buffer.from(parsed.format==="html"?html:json);if(bytes.length>96*1024*1024)throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
    const assertCurrent=()=>{this.check(context,undefined,signal);for(const selected of parsed.sessions)this.check(context,selected.sessionId,signal);checks.forEach(check=>check());};assertCurrent();
    return {name:`Aevoren-export-${digest.slice(0,12)}.${parsed.format}`,mimeType:parsed.format==="html"?"text/html":"application/json",bytes,assertCurrent};
  }
}
