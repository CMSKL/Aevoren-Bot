import { z } from "zod";
import { messageMediaReferenceSchema } from "./media-schemas";
const id=z.string().uuid();
export const botImageSetSchema=z.object({botId:id,expectedVersion:z.number().int().positive(),sessionId:id,reference:messageMediaReferenceSchema,requestId:id.optional()}).strict();
export const botImageClearSchema=z.object({botId:id,expectedVersion:z.number().int().positive()}).strict();
export const botImageReadSchema=z.object({botId:id,expectedImageId:id.optional()}).strict();
