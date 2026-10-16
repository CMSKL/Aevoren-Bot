import { z } from "zod";
import { resourceReferencesSchema } from "./library-schemas";
import { messageMediaReferencesSchema } from "./media-schemas";
const id = z.string().uuid(), version = z.number().int().positive();
export const routineTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), sessionId: id, botId: id }).strict(),
  z.object({ kind: z.literal("room"), sessionId: id, roomId: id, routingMode: z.enum(["everyone", "explicit"]).default("everyone"), expectedMembershipVersion: version, targetBotIds: z.array(id).min(1).max(6).refine(items => new Set(items).size === items.length) }).strict(),
]);
export const routineResourcesShape = { resourceRefs: resourceReferencesSchema.optional(), mediaRefs: messageMediaReferencesSchema.optional() };
export const routineRunCancelSchema = z.object({ runId: id, expectedVersion: version }).strict();
export const routineTriggerSchema = z.object({ routineId: id, expectedVersion: version, triggerKey: z.string().min(1).max(500), trigger: z.enum(["manual", "schedule", "event"]).optional(), scheduledFor: z.number().int().nonnegative().optional() }).strict();

export const routineRunNowSchema = z.object({ id, expectedVersion: version }).strict();
export const routineRunNowIpcSchema = z.union([id, routineRunNowSchema]);
