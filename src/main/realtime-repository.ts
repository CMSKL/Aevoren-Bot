import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { VoiceMessageOrigin } from "@shared/contracts";
import type { RealtimeInput, RealtimeSession, RealtimeSnapshot, RealtimeStartInput, RealtimeState, RealtimeTaskLink, RealtimeTurn } from "@shared/realtime-contracts";
import type { VoiceConfiguration } from "@shared/voice-contracts";
import { AevorenBotError } from "./errors";
import { voiceDigest, type VoiceContext } from "./voice-repository";
import type { RealtimeAdmission } from "./realtime-admission";

export const REALTIME_MIGRATION = { version: 44, sql: `
  CREATE TABLE realtime_sessions (
    id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,executor_bot_id TEXT NOT NULL,input_generation INTEGER NOT NULL,
    configuration_version INTEGER NOT NULL,model TEXT NOT NULL,voice TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('connecting','ready','listening','transcribing','responding','delegating','interrupting','stopped','failed','interrupted_unknown')),
    version INTEGER NOT NULL,capture_id TEXT NOT NULL UNIQUE,current_turn_id TEXT,playback_epoch INTEGER NOT NULL DEFAULT 0,response_id TEXT,item_id TEXT,content_index INTEGER,
    received_samples INTEGER NOT NULL DEFAULT 0,played_samples INTEGER NOT NULL DEFAULT 0,linked_task_json TEXT,last_error_code TEXT,access_revoked INTEGER NOT NULL DEFAULT 0 CHECK(access_revoked IN(0,1)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  );
  CREATE INDEX realtime_sessions_scope ON realtime_sessions(session_id,input_generation,created_at,id);
  CREATE TABLE realtime_session_private (voice_session_id TEXT PRIMARY KEY REFERENCES realtime_sessions(id) ON DELETE CASCADE,admission_json TEXT NOT NULL CHECK(json_valid(admission_json)));
  CREATE TABLE realtime_members (voice_session_id TEXT NOT NULL REFERENCES realtime_sessions(id) ON DELETE CASCADE,bot_id TEXT NOT NULL,PRIMARY KEY(voice_session_id,bot_id));
  CREATE TABLE realtime_turns (
    id TEXT PRIMARY KEY,voice_session_id TEXT NOT NULL REFERENCES realtime_sessions(id) ON DELETE CASCADE,turn_index INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('recording','transcribing','ready','responding','delegating','completed','cancelled','failed','interrupted_unknown')),
    input_item_id TEXT,transcript TEXT,transcript_digest TEXT,client_nonce TEXT NOT NULL UNIQUE,linked_task_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(voice_session_id,turn_index),UNIQUE(voice_session_id,input_item_id)
  );
  CREATE TABLE realtime_calls (
    id TEXT PRIMARY KEY,voice_session_id TEXT NOT NULL REFERENCES realtime_sessions(id) ON DELETE CASCADE,turn_id TEXT NOT NULL UNIQUE REFERENCES realtime_turns(id) ON DELETE CASCADE,
    call_id TEXT NOT NULL,response_id TEXT NOT NULL,item_id TEXT NOT NULL,arguments_digest TEXT NOT NULL,arguments_private TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('dispatching','accepted','completed','failed','cancelled','interrupted_unknown')),linked_task_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(voice_session_id,call_id)
  );
  CREATE TRIGGER retire_removed_member_realtime AFTER DELETE ON room_members BEGIN
    UPDATE realtime_sessions SET access_revoked=1 WHERE session_id IN (SELECT id FROM sessions WHERE room_id=OLD.room_id)
      AND id IN (SELECT voice_session_id FROM realtime_members WHERE bot_id=OLD.bot_id);
  END;
` } as const;

type SessionRow = { id:string;session_id:string;executor_bot_id:string;input_generation:number;configuration_version:number;model:string;voice:string;state:RealtimeState;version:number;capture_id:string;current_turn_id:string|null;
  playback_epoch:number;response_id:string|null;item_id:string|null;content_index:number|null;received_samples:number;played_samples:number;linked_task_json:string|null;last_error_code:string|null;access_revoked:number;created_at:string;updated_at:string };
