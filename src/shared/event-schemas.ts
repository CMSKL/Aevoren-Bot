import { z } from "zod";
const id = z.string().uuid(), version = z.number().int().positive();
export const eventSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("webhook") }).strict(),
  z.object({ kind: z.literal("runtime.completed"), sessionId: id }).strict(),
  z.object({ kind: z.literal("runtime.failed"), sessionId: id }).strict(),
]);
const configuration = { name: z.string().trim().min(1).max(120), source: eventSourceSchema, routineId: id, expectedRoutineVersion: version, enabled: z.boolean().optional() };
export const eventCreateSchema = z.object(configuration).strict();
export const eventUpdateSchema = z.object({ id, expectedVersion: version, patch: z.object(configuration).partial().strict().refine(value => Object.keys(value).length > 0 && (value.routineId === undefined || value.expectedRoutineVersion !== undefined)) }).strict();
export const eventVersionSchema = z.object({ id, expectedVersion: version }).strict();
export const eventListenerSchema = z.object({ port: z.number().int().min(0).max(65535).optional() }).strict();
export const eventIdempotencySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
/** Host-only metadata. Runtime text, arguments, credentials and approval fields cannot enter this envelope. */
export const runtimeEventSchema = z.object({
  eventId: eventIdempotencySchema, sessionId: id, runtimeRunId: id, state: z.enum(["completed", "failed"]), originRoutineRunId: id.optional(),
}).strict();
