import { randomUUID,createHash } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { afterEach,describe,expect,it } from "vitest";
import { AppRepository } from "./database";
import { MediaService } from "./media-service";
import { BotImageService } from "./bot-image-service";
import type { MediaParserAdapter } from "./media-parser-types";
const clean:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0))await close();});
function crc(bytes:Buffer):number{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;}return(value^0xffffffff)>>>0;}
function png(color=80):Buffer{const chunk=(type:string,body:Buffer)=>{const name=Buffer.from(type),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(body.length);sum.writeUInt32BE(crc(Buffer.concat([name,body])));return Buffer.concat([length,name,body,sum]);};const header=Buffer.alloc(13);header.writeUInt32BE(256,0);header.writeUInt32BE(256,4);header[8]=8;header[9]=6;const pixels=Buffer.alloc(256*(256*4+1),color);for(let i=0;i<256;i++)pixels[i*(256*4+1)]=0;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]);}
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),"aevoren-avatar-")),repository=new AppRepository(join(root,"app.sqlite")),owner=repository.createBot();
 let hold:Promise<void>|undefined,entered=0;const parser:MediaParserAdapter={parse:async()=>{entered++;if(hold)await hold;return{kind:"image",width:256,height:256,durationMs:null,extraction:null,parserName:"controlled-image-parser",parserVersion:"1"};},renderPdfPage:async()=>{throw new Error("not used");},shutdown:async()=>{}};
 const media=new MediaService(repository,join(root,"media"),parser),bytes=png(),source=(await media.importBytes({sessionId:owner.session.id,bytes,mimeType:"image/png",name:"selected.png"})).imported[0]!;
 const service=new BotImageService(repository,media,value=>value);clean.push(async()=>{await media.shutdown();repository.close();rmSync(root,{recursive:true,force:true});});
 return{repository,owner,media,service,source,bytes,parses:()=>entered,hold:(promise:Promise<void>)=>{entered=0;hold=promise;}};
}
describe("published owned Bot image avatars",()=>{
 it("copies verified pixels atomically and retains independent published pixels after source removal",async()=>{
  const f=await fixture(),bot=await f.service.set({botId:f.owner.bot.id,expectedVersion:f.owner.bot.version,sessionId:f.owner.session.id,reference:f.source.reference});expect(bot.version).toBe(f.owner.bot.version+1);expect(bot.avatarImage?.id).not.toBe(f.source.reference.mediaId);
  f.media.delete({sessionId:f.owner.session.id,id:f.source.reference.mediaId,expectedVersion:f.source.asset.version});
  const image=await f.service.image({botId:bot.id});expect(image?.reference.sha256).toBe(createHash("sha256").update(f.bytes).digest("hex"));expect(Buffer.from(image!.dataBase64,"base64")).toEqual(f.bytes);expect(image!.isAuthorized()).toBe(true);
  const duplicate=f.repository.duplicateBot(bot.id);expect(duplicate.bot.avatarImage?.sha256).toBe(bot.avatarImage?.sha256);expect(duplicate.bot.avatarImage?.id).not.toBe(bot.avatarImage?.id);
  f.service.clear({botId:bot.id,expectedVersion:bot.version});expect(image!.isAuthorized()).toBe(false);expect(await f.service.read({botId:bot.id})).toBeNull();expect((await f.service.read({botId:duplicate.bot.id}))?.reference.sha256).toBe(bot.avatarImage?.sha256);
 });
 it("publishes no asset or partial Bot change after CAS conflict or source revoke/rebind during staging",async()=>{
  const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.hold(gate);
  const before=f.media.list({sessionId:f.owner.session.id}),pending=f.service.set({botId:f.owner.bot.id,expectedVersion:f.owner.bot.version,sessionId:f.owner.session.id,reference:f.source.reference});
  const outcome=pending.catch(error=>error);await expect.poll(f.parses).toBe(1);f.repository.updateBot(f.owner.bot.id,f.owner.bot.version,{name:"Concurrent edit"});release();await expect(outcome).resolves.toMatchObject({code:"BOT_VERSION_CONFLICT"});expect(f.media.list({sessionId:f.owner.session.id})).toEqual(before);expect(f.repository.getBot(f.owner.bot.id).avatarImage).toBeUndefined();
  const current=f.repository.getBot(f.owner.bot.id);let resume!:()=>void;f.hold(new Promise<void>(resolve=>{resume=resolve;}));const second=f.service.set({botId:current.id,expectedVersion:current.version,sessionId:f.owner.session.id,reference:f.source.reference}).catch(error=>error);
  await expect.poll(f.parses).toBe(1);f.media.unbind({sessionId:f.owner.session.id,id:f.source.reference.mediaId});f.media.bind({sessionId:f.owner.session.id,id:f.source.reference.mediaId});resume();await expect(second).resolves.toMatchObject({code:"MEDIA_NOT_GRANTED"});expect(f.media.list({sessionId:f.owner.session.id})).toEqual(before);
 });
 it("cancels only its trusted UI image intent before publication",async()=>{
  const f=await fixture();let release!:()=>void;f.hold(new Promise<void>(resolve=>{release=resolve;}));const requestId=randomUUID();const outcome=f.service.set({botId:f.owner.bot.id,expectedVersion:f.owner.bot.version,sessionId:f.owner.session.id,reference:f.source.reference,requestId}).catch(error=>error);
  await expect.poll(f.parses).toBe(1);f.service.cancelUI(requestId);release();await expect(outcome).resolves.toMatchObject({code:"TOOL_EXECUTION_CANCELLED"});expect(f.repository.getBot(f.owner.bot.id).avatarImage).toBeUndefined();expect(f.media.list({sessionId:f.owner.session.id})).toHaveLength(1);
 });
 it("rejects a private image from another session before publishing through a Runtime",async()=>{
  const f=await fixture(),other=f.repository.createBot(),nonce=randomUUID();f.repository.prepareMessage({sessionId:other.session.id,clientNonce:nonce,text:"Use the selected avatar"});const entry=f.repository.getUserMessage(nonce),run=f.repository.createRuntimeRun(nonce,"fake",{schemaVersion:1,botId:other.bot.id,profileVersion:1,sessionId:other.session.id,generation:1,inputSeq:entry.seq,blocks:[],digest:"avatar-scope"});f.repository.transitionRuntimeRun(run.id,"dispatching");f.repository.transitionRuntimeRun(run.id,"running");
  await expect(f.service.set({botId:other.bot.id,expectedVersion:other.bot.version,sessionId:f.owner.session.id,reference:f.source.reference},{executorBotId:other.bot.id,runtimeRunId:run.id})).rejects.toMatchObject({code:"RUNTIME_CONTROL_SCOPE_INVALID"});expect(f.repository.getBot(other.bot.id).avatarImage).toBeUndefined();
 });
});
