import { validateAvatar } from "./user-profile-service";
import type { BotImageSetInput,BotImageClearInput,BotImageReadInput } from "@shared/bot-image-contracts";
import { botImageSetSchema,botImageClearSchema,botImageReadSchema } from "@shared/bot-image-schemas";
import type { AppRepository } from "./database";
import type { MediaExecutionContext,MediaService } from "./media-service";
import type { ModelImageAttachment } from "./model-image";
import { AevorenBotError } from "./errors";
/** A published avatar is an explicit public profile copy, independent of its original asset. */
export class BotImageService{
 private readonly pending=new Map<string,AbortController>();
 constructor(private readonly repository:AppRepository,private readonly media:MediaService,private readonly normalize:(bytes:Uint8Array)=>Uint8Array,private readonly changed:()=>void=()=>{}){}
 private assertBot(id:string,version?:number,context:MediaExecutionContext={}):void{const bot=this.repository.getBot(id);if(version!==undefined&&bot.version!==version)throw new AevorenBotError("BOT_VERSION_CONFLICT");context.signal?.throwIfAborted();context.assertCurrent?.();}
 set(input:BotImageSetInput,context:MediaExecutionContext={}){
  const parsed=botImageSetSchema.parse(input);if(!parsed.requestId)return this.apply(parsed,context);
  if(this.pending.has(parsed.requestId))throw new AevorenBotError("INVALID_REQUEST");
  const controller=new AbortController();this.pending.set(parsed.requestId,controller);
  return this.apply(parsed,{...context,signal:AbortSignal.any([controller.signal,...(context.signal?[context.signal]:[])])}).finally(()=>this.pending.delete(parsed.requestId!));
 }
 cancelUI(requestId:string):void{this.pending.get(requestId)?.abort();}
 private async apply(input:BotImageSetInput,context:MediaExecutionContext={}){
  const parsed=botImageSetSchema.parse(input);this.assertBot(parsed.botId,parsed.expectedVersion,context);
  if(context.runtimeRunId){const run=this.repository.getRuntimeRun(context.runtimeRunId);if(run.sessionId!==parsed.sessionId||run.executorBotId!==context.executorBotId)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");}
  const source=await this.media.readBinary({sessionId:parsed.sessionId,id:parsed.reference.mediaId,reference:parsed.reference},context);
  const asset=source.item.asset;if(asset.kind!=="image"||!["image/png","image/jpeg"].includes(asset.reference.mimeType)||asset.reference.size>2_097_152)throw new AevorenBotError("INVALID_REQUEST","请选择 2 MiB 以内的 PNG 或 JPEG 图片。");
  const pixels=this.normalize(source.bytes);validateAvatar(`data:image/png;base64,${Buffer.from(pixels).toString("base64")}`);
  const check=():void=>{this.assertBot(parsed.botId,parsed.expectedVersion,context);if(!source.isAuthorized())throw new AevorenBotError("MEDIA_NOT_GRANTED");};
  const session=this.repository.getMainSession(parsed.botId),targetContext={signal:context.signal,assertCurrent:check};
  const prepared=await this.media.prepareImageBytes({sessionId:session.id,bytes:pixels,name:`${this.repository.getBot(parsed.botId).name}头像.png`},targetContext);
  const result=this.repository.demonstrationsTransaction(()=>{check();const copy=this.media.commitImport(prepared,targetContext).imported[0]!;return this.repository.setBotImageAvatar(parsed.botId,parsed.expectedVersion,copy.asset.reference);});this.changed();return result;
 }
 clear(input:BotImageClearInput,context:MediaExecutionContext={}){const parsed=botImageClearSchema.parse(input);this.assertBot(parsed.botId,parsed.expectedVersion,context);const bot=this.repository.setBotImageAvatar(parsed.botId,parsed.expectedVersion,null);this.changed();return bot;}
 async image(input:BotImageReadInput,context:MediaExecutionContext={}):Promise<ModelImageAttachment|null>{
  const parsed=botImageReadSchema.parse(input),bot=this.repository.getBot(parsed.botId),reference=bot.avatarImage;if(!reference)return null;
  if(parsed.expectedImageId&&parsed.expectedImageId!==reference.id)throw new AevorenBotError("MEDIA_NOT_GRANTED");context.signal?.throwIfAborted();context.assertCurrent?.();
  const session=this.repository.getMainSession(bot.id),result=await this.media.readBinary({sessionId:session.id,id:reference.id,reference:{mediaId:reference.id,sha256:reference.sha256}},{signal:context.signal,assertCurrent:context.assertCurrent});
  const isAuthorized=():boolean=>{try{context.assertCurrent?.();const current=this.repository.getBot(bot.id).avatarImage;return current?.id===reference.id&&current.sha256===reference.sha256&&this.media.metadata({sessionId:session.id,id:reference.id}).asset.version===result.item.asset.version&&result.isAuthorized();}catch{return false;}};
  if(!isAuthorized())throw new AevorenBotError("MEDIA_NOT_GRANTED");return {origin:"media",reference,dataBase64:Buffer.from(result.bytes).toString("base64"),isAuthorized};
 }
 async read(input:BotImageReadInput){const image=await this.image(input);return image?{reference:image.reference,dataBase64:image.dataBase64}:null;}
}
