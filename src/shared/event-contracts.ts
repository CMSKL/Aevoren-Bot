import type { ApiResult } from "./contracts";
import type { RoutineTargetSnapshot } from "./routine-contracts";

export type AutomationEventSource = { kind: "webhook" } | { kind: "runtime.completed" | "runtime.failed"; sessionId: string };
export type EventSubscription = {
  id: string; name: string; source: AutomationEventSource; routineId: string; routineVersion: number;
  targetSnapshot: RoutineTargetSnapshot; enabled: boolean; version: number; hasToken: boolean;
  webhookPath: string | null; createdAt: string; updatedAt: string;
};
export type EventSubscriptionCreate = { name: string; source: AutomationEventSource; routineId: string; expectedRoutineVersion: number; enabled?: boolean };
export type EventSubscriptionUpdate = { id: string; expectedVersion: number; patch: Partial<EventSubscriptionCreate> };
export type EventVersionInput = { id: string; expectedVersion: number };
export type EventDeliveryState = "accepted" | "dispatching" | "dispatched" | "cancel-requested" | "cancelled" | "failed" | "unknown";
/** Receipt metadata only. Neither inbound payload nor authentication secrets are public. */
export type EventDelivery = {
  id: string; subscriptionId: string; subscriptionVersion: number; routineId: string; routineVersion: number;
  source: AutomationEventSource; targetSnapshot: RoutineTargetSnapshot; eventId: string; payloadDigest: string;
  ancestry: string[]; state: EventDeliveryState; routineRunId: string | null; version: number; errorCode: string | null;
  createdAt: string; updatedAt: string;
};
export type EventListenerState = { listening: boolean; host: "127.0.0.1"; port: number | null; revision: string; busy: boolean };
export type EventListenerControl = { expectedRevision: string; port: number };
export type EventSnapshot = { subscriptions: EventSubscription[]; deliveries: EventDelivery[]; listener: EventListenerState };
export type EventTokenReceipt = { subscription: EventSubscription; token: string };
export type EventApi = {
  onChanged(listener: () => void): () => void;
  snapshot(): Promise<ApiResult<EventSnapshot>>;
  create(input: EventSubscriptionCreate): Promise<ApiResult<EventSubscription>>;
  update(input: EventSubscriptionUpdate): Promise<ApiResult<EventSubscription>>;
  revoke(input: EventVersionInput): Promise<ApiResult<EventSubscription>>;
  cancel(input: EventVersionInput): Promise<ApiResult<EventDelivery>>;
  /** Credential management stays outside the AI operation catalog. */
  rotateToken(input: EventVersionInput): Promise<ApiResult<EventTokenReceipt>>;
  startListener(input: EventListenerControl): Promise<ApiResult<EventListenerState>>;
  stopListener(input: EventListenerControl): Promise<ApiResult<EventListenerState>>;
};
