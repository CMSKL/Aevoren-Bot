import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { MediaItem } from "@shared/media-contracts";
import { AppRepository, MIGRATIONS } from "./database";
import { VoiceSettings } from "./voice-settings";
import { voiceDigest, type VoiceContext } from "./voice-repository";
const repositories:AppRepository[]=[],roots:string[]=[];
const codec={isAvailable:()=>true,encrypt:(value:string)=>Buffer.from(`test-codec:${value}`).toString("base64"),decrypt:(value:string)=>Buffer.from(value,"base64").toString().slice(11)};
function fixture(){const repository=new AppRepository(":memory:");repositories.push(repository);return {repository,...repository.createBot()};}
function prepared(f:ReturnType<typeof fixture>,context:VoiceContext={},nonce:string=randomUUID()){
  const text="PRIVATE_SPEECH_SNAPSHOT",configuration=f.repository.voice.configuration("tts").configuration;
  return f.repository.voice.prepare({sessionId:f.session.id,kind:"speech",clientNonce:nonce,intentDigest:voiceDigest({nonce,source:text}),source:{kind:"text",digest:voiceDigest(text)},sourceText:text,configuration},context);
}
afterEach(()=>{for(const repository of repositories.splice(0))repository.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe("voice configuration and durable task repository",()=>{
  it("keeps three keys independently encrypted and exposes only configured flags",()=>{
    const f=fixture(),settings=new VoiceSettings(f.repository.voice,codec),initial=settings.configurations();
    expect(initial.map(value=>value.model)).toEqual(["gpt-transcribe","gpt-4o-mini-tts","gpt-realtime-2.1-mini"]);
    const stt=settings.save({kind:"stt",expectedVersion:1,model:initial[0]!.model,voice:initial[0]!.voice,apiKey:"STT_PRIVATE",enabled:true});
    const tts=settings.save({kind:"tts",expectedVersion:1,enabled:true,model:initial[1]!.model,voice:"alloy",apiKey:"TTS_PRIVATE"});
    expect(stt.version).toBe(2);expect(tts.version).toBe(2);
    expect(settings.credentials("stt",2).apiKey).toBe("STT_PRIVATE");expect(settings.credentials("tts",2).apiKey).toBe("TTS_PRIVATE");
    expect(JSON.stringify(settings.configurations())).not.toContain("PRIVATE");expect(f.repository.voice.configuration("stt").encryptedKey).not.toBe("STT_PRIVATE");
    expect(()=>settings.save({kind:"stt",expectedVersion:1,enabled:false,model:stt.model,voice:stt.voice})).toThrowError(expect.objectContaining({code:"VOICE_CONFIGURATION_CONFLICT"}));
    settings.save({kind:"stt",expectedVersion:2,enabled:false,model:stt.model,voice:stt.voice,clearApiKey:true});
    expect(()=>settings.credentials("stt",3)).toThrowError(expect.objectContaining({code:"VOICE_CONFIGURATION_REQUIRED"}));expect(settings.credentials("tts",2).apiKey).toBe("TTS_PRIVATE");
    expect(()=>settings.save({kind:"realtime",expectedVersion:1,enabled:true,model:initial[2]!.model,voice:"marin"})).toThrowError(expect.objectContaining({code:"VOICE_CONFIGURATION_REQUIRED"}));
  });
  it("dispatches a durable nonce only once and preserves terminal cancellation against late completion",()=>{
    const f=fixture(),first=prepared(f),task=first.record.task;
    expect(JSON.stringify(task)).not.toContain("PRIVATE_SPEECH_SNAPSHOT");expect(first.record.sourceText).toBe("PRIVATE_SPEECH_SNAPSHOT");
    expect(prepared(f,{},task.clientNonce).created).toBe(false);
    expect(f.repository.voice.dispatch(task.id,1)).toBe(true);expect(f.repository.voice.dispatch(task.id,1)).toBe(false);
    f.repository.voice.settle(task.id,"cancelled","TOOL_EXECUTION_CANCELLED");
    expect(f.repository.voice.complete(task.id,{transcript:"LATE_TEXT"})).toMatchObject({state:"cancelled",transcript:null,audio:null});
    expect(()=>f.repository.voice.prepare({sessionId:f.session.id,kind:"speech",clientNonce:task.clientNonce,intentDigest:"changed",source:task.source,configuration:f.repository.voice.configuration("tts").configuration})).toThrowError(expect.objectContaining({code:"VOICE_NONCE_CONFLICT"}));
  });
  it("recovers running work as explicitly unknown and never resets it to prepared",()=>{
    const f=fixture(),first=prepared(f),second=prepared(f);f.repository.voice.dispatch(first.record.task.id,1);f.repository.voice.recoverInterrupted();
    expect(f.repository.voice.internal(first.record.task.id).task).toMatchObject({state:"interrupted_unknown",lastErrorCode:"VOICE_REQUEST_UNKNOWN"});
    expect(f.repository.voice.internal(second.record.task.id).task.state).toBe("cancelled");
    expect(f.repository.voice.dispatch(first.record.task.id,3)).toBe(false);
    expect(prepared(f,{},first.record.task.clientNonce).record.task.state).toBe("interrupted_unknown");
  });
  it("does not let another Runtime or a new conversation generation read a task",()=>{
    const f=fixture(),nonce=randomUUID();f.repository.prepareMessage({sessionId:f.session.id,clientNonce:nonce,text:"task"});
    const runtime=f.repository.createRuntimeRun(nonce,"fake",{schemaVersion:1,botId:f.bot.id,profileVersion:1,sessionId:f.session.id,generation:1,inputSeq:1,blocks:[],digest:"voice-runtime"});
    const context={executorBotId:f.bot.id,runtimeRunId:runtime.id},item=prepared(f,context).record.task;
    expect(f.repository.voice.access(f.session.id,item.id,context).task.id).toBe(item.id);
    f.repository.transitionRuntimeRun(runtime.id,"failed");const next=f.repository.createRuntimeRun(nonce,"fake",runtime.promptManifest);
    expect(()=>f.repository.voice.access(f.session.id,item.id,{executorBotId:f.bot.id,runtimeRunId:next.id})).toThrowError(expect.objectContaining({code:"VOICE_NOT_GRANTED"}));
    f.repository.transitionRuntimeRun(next.id,"failed");f.repository.clearConversation(f.session.id);
    expect(()=>f.repository.voice.access(f.session.id,item.id)).toThrowError(expect.objectContaining({code:"VOICE_NOT_GRANTED"}));
    expect(f.repository.voice.findNonce(item.clientNonce)?.task.id).toBe(item.id);
  });
  it("retirement of a Room member cannot be undone by adding the member again",()=>{
    const f=fixture(),others=[f.repository.createBot(),f.repository.createBot()],room=f.repository.createRoom({memberBotIds:[f.bot.id,...others.map(value=>value.bot.id)]});
    const item=f.repository.voice.prepare({sessionId:room.session.id,kind:"speech",clientNonce:randomUUID(),intentDigest:"member-task",source:{kind:"text",digest:voiceDigest("private")},sourceText:"private",configuration:f.repository.voice.configuration("tts").configuration},{executorBotId:f.bot.id}).record.task;
    const removed=f.repository.removeRoomMember(room.room.id,f.bot.id,room.room.membershipVersion);f.repository.addRoomMember(room.room.id,f.bot.id,removed.room.membershipVersion);
    expect(()=>f.repository.voice.access(room.session.id,item.id)).toThrowError(expect.objectContaining({code:"VOICE_NOT_GRANTED"}));
  });
  it("upgrades real v42 media without changing bytes, incoming FKs, indexes or the Runtime trigger",()=>{
    const root=mkdtempSync(join(tmpdir(),"aevoren-voice-migration-"));roots.push(root);const filename=join(root,"old.sqlite"),raw=new DatabaseSync(filename);
    raw.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)");
    for(const migration of MIGRATIONS.filter(value=>value.version<=42)){
      if("foreignKeysOff" in migration&&migration.foreignKeysOff)raw.exec("PRAGMA foreign_keys=OFF");raw.exec("BEGIN");raw.exec(migration.sql);raw.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(migration.version,"2026-10-01T00:00:00Z");raw.exec("COMMIT");raw.exec("PRAGMA foreign_keys=ON");
    }
    const id=randomUUID();raw.prepare("INSERT INTO media_assets VALUES(?,?,?,?,?,?,1,1,NULL,NULL,NULL,?)").run(id,"old.pdf",10,"application/pdf","a".repeat(64),"pdf","2026-10-01T00:00:00Z");
    raw.prepare("INSERT INTO media_extractions VALUES(?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),id,"a".repeat(64),"old-parser","1","b".repeat(64),"OLD_TEXT","[]","[]","2026-10-01T00:00:00Z");
    const incoming=["media_extractions","session_media_bindings","send_media_admissions","runtime_media_admissions"];
    const fks=JSON.stringify(incoming.map(table=>raw.prepare(`PRAGMA foreign_key_list(${table})`).all()));
    const indexes=JSON.stringify(raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('media_assets','media_extractions','session_media_bindings','send_media_admissions','runtime_media_admissions') ORDER BY name").all());
    const trigger=(raw.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='capture_runtime_media'").get() as {sql:string}).sql;
    raw.close();const upgraded=new AppRepository(filename);repositories.push(upgraded);const db=Reflect.get(upgraded,"database") as DatabaseSync;
    expect(JSON.stringify(incoming.map(table=>db.prepare(`PRAGMA foreign_key_list(${table})`).all()))).toBe(fks);
    expect(JSON.stringify(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('media_assets','media_extractions','session_media_bindings','send_media_admissions','runtime_media_admissions') ORDER BY name").all())).toBe(indexes);
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='capture_runtime_media'").get() as {sql:string}).sql).toBe(trigger);
    expect(db.prepare("SELECT name,sha256,duration_ms FROM media_assets WHERE id=?").get(id)).toMatchObject({name:"old.pdf",sha256:"a".repeat(64),duration_ms:null});
    expect(db.prepare("SELECT body FROM media_extractions WHERE media_id=?").get(id)).toMatchObject({body:"OLD_TEXT"});expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const owner=upgraded.createBot();expect(upgraded.media.publishImport(owner.session.id,[{asset:{reference:{id:randomUUID(),name:"new.wav",size:44,mimeType:"audio/wav",sha256:"c".repeat(64)},kind:"audio" as MediaItem["asset"]["kind"],width:null,height:null,durationMs:null},extraction:null}])).toHaveLength(1);
    expect(readdirSync(join(root,"Backups")).some(name=>name.endsWith(".sqlite"))).toBe(true);
  });
});
