import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ResourceReference } from "@shared/library-contracts";
import { resourceReferencesSchema } from "@shared/library-schemas";
import type { TemplateImportResult, TemplateManifest, TemplateMetadata, TemplateReadInput, TemplateRecord, TemplateRevision } from "@shared/template-export-contracts";
import { templateManifestSchema, templateReadSchema } from "@shared/template-export-schemas";
import { AevorenBotError } from "./errors";
export const TEMPLATE_EXPORT_MIGRATION={version:48,sql:`
  CREATE TABLE portable_resource_epochs(resource_id TEXT PRIMARY KEY REFERENCES library_resources(id) ON DELETE CASCADE,epoch INTEGER NOT NULL CHECK(epoch>0));
  INSERT INTO portable_resource_epochs SELECT id,1 FROM library_resources;
  CREATE TRIGGER portable_new_resource_epoch AFTER INSERT ON library_resources BEGIN INSERT INTO portable_resource_epochs VALUES(NEW.id,1); END;
  CREATE TRIGGER portable_revoke_resource_epoch AFTER UPDATE OF enabled,deleted_at ON library_resources WHEN (OLD.enabled=1 AND NEW.enabled=0) OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) BEGIN UPDATE portable_resource_epochs SET epoch=epoch+1 WHERE resource_id=NEW.id; END;
  CREATE TABLE portable_templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),current_revision_id TEXT NOT NULL,owner_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE portable_template_revisions(id TEXT PRIMARY KEY,template_id TEXT NOT NULL REFERENCES portable_templates(id) ON DELETE CASCADE,number INTEGER NOT NULL CHECK(number>0),digest TEXT NOT NULL CHECK(length(digest)=64),manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),origins_json TEXT NOT NULL CHECK(json_valid(origins_json)),created_at TEXT NOT NULL,UNIQUE(template_id,number));
  CREATE TABLE portable_runtime_admissions(runtime_run_id TEXT PRIMARY KEY REFERENCES runtime_runs(id) ON DELETE CASCADE,templates_json TEXT NOT NULL CHECK(json_valid(templates_json)));
  CREATE TRIGGER portable_capture_runtime AFTER INSERT ON runtime_runs BEGIN
    INSERT INTO portable_runtime_admissions VALUES(NEW.id,CASE WHEN EXISTS(SELECT 1 FROM runtime_runs r WHERE r.client_nonce=NEW.client_nonce AND r.executor_bot_id=NEW.executor_bot_id AND r.id<>NEW.id)
      THEN COALESCE((SELECT a.templates_json FROM runtime_runs r LEFT JOIN portable_runtime_admissions a ON a.runtime_run_id=r.id WHERE r.client_nonce=NEW.client_nonce AND r.executor_bot_id=NEW.executor_bot_id AND r.id<>NEW.id ORDER BY r.rowid LIMIT 1),'[]')
      ELSE (SELECT json_group_array(json_object('id',t.id,'revisionId',v.id,'digest',v.digest)) FROM portable_templates t JOIN portable_template_revisions v ON v.id=t.current_revision_id WHERE t.owner_session_id=NEW.session_id) END);
  END;
  CREATE TABLE portable_template_imports(client_nonce TEXT PRIMARY KEY,intent_digest TEXT NOT NULL,bundle_digest TEXT NOT NULL,actor_session_id TEXT,actor_executor_bot_id TEXT,result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at TEXT NOT NULL);
`} as const;
export function stableTemplateJson(value:unknown):string{if(Array.isArray(value))return `[${value.map(stableTemplateJson).join(",")}]`;if(value&&typeof value==="object")return "{"+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>`${JSON.stringify(key)}:${stableTemplateJson(item)}`).join(",")+"}";return JSON.stringify(value);}
export const templateDigest=(value:unknown)=>createHash("sha256").update(stableTemplateJson(value)).digest("hex");
type MetadataRow={id:string;name:string;description:string;version:number;current_revision_id:string;owner_session_id:string|null;created_at:string;updated_at:string};
function metadata(row:MetadataRow):TemplateMetadata{return {id:row.id,name:row.name,description:row.description,version:row.version,currentRevisionId:row.current_revision_id,ownerSessionId:row.owner_session_id,createdAt:row.created_at,updatedAt:row.updated_at};}
export class TemplateExportRepository{
  private sequence=0;
  private resourceAuthority:((sessionId:string,executorBotId:string,runtimeId?:string)=>ResourceReference[]|null)|null=null;
  setResourceAuthority(reader:NonNullable<TemplateExportRepository["resourceAuthority"]>):void{this.resourceAuthority=reader;}
  private allowed(id:string,revisionId:string,sessionId?:string,executorBotId?:string,runtimeId?:string):boolean{
    if(!sessionId||!executorBotId)return true;if(!this.resourceAuthority)throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
    const references=this.resourceAuthority(sessionId,executorBotId,runtimeId);if(references===null)return true;
    const row=this.database.prepare("SELECT origins_json FROM portable_template_revisions WHERE id=? AND template_id=?").get(revisionId,id) as {origins_json:string}|undefined;
    if(!row)return false;const origins=resourceReferencesSchema.parse(JSON.parse(row.origins_json));
    return origins.every(origin=>references.some(reference=>reference.resourceId===origin.resourceId&&reference.revisionId===origin.revisionId&&reference.digest===origin.digest));
  }
  constructor(private readonly database:DatabaseSync){}
  transaction<T>(work:()=>T):T{const name=`portable_template_${++this.sequence}`;this.database.exec(`SAVEPOINT ${name}`);try{const result=work();this.database.exec(`RELEASE SAVEPOINT ${name}`);return result;}catch(error){this.database.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);throw error;}}
  resourceEpoch(id:string):number{const row=this.database.prepare("SELECT epoch FROM portable_resource_epochs WHERE resource_id=?").get(id) as {epoch:number}|undefined;if(!row)throw new AevorenBotError("LIBRARY_NOT_FOUND");return row.epoch;}
  private pins(sessionId:string,runtimeId:string):{id:string;revisionId:string;digest:string}[]{
    const row=this.database.prepare("SELECT a.templates_json FROM portable_runtime_admissions a JOIN runtime_runs r ON r.id=a.runtime_run_id WHERE a.runtime_run_id=? AND r.session_id=?").get(runtimeId,sessionId) as {templates_json:string}|undefined;
    if(!row)throw new AevorenBotError("APPROVAL_SCOPE_INVALID");return JSON.parse(row.templates_json) as {id:string;revisionId:string;digest:string}[];
  }
  list(actorSessionId?:string,runtimeId?:string,executorBotId?:string):TemplateMetadata[]{if(runtimeId){if(!actorSessionId)throw new AevorenBotError("APPROVAL_SCOPE_INVALID");return this.pins(actorSessionId,runtimeId).filter(pin=>this.allowed(pin.id,pin.revisionId,actorSessionId,executorBotId,runtimeId)).map(pin=>this.read({id:pin.id,revisionId:pin.revisionId},actorSessionId,runtimeId,executorBotId).template);}return (this.database.prepare("SELECT * FROM portable_templates WHERE (? IS NULL OR owner_session_id=?) ORDER BY updated_at DESC,id LIMIT 500").all(actorSessionId??null,actorSessionId??null) as MetadataRow[]).filter(row=>this.allowed(row.id,row.current_revision_id,actorSessionId,executorBotId)).map(metadata);}
  read(input:TemplateReadInput,actorSessionId?:string,runtimeId?:string,executorBotId?:string):TemplateRecord{
    const parsed=templateReadSchema.parse(input),row=this.database.prepare("SELECT * FROM portable_templates WHERE id=? AND (? IS NULL OR owner_session_id=?)").get(parsed.id,actorSessionId??null,actorSessionId??null) as MetadataRow|undefined;
    if(!row)throw new AevorenBotError("LIBRARY_NOT_FOUND");
    const pin=runtimeId?this.pins(actorSessionId??"",runtimeId).find(value=>value.id===parsed.id):undefined;
    if(runtimeId&&(!pin||parsed.revisionId&&parsed.revisionId!==pin.revisionId))throw new AevorenBotError("LIBRARY_NOT_BOUND");
    if(!this.allowed(parsed.id,parsed.revisionId??pin?.revisionId??row.current_revision_id,actorSessionId,executorBotId,runtimeId))throw new AevorenBotError("LIBRARY_NOT_BOUND");
    const revision=this.database.prepare("SELECT * FROM portable_template_revisions WHERE id=? AND template_id=?").get(parsed.revisionId??pin?.revisionId??row.current_revision_id,row.id) as {id:string;template_id:string;number:number;digest:string;manifest_json:string;created_at:string}|undefined;
    if(!revision)throw new AevorenBotError("LIBRARY_REFERENCE_INVALID");const manifest=templateManifestSchema.parse(JSON.parse(revision.manifest_json));
    if(templateDigest(manifest)!==revision.digest||pin&&pin.digest!==revision.digest)throw new AevorenBotError("LIBRARY_REFERENCE_INVALID");
    return {template:pin?{...metadata(row),name:manifest.name,description:manifest.description,version:revision.number,currentRevisionId:revision.id,updatedAt:revision.created_at}:metadata(row),revision:{id:revision.id,templateId:row.id,number:revision.number,digest:revision.digest,manifest,createdAt:revision.created_at}};
  }
  versions(id:string,actorSessionId?:string,runtimeId?:string,executorBotId?:string):Omit<TemplateRevision,"manifest">[]{const record=this.read({id},actorSessionId,runtimeId,executorBotId);if(runtimeId){const {id:revisionId,templateId,number,digest,createdAt}=record.revision;return [{id:revisionId,templateId,number,digest,createdAt}];}return (this.database.prepare("SELECT id,template_id AS templateId,number,digest,created_at AS createdAt FROM portable_template_revisions WHERE template_id=? ORDER BY number DESC LIMIT 50").all(id) as Omit<TemplateRevision,"manifest">[]).filter(row=>this.allowed(id,row.id,actorSessionId,executorBotId));}
  publish(manifest:TemplateManifest,ownerSessionId:string,id?:string,expectedVersion?:number,sourceOrigins:ResourceReference[]=[]):TemplateRecord{return this.transaction(()=>{
    const checked=templateManifestSchema.parse(manifest),origins=resourceReferencesSchema.parse(sourceOrigins);if(checked.resources.length!==origins.length||checked.resources.some(resource=>!origins.some(origin=>origin.resourceId===resource.key)))throw new AevorenBotError("LIBRARY_REFERENCE_INVALID");const timestamp=new Date().toISOString(),revisionId=randomUUID(),templateId=id??randomUUID();let number=1;
    if(id){const current=this.read({id});if(current.template.ownerSessionId!==ownerSessionId)throw new AevorenBotError("LIBRARY_NOT_BOUND");if(current.template.version!==expectedVersion)throw new AevorenBotError("LIBRARY_VERSION_CONFLICT",undefined,undefined,{currentVersion:current.template.version});number=current.template.version+1;
      this.database.prepare("UPDATE portable_templates SET name=?,description=?,version=?,current_revision_id=?,updated_at=? WHERE id=?").run(checked.name,checked.description,number,revisionId,timestamp,id);
    }else{if(expectedVersion!==undefined)throw new AevorenBotError("INVALID_REQUEST");this.database.prepare("INSERT INTO portable_templates VALUES(?,?,?,1,?,?,?,?)").run(templateId,checked.name,checked.description,revisionId,ownerSessionId,timestamp,timestamp);}
    this.database.prepare("INSERT INTO portable_template_revisions VALUES(?,?,?,?,?,?,?)").run(revisionId,templateId,number,templateDigest(checked),stableTemplateJson(checked),JSON.stringify(origins),timestamp);return this.read({id:templateId});
  });}
  importReceipt(clientNonce:string,intentDigest:string,actorSessionId?:string,actorExecutorBotId?:string):TemplateImportResult|null{
    const row=this.database.prepare("SELECT intent_digest,actor_session_id,actor_executor_bot_id,result_json FROM portable_template_imports WHERE client_nonce=?").get(clientNonce) as {intent_digest:string;actor_session_id:string|null;actor_executor_bot_id:string|null;result_json:string}|undefined;
    if(!row)return null;if(row.intent_digest!==intentDigest)throw new AevorenBotError("MESSAGE_NONCE_CONFLICT");if(actorSessionId!==undefined&&(row.actor_session_id!==actorSessionId||row.actor_executor_bot_id!==actorExecutorBotId))throw new AevorenBotError("APPROVAL_SCOPE_INVALID");return JSON.parse(row.result_json) as TemplateImportResult;
  }
  importAtomic(clientNonce:string,intentDigest:string,bundleDigest:string,actorSessionId:string|null,actorExecutorBotId:string|null,work:()=>TemplateImportResult):TemplateImportResult{return this.transaction(()=>{
    const previous=this.importReceipt(clientNonce,intentDigest,actorSessionId??undefined,actorExecutorBotId??undefined);if(previous)return previous;const result=work();
    this.database.prepare("INSERT INTO portable_template_imports VALUES(?,?,?,?,?,?,?)").run(clientNonce,intentDigest,bundleDigest,actorSessionId,actorExecutorBotId,JSON.stringify(result),new Date().toISOString());return result;
  });}
}
