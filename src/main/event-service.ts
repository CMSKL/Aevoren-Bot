import { randomBytes, timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import type { AttachmentDraft, Routine, RoutineRun } from "@shared/contracts";
import type { EventDelivery, EventSubscription, EventSubscriptionCreate, EventSubscriptionUpdate, EventTokenReceipt, EventVersionInput } from "@shared/event-contracts";
import { eventCreateSchema, eventUpdateSchema, eventVersionSchema, runtimeEventSchema } from "@shared/event-schemas";
import type { RoutineTriggerInput } from "@shared/routine-contracts";
import type { SecretCodec } from "./settings";
import { AevorenBotError } from "./errors";
import { canonicalEventPayload, eventDigest, EventRepository, EventStateError } from "./event-repository";

/** Host bridge. The event body can only enter through the untrusted attachment argument. */
export interface EventRoutineBridge {
  list(): Routine[];
  createTriggerRun(input: RoutineTriggerInput, attachment?: AttachmentDraft): Promise<RoutineRun>;
  getByTriggerKey(key: string): RoutineRun | null;
  cancelRun(input: { runId: string; expectedVersion: number }): Promise<RoutineRun>;
}
export type EventActorScope = { sessionId: string };
export type RuntimeAutomationEvent = z.infer<typeof runtimeEventSchema>;
const terminalRun = (run: RoutineRun) => ["completed", "failed", "cancelled", "missed", "unknown"].includes(run.state);
type EventCommit = <T>(operation: () => T) => T;

export class EventService {
  private readonly dispatches = new Map<string, Promise<EventDelivery>>();
  private closing = false;
  constructor(private readonly repository: EventRepository, private readonly routines: EventRoutineBridge,
    private readonly codec: SecretCodec, private readonly notify: () => void = () => {},
    private readonly host?: { assertSourceSession(id: string): void }) {}

  private routine(id: string): Routine {
    const routine = this.routines.list().find(value => value.id === id);
    if (!routine) throw new EventStateError("EVENT_NOT_FOUND");
    return routine;
  }
  private scope(hook: Pick<EventSubscription, "source" | "targetSnapshot">, actor?: EventActorScope): void {
    if (actor && (hook.targetSnapshot.target.sessionId !== actor.sessionId || hook.source.kind !== "webhook" && hook.source.sessionId !== actor.sessionId)) throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
  }
  snapshot(actor?: EventActorScope): { subscriptions: EventSubscription[]; deliveries: EventDelivery[] } {
    const subscriptions = this.repository.list().filter(hook => !actor || hook.targetSnapshot.target.sessionId === actor.sessionId && (hook.source.kind === "webhook" || hook.source.sessionId === actor.sessionId));
    const ids = new Set(subscriptions.map(hook => hook.id));
    return { subscriptions, deliveries: this.repository.deliveries().filter(value => ids.has(value.subscriptionId)) };
  }
  assertOperationScope(operation: string, input: unknown, actor: EventActorScope): void {
    if (operation === "automationEvents.snapshot") return;
    if (operation === "automationEvents.create") {
      const parsed = eventCreateSchema.parse(input); this.scope({ source: parsed.source, targetSnapshot: this.routine(parsed.routineId).targetSnapshot }, actor); return;
    }
    const parsed = operation === "automationEvents.update" ? eventUpdateSchema.parse(input) : eventVersionSchema.parse(input);
    if (operation === "automationEvents.cancel") { this.scope(this.repository.getDelivery(parsed.id), actor); return; }
    const hook = this.repository.get(parsed.id); this.scope(hook, actor);
    if (operation === "automationEvents.update") { const patch = (parsed as EventSubscriptionUpdate).patch; this.scope({ source: patch.source ?? hook.source, targetSnapshot: this.routine(patch.routineId ?? hook.routineId).targetSnapshot }, actor); }
  }
  private source(source: EventSubscription["source"]): void { if (source.kind !== "webhook") this.host?.assertSourceSession(source.sessionId); }
  create(input: EventSubscriptionCreate, actor?: EventActorScope): EventSubscription {
    const parsed = eventCreateSchema.parse(input), routine = this.routine(parsed.routineId);
    this.source(parsed.source);
    this.scope({ source: parsed.source, targetSnapshot: routine.targetSnapshot }, actor);
    const created = this.repository.create(parsed, routine); this.notify(); return created;
  }
  async update(input: EventSubscriptionUpdate, actor?: EventActorScope, commit: EventCommit = action => action()): Promise<EventSubscription> {
    const parsed = eventUpdateSchema.parse(input), current = this.repository.get(parsed.id); this.scope(current, actor);
    const routine = this.routine(parsed.patch.routineId ?? current.routineId);
    this.source(parsed.patch.source ?? current.source);
    this.scope({ source: parsed.patch.source ?? current.source, targetSnapshot: routine.targetSnapshot }, actor);
    const updated = commit(() => this.repository.update(parsed, routine)); this.notify();
    await this.cancelOwned(current.id);
    return updated;
  }
  /** Trusted UI only. Secrets never appear in snapshots, receipts or operation metadata. */
  async rotateToken(input: EventVersionInput): Promise<EventTokenReceipt> {
    const parsed = eventVersionSchema.parse(input), hook = this.repository.get(parsed.id);
    if (hook.source.kind !== "webhook") throw new EventStateError("EVENT_INVALID");
    if (!this.codec.isAvailable()) throw new AevorenBotError("SECURE_STORAGE_UNAVAILABLE");
    const token = randomBytes(32).toString("base64url"), subscription = this.repository.setToken(parsed.id, parsed.expectedVersion, this.codec.encrypt(token));
    this.notify(); await this.cancelOwned(hook.id);
    return { subscription, token };
  }
  async revoke(input: EventVersionInput, actor?: EventActorScope, commit: EventCommit = action => action()): Promise<EventSubscription> {
    const parsed = eventVersionSchema.parse(input), hook = this.repository.get(parsed.id); this.scope(hook, actor);
    const updated = commit(() => this.repository.setToken(parsed.id, parsed.expectedVersion, null)); this.notify(); await this.cancelOwned(hook.id); return updated;
  }
  authenticate(id: string, version: number, bearer: string): EventSubscription {
    if (this.closing) throw new EventStateError("EVENT_STOPPED");
    let hook: EventSubscription;
    try { hook = this.repository.assertAccepting(id, version); } catch { throw new EventStateError("EVENT_UNAUTHORIZED"); }
    if (hook.source.kind !== "webhook" || !this.codec.isAvailable() || !/^[A-Za-z0-9_-]{43}$/.test(bearer)) throw new EventStateError("EVENT_UNAUTHORIZED");
    try {
      const encrypted = this.repository.token(id), token = encrypted ? this.codec.decrypt(encrypted) : "";
      const supplied = Buffer.from(bearer), expected = Buffer.from(token);
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new EventStateError("EVENT_UNAUTHORIZED");
    } catch { throw new EventStateError("EVENT_UNAUTHORIZED"); }
    return hook;
  }
  async receiveWebhook(input: { id: string; version: number; bearer: string; eventId: string; payload: unknown }): Promise<EventDelivery> {
    const hook = this.authenticate(input.id, input.version, input.bearer);
    return this.accept(hook, input.eventId, input.payload, []);
  }
  /** Caller supplies only verified Runtime IDs/state; ancestry is recovered from our own ledger. */
  async emitRuntime(input: RuntimeAutomationEvent): Promise<EventDelivery[]> {
    if (this.closing) throw new EventStateError("EVENT_STOPPED");
    const parsed = runtimeEventSchema.parse(input);
    let ancestry = parsed.originRoutineRunId ? this.repository.ancestryForRun(parsed.originRoutineRunId) : [];
    // A fast Runtime can complete before createTriggerRun's awaiting caller has linked its receipt.
    // The Routine bridge already persisted its trigger key before starting that Runtime.
    if (parsed.originRoutineRunId && ancestry.length === 0) {
      const pending = this.repository.pending().find(receipt => this.known(receipt)?.id === parsed.originRoutineRunId);
      if (pending) ancestry = pending.ancestry;
    }
    const hooks = this.repository.list().filter(hook => hook.enabled && hook.source.kind === `runtime.${parsed.state}` && "sessionId" in hook.source && hook.source.sessionId === parsed.sessionId && !ancestry.includes(hook.id) && ancestry.length < 4);
    return Promise.all(hooks.map(hook => this.accept(hook, parsed.eventId, { eventId: parsed.eventId, sessionId: parsed.sessionId, runtimeRunId: parsed.runtimeRunId, state: parsed.state }, ancestry)));
  }
  private accept(hook: EventSubscription, eventId: string, payload: unknown, ancestry: string[]): Promise<EventDelivery> {
    if (ancestry.includes(hook.id) || ancestry.length >= 4) return Promise.reject(new EventStateError("EVENT_LOOP"));
    const delivery = this.repository.accept(hook, eventId, payload, [...ancestry, hook.id]); this.notify();
    if (delivery.state !== "accepted") return this.dispatches.get(delivery.id) ?? Promise.resolve(delivery);
    const existing = this.dispatches.get(delivery.id);
    if (existing) return existing;
    const promise = this.dispatch(delivery.id).finally(() => this.dispatches.delete(delivery.id));
    this.dispatches.set(delivery.id, promise);
    return promise;
  }
  private known(delivery: EventDelivery): RoutineRun | null {
    const run = this.routines.getByTriggerKey(this.repository.privateData(delivery.id).triggerKey);
    if (run && (run.routineId !== delivery.routineId || canonicalEventPayload(run.targetSnapshot) !== canonicalEventPayload(delivery.targetSnapshot))) throw new EventStateError("EVENT_INVALID");
    return run;
  }
  private async dispatch(id: string): Promise<EventDelivery> {
    let receipt = this.repository.getDelivery(id);
    try {
      if (this.closing) throw new EventStateError("EVENT_STOPPED");
      this.repository.assertAccepting(receipt.subscriptionId, receipt.subscriptionVersion);
      const routine = this.routine(receipt.routineId);
      if (!routine.enabled || routine.version !== receipt.routineVersion || canonicalEventPayload(routine.targetSnapshot) !== canonicalEventPayload(receipt.targetSnapshot)) throw new EventStateError("EVENT_VERSION_CONFLICT");
      receipt = this.repository.transition(id, "dispatching"); this.notify();
      const data = this.repository.privateData(id), content = canonicalEventPayload(data.payload);
      const attachment: AttachmentDraft = { id: data.attachmentId, name: "automation-event.json", mimeType: "application/json", kind: "text", content, size: Buffer.byteLength(content), sha256: eventDigest(content) };
      const run = await this.routines.createTriggerRun({ routineId: receipt.routineId, expectedVersion: receipt.routineVersion, triggerKey: data.triggerKey, trigger: "event" }, attachment);
      receipt = this.repository.link(id, run.id);
      if (["cancel-requested", "cancelled"].includes(receipt.state)) await this.stopReceipt(receipt, run);
    } catch (error) {
      receipt = this.repository.getDelivery(id);
      try {
        const run = this.known(receipt);
        if (run) { receipt = this.repository.link(id, run.id); if (["cancel-requested", "cancelled"].includes(receipt.state)) await this.stopReceipt(receipt, run); }
        else this.repository.transition(id, error instanceof EventStateError || error instanceof AevorenBotError ? "failed" : "unknown", { errorCode: error instanceof EventStateError || error instanceof AevorenBotError ? error.code : "INTERNAL_ERROR" });
      } catch { this.repository.transition(id, "unknown", { errorCode: "EVENT_INVALID" }); }
    }
    this.notify(); return this.repository.getDelivery(id);
  }
  async cancel(input: EventVersionInput, actor?: EventActorScope, commit: EventCommit = action => action()): Promise<EventDelivery> {
    const parsed = eventVersionSchema.parse(input); let receipt = this.repository.getDelivery(parsed.id); this.scope(receipt, actor);
    if (receipt.version !== parsed.expectedVersion) throw new EventStateError("EVENT_VERSION_CONFLICT", receipt.version);
    if (["cancelled", "failed"].includes(receipt.state)) return receipt;
    const known = this.known(receipt);
    if (receipt.state === "unknown") { if (!known) return receipt; receipt = this.repository.link(receipt.id, known.id); }
    // An already completed handoff cannot be undone by pausing its subscription.
    if (known && terminalRun(known) && known.state !== "cancelled") return this.repository.link(receipt.id, known.id);
    const cancelling = commit(() => this.repository.transition(receipt.id, "cancel-requested")); this.notify();
    await this.stopReceipt(cancelling, known);
    return this.repository.getDelivery(receipt.id);
  }
  private async stopReceipt(receipt: EventDelivery, run: RoutineRun | null): Promise<void> {
    if (!run) { if (!this.dispatches.has(receipt.id)) this.repository.transition(receipt.id, "cancelled"); return; }
    const result = terminalRun(run) ? run : await this.routines.cancelRun({ runId: run.id, expectedVersion: run.version });
    if (terminalRun(result)) this.repository.transition(receipt.id, "cancelled");
  }
  private async cancelOwned(id: string): Promise<void> {
    await Promise.all(this.repository.pending(id).map(receipt => this.cancel({ id: receipt.id, expectedVersion: receipt.version })));
  }
  /** Startup reconciliation only reads existing trigger receipts; it never invokes createTriggerRun. */
  async reconcile(): Promise<void> {
    for (const receipt of this.repository.pending()) {
      if (this.dispatches.has(receipt.id) || !["accepted", "dispatching", "unknown", "cancel-requested"].includes(receipt.state)) continue;
      try {
        const run = this.known(receipt);
        if (run) { const linked = this.repository.link(receipt.id, run.id); if (linked.state === "cancel-requested") await this.stopReceipt(linked, run); }
        else this.repository.transition(receipt.id, receipt.state === "cancel-requested" ? "cancelled" : "unknown");
      } catch { this.repository.transition(receipt.id, "unknown", { errorCode: "EVENT_INVALID" }); }
    }
    this.notify();
  }
  async shutdown(): Promise<void> { this.closing = true; await Promise.allSettled(this.dispatches.values()); }
}
