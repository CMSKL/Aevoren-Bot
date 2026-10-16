import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { VoiceConfiguration, VoiceConfigurationKind, VoiceTask, VoiceTaskSource, VoiceCaptureOrigin, VoiceTaskState } from "@shared/voice-contracts";
import type { MediaRef } from "@shared/contracts";
import { AevorenBotError } from "./errors";
import { MEDIA_MIGRATION } from "./media-repository";

const mediaRuntimeTrigger = MEDIA_MIGRATION.sql.match(/CREATE TRIGGER capture_runtime_media[\s\S]*?END;/u)![0];
export const VOICE_MIGRATION = { version: 43, foreignKeysOff: true, sql: `
  CREATE TABLE media_assets_v43 (
    id TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL CHECK(size>0),mime_type TEXT NOT NULL,sha256 TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('image','pdf','docx','audio','video')),version INTEGER NOT NULL CHECK(version>0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),width INTEGER,height INTEGER,deleted_at TEXT,created_at TEXT NOT NULL,duration_ms INTEGER
  );
  INSERT INTO media_assets_v43(id,name,size,mime_type,sha256,kind,version,enabled,width,height,deleted_at,created_at)
    SELECT id,name,size,mime_type,sha256,kind,version,enabled,width,height,deleted_at,created_at FROM media_assets;
  DROP TRIGGER capture_runtime_media;
  DROP TABLE media_assets;
  ALTER TABLE media_assets_v43 RENAME TO media_assets;
  ${mediaRuntimeTrigger}
  CREATE TABLE voice_configurations (
    kind TEXT PRIMARY KEY CHECK(kind IN ('stt','tts','realtime')),version INTEGER NOT NULL CHECK(version>0),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    model TEXT NOT NULL,voice TEXT NOT NULL,encrypted_key TEXT,updated_at TEXT NOT NULL
  );
  INSERT INTO voice_configurations VALUES('stt',1,0,'gpt-transcribe','alloy',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT INTO voice_configurations VALUES('tts',1,0,'gpt-4o-mini-tts','alloy',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT INTO voice_configurations VALUES('realtime',1,0,'gpt-realtime-2.1-mini','marin',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  CREATE TABLE voice_tasks (
    id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,executor_bot_id TEXT,runtime_run_id TEXT,
    input_generation INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('transcription','speech')),client_nonce TEXT NOT NULL UNIQUE,intent_digest TEXT NOT NULL,
    source_json TEXT NOT NULL,capture_json TEXT,configuration_version INTEGER NOT NULL,model TEXT NOT NULL,voice TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','running','completed','failed','cancelled','interrupted_unknown')),version INTEGER NOT NULL,
    transcript TEXT,audio_json TEXT,last_error_code TEXT,access_revoked INTEGER NOT NULL DEFAULT 0 CHECK(access_revoked IN (0,1)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  );
  CREATE INDEX voice_tasks_scope ON voice_tasks(session_id,input_generation,created_at,id);
  CREATE TABLE voice_task_private (
    task_id TEXT PRIMARY KEY REFERENCES voice_tasks(id) ON DELETE CASCADE,source_text TEXT,source_incarnation TEXT
  );
  CREATE TRIGGER retire_removed_member_voice AFTER DELETE ON room_members BEGIN
    UPDATE voice_tasks SET access_revoked=1,transcript=NULL,audio_json=NULL
      WHERE executor_bot_id=OLD.bot_id AND session_id IN (SELECT id FROM sessions WHERE room_id=OLD.room_id);
  END;
` } as const;

export type VoiceContext = { executorBotId?: string; runtimeRunId?: string; signal?: AbortSignal; assertCurrent?(): void };
type ConfigurationRow = { kind: VoiceConfigurationKind;version: number;enabled: number;model: string;voice: string;encrypted_key: string | null;updated_at: string };
type TaskRow = { id: string;session_id: string;executor_bot_id: string | null;runtime_run_id: string | null;input_generation: number;kind: VoiceTask["kind"];client_nonce: string;intent_digest: string;
  source_json: string;capture_json: string | null;configuration_version: number;model: string;voice: string;state: VoiceTaskState;version: number;transcript: string | null;audio_json: string | null;
  last_error_code: string | null;access_revoked: number;created_at: string;updated_at: string };
export type InternalVoiceTask = { task: VoiceTask;intentDigest: string;sourceText: string | null;sourceIncarnation: string | null;accessRevoked: boolean };
export type PreparedVoiceTask = { sessionId: string;kind: VoiceTask["kind"];clientNonce: string;intentDigest: string;source: VoiceTaskSource;
  capture?: VoiceCaptureOrigin;configuration: VoiceConfiguration;sourceText?: string;sourceIncarnation?: string };
