import { useEffect,useState } from "react";
import type { BotAvatarColor,BotAvatarShape } from "@shared/bot-avatar";
import type { MediaRef } from "@shared/library-contracts";
import { normalizeBotAvatarColor,normalizeBotAvatarShape } from "@shared/bot-avatar";
import { botAvatarUrl } from "../avatar-catalog";
type BotAvatarIconProps={shape?:BotAvatarShape|null;color?:BotAvatarColor|null;size?:number;className?:string;title?:string;botId?:string;image?:MediaRef};
const pixels=new Map<string,Promise<string|null>>();
function load(botId:string,image:Pick<MediaRef,"id"|"sha256">):Promise<string|null>{const key=`${botId}:${image.id}:${image.sha256}`,cached=pixels.get(key);if(cached)return cached;
 const pending=window.aevorenBot.botImages.read({botId,expectedImageId:image.id}).then(result=>result.ok&&result.data&&result.data.reference.sha256===image.sha256?`data:${result.data.reference.mimeType};base64,${result.data.dataBase64}`:null).catch(()=>null);
 pixels.set(key,pending);while(pixels.size>32)pixels.delete(pixels.keys().next().value!);return pending;
}
export function BotAvatarIcon({shape,color,size=24,className,title,botId,image}:BotAvatarIconProps):React.JSX.Element{
 const safeShape=normalizeBotAvatarShape(shape),safeColor=normalizeBotAvatarColor(color),key=`${botId}:${image?.id}:${image?.sha256}`,[loaded,setLoaded]=useState<{key:string;url:string|null}|null>(null);
 const imageId=image?.id,imageSha=image?.sha256;
 useEffect(()=>{if(!botId||!imageId||!imageSha)return;let active=true;const reference={id:imageId,sha256:imageSha};
  const read=():void=>{void load(botId,reference).then(url=>{if(active)setLoaded({key,url});});};read();
  const stop=window.aevorenBot.media.onChanged(event=>{if(event.mediaId!==imageId)return;pixels.delete(`${botId}:${imageId}:${imageSha}`);setLoaded(null);read();});return()=>{active=false;stop();};
 },[botId,imageId,imageSha,key]);
 const custom=loaded?.key===key?loaded.url:null;
 return <img className={`bot-avatar-icon${className?` ${className}`:""}`} src={custom||botAvatarUrl(safeShape,safeColor)} width={size} height={size} alt={title||""} title={title} aria-hidden={title?undefined:true} draggable={false} decoding="async" data-avatar-shape={safeShape} data-avatar-color={safeColor} data-custom-avatar={custom?"true":undefined}/>;
}
