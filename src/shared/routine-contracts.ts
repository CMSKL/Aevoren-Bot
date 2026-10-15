import type { RoutineSchedule } from "./contracts";
import type { ResourceReference } from "./library-contracts";
import type { MessageMediaReference } from "./media-contracts";

/** First group-automation delivery supports MAIN sessions only. */
export type RoutineTarget =
  | { kind: "bot"; sessionId: string; botId: string }
  | { kind: "room"; sessionId: string; roomId: string; routingMode: "everyone" | "explicit"; targetBotIds: string[]; expectedMembershipVersion: number };
export type RoutineTargetSnapshot = {
  target: RoutineTarget; generation: number; scopeVersion: number; membershipVersion: number | null;
  profileVersions: { botId: string; version: number }[]; resourceRefs: ResourceReference[]; mediaRefs: MessageMediaReference[];
  admissionDigest: string; legacy?: boolean;
};
export type RoutineCreateInput = { name: string; prompt: string; schedule: RoutineSchedule; enabled?: boolean; resourceRefs?: ResourceReference[]; mediaRefs?: MessageMediaReference[] }
  & ({ botId: string; target?: never } | { target: RoutineTarget; botId?: never });
export type RoutineUpdatePatch = { name?: string; prompt?: string; schedule?: RoutineSchedule; target?: RoutineTarget; resourceRefs?: ResourceReference[]; mediaRefs?: MessageMediaReference[] };
export type RoutineRunCancelInput = { runId: string; expectedVersion: number };
/** Internal durable bridge for a future event inbox. This does not subscribe to events or accept payload text. */
export type RoutineTriggerInput = { routineId: string; expectedVersion: number; triggerKey: string; trigger?: "manual" | "schedule" | "event"; scheduledFor?: number };

export type RoutineContext = { sessionId: string; executorBotId: string; runtimeRunId?: string };
export type RoutineRunNowInput = string | { id: string; expectedVersion: number };