export function voiceDigest(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function configuration(row: ConfigurationRow): VoiceConfiguration {
  return { kind: row.kind,version: row.version,provider: "openai",enabled: Boolean(row.enabled),model: row.model,voice: row.voice,keyConfigured: Boolean(row.encrypted_key),updatedAt: row.updated_at };
}
function task(row: TaskRow): VoiceTask {
  return { id: row.id,sessionId: row.session_id,executorBotId: row.executor_bot_id,runtimeRunId: row.runtime_run_id,inputGeneration: row.input_generation,kind: row.kind,clientNonce: row.client_nonce,
    source: JSON.parse(row.source_json),capture: row.capture_json ? JSON.parse(row.capture_json) : null,configurationVersion: row.configuration_version,model: row.model,voice: row.voice,
    state: row.state,version: row.version,transcript: row.transcript,audio: row.audio_json ? JSON.parse(row.audio_json) : null,lastErrorCode: row.last_error_code,createdAt: row.created_at,updatedAt: row.updated_at };
}
export class VoiceRepository {
  private sequence = 0;
  constructor(private readonly database: DatabaseSync,private readonly assertSession: (sessionId: string,executorBotId?: string) => void) {}
  transaction<T>(work: () => T): T {
    const name=`aevoren_voice_${++this.sequence}`;this.database.exec(`SAVEPOINT ${name}`);
    try { const value=work();this.database.exec(`RELEASE SAVEPOINT ${name}`);return value; }
    catch(error){this.database.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);throw error;}
  }
  configuration(kind: VoiceConfigurationKind): { configuration: VoiceConfiguration;encryptedKey: string | null } {
    const row=this.database.prepare("SELECT * FROM voice_configurations WHERE kind=?").get(kind) as ConfigurationRow | undefined;
    if(!row)throw new AevorenBotError("VOICE_CONFIGURATION_REQUIRED");return {configuration:configuration(row),encryptedKey:row.encrypted_key};
  }
  configurations(): VoiceConfiguration[]{return ["stt","tts","realtime"].map(kind=>this.configuration(kind as VoiceConfigurationKind).configuration);}
  saveConfiguration(input: {kind: VoiceConfigurationKind;expectedVersion: number;enabled: boolean;model: string;voice: string},encryptedKey: string | null): VoiceConfiguration {
    const changed=this.database.prepare("UPDATE voice_configurations SET version=version+1,enabled=?,model=?,voice=?,encrypted_key=?,updated_at=? WHERE kind=? AND version=?")
      .run(input.enabled?1:0,input.model,input.voice,encryptedKey,new Date().toISOString(),input.kind,input.expectedVersion);
    if(!changed.changes)throw new AevorenBotError("VOICE_CONFIGURATION_CONFLICT");return this.configuration(input.kind).configuration;
  }
  assertScope(sessionId: string,context: VoiceContext={}): number {
    context.signal?.throwIfAborted();context.assertCurrent?.();this.assertSession(sessionId,context.executorBotId);
    const session=this.database.prepare("SELECT generation FROM sessions WHERE id=?").get(sessionId) as {generation:number};
    if(context.runtimeRunId){
      const runtime=this.database.prepare("SELECT state,input_generation FROM runtime_runs WHERE id=? AND session_id=? AND executor_bot_id=?").get(context.runtimeRunId,sessionId,context.executorBotId??"") as {state:string;input_generation:number}|undefined;
      if(!runtime||!["created","dispatching","running","streaming"].includes(runtime.state)||runtime.input_generation!==session.generation)throw new AevorenBotError("VOICE_NOT_GRANTED");
    }
    return session.generation;
  }
  private row(id:string):TaskRow {const row=this.database.prepare("SELECT * FROM voice_tasks WHERE id=?").get(id) as TaskRow|undefined;if(!row)throw new AevorenBotError("VOICE_TASK_NOT_FOUND");return row;}
  internal(id:string):InternalVoiceTask {
    const row=this.row(id),privateRow=this.database.prepare("SELECT source_text,source_incarnation FROM voice_task_private WHERE task_id=?").get(id) as {source_text:string|null;source_incarnation:string|null};
    return {task:task(row),intentDigest:row.intent_digest,sourceText:privateRow.source_text,sourceIncarnation:privateRow.source_incarnation,accessRevoked:Boolean(row.access_revoked)};
  }
  findNonce(nonce:string):InternalVoiceTask|null {const row=this.database.prepare("SELECT id FROM voice_tasks WHERE client_nonce=?").get(nonce) as {id:string}|undefined;return row?this.internal(row.id):null;}
  access(sessionId:string,id:string,context:VoiceContext={}):InternalVoiceTask {
    const generation=this.assertScope(sessionId,context),record=this.internal(id),value=record.task;
    if(value.sessionId!==sessionId||value.inputGeneration!==generation||record.accessRevoked
      ||context.runtimeRunId&&(value.runtimeRunId!==context.runtimeRunId||value.executorBotId!==context.executorBotId))throw new AevorenBotError("VOICE_NOT_GRANTED");
    if(value.executorBotId)this.assertSession(sessionId,value.executorBotId);
    return record;
  }
  list(sessionId:string,limit=50,context:VoiceContext={}):InternalVoiceTask[]{
    const generation=this.assertScope(sessionId,context),rows=this.database.prepare("SELECT id FROM voice_tasks WHERE session_id=? AND input_generation=? AND access_revoked=0 ORDER BY created_at DESC,id DESC LIMIT ?").all(sessionId,generation,limit) as {id:string}[];
    return rows.flatMap(row=>{try{return [this.access(sessionId,row.id,context)];}catch(error){if(error instanceof AevorenBotError&&["VOICE_NOT_GRANTED","INVALID_REQUEST"].includes(error.code))return [];throw error;}});
  }
  mediaTasks(mediaId:string,sessionId?:string):VoiceTask[]{
    return (this.database.prepare("SELECT * FROM voice_tasks WHERE json_extract(source_json,'$.kind')='media' AND json_extract(source_json,'$.reference.mediaId')=? AND (? IS NULL OR session_id=?)")
      .all(mediaId,sessionId??null,sessionId??null) as TaskRow[]).map(task);
  }
  prepare(input:PreparedVoiceTask,context:VoiceContext={}):{created:boolean;record:InternalVoiceTask}{return this.transaction(()=>{
    const generation=this.assertScope(input.sessionId,context),existing=this.findNonce(input.clientNonce);
    if(existing){if(existing.intentDigest!==input.intentDigest)throw new AevorenBotError("VOICE_NONCE_CONFLICT");return {created:false,record:this.access(input.sessionId,existing.task.id,context)};}
    const id=randomUUID(),at=new Date().toISOString();
    this.database.prepare("INSERT INTO voice_tasks(id,session_id,executor_bot_id,runtime_run_id,input_generation,kind,client_nonce,intent_digest,source_json,capture_json,configuration_version,model,voice,state,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',1,?,?)")
      .run(id,input.sessionId,context.executorBotId??null,context.runtimeRunId??null,generation,input.kind,input.clientNonce,input.intentDigest,JSON.stringify(input.source),input.capture?JSON.stringify(input.capture):null,input.configuration.version,input.configuration.model,input.configuration.voice,at,at);
    this.database.prepare("INSERT INTO voice_task_private(task_id,source_text,source_incarnation) VALUES(?,?,?)").run(id,input.sourceText??null,input.sourceIncarnation??null);
    return {created:true,record:this.internal(id)};
  });}
  dispatch(id:string,expectedVersion:number):boolean {
    return Boolean(this.database.prepare("UPDATE voice_tasks SET state='running',version=version+1,updated_at=? WHERE id=? AND version=? AND state='prepared' AND access_revoked=0").run(new Date().toISOString(),id,expectedVersion).changes);
  }
  complete(id:string,output:{transcript?:string;audio?:MediaRef}):VoiceTask {
    this.database.prepare("UPDATE voice_tasks SET state='completed',version=version+1,transcript=?,audio_json=?,last_error_code=NULL,updated_at=? WHERE id=? AND state='running' AND access_revoked=0")
      .run(output.transcript??null,output.audio?JSON.stringify(output.audio):null,new Date().toISOString(),id);return this.internal(id).task;
  }
  settle(id:string,state:"failed"|"cancelled"|"interrupted_unknown",code:string):VoiceTask {
    this.database.prepare("UPDATE voice_tasks SET state=?,version=version+1,transcript=NULL,audio_json=NULL,last_error_code=?,updated_at=? WHERE id=? AND state IN ('prepared','running')")
      .run(state,code,new Date().toISOString(),id);return this.internal(id).task;
  }
  recoverInterrupted():void {
    this.database.prepare("UPDATE voice_tasks SET state=CASE WHEN state='running' THEN 'interrupted_unknown' ELSE 'cancelled' END,version=version+1,transcript=NULL,audio_json=NULL,last_error_code=CASE WHEN state='running' THEN 'VOICE_REQUEST_UNKNOWN' ELSE 'APP_INTERRUPTED' END,updated_at=? WHERE state IN ('prepared','running')")
      .run(new Date().toISOString());
  }
}
