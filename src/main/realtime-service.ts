import { REALTIME_CAPTURE_MAX_DURATION_MS } from "@shared/realtime-channels";
import type { RealtimeAppendInput, RealtimeCommitInput, RealtimeEvent, RealtimeInput, RealtimePlaybackAck, RealtimeSnapshot, RealtimeStartInput, RealtimeTaskLink } from "@shared/realtime-contracts";
import { realtimeAppendSchema, realtimeCommitSchema, realtimeInputSchema, realtimePlaybackSchema, realtimeStartSchema } from "@shared/realtime-schemas";
import type { AppRepository } from "./database";
import type { SecretCodec } from "./settings";
import type { VoiceContext } from "./voice-repository";
import type { RealtimeDispatchRequest } from "./realtime-business-host";
import { assertRealtimeAdmission, captureRealtimeAdmission, type RealtimeAdmission } from "./realtime-admission";
import { VoiceSettings } from "./voice-settings";
import { AevorenBotError } from "./errors";
import { decodeRealtimePcm, REALTIME_DELEGATE_NAME, REALTIME_MAX_ARGUMENTS, type RealtimeWireEvent } from "./realtime-protocol";
import { RealtimeSocketAdapter, type RealtimeSocketFactory } from "./realtime-socket-adapter";

export type RealtimeCaptureLease = {captureId:string;signal:AbortSignal;assertCurrent():void};
export type RealtimeHost = {
  dispatch(request:RealtimeDispatchRequest,signal:AbortSignal):Promise<RealtimeTaskLink>;
  lookup(request:Pick<RealtimeDispatchRequest,"sessionId"|"clientNonce">):RealtimeTaskLink|null;
  wait(link:RealtimeTaskLink,signal:AbortSignal):Promise<{state:string;text:string}>;
  cancel(link:RealtimeTaskLink):void|Promise<void>;
};
type FunctionArguments={itemId:string;callId:string;name:string|null;text:string;done:boolean};
type ResponseState={turnId:string;done:boolean;cancelled:boolean;arguments:Map<string,FunctionArguments>;doneSignature?:string};
type AudioState={epoch:number;responseId:string;itemId:string;contentIndex:number;received:number;played:number};
type Job={id:string;lease:RealtimeCaptureLease;controller:AbortController;signal:AbortSignal;socket:RealtimeSocketAdapter;sequence:number;lastCommitted:number;inputBytes:number;
  pendingCommit:string|null;responses:Map<string,ResponseState>;audio:Map<string,AudioState>;pendingTruncates:Map<string,number>;pendingCancel:Set<string>;interrupted:Set<string>;
  pending:Set<Promise<unknown>>;ready:boolean;closed:boolean;deadline:ReturnType<typeof setTimeout>;guard:ReturnType<typeof setInterval>;interruptTimer?:ReturnType<typeof setTimeout>;cancelBusiness:boolean};
type AsrFinal=Extract<RealtimeWireEvent,{type:"conversation.item.input_audio_transcription.completed"|"conversation.item.input_audio_transcription.failed"}>;
const audioKey=(responseId:string,itemId:string,contentIndex:number):string=>`${responseId}:${itemId}:${contentIndex}`;