type TurnRow = {id:string;voice_session_id:string;turn_index:number;state:RealtimeTurn["state"];input_item_id:string|null;transcript:string|null;transcript_digest:string|null;client_nonce:string;linked_task_json:string|null;created_at:string;updated_at:string};
type CallRow = {id:string;voice_session_id:string;turn_id:string;call_id:string;response_id:string;item_id:string;arguments_digest:string;arguments_private:string;state:RealtimeCall["state"];linked_task_json:string|null;created_at:string;updated_at:string};
export type RealtimeCall = {id:string;voiceSessionId:string;turnId:string;callId:string;responseId:string;itemId:string;argumentsDigest:string;arguments:string;state:"dispatching"|"accepted"|"completed"|"failed"|"cancelled"|"interrupted_unknown";linkedTask:RealtimeTaskLink|null};
export type RealtimeRecord = {session:RealtimeSession;admission:RealtimeAdmission;accessRevoked:boolean};
function session(row:SessionRow):RealtimeSession{return {id:row.id,sessionId:row.session_id,executorBotId:row.executor_bot_id,inputGeneration:row.input_generation,configurationVersion:row.configuration_version,model:row.model,voice:row.voice,protocol:"realtime-v1",state:row.state,version:row.version,
  captureId:row.capture_id,currentTurnId:row.current_turn_id,playbackEpoch:row.playback_epoch,responseId:row.response_id,itemId:row.item_id,contentIndex:row.content_index,receivedSamples:row.received_samples,playedSamples:row.played_samples,
  linkedTask:row.linked_task_json?JSON.parse(row.linked_task_json):null,lastErrorCode:row.last_error_code,createdAt:row.created_at,updatedAt:row.updated_at};}
