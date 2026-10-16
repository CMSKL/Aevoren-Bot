import { createServer,type Server } from "node:http";
import { afterEach,describe,expect,it } from "vitest";
import { VOICE_AUDIO_MAX_BYTES } from "@shared/voice-schemas";
import { VoiceHttpAdapter,pcmToWav,type VoiceFetch } from "./voice-http-adapter";
const servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
const auth=()=>({apiKey:"controlled-fixture-key",model:"gpt-transcribe",signal:new AbortController().signal,assertCurrent:()=>{}});
describe("reference voice HTTP transport",()=>{
  it("uploads actual multipart bytes to a controlled server and requires a final SSE transcript",async()=>{
    let received:Uint8Array|undefined,model:string|undefined,stream:string|undefined,authorized=false;
    const server=createServer((request,response)=>{void(async()=>{
      authorized=request.headers.authorization==="Bearer controlled-fixture-key";
      const parts:Buffer[]=[];for await(const chunk of request)parts.push(Buffer.from(chunk));
      const form=await new Response(Buffer.concat(parts),{headers:{"content-type":request.headers["content-type"]!}}).formData();
      received=new Uint8Array(await (form.get("file") as File).arrayBuffer());model=String(form.get("model"));stream=String(form.get("stream"));
      response.writeHead(200,{"content-type":"text/event-stream"});response.write('data: {"type":"transcript.text.delta","delta":"你好"}\r\n\r\n');
      response.end('data: {"type":"transcript.text.done","text":"你好，完整转写。"}\r\n\r\n');
    })().catch(()=>{response.writeHead(500).end();});});servers.push(server);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const address=server.address();if(!address||typeof address==="string")throw new Error("Fixture port missing");
    const fetchFn:VoiceFetch=(url,init)=>{expect(url.href).toBe("https://api.openai.com/v1/audio/transcriptions");expect(init.redirect).toBe("error");return fetch(`http://127.0.0.1:${address.port}${url.pathname}`,init);};
    const wav=pcmToWav(Buffer.from([0,0,255,127])),deltas:string[]=[];
    expect(await new VoiceHttpAdapter(fetchFn).transcribe({...auth(),bytes:wav,mimeType:"audio/wav",name:"owned.wav",onDelta:delta=>deltas.push(delta)})).toBe("你好，完整转写。");
    expect(Buffer.from(received!)).toEqual(wav);expect([model,stream,authorized]).toEqual(["gpt-transcribe","true",true]);expect(deltas).toEqual(["你好"]);
  });
  it("handles UTF-8 split inside a stream chunk and rejects a missing final event",async()=>{
    const bytes=new TextEncoder().encode('data: {"type":"transcript.text.delta","delta":"你好"}\n\ndata: {"type":"transcript.text.done","text":"你好"}\n\n');
    const marker=bytes.indexOf(228),parts=[bytes.slice(0,marker+1),bytes.slice(marker+1,marker+2),bytes.slice(marker+2)];
    const adapter=new VoiceHttpAdapter(async()=>new Response(new ReadableStream({start(controller){for(const part of parts)controller.enqueue(part);controller.close();}}),{headers:{"content-type":"text/event-stream"}}));
    expect(await adapter.transcribe({...auth(),bytes:Buffer.from("audio"),mimeType:"audio/wav",name:"a.wav",onDelta:()=>{}})).toBe("你好");
    const incomplete=new VoiceHttpAdapter(async()=>new Response('data: {"type":"transcript.text.delta","delta":"partial"}\n\n',{headers:{"content-type":"text/event-stream"}}));
    await expect(incomplete.transcribe({...auth(),bytes:Buffer.from("audio"),mimeType:"audio/wav",name:"a.wav",onDelta:()=>{}})).rejects.toMatchObject({code:"VOICE_RESPONSE_INVALID",unknownOutcome:true});
  });
  it("wraps actual aligned PCM as mono24k16LE WAV and bounds the result",async()=>{
    let input:Record<string,unknown>|undefined;const pcm=Buffer.from([0,128,0,0,255,127]);
    const adapter=new VoiceHttpAdapter(async(url,init)=>{expect(url.href).toBe("https://api.openai.com/v1/audio/speech");input=JSON.parse(String(init.body));return new Response(pcm,{headers:{"content-type":"application/octet-stream"}});});
    const wav=await adapter.speak({...auth(),model:"gpt-4o-mini-tts",voice:"alloy",text:"Speak this"});
    expect(input).toEqual({model:"gpt-4o-mini-tts",voice:"alloy",input:"Speak this",response_format:"pcm",stream_format:"audio"});
    expect(wav.subarray(0,4).toString()).toBe("RIFF");expect(wav.readUInt32LE(24)).toBe(24_000);expect(wav.readUInt16LE(22)).toBe(1);expect(wav.readUInt16LE(34)).toBe(16);expect(wav.subarray(44)).toEqual(pcm);
    expect(()=>pcmToWav(Buffer.from([1]))).toThrowError(expect.objectContaining({code:"VOICE_RESPONSE_INVALID"}));
    expect(()=>pcmToWav(Buffer.alloc(VOICE_AUDIO_MAX_BYTES))).toThrow();
  });
  it("does not expose provider error bodies and stops reading after authorization revocation",async()=>{
    const rejected=new VoiceHttpAdapter(async()=>new Response("PRIVATE_PROVIDER_ERROR_BODY",{status:401}));
    await expect(rejected.speak({...auth(),voice:"alloy",text:"hello"})).rejects.not.toThrow(/PRIVATE_PROVIDER/u);
    let reads=0,allowed=true;
    const stream=new ReadableStream<Uint8Array>({pull(controller){reads+=1;controller.enqueue(new TextEncoder().encode('data: {"type":"transcript.text.delta","delta":"one"}\n\n'));},cancel(){}});
    const adapter=new VoiceHttpAdapter(async()=>new Response(stream,{headers:{"content-type":"text/event-stream"}}));
    await expect(adapter.transcribe({...auth(),bytes:Buffer.from("audio"),mimeType:"audio/wav",name:"a.wav",assertCurrent:()=>{if(!allowed)throw new Error("revoked");},onDelta:()=>{allowed=false;}})).rejects.toThrow("revoked");
    expect(reads).toBeLessThan(4);
  });
});
