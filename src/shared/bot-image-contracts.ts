import type { ApiResult,Bot,MediaRef } from "./contracts";
import type { MessageMediaReference } from "./media-contracts";
export type BotImageSetInput={botId:string;expectedVersion:number;sessionId:string;reference:MessageMediaReference;requestId?:string};
export type BotImageClearInput={botId:string;expectedVersion:number};
export type BotImageReadInput={botId:string;expectedImageId?:string};
export type BotImagePixels={reference:MediaRef;dataBase64:string};
export type BotImageApi={cancel(requestId:string):Promise<ApiResult<void>>;set(input:BotImageSetInput):Promise<ApiResult<Bot>>;clear(input:BotImageClearInput):Promise<ApiResult<Bot>>;read(input:BotImageReadInput):Promise<ApiResult<BotImagePixels|null>>};