function turn(row:TurnRow):RealtimeTurn{return {id:row.id,voiceSessionId:row.voice_session_id,index:row.turn_index,state:row.state,inputItemId:row.input_item_id,transcript:row.transcript,transcriptDigest:row.transcript_digest,linkedTask:row.linked_task_json?JSON.parse(row.linked_task_json):null,createdAt:row.created_at,updatedAt:row.updated_at};}
function call(row:CallRow):RealtimeCall{return {id:row.id,voiceSessionId:row.voice_session_id,turnId:row.turn_id,callId:row.call_id,responseId:row.response_id,itemId:row.item_id,argumentsDigest:row.arguments_digest,arguments:row.arguments_private,state:row.state,linkedTask:row.linked_task_json?JSON.parse(row.linked_task_json):null};}
export class RealtimeRepository {
  private sequence=0;
  constructor(private readonly database:DatabaseSync,private readonly assertSession:(sessionId:string,executorBotId:string)=>void,private readonly assertAdmission:(admission:RealtimeAdmission)=>void){}
  private transaction<T>(work:()=>T):T{const name=`realtime_${++this.sequence}`;this.database.exec(`SAVEPOINT ${name}`);try{const value=work();this.database.exec(`RELEASE SAVEPOINT ${name}`);return value;}catch(error){this.database.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);throw error;}}
  internal(id:string):RealtimeRecord{
    const row=this.database.prepare("SELECT * FROM realtime_sessions WHERE id=?").get(id) as SessionRow|undefined;
    if(!row)throw new AevorenBotError("VOICE_TASK_NOT_FOUND");
    const saved=this.database.prepare("SELECT admission_json FROM realtime_session_private WHERE voice_session_id=?").get(id) as {admission_json:string};
    return {session:session(row),admission:JSON.parse(saved.admission_json),accessRevoked:Boolean(row.access_revoked)};
  }
  access(input:RealtimeInput,context:VoiceContext={}):RealtimeRecord{
    context.signal?.throwIfAborted();context.assertCurrent?.();const value=this.internal(input.id),saved=value.session;
    if(saved.sessionId!==input.sessionId||value.accessRevoked||context.executorBotId&&context.executorBotId!==saved.executorBotId)throw new AevorenBotError("VOICE_NOT_GRANTED");
    this.assertSession(saved.sessionId,saved.executorBotId);this.assertAdmission(value.admission);
    if(context.runtimeRunId){const runtime=this.database.prepare("SELECT id FROM runtime_runs WHERE id=? AND session_id=? AND executor_bot_id=? AND input_generation=? AND state IN('running','streaming') AND client_nonce IN(SELECT client_nonce FROM realtime_turns WHERE voice_session_id=?)")
      .get(context.runtimeRunId,saved.sessionId,context.executorBotId??"",saved.inputGeneration,saved.id);if(!runtime)throw new AevorenBotError("VOICE_NOT_GRANTED");}
    return value;
  }
  create(input:RealtimeStartInput,captureId:string,configuration:VoiceConfiguration,admission:RealtimeAdmission):RealtimeRecord{return this.transaction(()=>{
    this.assertSession(input.sessionId,input.executorBotId);this.assertAdmission(admission);
    if(JSON.stringify(admission.input)!==JSON.stringify(input))throw new AevorenBotError("VOICE_NOT_GRANTED");
    const id=randomUUID(),at=new Date().toISOString();
    this.database.prepare("INSERT INTO realtime_sessions(id,session_id,executor_bot_id,input_generation,configuration_version,model,voice,state,version,capture_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'connecting',1,?,?,?)")
      .run(id,input.sessionId,input.executorBotId,admission.generation,configuration.version,configuration.model,configuration.voice,captureId,at,at);
    this.database.prepare("INSERT INTO realtime_session_private VALUES(?,?)").run(id,JSON.stringify(admission));
    for(const member of admission.memberBotIds)this.database.prepare("INSERT INTO realtime_members VALUES(?,?)").run(id,member);
    return this.internal(id);
  });}
  snapshot(input:RealtimeInput,context:VoiceContext={}):RealtimeSnapshot{const value=this.access(input,context);return {session:value.session,turns:this.turns(input.id)};}
  turns(id:string):RealtimeTurn[]{return (this.database.prepare("SELECT * FROM realtime_turns WHERE voice_session_id=? ORDER BY turn_index").all(id) as TurnRow[]).map(turn);}
  turn(id:string):RealtimeTurn{const row=this.turnRow(id);return turn(row);}
  private turnRow(id:string):TurnRow{const row=this.database.prepare("SELECT * FROM realtime_turns WHERE id=?").get(id) as TurnRow|undefined;if(!row)throw new AevorenBotError("VOICE_TASK_NOT_FOUND");return row;}
  turnNonce(id:string):string{return this.turnRow(id).client_nonce;}
  setSession(id:string,patch:Partial<Pick<RealtimeSession,"state"|"currentTurnId"|"playbackEpoch"|"responseId"|"itemId"|"contentIndex"|"receivedSamples"|"playedSamples"|"linkedTask"|"lastErrorCode">>):RealtimeSession{
    const columns={state:"state",currentTurnId:"current_turn_id",playbackEpoch:"playback_epoch",responseId:"response_id",itemId:"item_id",contentIndex:"content_index",receivedSamples:"received_samples",playedSamples:"played_samples",linkedTask:"linked_task_json",lastErrorCode:"last_error_code"} as const;
    const entries=Object.entries(patch) as Array<[keyof typeof columns,string|number|RealtimeTaskLink|null]>;
    if(entries.length)this.database.prepare(`UPDATE realtime_sessions SET ${entries.map(([key])=>`${columns[key]}=?`).join(",")},version=version+1,updated_at=? WHERE id=?`)
      .run(...entries.map(([key,value])=>key==="linkedTask"&&value!==null?JSON.stringify(value):value as string|number|null),new Date().toISOString(),id);
    return this.internal(id).session;
  }
  beginTurn(id:string):RealtimeTurn{return this.transaction(()=>{
    const value=this.internal(id).session,previous=value.currentTurnId?this.turn(value.currentTurnId):null;
    if(previous&&!["completed","cancelled","failed","interrupted_unknown"].includes(previous.state))throw new AevorenBotError("SESSION_BUSY");
    const count=(this.database.prepare("SELECT count(*) AS count FROM realtime_turns WHERE voice_session_id=?").get(id) as {count:number}).count;
    if(count>=64)throw new AevorenBotError("VOICE_TOO_LARGE");
    const turnId=randomUUID(),at=new Date().toISOString();this.database.prepare("INSERT INTO realtime_turns(id,voice_session_id,turn_index,state,client_nonce,created_at,updated_at) VALUES(?,?,?,'recording',?,?,?)").run(turnId,id,count,randomUUID(),at,at);
    this.setSession(id,{currentTurnId:turnId,state:"listening"});return this.turn(turnId);
  });}
  setTurn(id:string,state:RealtimeTurn["state"]):RealtimeTurn{this.database.prepare("UPDATE realtime_turns SET state=?,updated_at=? WHERE id=?").run(state,new Date().toISOString(),id);return this.turn(id);}
  bindInput(id:string,itemId:string):void{
    const value=this.turn(id);if(value.inputItemId!==null&&value.inputItemId!==itemId)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
    this.database.prepare("UPDATE realtime_turns SET input_item_id=?,updated_at=? WHERE id=?").run(itemId,new Date().toISOString(),id);
  }
  finishTranscript(id:string,text:string):RealtimeTurn{
    const value=this.turn(id);if(value.state!=="transcribing"||!text.trim()||text.length>20_000)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
    this.database.prepare("UPDATE realtime_turns SET transcript=?,transcript_digest=?,state='ready',updated_at=? WHERE id=? AND transcript IS NULL").run(text.trim(),voiceDigest(text.trim()),new Date().toISOString(),id);
    return this.turn(id);
  }
  private callRow(turnId:string):CallRow|null{return this.database.prepare("SELECT * FROM realtime_calls WHERE turn_id=?").get(turnId) as CallRow|undefined??null;}
  call(turnId:string):RealtimeCall|null{const value=this.callRow(turnId);return value?call(value):null;}
  claimCall(turnId:string,input:{callId:string;responseId:string;itemId:string;arguments:string}):{created:boolean;call:RealtimeCall}{return this.transaction(()=>{
    const value=this.turn(turnId),saved=this.internal(value.voiceSessionId);this.access({sessionId:saved.session.sessionId,id:saved.session.id});
    const digest=voiceDigest(input.arguments),old=this.callRow(turnId);
    if(old){if(old.call_id!==input.callId||old.response_id!==input.responseId||old.item_id!==input.itemId||old.arguments_digest!==digest)throw new AevorenBotError("VOICE_NONCE_CONFLICT");return {created:false,call:call(old)};}
    if(!value.transcript||!value.transcriptDigest||value.state!=="responding"||saved.session.state!=="responding")throw new AevorenBotError("VOICE_NOT_GRANTED");
    const id=randomUUID(),at=new Date().toISOString();
    this.database.prepare("INSERT INTO realtime_calls(id,voice_session_id,turn_id,call_id,response_id,item_id,arguments_digest,arguments_private,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'dispatching',?,?)")
      .run(id,value.voiceSessionId,turnId,input.callId,input.responseId,input.itemId,digest,input.arguments,at,at);
    this.setTurn(turnId,"delegating");this.setSession(value.voiceSessionId,{state:"delegating"});return {created:true,call:this.call(turnId)!};
  });}
  linkCall(turnId:string,link:RealtimeTaskLink,recovered=false):void{this.transaction(()=>{
    this.database.prepare("UPDATE realtime_calls SET linked_task_json=?,state=CASE WHEN ?=1 THEN state ELSE 'accepted' END,updated_at=? WHERE turn_id=? AND state IN('dispatching','interrupted_unknown') AND linked_task_json IS NULL").run(JSON.stringify(link),recovered?1:0,new Date().toISOString(),turnId);
    this.database.prepare("UPDATE realtime_turns SET linked_task_json=?,updated_at=? WHERE id=?").run(JSON.stringify(link),new Date().toISOString(),turnId);
    this.setSession(this.turn(turnId).voiceSessionId,{linkedTask:link});
  });}
  settleCall(turnId:string,state:Exclude<RealtimeCall["state"],"dispatching"|"accepted">):void{
    this.database.prepare("UPDATE realtime_calls SET state=?,updated_at=? WHERE turn_id=? AND state IN('dispatching','accepted','interrupted_unknown')").run(state,new Date().toISOString(),turnId);
    this.setTurn(turnId,state);
  }
  pendingCalls():RealtimeCall[]{return (this.database.prepare("SELECT * FROM realtime_calls WHERE state='interrupted_unknown'").all() as CallRow[]).map(call);}
  recoverInterrupted():void{
    const at=new Date().toISOString();this.database.prepare("UPDATE realtime_calls SET state='interrupted_unknown',updated_at=? WHERE state IN('dispatching','accepted')").run(at);
    this.database.prepare("UPDATE realtime_turns SET state='interrupted_unknown',updated_at=? WHERE state IN('recording','transcribing','ready','responding','delegating')").run(at);
    this.database.prepare("UPDATE realtime_sessions SET state='interrupted_unknown',last_error_code='VOICE_REQUEST_UNKNOWN',version=version+1,updated_at=? WHERE state NOT IN('stopped','failed','interrupted_unknown')").run(at);
  }
  assertVoiceOrigin(origin:VoiceMessageOrigin,command:{sessionId:string;clientNonce:string;text:string}):void{
    const record=this.access({sessionId:command.sessionId,id:origin.voiceSessionId}),value=this.turnRow(origin.turnId),invocation=this.call(origin.turnId);
    if(value.voice_session_id!==record.session.id||value.client_nonce!==command.clientNonce||value.transcript!==command.text||value.transcript_digest!==origin.transcriptDigest
      ||voiceDigest(command.text)!==origin.transcriptDigest||!invocation||invocation.callId!==origin.callId||invocation.state!=="dispatching"||record.session.state!=="delegating")throw new AevorenBotError("VOICE_NOT_GRANTED");
  }
}
