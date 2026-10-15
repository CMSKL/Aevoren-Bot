import { browserScopeSchema } from "@shared/browser-schemas";
import { DEMONSTRATION_OPERATION_SCHEMAS, DEMONSTRATION_PRODUCT_OPERATIONS } from "@shared/demonstration-product";
import { demonstrationDeleteSchema, demonstrationDraftInputSchema, demonstrationPublishSchema, demonstrationRecordSchema, demonstrationUpdateSchema } from "@shared/demonstration-schemas";
import type { AppRepository } from "./database";
import type { DemonstrationService } from "./demonstration-service";
import type { LibraryExecutionContext } from "./library-product-handlers";
import { AevorenBotError } from "./errors";
export type DemonstrationProductDependencies = { repository: AppRepository; demonstrationService?: DemonstrationService };
export function addDemonstrationProductHandlers(handlers: Map<string, (input?: unknown) => unknown>, dependencies: DemonstrationProductDependencies, commit: <T>(work: () => T) => T = work => work(), context?: LibraryExecutionContext): void {
  for (const definition of DEMONSTRATION_PRODUCT_OPERATIONS) handlers.set(definition.channel, async input => {
    const raw = (input ?? {}) as Record<string, unknown>;
    if (context && (raw.sessionId !== undefined && raw.sessionId !== context.sessionId || raw.executorBotId !== undefined && raw.executorBotId !== context.executorBotId)) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    const scoped = context ? { ...raw, sessionId: context.sessionId, executorBotId: context.executorBotId } : raw;
    const parsed = context ? DEMONSTRATION_OPERATION_SCHEMAS[definition.name as keyof typeof DEMONSTRATION_OPERATION_SCHEMAS].parse(scoped) : scoped;
    const call = { actor: context ? "ai" as const : "user" as const, signal: context?.signal, runtimeRunId: context?.runtimeRunId };
    if (!dependencies.demonstrationService) throw new AevorenBotError("DEMONSTRATION_UNSUPPORTED"); const service = dependencies.demonstrationService;
    if (context && ["start", "stop", "discard"].some(method => definition.name === `demonstrations.${method}`)) { dependencies.repository.assertSessionExecutor(context.sessionId, context.executorBotId); context.signal?.throwIfAborted(); return { status: "waiting_user", reason: "请用户在当前成员电脑面板明确操作示范录制。接管期间不向 AI 提供录制步骤或原始输入。" }; }
    switch (definition.name) {
      case "demonstrations.status": return service.status(browserScopeSchema.parse(parsed), call);
      case "demonstrations.start": return service.start(demonstrationRecordSchema.parse(parsed), call);
      case "demonstrations.stop": return service.stop(demonstrationRecordSchema.parse(parsed), call);
      case "demonstrations.discard": return service.discard(demonstrationRecordSchema.parse(parsed), call);
      case "demonstrations.drafts": return service.drafts(browserScopeSchema.parse(parsed), call);
      case "demonstrations.readDraft": return service.readDraft(demonstrationDraftInputSchema.parse(parsed), call);
      case "demonstrations.deleteDraft": return commit(() => service.deleteDraft(demonstrationDeleteSchema.parse(parsed), call));
      case "demonstrations.updateDraft": return commit(() => service.updateDraft(demonstrationUpdateSchema.parse(parsed), call));
      case "demonstrations.publish": return commit(() => service.publish(demonstrationPublishSchema.parse(parsed), call));
    }
  });
}
