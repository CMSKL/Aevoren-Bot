import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it,vi } from "vitest";
import type { VoiceEvent,VoiceTranscribeInput } from "@shared/voice-contracts";
import type { MediaItem } from "@shared/media-contracts";
import type { PromptManifest } from "@shared/contracts";
import { AppRepository,digestMessage } from "./database";
import { VoiceService,type VoiceMediaReader } from "./voice-service";
import { pcmToWav,type VoiceFetch } from "./voice-http-adapter";
import { MediaBlobStore,mediaBytesDigest } from "./media-blob-store";
import { voiceDigest } from "./voice-repository";
const codec={isAvailable:()=>true,encrypt:(value:string)=>Buffer.from(value).toString("base64"),decrypt:(value:string)=>Buffer.from(value,"base64").toString()};
const cleanups:(()=>Promise<void>)[]=[],roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0).reverse())await cleanup();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),"aevoren-voice-service-"));roots.push(root);const filename=join(root,"voice.sqlite"),repository=new AppRepository(filename),owner=repository.createBot();
  let holdStt=false,holdTts=false,omitFinal=false;const requests={stt:0,tts:0},releases:(()=>void)[]=[],events:VoiceEvent[]=[],pcm=Buffer.from([0,0,255,127,0,128]);
  const server=createServer((request,response)=>{void(async()=>{
    const parts:Buffer[]=[];for await(const chunk of request)parts.push(Buffer.from(chunk));
    if(request.url==="/v1/audio/transcriptions"){
      requests.stt+=1;response.writeHead(200,{"content-type":"text/event-stream"});response.write('data: {"type":"transcript.text.delta","delta":"VOICE_PARTIAL"}\n\n');
      const finish=()=>response.end(omitFinal?"":'data: {"type":"transcript.text.done","text":"VOICE_FINAL_TRANSCRIPT"}\n\n');if(holdStt)releases.push(finish);else finish();
    }else if(request.url==="/v1/audio/speech"){
      requests.tts+=1;const finish=()=>{response.writeHead(200,{"content-type":"application/octet-stream"});response.end(pcm);};if(holdTts)releases.push(finish);else finish();
    }else response.writeHead(404).end();
  })().catch(()=>{if(!response.headersSent)response.writeHead(500);response.end();});});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("Fixture missing");
  const fetchFn:VoiceFetch=(url,init)=>fetch(`http://127.0.0.1:${address.port}${url.pathname}`,init);
  const bytes=pcmToWav(pcm),media=repository.media.publishImport(owner.session.id,[{asset:{reference:{id:randomUUID(),name:"owned.wav",size:bytes.length,mimeType:"audio/wav",sha256:mediaBytesDigest(bytes)},kind:"audio" as MediaItem["asset"]["kind"],width:null,height:null},extraction:null}])[0]!;
  const reader:VoiceMediaReader={async readBinary(input,context={}){
    const scope=context.runtimeRunId?{sessionId:input.sessionId,executorBotId:context.executorBotId!,runtimeRunId:context.runtimeRunId}:null;
    const lease=scope?null:repository.media.captureUiLease(input,context.executorBotId);
    const current=()=>scope?repository.media.resolveRuntimeRead(scope,input.id,input.reference):repository.media.resolveUiLease(lease!);const item=current().item;
    return {item,bytes,isAuthorized:()=>{try{current();return true;}catch{return false;}}};
  }};
  const service=new VoiceService(repository,codec,reader,join(root,"audio"),{fetch:fetchFn,onChanged:event=>events.push(event)});
  const configure=(kind:"stt"|"tts",apiKey=`controlled-${kind}`)=>{const current=service.configurations().find(value=>value.kind===kind)!;return service.saveConfiguration({kind,expectedVersion:current.version,enabled:true,model:current.model,voice:current.voice,apiKey});};
  const stt=configure("stt"),tts=configure("tts");
  cleanups.push(async()=>{for(const release of releases.splice(0))release();await service.shutdown();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));repository.close();});
  const transcribe=(extra:Partial<VoiceTranscribeInput>={})=>({sessionId:owner.session.id,clientNonce:randomUUID(),expectedConfigVersion:stt.version,media:media.reference,...extra});
  return {root,filename,repository,service,reader,events,requests,media,bytes,pcm,stt,tts,configure,transcribe,...owner,
    hold(kind:"stt"|"tts"){if(kind==="stt")holdStt=true;else holdTts=true;},omitFinal(){omitFinal=true;},release(){for(const release of releases.splice(0))release();}};
}
describe("owned voice tasks with controlled real HTTP",()=>{
  it("returns a durable ID promptly, emits deltas, and reuses the terminal nonce without another upload",async()=>{
    const f=await fixture(),capture={captureId:randomUUID(),draftVersion:7,baseDigest:"a".repeat(64)},input=f.transcribe({capture});
    const accepted=await f.service.transcribe(input);expect(accepted.state).toBe("running");expect(f.events[0]?.task).toMatchObject({id:accepted.id,state:"prepared",capture});
    const completed=await f.service.wait({sessionId:f.session.id,id:accepted.id});expect(completed).toMatchObject({state:"completed",transcript:"VOICE_FINAL_TRANSCRIPT",capture,configurationVersion:2});
    expect(f.events.some(event=>event.delta==="VOICE_PARTIAL")).toBe(true);expect(f.requests.stt).toBe(1);
    f.service.saveConfiguration({kind:"stt",expectedVersion:f.stt.version,enabled:false,model:f.stt.model,voice:f.stt.voice,clearApiKey:true});
    expect((await f.service.transcribe(input)).transcript).toBe("VOICE_FINAL_TRANSCRIPT");expect(f.requests.stt).toBe(1);
    await expect(f.service.transcribe({...input,capture:{...capture,draftVersion:8}})).rejects.toMatchObject({code:"VOICE_NONCE_CONFLICT"});
    const other=f.repository.createBot();expect(()=>f.service.get({sessionId:other.session.id,id:accepted.id})).toThrowError(expect.objectContaining({code:"VOICE_NOT_GRANTED"}));
  });
  it("stores a private exact assistant snapshot and exposes genuine WAV bytes only while its source is unchanged",async()=>{
    const f=await fixture(),entry=f.repository.createAssistantEntry(f.session.id),text="PRIVATE_ASSISTANT_SPEECH";f.repository.updateTranscriptEntry(entry.id,text,"completed");
    const accepted=await f.service.speak({sessionId:f.session.id,clientNonce:randomUUID(),expectedConfigVersion:f.tts.version,source:{entryId:entry.id,digest:digestMessage(text)}});
    const completed=await f.service.wait({sessionId:f.session.id,id:accepted.id}),audio=await f.service.audio({sessionId:f.session.id,id:accepted.id});
    expect(JSON.stringify(completed)).not.toContain(text);const bytes=Buffer.from(audio.dataBase64,"base64");expect(bytes.subarray(44)).toEqual(f.pcm);expect(audio.reference.sha256).toBe(mediaBytesDigest(bytes));
    f.service.saveConfiguration({kind:"tts",expectedVersion:f.tts.version,enabled:false,model:f.tts.model,voice:"coral",clearApiKey:true});
    expect((await f.service.audio({sessionId:f.session.id,id:accepted.id})).reference).toEqual(audio.reference);
    f.repository.updateTranscriptEntry(entry.id,"changed source","completed");await expect(f.service.audio({sessionId:f.session.id,id:accepted.id})).rejects.toMatchObject({code:"VOICE_SOURCE_CHANGED"});
    expect(f.service.list({sessionId:f.session.id})).toEqual([]);expect(f.requests.tts).toBe(1);
  });
  it("revokes an inflight transcript and never revives its old result or nonce after media rebind",async()=>{
    const f=await fixture();f.hold("stt");const input=f.transcribe(),accepted=await f.service.transcribe(input);await vi.waitFor(()=>expect(f.requests.stt).toBe(1));
    f.repository.media.unbind({sessionId:f.session.id,id:f.media.asset.reference.id});f.service.mediaChanged({sessionId:f.session.id,mediaId:f.media.asset.reference.id,action:"unbound"});
    expect(f.repository.voice.internal(accepted.id).task.state).toBe("cancelled");f.release();await vi.waitFor(()=>expect(f.events.some(event=>event.task.id===accepted.id&&event.task.state==="cancelled")).toBe(true));
    f.repository.media.bind({sessionId:f.session.id,id:f.media.asset.reference.id});expect(()=>f.service.get({sessionId:f.session.id,id:accepted.id})).toThrow();
    await expect(f.service.transcribe(input)).rejects.toThrow();expect(f.service.list({sessionId:f.session.id})).toEqual([]);expect(f.requests.stt).toBe(1);
    expect(f.events.filter(event=>event.task.id===accepted.id).at(-1)?.task.transcript).toBeNull();
  });
  it("changing only STT configuration cancels STT and leaves the concurrent TTS job alive",async()=>{
    const f=await fixture();f.hold("stt");f.hold("tts");const input=f.transcribe(),stt=await f.service.transcribe(input),tts=await f.service.speak({sessionId:f.session.id,clientNonce:randomUUID(),expectedConfigVersion:f.tts.version,source:{text:"concurrent speech"}});
    await vi.waitFor(()=>expect(f.requests).toEqual({stt:1,tts:1}));f.configure("stt","replacement-controlled-key");
    expect(f.repository.voice.internal(stt.id).task.state).toBe("cancelled");expect(f.repository.voice.internal(tts.id).task.state).toBe("running");f.release();
    expect((await f.service.wait({sessionId:f.session.id,id:tts.id})).state).toBe("completed");expect((await f.service.transcribe(input)).state).toBe("cancelled");expect(f.requests).toEqual({stt:1,tts:1});
  });
  it("keeps incomplete SSE explicitly unknown and does not upload again on a repeat call",async()=>{
    const f=await fixture();f.omitFinal();const input=f.transcribe(),accepted=await f.service.transcribe(input),finished=await f.service.wait({sessionId:f.session.id,id:accepted.id});
    expect(finished).toMatchObject({state:"interrupted_unknown",transcript:null,lastErrorCode:"VOICE_REQUEST_UNKNOWN"});expect((await f.service.transcribe(input)).state).toBe("interrupted_unknown");expect(f.requests.stt).toBe(1);
  });
  it("does not move delayed media preparation into a newly cleared conversation generation",async()=>{
    const f=await fixture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const reader:VoiceMediaReader={async readBinary(input,context){const value=await f.reader.readBinary(input,context);entered();await gate;return value;}};
    const service=new VoiceService(f.repository,codec,reader,join(f.root,"late-audio"),{fetch:async()=>{throw new Error("Unexpected delayed upload");}});cleanups.push(()=>service.shutdown());
    const input=f.transcribe(),pending=service.transcribe(input);await started;f.repository.clearConversation(f.session.id);release();
    await expect(pending).rejects.toMatchObject({code:"VOICE_NOT_GRANTED"});expect(f.repository.voice.findNonce(input.clientNonce)).toBeNull();expect(f.requests.stt).toBe(0);
  });
  it("keeps completed transcripts source-bound across a real reopen and does not leak them through Stop",async()=>{
    const f=await fixture(),accepted=await f.service.transcribe(f.transcribe());await f.service.wait({sessionId:f.session.id,id:accepted.id});
    const reopened=new AppRepository(f.filename),service=new VoiceService(reopened,codec,{readBinary:async()=>{throw new Error("Unexpected completed-task upload");}},join(f.root,"reopened-audio"));
    cleanups.push(async()=>{await service.shutdown();reopened.close();});expect(service.get({sessionId:f.session.id,id:accepted.id}).transcript).toBe("VOICE_FINAL_TRANSCRIPT");
    reopened.media.unbind({sessionId:f.session.id,id:f.media.asset.reference.id});reopened.media.bind({sessionId:f.session.id,id:f.media.asset.reference.id});
    expect(()=>service.get({sessionId:f.session.id,id:accepted.id})).toThrow();expect(service.list({sessionId:f.session.id})).toEqual([]);
    expect(service.stop({sessionId:f.session.id,id:accepted.id})).toMatchObject({transcript:null,audio:null});expect(f.requests.stt).toBe(1);
  });
  it("starts six member cloud jobs before any finishes and stopping one preserves all five siblings",async()=>{
    const f=await fixture(),members=[f.bot,...Array.from({length:5},()=>f.repository.createBot().bot)],room=f.repository.createRoom({memberBotIds:members.map(bot=>bot.id),leadBotId:null});f.hold("tts");
    const casFailures:string[]=[],put=MediaBlobStore.prototype.put;const probe=vi.spyOn(MediaBlobStore.prototype,"put").mockImplementation(async function(this:MediaBlobStore,bytes,signal){try{return await put.call(this,bytes,signal);}catch(error){casFailures.push(error instanceof Error&&"code" in error?String(error.code):"UNCLASSIFIED_LOCAL");throw error;}});
    const batch=f.repository.createRoomRunWithInitialTurns({roomId:room.room.id,sessionId:room.session.id,clientNonce:randomUUID(),text:"parallel speech",membershipVersion:room.room.membershipVersion,maxTurns:6,maxHops:0,maxTargetsPerTurn:6,
      deadlineAt:new Date(Date.now()+60_000).toISOString(),initialTurns:members.map(bot=>({agentId:bot.id,nonce:randomUUID()})),routingMode:"everyone",orchestrationEnabled:false});f.repository.transitionRoomBatch(batch.run.id,"running");
    const contexts=batch.turns.map(original=>{const turn=f.repository.transitionRoomTurn(original.id,"running",{promptCutoffSeq:original.inputSeq});
      const manifest:PromptManifest={schemaVersion:2,botId:turn.memberBotId,profileVersion:1,sessionId:room.session.id,generation:turn.inputGeneration,inputSeq:turn.inputSeq,promptCutoffSeq:turn.inputSeq,roomId:room.room.id,roomMembershipVersion:batch.run.membershipVersion,executorBotId:turn.memberBotId,sourceTurnId:turn.id,blocks:[],digest:"voice-six"};
      const runtime=f.repository.createRuntimeRun(batch.run.clientNonce,"fake",manifest,{executorBotId:turn.memberBotId,executionKey:`${batch.run.id}:${turn.logicalTurnId}`});f.repository.attachRoomTurnRuntime(turn.id,runtime.id);return {executorBotId:turn.memberBotId,runtimeRunId:runtime.id};});
    const tasks=await Promise.all(contexts.map((context,index)=>f.service.speak({sessionId:room.session.id,clientNonce:randomUUID(),expectedConfigVersion:f.tts.version,source:{text:`member ${index}`}},context)));
    await vi.waitFor(()=>expect(f.requests.tts).toBe(6));expect(tasks.every(task=>f.repository.voice.internal(task.id).task.state==="running")).toBe(true);
    f.service.stop({sessionId:room.session.id,id:tasks[0]!.id},contexts[0]);f.release();
    const rest=await Promise.all(tasks.slice(1).map((task,index)=>f.service.wait({sessionId:room.session.id,id:task.id},contexts[index+1])));probe.mockRestore();expect({states:rest.map(task=>({state:task.state,error:task.lastErrorCode})),casFailures}).toEqual({states:Array.from({length:5},()=>({state:"completed",error:null})),casFailures:[]});
    expect(f.repository.voice.internal(tasks[0]!.id).task.state).toBe("cancelled");expect(f.requests.tts).toBe(6);
    expect(()=>f.service.get({sessionId:room.session.id,id:tasks[1]!.id},contexts[2])).toThrowError(expect.objectContaining({code:"VOICE_NOT_GRANTED"}));
  });
  it("reopens a running durable intent as unknown without cloud replay",async()=>{
    const root=mkdtempSync(join(tmpdir(),"aevoren-voice-restart-"));roots.push(root);const filename=join(root,"app.sqlite"),repository=new AppRepository(filename),owner=repository.createBot(),nonce=randomUUID(),text="restart source";
    const configuration=repository.voice.configuration("tts").configuration,source={kind:"text" as const,digest:voiceDigest(text)},digest=voiceDigest({kind:"speech",sessionId:owner.session.id,generation:1,executorBotId:null,runtimeRunId:null,configurationVersion:configuration.version,source,capture:null});
    const created=repository.voice.prepare({sessionId:owner.session.id,kind:"speech",clientNonce:nonce,intentDigest:digest,source,sourceText:text,configuration});repository.voice.dispatch(created.record.task.id,1);repository.close();
    const reopened=new AppRepository(filename),fetchFn=vi.fn(async()=>{throw new Error("Unexpected replay");}),service=new VoiceService(reopened,codec,{readBinary:async()=>{throw new Error("Unexpected media read");}},join(root,"audio"),{fetch:fetchFn});
    cleanups.push(async()=>{await service.shutdown();reopened.close();});
    expect((await service.speak({sessionId:owner.session.id,clientNonce:nonce,expectedConfigVersion:configuration.version,source:{text}})).state).toBe("interrupted_unknown");expect(fetchFn).not.toHaveBeenCalled();
  });
});
