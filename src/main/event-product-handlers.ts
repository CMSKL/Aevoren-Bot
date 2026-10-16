import { AUTOMATION_EVENT_PRODUCT_OPERATIONS } from "@shared/event-product";
import { eventCreateSchema, eventUpdateSchema, eventVersionSchema, eventListenerStartSchema, eventListenerStopSchema } from "@shared/event-schemas";
import type { EventService } from "./event-service";
import type { EventHttpServer } from "./event-http-server";
import type { RoutineService } from "./routine-service";
import type { LibraryExecutionContext } from "./library-product-handlers";
import { AevorenBotError } from "./errors";
export type AutomationEventDependencies = { automationEventService?: EventService; automationEventHttp?: EventHttpServer; routineService: RoutineService };
export function addAutomationEventHandlers(handlers: Map<string, (input?: unknown) => unknown>, dependencies: AutomationEventDependencies, commit: <T>(operation: () => T) => T, context?: LibraryExecutionContext): void {
  for (const definition of AUTOMATION_EVENT_PRODUCT_OPERATIONS) handlers.set(definition.channel, input => {
    const service = dependencies.automationEventService; if (!service) throw new AevorenBotError("INTERNAL_ERROR");
    const listenerControl = definition.name === "automationEvents.startListener" || definition.name === "automationEvents.stopListener";
    const assertActor = (): void => { if (context) { context.signal?.throwIfAborted(); dependencies.routineService.assertOperationScope("routines.list", undefined, context); } };
    assertActor();
    if (context && !listenerControl) service.assertOperationScope(definition.name, input, context);
    if (listenerControl && !dependencies.automationEventHttp) throw new AevorenBotError("INTERNAL_ERROR");
    switch (definition.name) {
      case "automationEvents.startListener": {
        const parsed = eventListenerStartSchema.parse(input);
        if (context && parsed.port === 0) throw new AevorenBotError("INVALID_REQUEST");
        return dependencies.automationEventHttp!.startControlled(parsed, { signal: context?.signal, assertCurrent: assertActor }, value => commit(() => value));
      }
      case "automationEvents.stopListener": return dependencies.automationEventHttp!.stopControlled(eventListenerStopSchema.parse(input), { signal: context?.signal, assertCurrent: assertActor }, value => commit(() => value));
      case "automationEvents.snapshot": return { ...service.snapshot(context), listener: dependencies.automationEventHttp?.snapshot() ?? { listening: false, host: "127.0.0.1", port: null, revision: "", busy: false } };
      case "automationEvents.create": return commit(() => service.create(eventCreateSchema.parse(input), context));
      case "automationEvents.update": return service.update(eventUpdateSchema.parse(input), context, commit);
      case "automationEvents.revoke": return service.revoke(eventVersionSchema.parse(input), context, commit);
      case "automationEvents.cancel": return service.cancel(eventVersionSchema.parse(input), context, commit);
      default: throw new AevorenBotError("INVALID_REQUEST");
    }
  });
}
