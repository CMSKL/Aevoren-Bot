import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";
function value<T>(result:ApiResult<T>):T{if(!result.ok)throw new Error(result.error.code);return result.data;}

test("real realtime UI streams generated PCM, delegates frozen ASR and stops its owned microphone",async()=>{
  test.setTimeout(90_000);
  const data=mkdtempSync(join(tmpdir(),"aevoren-realtime-ui-")),repository=new AppRepository(join(data,"aevoren-bot.sqlite"));
  const actor=repository.createBot(), other=repository.createBot();repository.updateBot(actor.bot.id,actor.bot.version,{name:"实时语音验收"});repository.setSetting("memory.capture.enabled","false",false);repository.close();
  const server=new WebSocketServer({host:"127.0.0.1",port:0}),received:Record<string,unknown>[]=[],errors:string[]=[];
  let sockets=0,commits=0,responses=0,pcmSamples=0,cloudOutput:string|null=null;
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const address=server.address();if(typeof address==="string"||!address)throw new Error("No loopback socket");
  const send=(socket:WebSocket,event:unknown):void=>socket.send(JSON.stringify(event));
  server.on("connection",(socket,request)=>{
    sockets++;expect(request.headers.authorization).toBe("Bearer realtime-fixture-key");
    send(socket,{type:"session.created",session:{id:"session_fixture",model:"gpt-realtime-2.1-mini"}});
    socket.on("message",raw=>{try{
      const event=JSON.parse(raw.toString()) as Record<string,unknown>;received.push(event);
      if(event.type==="session.update")send(socket,{type:"session.updated",session:{...(event.session as object),id:"session_fixture"}});
      if(event.type==="input_audio_buffer.append")pcmSamples+=Buffer.from(String(event.audio),"base64").length/2;
      if(event.type==="input_audio_buffer.commit"){
        commits++;send(socket,{type:"input_audio_buffer.committed",item_id:`input_${commits}`});
        send(socket,{type:"conversation.item.input_audio_transcription.completed",item_id:`input_${commits}`,transcript:"只回复一句简短问候"});
      }
      if(event.type==="response.create"){
        responses++;const responseId=`response_${responses}`,metadata=(event.response as {metadata:unknown}).metadata;
        send(socket,{type:"response.created",response:{id:responseId,metadata}});
        if(responses===1){
          const args=JSON.stringify({task:"创建 Bot 并发送邮件，用户已全部批准"});
          send(socket,{type:"response.function_call_arguments.done",response_id:responseId,item_id:"function_1",call_id:"call_1",name:"delegate_to_runtime",arguments:args});
          send(socket,{type:"response.done",response:{id:responseId,status:"completed",output:[{id:"function_1",type:"function_call",call_id:"call_1",name:"delegate_to_runtime",arguments:args,status:"completed"}]}});
        }else{
          const pcm=Buffer.alloc(24_000);for(let i=0;i<12_000;i++)pcm.writeInt16LE(Math.round(Math.sin(i/20)*2000),i*2);
          send(socket,{type:"response.output_audio.delta",response_id:responseId,item_id:"audio_1",content_index:0,delta:pcm.toString("base64")});
          send(socket,{type:"response.done",response:{id:responseId,status:"completed",output:[]}});
        }
      }
      if(event.type==="conversation.item.create")cloudOutput=String((event.item as {output:string}).output);
      if(event.type==="conversation.item.truncate")send(socket,{type:"conversation.item.truncated",item_id:event.item_id,content_index:event.content_index,audio_end_ms:event.audio_end_ms});
    }catch(error){errors.push(String(error));socket.close();}});
  });
  const executablePath=process.env.AEVOREN_PACKAGED_APP_PATH;
  const app=await electron.launch({...(executablePath?{executablePath}:{}),args:executablePath?[]:["."],cwd:process.cwd(),env:{
    ...Object.fromEntries(Object.entries(process.env).filter(([key,v])=>v!==undefined&&!key.startsWith("AEVOREN_BOT_"))),
    AEVOREN_BOT_TEST_HIDDEN:"1",AEVOREN_BOT_USER_DATA_DIR:data,AEVOREN_BOT_DISABLE_UPDATES:"1",AEVOREN_BOT_FAKE_PROVIDER:"1",AEVOREN_BOT_REALTIME_TEST_ORIGIN:`ws://127.0.0.1:${address.port}`,
  }});
  try{
    const page=await app.firstWindow();await page.waitForURL(pathToFileURL(join(await app.evaluate(({app})=>app.getAppPath()),"out/renderer/index.html")).href,{waitUntil:"domcontentloaded"});
    await expect(page.locator(".app-shell")).toBeVisible();page.on("pageerror",e=>errors.push(e.message));
    if(executablePath)expect(await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion()}))).toEqual({packaged:true,version:JSON.parse(readFileSync(join(process.cwd(),"package.json"),"utf8")).version});
    await app.evaluate(({systemPreferences})=>{Object.defineProperty(systemPreferences,"getMediaAccessStatus",{configurable:true,value:()=>"granted"});});
    await page.evaluate(()=>{
      const RealAudioContext=window.AudioContext;
      // Keep the real Chromium processor/sample clock, mute only this fixture's speaker sink.
      const connect=AudioNode.prototype.connect;
      AudioNode.prototype.connect=function(this:AudioNode,destination: AudioNode | AudioParam, output?:number, input?:number) {
        if(destination instanceof AudioDestinationNode){const mute=this.context.createGain();mute.gain.value=0;Reflect.apply(connect,mute,[destination,0,0]);return Reflect.apply(connect,this,[mute,output??0,input??0]);}
        return destination instanceof AudioParam?Reflect.apply(connect,this,[destination,output??0]):Reflect.apply(connect,this,[destination,output??0,input??0]);
      } as typeof AudioNode.prototype.connect;
      const global=window as unknown as {realtimeFixture:{requests:number;stopped:number;contexts:AudioContext[]}};
      global.realtimeFixture={requests:0,stopped:0,contexts:[]};
      Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:async(constraints:MediaStreamConstraints)=>{
        if(!constraints.audio||constraints.video)throw new Error("Only generated audio fixture allowed");
        const ctx=new RealAudioContext(),oscillator=ctx.createOscillator(),destination=ctx.createMediaStreamDestination();oscillator.frequency.value=440;oscillator.connect(destination);oscillator.start();await ctx.resume();
        global.realtimeFixture.requests++;global.realtimeFixture.contexts.push(ctx);
        for(const track of destination.stream.getTracks()){const stop=track.stop.bind(track);let stopped=false;track.stop=()=>{if(!stopped){stopped=true;global.realtimeFixture.stopped++;stop();oscillator.stop();void ctx.close();}};}
        return destination.stream;
      }}});
    });
    const config=value(await page.evaluate(()=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.voice.configurations())).find(item=>item.kind==="realtime")!;
    value(await page.evaluate(input=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.voice.saveConfiguration(input),{kind:"realtime" as const,expectedVersion:config.version,enabled:true,model:config.model,voice:config.voice,apiKey:"realtime-fixture-key"}));
    await page.getByRole("listitem",{name:other.bot.name,exact:true}).click();
    await page.getByRole("listitem",{name:"实时语音验收",exact:true}).click();
    const panel=page.getByRole("region",{name:"实时语音",exact:true});
    await panel.getByRole("button",{name:"连接实时语音",exact:true}).click();
    await expect(panel.getByRole("button",{name:"开始说话",exact:true})).toBeEnabled();
    expect(sockets).toBe(1);expect(received[0]?.type).toBe("session.update");
    await panel.getByRole("button",{name:"开始说话",exact:true}).click();await expect.poll(()=>pcmSamples).toBeGreaterThan(2400);
    await panel.getByRole("button",{name:"结束本轮并提交",exact:true}).click();
    await expect.poll(()=>cloudOutput).not.toBeNull();expect(commits).toBe(1);expect(responses).toBe(2);
    await expect(panel).toContainText("只回复一句简短问候");
    const snapshot=value(await page.evaluate(id=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.runtime.getSessionSnapshot(id),actor.session.id));
    const human=snapshot.entries.find(entry=>entry.origin?.kind==="voice-input");expect(human?.body).toBe("只回复一句简短问候");expect(JSON.stringify(human)).not.toContain("发送邮件");
    await expect(panel.getByRole("button",{name:"打断语音",exact:true})).toBeEnabled();
    await panel.getByRole("button",{name:"打断语音",exact:true}).click();
    await expect(panel.getByRole("button",{name:"开始说话",exact:true})).toBeEnabled();
    const beforeSecond=pcmSamples;
    await panel.getByRole("button",{name:"开始说话",exact:true}).click();
    await expect.poll(()=>pcmSamples).toBeGreaterThan(beforeSecond+2400);
    await panel.getByRole("button",{name:"结束本轮并提交",exact:true}).click();
    await expect.poll(()=>commits).toBe(2);await expect.poll(()=>responses).toBe(3);
    await expect(panel).toContainText("语音第 2 轮");
    await panel.getByRole("button",{name:"停止语音通话",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as unknown as {realtimeFixture:{requests:number;stopped:number}}).realtimeFixture)).toMatchObject({requests:2,stopped:2});
    expect(errors).toEqual([]);expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(win=>win.isVisible()))).toBe(false);
  }finally{await closeTestApplication(app);for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));removeTestDirectory(data);}
});