export class RealtimeService {
  private readonly settings:VoiceSettings;
  private readonly jobs=new Map<string,Job>();
  private readonly earlyAsr=new Map<string,Map<string,AsrFinal>>();
  private readonly interruptWaiters=new Map<string,Set<()=>void>>();
  private closed=false;
  constructor(private readonly repository:AppRepository,codec:SecretCodec,private readonly host:RealtimeHost,private readonly options:{onEvent?:(event:RealtimeEvent)=>void;socketFactory?:RealtimeSocketFactory}={}){
    this.settings=new VoiceSettings(repository.voice,codec);repository.realtime.recoverInterrupted();
    for(const call of repository.realtime.pendingCalls()){
      if(call.linkedTask)continue;
      try{const saved=repository.realtime.internal(call.voiceSessionId);repository.realtime.access({sessionId:saved.session.sessionId,id:saved.session.id});
        const link=host.lookup({sessionId:saved.session.sessionId,clientNonce:repository.realtime.turnNonce(call.turnId)});if(link)repository.realtime.linkCall(call.turnId,link,true);
      }catch{/* Recovery only queries an existing accepted nonce; it never replays an operation. */}
    }
  }
  private emit(id:string):void{
    const record=this.repository.realtime.internal(id);
    try{this.repository.realtime.access({sessionId:record.session.sessionId,id});this.options.onEvent?.({type:"snapshot",snapshot:{session:record.session,turns:this.repository.realtime.turns(id)}});}
    catch{this.options.onEvent?.({type:"snapshot",snapshot:{session:{...record.session,state:"stopped",lastErrorCode:"VOICE_NOT_GRANTED"},turns:[]}});}
  }
  private check(job:Job):void{
    if(this.closed||job.closed)throw new AevorenBotError("VOICE_CAPTURE_INVALID");
    job.signal.throwIfAborted();job.lease.assertCurrent();const record=this.repository.realtime.internal(job.id);
    this.repository.realtime.access({sessionId:record.session.sessionId,id:job.id});
    const config=this.repository.voice.configuration("realtime").configuration;
    if(config.version!==record.session.configurationVersion||!config.enabled)throw new AevorenBotError("VOICE_CONFIGURATION_CONFLICT");
  }
  private job(input:RealtimeInput,context:VoiceContext={}):Job{
    this.repository.realtime.access(input,context);const job=this.jobs.get(input.id);
    if(!job||job.closed)throw new AevorenBotError("VOICE_CAPTURE_INVALID");this.check(job);return job;
  }
  snapshot(input:RealtimeInput,context:VoiceContext={}):RealtimeSnapshot{return this.repository.realtime.snapshot(realtimeInputSchema.parse(input),context);}
  async start(input:RealtimeStartInput,lease:RealtimeCaptureLease,admission?:RealtimeAdmission):Promise<RealtimeSnapshot>{
    const parsed=realtimeStartSchema.parse(input);if(this.closed)throw new AevorenBotError("APP_INTERRUPTED");
    lease.signal.throwIfAborted();lease.assertCurrent();const captured=admission??captureRealtimeAdmission(this.repository,parsed);assertRealtimeAdmission(this.repository,captured);
    const auth=this.settings.credentials("realtime",parsed.expectedConfigVersion),record=this.repository.realtime.create(parsed,lease.captureId,auth.configuration,captured),controller=new AbortController();
    const signal=AbortSignal.any([controller.signal,lease.signal]);
    const socket=new RealtimeSocketAdapter({model:auth.configuration.model,voice:auth.configuration.voice,apiKey:auth.apiKey,signal,
      assertCurrent:()=>this.check(job),onEvent:event=>this.event(job,event),onClosed:code=>{void this.finish(job,"interrupted_unknown",code);}},this.options.socketFactory);
    const job:Job={id:record.session.id,lease,controller,signal,socket,sequence:0,lastCommitted:-1,inputBytes:0,pendingCommit:null,responses:new Map(),audio:new Map(),pendingTruncates:new Map(),pendingCancel:new Set(),interrupted:new Set(),pending:new Set(),ready:false,closed:false,cancelBusiness:false,
      deadline:setTimeout(()=>{void this.finish(job,"stopped","VOICE_TOO_LARGE");},REALTIME_CAPTURE_MAX_DURATION_MS),guard:setInterval(()=>{try{this.check(job);}catch{void this.finish(job,"stopped","VOICE_NOT_GRANTED");}},250)};
    this.jobs.set(job.id,job);signal.addEventListener("abort",()=>{if(!job.closed)void this.finish(job,"stopped","TOOL_EXECUTION_CANCELLED");},{once:true});
    this.emit(job.id);
    this.track(job,socket.open().then(()=>{this.check(job);job.ready=true;this.repository.realtime.setSession(job.id,{state:"ready"});this.emit(job.id);}).catch(error=>{if(!job.closed)return this.finish(job,"failed",error instanceof AevorenBotError?error.code:"VOICE_REQUEST_FAILED");}));
    return this.snapshot({sessionId:parsed.sessionId,id:job.id});
  }
  append(input:RealtimeAppendInput):void{
    const parsed=realtimeAppendSchema.parse(input),job=this.job(parsed),saved=this.repository.realtime.internal(job.id).session;
    if(!job.ready||parsed.captureId!==saved.captureId||parsed.sequence!==job.sequence||!["ready","listening"].includes(saved.state))throw new AevorenBotError("VOICE_CAPTURE_INVALID");
    if(saved.state==="ready"&&[...job.audio.values()].some(value=>value.received>value.played))throw new AevorenBotError("SESSION_BUSY");
    const bytes=decodeRealtimePcm(parsed.dataBase64,24_000);
    if(job.inputBytes+bytes.length>24_000*2*120)throw new AevorenBotError("VOICE_TOO_LARGE");
    if(saved.state==="ready")this.repository.realtime.beginTurn(job.id);
    job.socket.send({type:"input_audio_buffer.append",audio:bytes.toString("base64")});job.sequence+=1;job.inputBytes+=bytes.length;this.emit(job.id);
  }
  commitTurn(input:RealtimeCommitInput):RealtimeSnapshot{
    const parsed=realtimeCommitSchema.parse(input),job=this.job(parsed),saved=this.repository.realtime.internal(job.id).session;
    if(parsed.captureId!==saved.captureId||parsed.lastSequence!==job.sequence-1||parsed.lastSequence<=job.lastCommitted||saved.state!=="listening"||!saved.currentTurnId||job.pendingCommit)throw new AevorenBotError("VOICE_CAPTURE_INVALID");
    job.pendingCommit=saved.currentTurnId;job.lastCommitted=parsed.lastSequence;job.inputBytes=0;
    this.repository.realtime.setTurn(saved.currentTurnId,"transcribing");this.repository.realtime.setSession(job.id,{state:"transcribing"});
    job.socket.send({type:"input_audio_buffer.commit"});this.emit(job.id);return this.snapshot({sessionId:parsed.sessionId,id:parsed.id});
  }
  private event(job:Job,event:RealtimeWireEvent):void{
    if(job.closed)return;this.check(job);
    if(event.type==="session.created"||event.type==="session.updated"||event.type==="ignored")return;
    if(event.type==="input_audio_buffer.committed"){
      if(!job.pendingCommit)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
      this.repository.realtime.bindInput(job.pendingCommit,event.itemId);job.pendingCommit=null;
      const early=this.earlyAsr.get(job.id)?.get(event.itemId);this.earlyAsr.get(job.id)?.delete(event.itemId);if(early)this.event(job,early);this.emit(job.id);return;
    }
    if(event.type.startsWith("conversation.item.input_audio_transcription.")){
      const input=event as Extract<RealtimeWireEvent,{itemId:string}>;
      const turn=this.repository.realtime.turns(job.id).find(value=>value.inputItemId===input.itemId);
      if(!turn){
        if(event.type==="conversation.item.input_audio_transcription.delta")return;
        if(!job.pendingCommit)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
        const early=this.earlyAsr.get(job.id)??new Map<string,AsrFinal>(),old=early.get(input.itemId);
        if(old&&JSON.stringify(old)!==JSON.stringify(event)||early.size>=4&&!old)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
        early.set(input.itemId,event as AsrFinal);this.earlyAsr.set(job.id,early);return;
      }
      if(turn.state!=="transcribing")return;
      if(event.type==="conversation.item.input_audio_transcription.delta")return;
      if(event.type==="conversation.item.input_audio_transcription.failed"){
        this.repository.realtime.setTurn(turn.id,"failed");this.repository.realtime.setSession(job.id,{state:"ready",lastErrorCode:"VOICE_REQUEST_FAILED"});this.emit(job.id);return;
      }
      if(event.type==="conversation.item.input_audio_transcription.completed"){
        if(!event.transcript.trim()){this.repository.realtime.setTurn(turn.id,"failed");this.repository.realtime.setSession(job.id,{state:"ready",lastErrorCode:"VOICE_RESPONSE_INVALID"});this.emit(job.id);return;}
        const final=this.repository.realtime.finishTranscript(turn.id,event.transcript);this.requestResponse(job,final.id);this.emit(job.id);return;
      }
    }
    if(event.type==="response.created"){
      const turn=event.turnId?this.repository.realtime.turn(event.turnId):null;
      if(!turn||turn.voiceSessionId!==job.id||turn.state!=="responding"||job.responses.has(event.responseId)||job.responses.size>=128)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
      job.responses.set(event.responseId,{turnId:turn.id,done:false,cancelled:false,arguments:new Map()});this.repository.realtime.setSession(job.id,{responseId:event.responseId});this.emit(job.id);return;
    }
    if(event.type==="conversation.item.truncated"){
      const key=`${event.itemId}:${event.contentIndex}`,expected=job.pendingTruncates.get(key);
      if(expected===undefined||expected!==event.audioEndMs)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
      job.pendingTruncates.delete(key);this.finishInterrupt(job);return;
    }
    if(event.type==="error"){void this.finish(job,"interrupted_unknown","VOICE_REQUEST_UNKNOWN");return;}
    if(!("responseId" in event))return;
    const response=job.responses.get(event.responseId);if(!response)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
    if(job.interrupted.has(event.responseId)&&event.type!=="response.done")return;
    if(event.type==="response.function_call_arguments.delta"||event.type==="response.function_call_arguments.done"){
      if(response.done)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
      const existing=response.arguments.get(event.callId)??{callId:event.callId,itemId:event.itemId,name:null,text:"",done:false};
      if(existing.done&&event.type==="response.function_call_arguments.done"&&existing.itemId===event.itemId&&existing.text===event.arguments&&existing.name===event.name)return;
      if(existing.itemId!==event.itemId||existing.done||response.arguments.size>1)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
      if(event.type==="response.function_call_arguments.delta")existing.text+=event.delta;
      else{if(existing.text&&existing.text!==event.arguments)throw new AevorenBotError("VOICE_RESPONSE_INVALID");existing.text=event.arguments;existing.name=event.name;existing.done=true;}
      if(existing.text.length>REALTIME_MAX_ARGUMENTS)throw new AevorenBotError("VOICE_TOO_LARGE");response.arguments.set(event.callId,existing);return;
    }
    if(event.type==="response.output_audio.delta"){
      if(response.done)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
      const saved=this.repository.realtime.internal(job.id).session,key=audioKey(event.responseId,event.itemId,event.contentIndex),audio=job.audio.get(key)??{epoch:saved.playbackEpoch,responseId:event.responseId,itemId:event.itemId,contentIndex:event.contentIndex,received:0,played:0};
      audio.received+=event.pcm.length/2;if(audio.received>8_388_608||job.audio.size>=128&&!job.audio.has(key))throw new AevorenBotError("VOICE_TOO_LARGE");job.audio.set(key,audio);
      this.repository.realtime.setSession(job.id,{itemId:event.itemId,contentIndex:event.contentIndex,receivedSamples:audio.received,playedSamples:audio.played});
      this.options.onEvent?.({type:"audio",sessionId:saved.sessionId,id:job.id,playbackEpoch:audio.epoch,responseId:event.responseId,itemId:event.itemId,contentIndex:event.contentIndex,dataBase64:event.pcm.toString("base64")});return;
    }
    if(event.type==="response.done"){
      const signature=JSON.stringify({status:event.status,calls:event.calls});if(response.done){if(response.doneSignature!==signature)throw new AevorenBotError("VOICE_NONCE_CONFLICT");return;}
      response.doneSignature=signature;response.done=true;response.cancelled=event.status==="cancelled";
      if(job.pendingCancel.has(event.responseId)){if(event.status!=="cancelled"&&event.status!=="completed")throw new AevorenBotError("VOICE_RESPONSE_INVALID");job.pendingCancel.delete(event.responseId);this.finishInterrupt(job);return;}
      if(event.status!=="completed"){
        this.repository.realtime.setTurn(response.turnId,event.status==="cancelled"?"cancelled":"failed");this.repository.realtime.setSession(job.id,{state:"ready",lastErrorCode:event.status==="cancelled"?null:"VOICE_REQUEST_FAILED"});this.emit(job.id);return;
      }
      if(event.calls.length){
        if(event.calls.length!==1)throw new AevorenBotError("VOICE_RESPONSE_INVALID");const fn=event.calls[0]!,args=response.arguments.get(fn.callId);
        if(fn.name!==REALTIME_DELEGATE_NAME||fn.status!=="completed"||!args?.done||args.itemId!==fn.itemId||args.text!==fn.arguments||args.name!==fn.name)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
        let value:unknown;try{value=JSON.parse(fn.arguments);}catch{throw new AevorenBotError("VOICE_RESPONSE_INVALID");}
        if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>key!=="task")||typeof Reflect.get(value,"task")!=="string"||String(Reflect.get(value,"task")).length>4_000)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
        const claimed=this.repository.realtime.claimCall(response.turnId,{...fn,responseId:event.responseId});if(claimed.created)this.track(job,this.delegate(job,response.turnId));return;
      }
      this.repository.realtime.setTurn(response.turnId,"completed");this.repository.realtime.setSession(job.id,{state:"ready"});this.emit(job.id);
    }
  }
  private requestResponse(job:Job,turnId:string,continuation=false):void{
    this.check(job);this.repository.realtime.setTurn(turnId,"responding");this.repository.realtime.setSession(job.id,{state:"responding"});
    job.socket.send({type:"response.create",response:{metadata:{aevoren_turn_id:turnId},...(continuation?{tool_choice:"none"}:{})}});
  }
  private request(job:Job,turnId:string):RealtimeDispatchRequest{
    const saved=this.repository.realtime.internal(job.id),turn=this.repository.realtime.turn(turnId),call=this.repository.realtime.call(turnId);
    if(!call||!turn.transcript)throw new AevorenBotError("VOICE_NOT_GRANTED");
    return {voiceSessionId:job.id,turnId,callId:call.callId,sessionId:saved.session.sessionId,executorBotId:saved.session.executorBotId,inputGeneration:saved.session.inputGeneration,
      clientNonce:this.repository.realtime.turnNonce(turnId),text:turn.transcript,admission:saved.admission};
  }
  private async delegate(job:Job,turnId:string):Promise<void>{
    const request=this.request(job,turnId);let accepted:RealtimeTaskLink|null=null;
    try{
      this.check(job);this.emit(job.id);accepted=await this.host.dispatch(request,job.signal);this.repository.realtime.linkCall(turnId,accepted);
      if(job.cancelBusiness)await this.host.cancel(accepted);
      if(job.closed)return;this.check(job);this.emit(job.id);
      const result=await this.host.wait(accepted,job.signal);this.check(job);await this.waitForInterrupt(job);this.check(job);
      this.repository.realtime.settleCall(turnId,result.state==="completed"?"completed":result.state==="cancelled"?"cancelled":result.state==="interrupted"?"interrupted_unknown":"failed");
      const text=result.text.slice(0,32_000);job.socket.send({type:"conversation.item.create",item:{type:"function_call_output",call_id:request.callId,
        output:JSON.stringify({state:result.state,text,...(result.text.length>text.length?{truncated:true}:{})})}});this.requestResponse(job,turnId,true);this.emit(job.id);
    }catch{
      if(!accepted){try{accepted=this.host.lookup(request);if(accepted)this.repository.realtime.linkCall(turnId,accepted);}catch{/* A failed read-only reconciliation never dispatches. */}}
      this.repository.realtime.settleCall(turnId,"interrupted_unknown");if(!job.closed)await this.finish(job,"interrupted_unknown","VOICE_REQUEST_UNKNOWN");
    }
  }
  playbackAck(input:RealtimePlaybackAck):void{
    const parsed=realtimePlaybackSchema.parse(input),job=this.job(parsed),saved=this.repository.realtime.internal(job.id).session,audio=job.audio.get(audioKey(parsed.responseId,parsed.itemId,parsed.contentIndex));
    if(!audio||parsed.playbackEpoch!==saved.playbackEpoch||audio.epoch!==parsed.playbackEpoch||parsed.playedSamples<audio.played||parsed.playedSamples>audio.received)throw new AevorenBotError("VOICE_RESPONSE_INVALID");
    audio.played=parsed.playedSamples;this.repository.realtime.setSession(job.id,{responseId:audio.responseId,itemId:audio.itemId,contentIndex:audio.contentIndex,receivedSamples:audio.received,playedSamples:audio.played});
  }
  interrupt(input:RealtimePlaybackAck):RealtimeSnapshot{
    const parsed=realtimePlaybackSchema.parse(input);this.playbackAck(parsed);const job=this.job(parsed),saved=this.repository.realtime.internal(job.id).session;
    if(saved.state==="interrupting")throw new AevorenBotError("VOICE_CAPTURE_INVALID");
    this.repository.realtime.setSession(job.id,{state:"interrupting",playbackEpoch:saved.playbackEpoch+1});
    for(const [responseId,response] of job.responses){if(!response.done){job.pendingCancel.add(responseId);job.interrupted.add(responseId);job.socket.send({type:"response.cancel",response_id:responseId});}}
    for(const audio of job.audio.values()){
      job.interrupted.add(audio.responseId);if(audio.received<=audio.played)continue;
      const end=Math.floor(audio.played*1000/24_000);job.pendingTruncates.set(`${audio.itemId}:${audio.contentIndex}`,end);
      job.socket.send({type:"conversation.item.truncate",item_id:audio.itemId,content_index:audio.contentIndex,audio_end_ms:end});
    }
    job.audio.clear();job.interruptTimer=setTimeout(()=>{void this.finish(job,"interrupted_unknown","VOICE_REQUEST_UNKNOWN");},5_000);this.finishInterrupt(job);this.emit(job.id);return this.snapshot({sessionId:parsed.sessionId,id:parsed.id});
  }
  private finishInterrupt(job:Job):void{
    if(job.closed||job.pendingCancel.size||job.pendingTruncates.size)return;
    const saved=this.repository.realtime.internal(job.id).session;if(saved.state!=="interrupting")return;
    clearTimeout(job.interruptTimer);if(saved.currentTurnId&&this.repository.realtime.turn(saved.currentTurnId).state!=="delegating")this.repository.realtime.setTurn(saved.currentTurnId,"cancelled");
    this.repository.realtime.setSession(job.id,{state:saved.currentTurnId&&this.repository.realtime.turn(saved.currentTurnId).state==="delegating"?"delegating":"ready",responseId:null,itemId:null,contentIndex:null,receivedSamples:0,playedSamples:0});
    for(const resolve of this.interruptWaiters.get(job.id)??[])resolve();this.emit(job.id);
  }
  private waitForInterrupt(job:Job):Promise<void>{
    if(this.repository.realtime.internal(job.id).session.state!=="interrupting")return Promise.resolve();
    return new Promise((resolve,reject)=>{const waiters=this.interruptWaiters.get(job.id)??new Set<()=>void>();
      const finish=():void=>{waiters.delete(ready);job.signal.removeEventListener("abort",abort);};const ready=():void=>{finish();resolve();};
      const abort=():void=>{finish();reject(new AevorenBotError("TOOL_EXECUTION_CANCELLED"));};waiters.add(ready);this.interruptWaiters.set(job.id,waiters);
      job.signal.addEventListener("abort",abort,{once:true});if(job.signal.aborted)abort();});
  }
  async stop(input:RealtimeInput,context:VoiceContext={}):Promise<RealtimeSnapshot>{
    const parsed=realtimeInputSchema.parse(input);this.repository.realtime.access(parsed,context);const job=this.jobs.get(parsed.id);if(job)await this.finish(job,"stopped",null);return this.snapshot(parsed,context);
  }
  async stopTask(input:RealtimeInput,context:VoiceContext={}):Promise<RealtimeSnapshot>{
    const parsed=realtimeInputSchema.parse(input),record=this.repository.realtime.access(parsed,context),job=this.jobs.get(parsed.id);if(job)job.cancelBusiness=true;
    const link=record.session.linkedTask;if(link)await this.host.cancel(link);
    if(job)await this.finish(job,"stopped",null);return this.snapshot(parsed,context);
  }
  private track(job:Job,work:Promise<unknown>):void{job.pending.add(work);void work.finally(()=>{job.pending.delete(work);if(job.closed&&!job.pending.size)this.jobs.delete(job.id);}).catch(()=>{});}
  private async finish(job:Job,state:"stopped"|"failed"|"interrupted_unknown",code:string|null):Promise<void>{
    if(job.closed)return;job.closed=true;job.ready=false;clearTimeout(job.deadline);clearTimeout(job.interruptTimer);clearInterval(job.guard);
    try{
      const saved=this.repository.realtime.internal(job.id).session;
      if(saved.currentTurnId){const turn=this.repository.realtime.turn(saved.currentTurnId);if(!["completed","failed","cancelled","interrupted_unknown"].includes(turn.state))this.repository.realtime.setTurn(turn.id,this.repository.realtime.call(turn.id)?"interrupted_unknown":"cancelled");}
      this.repository.realtime.setSession(job.id,{state,lastErrorCode:code,playbackEpoch:saved.playbackEpoch+1});this.emit(job.id);
    }catch(error){if(!(error instanceof AevorenBotError&&error.code==="VOICE_TASK_NOT_FOUND"))throw error;}
    finally{job.controller.abort();job.audio.clear();this.earlyAsr.delete(job.id);this.interruptWaiters.delete(job.id);await job.socket.close();if(!job.pending.size)this.jobs.delete(job.id);}
  }
  configurationChanged():void{for(const job of this.jobs.values())if(!job.closed){try{this.check(job);}catch{void this.finish(job,"stopped","VOICE_CONFIGURATION_CONFLICT");}}}
  sessionChanged(sessionId:string,generation:number):void{for(const job of this.jobs.values()){
    try{const saved=this.repository.realtime.internal(job.id).session;if(saved.sessionId===sessionId&&saved.inputGeneration!==generation)void this.finish(job,"stopped","VOICE_NOT_GRANTED");}
    catch{void this.finish(job,"stopped","VOICE_NOT_GRANTED");}
  }}
  async stopAll():Promise<void>{await Promise.all([...this.jobs.values()].filter(job=>!job.closed).map(job=>this.finish(job,"stopped",null)));}
  async shutdown():Promise<void>{await this.stopAll();this.closed=true;await Promise.allSettled([...this.jobs.values()].flatMap(job=>[...job.pending]));this.jobs.clear();}
}
