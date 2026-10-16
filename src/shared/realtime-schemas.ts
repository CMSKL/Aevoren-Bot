import { z } from "zod";
import { sendCommandSchema } from "./schemas";
const id = z.string().uuid();
export const realtimeInputSchema = z.object({ sessionId: id, id }).strict();
export const realtimeStartSchema = z.object({
  sessionId: id, executorBotId: id, expectedConfigVersion: z.number().int().positive(),
  routingMode: z.enum(["automatic", "explicit", "everyone"]), targetBotIds: z.array(id).max(6).refine(ids => new Set(ids).size === ids.length),
  resourceRefs: sendCommandSchema.shape.resourceRefs, mediaRefs: sendCommandSchema.shape.mediaRefs,
}).strict().refine(input => input.routingMode === "automatic" ? input.targetBotIds.length === 0 : input.targetBotIds.length > 0);
export const realtimeAppendSchema = realtimeInputSchema.extend({captureId: id, sequence: z.number().int().nonnegative(),
  dataBase64: z.string().min(4).max(32_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)});
export const realtimeCommitSchema = realtimeInputSchema.extend({captureId: id, lastSequence: z.number().int().nonnegative()});
export const realtimePlaybackSchema = realtimeInputSchema.extend({playbackEpoch: z.number().int().nonnegative(),
  responseId: z.string().min(1).max(200), itemId: z.string().min(1).max(200), contentIndex: z.number().int().nonnegative(), playedSamples: z.number().int().nonnegative()});
