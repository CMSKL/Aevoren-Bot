import { randomUUID } from "node:crypto";
import type { MediaItem, MediaReadInput, MediaChangedEvent } from "@shared/media-contracts";
import type { VoiceAudio, VoiceConfigurationSave, VoiceEvent, VoiceSpeechInput, VoiceTask, VoiceTaskInput, VoiceTaskListInput, VoiceTranscribeInput } from "@shared/voice-contracts";
import { VOICE_AUDIO_MAX_BYTES, VOICE_TEXT_MAX_CHARACTERS, voiceSpeechSchema, voiceTaskListSchema, voiceTaskSchema, voiceTranscribeSchema } from "@shared/voice-schemas";
import type { AppRepository } from "./database";
import { digestMessage } from "./database";
import { AevorenBotError } from "./errors";
import { MediaBlobStore, mediaBytesDigest, assertMediaNotCancelled } from "./media-blob-store";
import { VoiceHttpAdapter, VoiceHttpError, type VoiceFetch } from "./voice-http-adapter";
import { VoiceSettings } from "./voice-settings";
import { voiceDigest, type InternalVoiceTask, type VoiceContext } from "./voice-repository";
import type { SecretCodec } from "./settings";

export type VoiceExecutionContext = VoiceContext;
export type VoiceMediaReader = { readBinary(input:MediaReadInput,context?:VoiceContext):Promise<{item:MediaItem;bytes:Uint8Array;isAuthorized():boolean}> };
type Job = { id:string;kind:"stt"|"tts";context:VoiceContext;controller:AbortController;signal:AbortSignal;completion:Promise<VoiceTask> };
const terminal=(task:VoiceTask):boolean=>!["prepared","running"].includes(task.state);
export class VoiceService {
  private readonly settings:VoiceSettings;
  private readonly adapter:VoiceHttpAdapter;
  private readonly blobs:MediaBlobStore;
  private readonly jobs=new Map<string,Job>();
  private readonly lifetime=new AbortController();
  private closing:Promise<void>|undefined;
  constructor(private readonly repository:AppRepository,codec:SecretCodec,private readonly mediaReader:VoiceMediaReader,blobRoot:string,
    private readonly options:{onChanged?:(event:VoiceEvent)=>void;onConfigurationChanged?():void;fetch?:VoiceFetch}={}){
    this.settings=new VoiceSettings(repository.voice,codec);this.adapter=new VoiceHttpAdapter(options.fetch);this.blobs=new MediaBlobStore(blobRoot);
    repository.voice.recoverInterrupted();
  }
  configurations(){return this.settings.configurations();}
  saveConfiguration(input:VoiceConfigurationSave){
    assertMediaNotCancelled(this.lifetime.signal);const result=this.settings.save(input);
    for(const job of this.jobs.values())if(job.kind===result.kind)this.cancelJob(job,"VOICE_CONFIGURATION_CONFLICT");
    if(result.kind==="realtime")this.options.onConfigurationChanged?.();return result;
  }
  private check(sessionId:string,context:VoiceContext):void {
    assertMediaNotCancelled(this.lifetime.signal);assertMediaNotCancelled(context.signal);this.repository.voice.assertScope(sessionId,context);
  }
  private emit(task:VoiceTask,delta?:string):void {this.options.onChanged?.({task,...(delta!==undefined?{delta}:{})});}
  private intent(kind:VoiceTask["kind"],input:VoiceTranscribeInput|VoiceSpeechInput,source:unknown,context:VoiceContext):string {
    return voiceDigest({kind,sessionId:input.sessionId,generation:this.repository.getSession(input.sessionId).generation,executorBotId:context.executorBotId??null,runtimeRunId:context.runtimeRunId??null,
      configurationVersion:input.expectedConfigVersion,source,capture:"capture" in input?input.capture??null:null});
  }
  private duplicate(input:VoiceTranscribeInput|VoiceSpeechInput,digest:string,context:VoiceContext):VoiceTask|null {
    const existing=this.repository.voice.findNonce(input.clientNonce);if(!existing)return null;
    if(existing.intentDigest!==digest)throw new AevorenBotError("VOICE_NONCE_CONFLICT");return this.get({sessionId:input.sessionId,id:existing.task.id},context);
  }
  private assertSource(record:InternalVoiceTask):void {
    const {task}=record;
    if(task.source.kind==="media"){
      const captured=this.repository.media.captureSendReferences(task.sessionId,[task.source.reference],task.executorBotId??undefined)[0];
      if(!captured||captured.incarnation!==record.sourceIncarnation)throw new AevorenBotError("VOICE_NOT_GRANTED");
    }else if(task.source.kind==="entry"){
      let entry;try{entry=this.repository.getTranscriptEntry(task.source.entryId);}catch{throw new AevorenBotError("VOICE_SOURCE_CHANGED");}
      if(entry.sessionId!==task.sessionId||entry.generation!==task.inputGeneration||entry.role!=="assistant"||entry.status!=="completed"||digestMessage(entry.body)!==task.source.digest)
        throw new AevorenBotError("VOICE_SOURCE_CHANGED");
    }else if(!record.sourceText||voiceDigest(record.sourceText)!==task.source.digest)throw new AevorenBotError("VOICE_SOURCE_CHANGED");
  }
  get(input:VoiceTaskInput,context:VoiceContext={}):VoiceTask {
    const parsed=voiceTaskSchema.parse(input);this.check(parsed.sessionId,context);const record=this.repository.voice.access(parsed.sessionId,parsed.id,context);this.assertSource(record);return record.task;
  }
  list(input:VoiceTaskListInput,context:VoiceContext={}):VoiceTask[]{
    const parsed=voiceTaskListSchema.parse(input);this.check(parsed.sessionId,context);
    return this.repository.voice.list(parsed.sessionId,parsed.limit,context).flatMap(record=>{try{this.assertSource(record);return [record.task];}catch{return [];}});
  }
  async transcribe(input:VoiceTranscribeInput,context:VoiceContext={}):Promise<VoiceTask>{
    const parsed=voiceTranscribeSchema.parse(input);this.check(parsed.sessionId,context);
    const generation=this.repository.getSession(parsed.sessionId).generation;
    const source={kind:"media" as const,reference:parsed.media},digest=this.intent("transcription",parsed,source,context),old=this.duplicate(parsed,digest,context);if(old)return old;
    const auth=this.settings.credentials("stt",parsed.expectedConfigVersion);
    const media=await this.mediaReader.readBinary({sessionId:parsed.sessionId,id:parsed.media.mediaId,reference:parsed.media},context);this.check(parsed.sessionId,context);
    if(this.repository.getSession(parsed.sessionId).generation!==generation)throw new AevorenBotError("VOICE_NOT_GRANTED");
    if(!media.isAuthorized())throw new AevorenBotError("VOICE_NOT_GRANTED");
    if(!/^(?:audio|video)\//u.test(media.item.asset.reference.mimeType))throw new AevorenBotError("VOICE_UNSUPPORTED");
    if(media.bytes.byteLength<1||media.bytes.byteLength>VOICE_AUDIO_MAX_BYTES)throw new AevorenBotError("VOICE_TOO_LARGE");
    if(media.item.reference.sha256!==parsed.media.sha256||mediaBytesDigest(media.bytes)!==parsed.media.sha256)throw new AevorenBotError("VOICE_SOURCE_CHANGED");
    const admission=this.repository.media.captureSendReferences(parsed.sessionId,[parsed.media],context.executorBotId)[0]!;
    this.settings.credentials("stt",auth.configuration.version);
    const prepared=this.repository.voice.prepare({sessionId:parsed.sessionId,kind:"transcription",clientNonce:parsed.clientNonce,intentDigest:digest,source,capture:parsed.capture,
      configuration:auth.configuration,sourceIncarnation:admission.incarnation},context);
    if(!prepared.created)return this.get({sessionId:parsed.sessionId,id:prepared.record.task.id},context);
    return this.start(prepared.record,"stt",context,async check=>({transcript:await this.adapter.transcribe({apiKey:auth.apiKey,model:auth.configuration.model,bytes:media.bytes,
      mimeType:media.item.asset.reference.mimeType,name:media.item.asset.reference.name,signal:check.signal,assertCurrent:()=>{check.current();if(!media.isAuthorized())throw new AevorenBotError("VOICE_NOT_GRANTED");},
      onDelta:delta=>{check.current();this.emit(this.repository.voice.internal(prepared.record.task.id).task,delta);}})}));
  }
  async speak(input:VoiceSpeechInput,context:VoiceContext={}):Promise<VoiceTask>{
    const parsed=voiceSpeechSchema.parse(input);this.check(parsed.sessionId,context);
    const source="entryId" in parsed.source?{kind:"entry" as const,entryId:parsed.source.entryId,digest:parsed.source.digest}:{kind:"text" as const,digest:voiceDigest(parsed.source.text)};
    const digest=this.intent("speech",parsed,source,context),old=this.duplicate(parsed,digest,context);if(old)return old;
    const auth=this.settings.credentials("tts",parsed.expectedConfigVersion);let text:string;
    if("text" in parsed.source)text=parsed.source.text;else{
      const entry=this.repository.getTranscriptEntry(parsed.source.entryId);
      if(entry.sessionId!==parsed.sessionId||entry.generation!==this.repository.getSession(parsed.sessionId).generation||entry.role!=="assistant"||entry.status!=="completed"||digestMessage(entry.body)!==parsed.source.digest)
        throw new AevorenBotError("VOICE_SOURCE_CHANGED");text=entry.body;
    }
    if(!text.trim()||text.length>VOICE_TEXT_MAX_CHARACTERS)throw new AevorenBotError("VOICE_TOO_LARGE");
    const prepared=this.repository.voice.prepare({sessionId:parsed.sessionId,kind:"speech",clientNonce:parsed.clientNonce,intentDigest:digest,source,configuration:auth.configuration,sourceText:text},context);
    if(!prepared.created)return this.get({sessionId:parsed.sessionId,id:prepared.record.task.id},context);
    return this.start(prepared.record,"tts",context,async check=>{
      const bytes=await this.adapter.speak({apiKey:auth.apiKey,model:auth.configuration.model,voice:auth.configuration.voice,text,signal:check.signal,assertCurrent:check.current});check.current();
      const sha256=await this.blobs.put(bytes,check.signal);check.current();
      return {audio:{id:randomUUID(),name:`speech-${prepared.record.task.id}.wav`,mimeType:"audio/wav",size:bytes.length,sha256}};
    });
  }
  private start(record:InternalVoiceTask,kind:"stt"|"tts",context:VoiceContext,work:(check:{signal:AbortSignal;current():void})=>Promise<Parameters<AppRepository["voice"]["complete"]>[1]>):VoiceTask{
    const task=record.task;this.emit(task);
    if(!this.repository.voice.dispatch(task.id,task.version))return this.get({sessionId:task.sessionId,id:task.id},context);
    const controller=new AbortController(),signal=AbortSignal.any([this.lifetime.signal,controller.signal,...(context.signal?[context.signal]:[])]);
    const current=():void=>{
      assertMediaNotCancelled(signal);this.check(task.sessionId,context);
      const now=this.repository.voice.access(task.sessionId,task.id,context);if(now.task.state!=="running")throw new AevorenBotError("VOICE_NOT_GRANTED");
      this.assertSource(now);const configuration=this.repository.voice.configuration(kind).configuration;
      if(configuration.version!==task.configurationVersion||!configuration.enabled)throw new AevorenBotError("VOICE_CONFIGURATION_CONFLICT");
    };
    const completion=Promise.resolve().then(async()=>{
      try {current();const output=await work({signal,current});current();const finished=this.repository.voice.complete(task.id,output);this.emit(finished);return finished;}
      catch(error){
        const now=this.repository.voice.internal(task.id).task;if(terminal(now))return now;
        const revoked=signal.aborted||error instanceof AevorenBotError&&["VOICE_NOT_GRANTED","VOICE_SOURCE_CHANGED","VOICE_CONFIGURATION_CONFLICT","MEDIA_NOT_GRANTED","TOOL_EXECUTION_CANCELLED","INVALID_REQUEST"].includes(error.code);
        const unknown=!revoked&&(error instanceof VoiceHttpError?error.unknownOutcome:!(error instanceof AevorenBotError));
        const code=revoked?"TOOL_EXECUTION_CANCELLED":unknown?"VOICE_REQUEST_UNKNOWN":error instanceof AevorenBotError?error.code:"VOICE_REQUEST_FAILED";
        const finished=this.repository.voice.settle(task.id,revoked?"cancelled":unknown?"interrupted_unknown":"failed",code);this.emit(finished);return finished;
      }
    });
    const job:Job={id:task.id,kind,context,controller,signal,completion};this.jobs.set(task.id,job);
    void completion.finally(()=>{if(this.jobs.get(task.id)===job)this.jobs.delete(task.id);}).catch(()=>{});
    const running=this.repository.voice.internal(task.id).task;this.emit(running);return running;
  }
  /** Internal model/host wait. Looking up an old task never dispatches another request. */
  async wait(input:VoiceTaskInput,context:VoiceContext={}):Promise<VoiceTask>{
    const initial=this.get(input,context);if(terminal(initial))return initial;const job=this.jobs.get(initial.id);
    if(!job)throw new AevorenBotError("VOICE_REQUEST_UNKNOWN");
    let abort:(()=>void)|undefined;
    try{
      await Promise.race([job.completion,new Promise<never>((_resolve,reject)=>{
        abort=()=>reject(new AevorenBotError("TOOL_EXECUTION_CANCELLED"));context.signal?.addEventListener("abort",abort,{once:true});if(context.signal?.aborted)abort();
      })]);return this.get(input,context);
    }finally{if(abort)context.signal?.removeEventListener("abort",abort);}
  }
  private cancelJob(job:Job,code:string):VoiceTask {
    const result=this.repository.voice.settle(job.id,"cancelled",code),safe={...result,transcript:null,audio:null};job.controller.abort();this.emit(safe);return safe;
  }
  stop(input:VoiceTaskInput,context:VoiceContext={}):VoiceTask{
    const parsed=voiceTaskSchema.parse(input);this.check(parsed.sessionId,context);const record=this.repository.voice.access(parsed.sessionId,parsed.id,context),job=this.jobs.get(parsed.id);
    const result=job?this.cancelJob(job,"TOOL_EXECUTION_CANCELLED"):this.repository.voice.settle(record.task.id,"cancelled","TOOL_EXECUTION_CANCELLED");
    return {...result,transcript:null,audio:null};
  }
  async audio(input:VoiceTaskInput,context:VoiceContext={}):Promise<VoiceAudio>{
    const task=this.get(input,context);if(task.state!=="completed"||!task.audio)throw new AevorenBotError("VOICE_TASK_NOT_FOUND");
    const bytes=await this.blobs.read(task.audio.sha256,task.audio.size,context.signal);const current=this.get(input,context);
    if(current.audio?.sha256!==task.audio.sha256)throw new AevorenBotError("VOICE_SOURCE_CHANGED");return {task:current,reference:task.audio,dataBase64:bytes.toString("base64")};
  }
  mediaChanged(event:MediaChangedEvent):void{
    if(!["unbound","enabled","deleted","restored"].includes(event.action))return;
    for(const job of this.jobs.values()){
      const task=this.repository.voice.internal(job.id).task;
      if(task.source.kind==="media"&&task.source.reference.mediaId===event.mediaId&&(event.action!=="unbound"||task.sessionId===event.sessionId))this.cancelJob(job,"VOICE_NOT_GRANTED");
    }
    for(const task of this.repository.voice.mediaTasks(event.mediaId,event.action==="unbound"?event.sessionId:undefined))
      this.emit({...task,transcript:null,audio:null,lastErrorCode:"VOICE_NOT_GRANTED"});
  }
  sessionChanged(sessionId:string,generation:number):void {
    for(const job of this.jobs.values()){
      const task=this.repository.voice.internal(job.id).task;
      if(task.sessionId===sessionId&&task.inputGeneration!==generation)this.cancelJob(job,"VOICE_SOURCE_CHANGED");
    }
  }
  shutdown():Promise<void>{
    if(!this.closing){for(const job of this.jobs.values())this.cancelJob(job,"APP_INTERRUPTED");this.lifetime.abort();this.closing=Promise.allSettled([...this.jobs.values()].map(job=>job.completion)).then(()=>{});}return this.closing;
  }
}
