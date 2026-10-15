import { AUTOMATION_EVENT_PRODUCT_OPERATIONS } from "@shared/event-product";
import { eventCreateSchema, eventUpdateSchema, eventVersionSchema } from "@shared/event-schemas";
import type { EventService } from "./event-service";
import type { EventHttpServer } from "./event-http-server";
import type { RoutineService } from "./routine-service";
import type { LibraryExecutionContext } from "./library-product-handlers";
import { AevorenBotError } from "./errors";
export type AutomationEventDependencies = { automationEventService?: EventService; automationEventHttp?: EventHttpServer; routineService: RoutineService };
export function addAutomationEventHandlers(handlers: Map<string, (input?: unknown) => unknown>, dependencies: AutomationEventDependencies, commit: <T>(operation: () => T) => T, context?: LibraryExecutionContext): void {
  for (const definition of AUTOMATION_EVENT_PRODUCT_OPERATIONS) handlers.set(definition.channel, input => {
    const service = dependencies.automationEventService; if (!service) throw new AevorenBotError("INTERNAL_ERROR");
    if (context) { dependencies.routineService.assertOperationScope("routines.list", undefined, context); service.assertOperationScope(definition.name, input, context); context.signal?.throwIfAborted(); }
    switch (definition.name) {
      case "automationEvents.snapshot": return { ...service.snapshot(context), listener: dependencies.automationEventHttp?.snapshot() ?? { listening: false, host: "127.0.0.1", port: null } };
      case "automationEvents.create": return commit(() => service.create(eventCreateSchema.parse(input), context));
      case "automationEvents.update": return service.update(eventUpdateSchema.parse(input), context, commit);
      case "automationEvents.revoke": return service.revoke(eventVersionSchema.parse(input), context, commit);
      case "automationEvents.cancel": return service.cancel(eventVersionSchema.parse(input), context, commit);
      default: throw new AevorenBotError("INVALID_REQUEST");
    }
  });
}
