import { describe,expect,it } from "vitest";
import { decodeRealtimePcm,parseRealtimeEvent,realtimeSessionUpdate,REALTIME_MAX_MESSAGE_BYTES } from "./realtime-protocol";

describe("versioned realtime-v1 protocol",()=>{
  it("verifies the exact nested PCM/transcription/tool contract and discards provider instructions",()=>{
    const update=realtimeSessionUpdate("gpt-realtime-2.1-mini","marin"),session={...(update.session as object),id:"sess_test",instructions:"PRIVATE_PROVIDER_INSTRUCTIONS"};
    const parsed=parseRealtimeEvent(JSON.stringify({type:"session.updated",session}));expect(parsed).toMatchObject({type:"session.updated",configured:true,model:"gpt-realtime-2.1-mini"});expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
    for(const mutation of [{output_modalities:["text"]},{tools:[]},{parallel_tool_calls:true},{tool_choice:"required"},{audio:{input:{format:{type:"pcm16"}},output:{format:{type:"audio/pcm",rate:24000}}}}])
      expect(parseRealtimeEvent(JSON.stringify({type:"session.updated",session:{...session,...mutation}}))).toMatchObject({configured:false});
    const altered=structuredClone(session) as Record<string,unknown>;Reflect.set((altered.tools as Array<Record<string,unknown>>)[0]!,"parameters",{type:"object",additionalProperties:true});
    expect(parseRealtimeEvent(JSON.stringify({type:"session.updated",session:altered}))).toMatchObject({configured:false});
  });
  it("parses real PCM and rejects unaligned, noncanonical, oversized and other-protocol payloads",()=>{
    const bytes=Buffer.from([0,0,255,127]);expect(decodeRealtimePcm(bytes.toString("base64"),4)).toEqual(bytes);
    for(const value of ["AQ==","!!!!","AAB=",Buffer.alloc(6).toString("base64")])expect(()=>decodeRealtimePcm(value,4)).toThrowError(expect.objectContaining({code:"VOICE_RESPONSE_INVALID"}));
    expect(()=>parseRealtimeEvent(JSON.stringify({type:"session.started"}))).toThrow();expect(()=>parseRealtimeEvent(" ".repeat(REALTIME_MAX_MESSAGE_BYTES+1))).toThrow();
    expect(()=>parseRealtimeEvent(JSON.stringify({type:"response.function_call_arguments.done",response_id:"r",item_id:"i",call_id:"c",name:"tool",arguments:"x".repeat(8193)}))).toThrow();
  });
  it("accepts truncate acknowledgements above two minutes within the actual output sample budget",()=>{
    expect(parseRealtimeEvent(JSON.stringify({type:"conversation.item.truncated",item_id:"long_audio",content_index:0,audio_end_ms:121000}))).toEqual({type:"conversation.item.truncated",itemId:"long_audio",contentIndex:0,audioEndMs:121000});
    expect(()=>parseRealtimeEvent(JSON.stringify({type:"conversation.item.truncated",item_id:"too_long",content_index:0,audio_end_ms:350000}))).toThrow();
  });
  it("retains only safe correlated provider error metadata",()=>{
    expect(parseRealtimeEvent(JSON.stringify({type:"error",error:{event_id:"event_1",message:"PRIVATE_KEY_OR_PROVIDER_BODY",code:"private"}}))).toEqual({type:"error",clientEventId:"event_1"});
  });
});
