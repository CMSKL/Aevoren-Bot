import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CDPSession, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWorkerFrame } from "@shared/browser-contracts";
import { BrowserEngine } from "./engine";

afterEach(()=>vi.useRealTimers());
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(ready=>{resolve=ready;});return {promise,resolve};}
async function fixture(){
  const engine=new BrowserEngine({browserSessionId:randomUUID(),profileDirectory:"controlled-profile",downloadsDirectory:"controlled-downloads"});
  await engine.perform("control",{owner:"ai",epoch:7,needsObservation:false});
  let focused=false,closed=false;const waiting=deferred<void>(),settled=deferred<boolean>();
  const record={id:randomUUID(),version:4,createdAt:"2026-10-01T00:00:00Z",page:null as unknown as Page,session:null as unknown as CDPSession};
  record.page={bringToFront:vi.fn(async()=>{}),isClosed:()=>closed,close:vi.fn(async()=>{closed=true;}),evaluate:vi.fn(async()=>({text:"controlled page",truncated:false})),$$:vi.fn(async()=>[]),url:()=>"about:blank",title:async()=>"controlled"} as unknown as Page;
  record.session={send:vi.fn(async(method:string,input?:Record<string,unknown>)=>{
    if(method==="Page.getFrameTree")return {frameTree:{frame:{id:"controlled_frame"}}};
    if(method==="Page.createIsolatedWorld")return {executionContextId:17};
    if(method==="Runtime.evaluate"){
      if(input?.expression==="document.hasFocus()")return {result:{value:focused}};
      if(input?.awaitPromise){waiting.resolve();return {result:{value:await settled.promise}};}
      settled.resolve(false);return {result:{value:null}};
    }
    throw new Error("Unexpected controlled CDP method");
  })} as unknown as CDPSession;
  const pixels=readFileSync(new URL("../../tests/fixtures/media-parser/red.jpg",import.meta.url));
  const internals=engine as unknown as {pages:Map<string,typeof record>;runProgram(...args:unknown[]):Promise<Buffer>};internals.pages.set(record.id,record);
  const capture=vi.spyOn(internals,"runProgram").mockResolvedValue(pixels);
  const input={actor:"ai",expectedEpoch:7,pageId:record.id,operationId:randomUUID()};
  return {engine,record,input,waiting,capture,pixels,settle(value:boolean){focused=value;settled.resolve(value);},close:()=>{closed=true;}};
}
describe("explicit frame focus readiness",()=>{
  it("waits for delayed isolated-world focus after bringToFront before reading or capturing",async()=>{
    const f=await fixture(),outcome=f.engine.perform("desktop-frame",f.input).then(value=>({value}),error=>({error}));
    expect(await Promise.race([f.waiting.promise.then(()=>"waiting"),outcome.then(()=>"settled")])).toBe("waiting");
    expect(f.record.page.evaluate).not.toHaveBeenCalled();expect(f.capture).not.toHaveBeenCalled();f.settle(true);
    const result=await outcome;expect(result).not.toHaveProperty("error");const frame=(result as {value:BrowserWorkerFrame}).value;
    expect(Buffer.from(frame.dataBase64,"base64")).toEqual(f.pixels);expect(frame.sha256).toBe(createHash("sha256").update(f.pixels).digest("hex"));expect(f.capture).toHaveBeenCalledOnce();
    const wait=vi.mocked(f.record.session.send).mock.calls.find(([method,params])=>method==="Runtime.evaluate"&&(params as {awaitPromise?:boolean})?.awaitPromise);
    expect(wait?.[1]).toMatchObject({contextId:17,awaitPromise:true,returnByValue:true});expect(String((wait?.[1] as {expression:string}).expression)).toContain("window.addEventListener('focus'");
  });
  it("keeps permanent false focus bounded and never captures",async()=>{
    vi.useFakeTimers();const f=await fixture(),outcome=f.engine.perform("desktop-frame",f.input).catch(error=>error);
    await f.waiting.promise;await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).toMatchObject({code:"BROWSER_OBSERVATION_STALE",status:409});expect(f.capture).not.toHaveBeenCalled();expect(f.record.page.evaluate).not.toHaveBeenCalled();
  });
  it("does not accept a different or ambiguous focused target after readiness",async()=>{
    const f=await fixture(),internals=f.engine as unknown as {pages:Map<string,typeof f.record>},send=f.record.session.send.bind(f.record.session);
    const peer={...f.record,id:randomUUID(),session:{send:vi.fn(async(method:string,input?:Record<string,unknown>)=>method==="Runtime.evaluate"&&input?.expression==="document.hasFocus()"?{result:{value:true}}:send(method as "Page.getFrameTree",input))} as unknown as CDPSession};internals.pages.set(peer.id,peer);
    const outcome=f.engine.perform("desktop-frame",f.input).catch(error=>error);await f.waiting.promise;f.settle(true);
    expect(await outcome).toMatchObject({code:"BROWSER_OBSERVATION_STALE",status:409});expect(f.capture).not.toHaveBeenCalled();
  });
  it.each(["epoch","ownership"] as const)("stops a pending focus wait promptly when %s changes",async change=>{
    const f=await fixture(),outcome=f.engine.perform("desktop-frame",f.input).catch(error=>error);await f.waiting.promise;
    const changed=f.engine.perform("control",{owner:change==="ownership"?"user":"ai",epoch:8,needsObservation:true});
    expect(await outcome).toMatchObject({code:change==="ownership"?"BROWSER_USER_CONTROL":"BROWSER_CONTROL_CHANGED",status:409});await changed;
    expect(f.capture).not.toHaveBeenCalled();expect(f.record.page.evaluate).not.toHaveBeenCalled();
  });
  it.each(["navigation","closed"] as const)("rejects a page %s during focus settlement",async change=>{
    const f=await fixture(),outcome=f.engine.perform("desktop-frame",f.input).catch(error=>error);await f.waiting.promise;
    if(change==="navigation")f.record.version++;else f.close();f.settle(true);
    expect(await outcome).toMatchObject({code:"BROWSER_OBSERVATION_STALE",status:409});expect(f.capture).not.toHaveBeenCalled();expect(f.record.page.evaluate).not.toHaveBeenCalled();
  });
  it.each(["cancel","shutdown"] as const)("settles the owned focus wait on %s before it captures",async action=>{
    const f=await fixture(),outcome=f.engine.perform("desktop-frame",f.input).catch(error=>error);await f.waiting.promise;
    await f.engine.perform(action,{operationId:f.input.operationId});expect(await outcome).toMatchObject({code:"BROWSER_OPERATION_CANCELLED",status:409});expect(f.capture).not.toHaveBeenCalled();
  });
});
