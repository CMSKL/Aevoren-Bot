import { randomUUID } from "node:crypto";
import { mkdtempSync,readdirSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach,describe,expect,it } from "vitest";
import type { RealtimeStartInput } from "@shared/realtime-contracts";
import { AppRepository,MIGRATIONS } from "./database";
import { captureRealtimeAdmission } from "./realtime-admission";
import { voiceDigest } from "./voice-repository";

const repositories:AppRepository[]=[],roots:string[]=[];
afterEach(()=>{for(const repository of repositories.splice(0))repository.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const repository=new AppRepository(":memory:");repositories.push(repository);const owner=repository.createBot(),input:RealtimeStartInput={sessionId:owner.session.id,executorBotId:owner.bot.id,expectedConfigVersion:1,routingMode:"automatic",targetBotIds:[]};
  const record=repository.realtime.create(input,randomUUID(),repository.voice.configuration("realtime").configuration,captureRealtimeAdmission(repository,input));return {repository,owner,input,record};}
function readyTurn(f:ReturnType<typeof fixture>){const turn=f.repository.realtime.beginTurn(f.record.session.id);f.repository.realtime.setTurn(turn.id,"transcribing");f.repository.realtime.bindInput(turn.id,"input_1");
  f.repository.realtime.finishTranscript(turn.id,"不要创建 Bot");f.repository.realtime.setTurn(turn.id,"responding");f.repository.realtime.setSession(f.record.session.id,{state:"responding"});return turn;}
describe("durable realtime sessions, turns and business admissions",()=>{
  it("claims a persisted turn nonce once and verifies exact human origin before ordinary prepare",()=>{
    const f=fixture(),turn=readyTurn(f),args={callId:"call_1",responseId:"response_1",itemId:"function_1",arguments:'{"task":"MODEL_ONLY_CREATE_BOT"}'};
    const first=f.repository.realtime.claimCall(turn.id,args);expect(first.created).toBe(true);expect(f.repository.realtime.claimCall(turn.id,args).created).toBe(false);
    const command={sessionId:f.input.sessionId,clientNonce:f.repository.realtime.turnNonce(turn.id),text:"不要创建 Bot"},origin={kind:"voice-input" as const,voiceSessionId:f.record.session.id,turnId:turn.id,callId:"call_1",transcriptDigest:voiceDigest(command.text)};
    expect(f.repository.prepareMessage(command,origin).disposition).toBe("prepared");expect(f.repository.getUserMessage(command.clientNonce).body).toBe(command.text);
    expect(JSON.stringify(f.repository.realtime.snapshot({sessionId:f.input.sessionId,id:f.record.session.id}))).not.toContain("MODEL_ONLY");
    expect(()=>f.repository.realtime.claimCall(turn.id,{...args,callId:"call_2"})).toThrowError(expect.objectContaining({code:"VOICE_NONCE_CONFLICT"}));
    expect(()=>f.repository.realtime.assertVoiceOrigin(origin,{...command,text:"MODEL_ONLY_CREATE_BOT"})).toThrowError(expect.objectContaining({code:"VOICE_NOT_GRANTED"}));
  });
  it("marks crash gaps unknown and keeps the original nonce without dispatch admission",()=>{
    const f=fixture(),turn=readyTurn(f);f.repository.realtime.claimCall(turn.id,{callId:"c",responseId:"r",itemId:"i",arguments:'{"task":"hint"}'});const nonce=f.repository.realtime.turnNonce(turn.id);
    f.repository.realtime.recoverInterrupted();expect(f.repository.realtime.call(turn.id)?.state).toBe("interrupted_unknown");expect(f.repository.realtime.turnNonce(turn.id)).toBe(nonce);
    expect(f.repository.realtime.internal(f.record.session.id).session.state).toBe("interrupted_unknown");
    expect(()=>f.repository.realtime.assertVoiceOrigin({kind:"voice-input",voiceSessionId:f.record.session.id,turnId:turn.id,callId:"c",transcriptDigest:voiceDigest("不要创建 Bot")},{sessionId:f.input.sessionId,clientNonce:nonce,text:"不要创建 Bot"})).toThrow();
    const link={kind:"runtime" as const,id:randomUUID()};f.repository.realtime.linkCall(turn.id,link,true);expect(f.repository.realtime.call(turn.id)).toMatchObject({state:"interrupted_unknown",linkedTask:link});
  });
  it("denies a different session and permanently retires any removed admitted Room member",()=>{
    const f=fixture(),other=f.repository.createBot();expect(()=>f.repository.realtime.snapshot({sessionId:other.session.id,id:f.record.session.id})).toThrowError(expect.objectContaining({code:"VOICE_NOT_GRANTED"}));
    const third=f.repository.createBot(),room=f.repository.createRoom({memberBotIds:[f.owner.bot.id,other.bot.id,third.bot.id]}),input={...f.input,sessionId:room.session.id};
    const value=f.repository.realtime.create(input,randomUUID(),f.repository.voice.configuration("realtime").configuration,captureRealtimeAdmission(f.repository,input));
    const removed=f.repository.removeRoomMember(room.room.id,other.bot.id,room.room.membershipVersion);f.repository.addRoomMember(room.room.id,other.bot.id,removed.room.membershipVersion);
    expect(f.repository.realtime.internal(value.session.id).accessRevoked).toBe(true);expect(()=>f.repository.realtime.snapshot({sessionId:room.session.id,id:value.session.id})).toThrow();
    f.repository.clearConversation(f.input.sessionId);expect(()=>f.repository.realtime.snapshot({sessionId:f.input.sessionId,id:f.record.session.id})).toThrow();
  });
  it("upgrades a real v43 database with old voice/media rows and triggers intact",()=>{
    const root=mkdtempSync(join(tmpdir(),"aevoren-realtime44-"));roots.push(root);const filename=join(root,"old.sqlite"),raw=new DatabaseSync(filename);raw.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)");
    for(const migration of MIGRATIONS.filter(value=>value.version<=43)){if("foreignKeysOff" in migration&&migration.foreignKeysOff)raw.exec("PRAGMA foreign_keys=OFF");raw.exec("BEGIN");raw.exec(migration.sql);raw.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(migration.version,"2026-10-01T00:00:00Z");raw.exec("COMMIT");raw.exec("PRAGMA foreign_keys=ON");}
    raw.prepare("UPDATE voice_configurations SET encrypted_key=?,version=7 WHERE kind='realtime'").run("ENCRYPTED_OLD_KEY");
    const schema=raw.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN('trigger','index') ORDER BY type,name").all() as {type:string;name:string;sql:string|null}[];raw.close();
    const repository=new AppRepository(filename);repositories.push(repository);const db=Reflect.get(repository,"database") as DatabaseSync;
    expect(repository.voice.configuration("realtime")).toMatchObject({configuration:{version:7,keyConfigured:true},encryptedKey:"ENCRYPTED_OLD_KEY"});
    const compact=(sql:string):string=>sql.replace(/\s+/gu,"");
    for(const old of schema){
      const actual=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=?").get(old.type,old.name) as typeof old|undefined;
      expect(actual,old.name).toBeDefined();
      if(old.name==="sessions_one_main_per_bot"||old.name==="sessions_one_main_per_room"){
        const owner=old.name.endsWith("bot")?"bot_id":"room_id";
        expect(compact(actual!.sql!)).toBe(compact(`CREATE UNIQUE INDEX ${old.name} ON sessions(${owner}) WHERE ${owner} IS NOT NULL AND kind='MAIN'`));
      }else if(old.name==="initialize_conversation"){
        // Exact legacy body retained; only automatic initialization becomes MAIN-only.
        expect(compact(actual!.sql!)).toBe(compact(old.sql!).replace("AFTERINSERTONsessionsBEGIN","AFTERINSERTONsessionsWHENNEW.kind='MAIN'BEGIN"));
      }else if(old.name==="capture_runtime_media"){
        expect(actual!.sql).toBe(old.sql!.replace("AFTER INSERT ON runtime_runs BEGIN","AFTER INSERT ON runtime_runs WHEN (SELECT kind FROM sessions WHERE id=NEW.session_id)='MAIN' BEGIN"));
      }else if(old.name==="initialize_runtime_scope"){
        // The one intentionally replaced body must equal migration45's complete
        // immutable TASK/retry scope capture, not an arbitrary changed trigger.
        const declared=MIGRATIONS.find(migration=>migration.version===45)!.sql.match(/CREATE TRIGGER initialize_runtime_scope\b[\s\S]*?\n[ ]{2}END;/u)?.[0];
        expect(declared).toBeDefined();expect(actual!.sql).toBe(declared!.replace(/;$/u,""));
      }else expect(actual).toEqual(old);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);expect(readdirSync(join(root,"Backups")).some(name=>name.endsWith(".sqlite"))).toBe(true);
  });
});
