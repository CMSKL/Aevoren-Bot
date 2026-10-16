import type { ProductOperationDefinition } from "./product-operations";
import { BOT_IMAGE_CHANNELS } from "./bot-image-channels";
import { botImageSetSchema,botImageClearSchema,botImageReadSchema } from "./bot-image-schemas";
export const BOT_IMAGE_OPERATION_SCHEMAS={"bots.setImageAvatar":botImageSetSchema.omit({requestId:true}).partial({sessionId:true}),"bots.clearImageAvatar":botImageClearSchema,"bots.readImageAvatar":botImageReadSchema};
export const BOT_IMAGE_PRODUCT_OPERATIONS:readonly ProductOperationDefinition[]=[
 {name:"bots.setImageAvatar",channel:BOT_IMAGE_CHANNELS.set,description:"将当前授权图片发布为指定 Bot 头像；会在此 Bot 的所有会话显示，需明确审批",effectClass:"write-reversible",interaction:"none"},
 {name:"bots.clearImageAvatar",channel:BOT_IMAGE_CHANNELS.clear,description:"移除指定 Bot 图片头像，恢复现有形状与颜色",effectClass:"write-reversible",interaction:"none"},
 {name:"bots.readImageAvatar",channel:BOT_IMAGE_CHANNELS.read,description:"读取已经明确发布的 Bot 头像真实像素；不读取原会话的其他媒体",effectClass:"read-local",interaction:"none"},
];
