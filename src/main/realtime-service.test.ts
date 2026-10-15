import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach,describe,expect,it,vi } from "vitest";
import { WebSocket,WebSocketServer } from "ws";
import type { RealtimeEvent,RealtimeStartInput,RealtimeTaskLink } from "@shared/realtime-contracts";
import { AppRepository } from "./database";
import { RealtimeService,type RealtimeHost } from "./realtime-service";
import type { RealtimeDispatchRequest } from "./realtime-business-host";
import { VoiceSettings } from "./voice-settings";
import { voiceDigest } from "./voice-repository";
import { REALTIME_DELEGATE_NAME } from "./realtime-protocol";

const codec={isAvailable:()=>true,encrypt:(value:string)=>Buffer.from(value).toString("base64"),decrypt:(value:string)=>Buffer.from(value,"base64").toString()};
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
type ClientMessage={type:string;[key:string]:unknown};
async function fixture(){
  const repository=new AppRepository(":memory:"),owner=repository.createBot(),events:RealtimeEvent[]=[],requests:RealtimeDispatchRequest[]=[],cancelled:RealtimeTaskLink[]=[],messages:ClientMessage[]=[],peers:WebSocket[]=[];
  const server=createServer(),wsServer=new WebSocketServer({server});let holdBusiness=false;const completions:Array<()=>void>=[];
  const settings=new VoiceSettings(repository.voice,codec);settings.save({kind:"realtime",expectedVersion:1,enabled:true,model:"gpt-realtime-2.1-mini",voice:"marin",apiKey:"CONTROLLED_REALTIME_KEY"});
  wsServer.on("connection",(peer,request)=>{
    peers.push(peer);expect(request.headers.authorization).toBe("Bearer CONTROLLED_REALTIME_KEY");peer.send(JSON.stringify({type:"session.created",session:{id:`sess_${peers.length}`,type:"realtime",model:"gpt-realtime-2.1-mini"}}));
    peer.on("message",data=>{const event=JSON.parse(data.toString()) as ClientMessage;messages.push(event);
      if(event.type==="session.update")peer.send(JSON.stringify({type:"session.updated",session:{...(event.session as object),id:`sess_${peers.indexOf(peer)+1}`}}));
    });
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("Fixture missing");
  const host:RealtimeHost={
    async dispatch(request,signal){signal.throwIfAborted();requests.push(request);
      repository.prepareMessage({sessionId:request.sessionId,clientNonce:request.clientNonce,text:request.text},{kind:"voice-input",voiceSessionId:request.voiceSessionId,turnId:request.turnId,callId:request.callId,transcriptDigest:voiceDigest(request.text)});
      const bot=repository.getBot(request.executorBotId),run=repository.createRuntimeRun(request.clientNonce,"fake",{schemaVersion:1,botId:bot.id,profileVersion:bot.version,sessionId:request.sessionId,generation:request.inputGeneration,inputSeq:1,blocks:[],digest:"controlled-realtime"});
      repository.transitionRuntimeRun(run.id,"dispatching");repository.transitionRuntimeRun(run.id,"running");return {kind:"runtime",id:run.id};
    },
    lookup(request){const run=repository.getLatestRuntimeRun(request.clientNonce);return run?{kind:"runtime",id:run.id}:null;},
    wait(link,signal){return new Promise((resolve,reject)=>{const abort=()=>reject(new Error("cancelled wait"));signal.addEventListener("abort",abort,{once:true});
      const done=()=>{signal.removeEventListener("abort",abort);if(signal.aborted)return;repository.transitionRuntimeRun(link.id,"completed");resolve({state:"completed",text:"ACTUAL_CONTROLLED_RUNTIME_RESULT"});};if(holdBusiness)completions.push(done);else done();});},
    cancel(link){cancelled.push(link);const run=repository.getRuntimeRun(link.id);if(["running","streaming"].includes(run.state)){repository.transitionRuntimeRun(link.id,"cancel-requested");repository.transitionRuntimeRun(link.id,"cancelled");}}
  };
  const options={onEvent:(event:RealtimeEvent)=>events.push(event),socketFactory:(url:URL,options:import("ws").ClientOptions)=>{expect(url.href).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini");expect(options.followRedirects).toBe(false);return new WebSocket(`ws://127.0.0.1:${address.port}`,options);}};
  const service=new RealtimeService(repository,codec,host,options);cleanups.push(async()=>{await service.shutdown();for(const peer of peers)peer.terminate();await new Promise<void>(resolve=>wsServer.close(()=>resolve()));server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));repository.close();});
  async function start(created=owner){const input:RealtimeStartInput={sessionId:created.session.id,executorBotId:created.bot.id,expectedConfigVersion:2,routingMode:"automatic",targetBotIds:[]},controller=new AbortController(),captureId=randomUUID();let allowed=true;
    const snapshot=await service.start(input,{captureId,signal:controller.signal,assertCurrent:()=>{if(!allowed)throw new Error("capture revoked");}});expect(snapshot.session.state).toBe("connecting");
    await vi.waitFor(()=>expect(service.snapshot({sessionId:input.sessionId,id:snapshot.session.id}).session.state).toBe("ready"));
    return {input,scope:{sessionId:input.sessionId,id:snapshot.session.id},captureId,controller,revoke:()=>{allowed=false;},peer:peers.at(-1)!};}
  async function send(peer:WebSocket,event:unknown){await new Promise<void>((resolve,reject)=>peer.send(JSON.stringify(event),error=>error?reject(error):resolve()));}
  async function commit(value:Awaited<ReturnType<typeof start>>,text="实际用户请求",sequence=0,early=false){
    service.append({...value.scope,captureId:value.captureId,sequence,dataBase64:Buffer.alloc(4800).toString("base64")});const snapshot=service.commitTurn({...value.scope,captureId:value.captureId,lastSequence:sequence}),turnId=snapshot.session.currentTurnId!,itemId=`input_${turnId}`;
    if(early)await send(value.peer,{type:"conversation.item.input_audio_transcription.completed",item_id:itemId,transcript:text});
    await send(value.peer,{type:"input_audio_buffer.committed",item_id:itemId});if(!early)await send(value.peer,{type:"conversation.item.input_audio_transcription.completed",item_id:itemId,transcript:text});
    await vi.waitFor(()=>expect(messages.some(event=>event.type==="response.create"&&(event.response as {metadata?:{aevoren_turn_id?:string}}).metadata?.aevoren_turn_id===turnId)).toBe(true));return turnId;
  }
  async function response(value:Awaited<ReturnType<typeof start>>,turnId:string,responseId="response_1"){
    await send(value.peer,{type:"response.created",response:{id:responseId,metadata:{aevoren_turn_id:turnId}}});return responseId;
  }
  async function functionDone(value:Awaited<ReturnType<typeof start>>,responseId:string,callId="call_1",args='{"task":"MODEL_ONLY_CREATE_BOT"}'){
    const itemId=`function_${callId}`;await send(value.peer,{type:"response.function_call_arguments.done",response_id:responseId,item_id:itemId,call_id:callId,name:REALTIME_DELEGATE_NAME,arguments:args});
    return {id:itemId,type:"function_call",call_id:callId,name:REALTIME_DELEGATE_NAME,arguments:args,status:"completed"};
  }
  return {repository,owner,service,host,options,start,send,commit,response,functionDone,events,requests,messages,peers,cancelled,hold:()=>{holdBusiness=true;},release:()=>{for(const done of completions.splice(0))done();}};
}
describe("Realtime host transport and ordinary Runtime delegation",()=>{
  it("uses real socket PCM, survives ASR-before-commit ordering and dispatches only the human final text",async()=>{
    const f=await fixture(),live=await f.start(),turn=await f.commit(live,"不要创建 Bot",0,true),response=await f.response(live,turn),call=await f.functionDone(live,response);
    await f.send(live.peer,{type:"response.done",response:{id:response,status:"completed",output:[call]}});
    await vi.waitFor(()=>expect(f.messages.some(event=>event.type==="conversation.item.create")).toBe(true));expect(f.requests).toHaveLength(1);expect(f.requests[0]!.text).toBe("不要创建 Bot");
    expect(f.repository.getUserMessage(f.requests[0]!.clientNonce).body).not.toContain("MODEL_ONLY");
    expect(JSON.stringify(f.service.snapshot(live.scope))).not.toContain("MODEL_ONLY");expect(JSON.stringify(f.events)).not.toContain("CONTROLLED_REALTIME_KEY");
    expect(Buffer.from(String(f.messages.find(event=>event.type==="input_audio_buffer.append")!.audio),"base64")).toEqual(Buffer.alloc(4800));
    const output=(f.messages.find(event=>event.type==="conversation.item.create")!.item as {call_id:string;output:string});expect(output.call_id).toBe("call_1");expect(output.output).toContain("ACTUAL_CONTROLLED_RUNTIME_RESULT");
  });
  it("never dispatches arguments.done when the response is later cancelled",async()=>{
    const f=await fixture(),live=await f.start(),turn=await f.commit(live),response=await f.response(live,turn),call=await f.functionDone(live,response);
    await f.send(live.peer,{type:"response.done",response:{id:response,status:"cancelled",output:[call]}});await vi.waitFor(()=>expect(f.service.snapshot(live.scope).turns[0]!.state).toBe("cancelled"));expect(f.requests).toEqual([]);
  });
  it("deduplicates identical final function events and rejects altered replay",async()=>{
    const f=await fixture();f.hold();const live=await f.start(),turn=await f.commit(live),response=await f.response(live,turn),call=await f.functionDone(live,response);await f.functionDone(live,response);
    const done={type:"response.done",response:{id:response,status:"completed",output:[call]}};await f.send(live.peer,done);await f.send(live.peer,done);await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    await f.send(live.peer,{...done,response:{...done.response,output:[{...call,arguments:'{"task":"CHANGED"}'}]}});
    await vi.waitFor(()=>expect(f.service.snapshot(live.scope).session.state).toBe("interrupted_unknown"));expect(f.requests).toHaveLength(1);
  });
  it("validates global sequence and truncates the actually rendered older queued item at250ms",async()=>{
    const f=await fixture(),live=await f.start(),turn=await f.commit(live),response=await f.response(live,turn);
    for(const item of ["audio_old","audio_new"])await f.send(live.peer,{type:"response.output_audio.delta",response_id:response,item_id:item,content_index:0,delta:Buffer.alloc(48_000).toString("base64")});
    await vi.waitFor(()=>expect(f.events.filter(event=>event.type==="audio")).toHaveLength(2));
    const ack={...live.scope,playbackEpoch:0,responseId:response,itemId:"audio_old",contentIndex:0,playedSamples:6000};f.service.playbackAck(ack);
    expect(()=>f.service.playbackAck({...ack,playedSamples:24_001})).toThrow();const interrupted=f.service.interrupt(ack);expect(interrupted.session.state).toBe("interrupting");
    await vi.waitFor(()=>expect(f.messages.filter(event=>event.type==="conversation.item.truncate")).toHaveLength(2));expect(f.messages.filter(event=>event.type==="conversation.item.truncate").map(value=>[value.item_id,value.audio_end_ms])).toEqual([["audio_old",250],["audio_new",0]]);
    expect(()=>f.service.playbackAck(ack)).toThrow();await f.send(live.peer,{type:"response.done",response:{id:response,status:"cancelled",output:[]}});
    await f.send(live.peer,{type:"conversation.item.truncated",item_id:"audio_old",content_index:0,audio_end_ms:250});expect(f.service.snapshot(live.scope).session.state).toBe("interrupting");
    await f.send(live.peer,{type:"conversation.item.truncated",item_id:"audio_new",content_index:0,audio_end_ms:0});await vi.waitFor(()=>expect(f.service.snapshot(live.scope).session.state).toBe("ready"));
    expect(()=>f.service.append({...live.scope,captureId:live.captureId,sequence:0,dataBase64:Buffer.alloc(480).toString("base64")})).toThrow();
    f.service.append({...live.scope,captureId:live.captureId,sequence:1,dataBase64:Buffer.alloc(480).toString("base64")});expect(f.service.snapshot(live.scope).turns).toHaveLength(2);
  });
  it("holds a completed business result behind truncate confirmation",async()=>{
    const f=await fixture();f.hold();const live=await f.start(),turn=await f.commit(live),response=await f.response(live,turn);
    await f.send(live.peer,{type:"response.output_audio.delta",response_id:response,item_id:"audio_1",content_index:0,delta:Buffer.alloc(4800).toString("base64")});const call=await f.functionDone(live,response);
    await f.send(live.peer,{type:"response.done",response:{id:response,status:"completed",output:[call]}});await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    f.service.interrupt({...live.scope,playbackEpoch:0,responseId:response,itemId:"audio_1",contentIndex:0,playedSamples:0});f.release();
    await vi.waitFor(()=>expect(f.repository.getRuntimeRun(f.service.snapshot(live.scope).session.linkedTask!.id).state).toBe("completed"));expect(f.messages.filter(value=>value.type==="conversation.item.create")).toHaveLength(0);
    await f.send(live.peer,{type:"conversation.item.truncated",item_id:"audio_1",content_index:0,audio_end_ms:0});await vi.waitFor(()=>expect(f.messages.filter(value=>value.type==="conversation.item.create")).toHaveLength(1));
  });
  it("stops voice without cancelling accepted business and rejects another Runtime's control",async()=>{
    const f=await fixture();f.hold();const live=await f.start(),turn=await f.commit(live),response=await f.response(live,turn),call=await f.functionDone(live,response);
    await f.send(live.peer,{type:"response.done",response:{id:response,status:"completed",output:[call]}});await vi.waitFor(()=>expect(f.service.snapshot(live.scope).session.linkedTask).not.toBeNull());
    const nonce=randomUUID();f.repository.prepareMessage({sessionId:f.repository.createBot().session.id,clientNonce:nonce,text:"other"});
    await expect(f.service.stop(live.scope,{executorBotId:f.owner.bot.id,runtimeRunId:randomUUID()})).rejects.toMatchObject({code:"VOICE_NOT_GRANTED"});
    const stopped=await f.service.stop(live.scope);expect(stopped.session.state).toBe("stopped");expect(f.cancelled).toEqual([]);expect(f.repository.getRuntimeRun(stopped.session.linkedTask!.id).state).toBe("running");
    await f.service.stopTask(live.scope);expect(f.cancelled).toEqual([stopped.session.linkedTask]);
  });
  it("reconciles a crash gap by the existing nonce without reconnect or replay",async()=>{
    const f=await fixture();f.hold();const live=await f.start(),turn=await f.commit(live),response=await f.response(live,turn),call=await f.functionDone(live,response);
    await f.send(live.peer,{type:"response.done",response:{id:response,status:"completed",output:[call]}});await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    const db=Reflect.get(f.repository,"database") as import("node:sqlite").DatabaseSync;db.prepare("UPDATE realtime_calls SET linked_task_json=NULL WHERE turn_id=?").run(turn);
    await f.service.stop(live.scope);const peerCount=f.peers.length,lookup=vi.spyOn(f.host,"lookup"),reopened=new RealtimeService(f.repository,codec,f.host,f.options);
    expect(lookup).toHaveBeenCalledOnce();expect(reopened.snapshot(live.scope).session.linkedTask).not.toBeNull();expect(f.repository.realtime.call(turn)?.state).toBe("interrupted_unknown");expect(f.requests).toHaveLength(1);expect(f.peers).toHaveLength(peerCount);await reopened.shutdown();
  });
  it("starts six independent real sockets and business jobs before any result completes",async()=>{
    const f=await fixture();f.hold();const owners=[f.owner,...Array.from({length:5},()=>f.repository.createBot())],lives=[];
    for(const owner of owners)lives.push(await f.start(owner));
    await Promise.all(lives.map(async(live,index)=>{const turn=await f.commit(live,`human_${index}`),response=await f.response(live,turn,`response_${index}`),call=await f.functionDone(live,response,`call_${index}`);await f.send(live.peer,{type:"response.done",response:{id:response,status:"completed",output:[call]}});}));
    await vi.waitFor(()=>expect(f.requests).toHaveLength(6));expect(f.messages.filter(event=>event.type==="conversation.item.create")).toHaveLength(0);
    const first=f.service.snapshot(lives[0]!.scope).session.linkedTask!;await f.service.stopTask(lives[0]!.scope);expect(f.cancelled).toEqual([first]);
    expect(lives.slice(1).map(live=>f.repository.getRuntimeRun(f.service.snapshot(live.scope).session.linkedTask!.id).state)).toEqual(Array(5).fill("running"));f.release();
  });
  it("closes only owned capture on key configuration change and makes an empty final terminal",async()=>{
    const f=await fixture(),live=await f.start();f.service.append({...live.scope,captureId:live.captureId,sequence:0,dataBase64:Buffer.alloc(4800).toString("base64")});const turn=f.service.commitTurn({...live.scope,captureId:live.captureId,lastSequence:0}).session.currentTurnId!;
    await f.send(live.peer,{type:"input_audio_buffer.committed",item_id:"empty_input"});await f.send(live.peer,{type:"conversation.item.input_audio_transcription.completed",item_id:"empty_input",transcript:"   "});
    await vi.waitFor(()=>expect(f.service.snapshot(live.scope).turns.find(value=>value.id===turn)!.state).toBe("failed"));expect(f.messages.filter(event=>event.type==="response.create")).toHaveLength(0);
    new VoiceSettings(f.repository.voice,codec).save({kind:"realtime",expectedVersion:2,enabled:false,model:"gpt-realtime-2.1-mini",voice:"marin"});f.service.configurationChanged();
    await vi.waitFor(()=>expect(f.service.snapshot(live.scope).session.state).toBe("stopped"));expect(f.requests).toEqual([]);
  });
  it("rejects a wrong truncate ACK and never accepts late audio or mic data after capture cancellation",async()=>{
    const f=await fixture(),live=await f.start(),turn=await f.commit(live),response=await f.response(live,turn);
    await f.send(live.peer,{type:"response.output_audio.delta",response_id:response,item_id:"audio_1",content_index:0,delta:Buffer.alloc(4800).toString("base64")});
    await vi.waitFor(()=>expect(f.events.filter(event=>event.type==="audio")).toHaveLength(1));
    f.service.interrupt({...live.scope,playbackEpoch:0,responseId:response,itemId:"audio_1",contentIndex:0,playedSamples:480});
    await f.send(live.peer,{type:"conversation.item.truncated",item_id:"audio_1",content_index:0,audio_end_ms:21});
    await vi.waitFor(()=>expect(f.service.snapshot(live.scope).session.state).toBe("interrupted_unknown"));expect(f.requests).toEqual([]);
    expect(()=>f.service.append({...live.scope,captureId:live.captureId,sequence:1,dataBase64:Buffer.alloc(480).toString("base64")})).toThrow();
    const second=await f.start(f.repository.createBot());second.controller.abort();await vi.waitFor(()=>expect(f.service.snapshot(second.scope).session.state).toBe("stopped"));
    expect(()=>f.service.append({...second.scope,captureId:second.captureId,sequence:0,dataBase64:Buffer.alloc(480).toString("base64")})).toThrow();
  });
  it("closes its live socket when an idle Bot deletion cascades the voice journal",async()=>{
    const f=await fixture(),live=await f.start();f.repository.deleteBot(f.owner.bot.id);
    await expect(f.service.stopAll()).resolves.toBeUndefined();await vi.waitFor(()=>expect(live.peer.readyState).toBe(WebSocket.CLOSED));
  });
});
