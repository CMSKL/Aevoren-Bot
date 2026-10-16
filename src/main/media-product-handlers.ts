import { MEDIA_PRODUCT_OPERATIONS } from "@shared/media-product";
import { mediaAvailableSchema, mediaIdSchema, mediaImportPathSchema, mediaListSchema, mediaMutationSchema, mediaPreviewSchema, mediaReadSchema, mediaScopeSchema, mediaSetEnabledSchema } from "@shared/media-schemas";
import type { MediaScope } from "@shared/media-contracts";
import type { LibraryExecutionContext } from "./library-product-handlers";
import type { MediaExecutionContext, MediaService } from "./media-service";
import { AevorenBotError } from "./errors";

export type MediaProductDependencies = {
  mediaService?: MediaService;
  pickMediaPaths?(input: MediaScope, signal?: AbortSignal): Promise<string[] | null>;
};

export function addMediaProductHandlers(handlers: Map<string, (input?: unknown) => unknown>, dependencies: MediaProductDependencies,
  commit: <T>(operation: () => T) => T = operation => operation(), context?: LibraryExecutionContext): void {
  for (const definition of MEDIA_PRODUCT_OPERATIONS) handlers.set(definition.channel, async input => {
    const service = dependencies.mediaService;
    if (!service) throw new AevorenBotError("MEDIA_PARSER_UNAVAILABLE");
    context?.signal?.throwIfAborted();
    const execution: MediaExecutionContext = context ?? {};
    if (definition.name === "media.available") return service.available(mediaAvailableSchema.parse(input ?? {}));
    let scoped = input;
    if (context) {
      if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new AevorenBotError("INVALID_REQUEST");
      const supplied = (input ?? {}) as Record<string, unknown>;
      if (supplied.sessionId !== undefined && supplied.sessionId !== context.sessionId) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
      scoped = { ...supplied, sessionId: context.sessionId };
    }
    switch (definition.name) {
      case "media.list": return service.list(mediaListSchema.parse(scoped), execution);
      case "media.metadata": return service.metadata(mediaIdSchema.parse(scoped), execution);
      case "media.read": return service.readForUi(mediaReadSchema.parse(scoped), execution);
      case "media.preview": return service.previewForUi(mediaPreviewSchema.parse(scoped), execution);
      case "media.pickImport": {
        const scope = mediaScopeSchema.parse(scoped);
        const paths = await dependencies.pickMediaPaths?.(scope, context?.signal);
        context?.signal?.throwIfAborted();
        if (!paths?.length) return null;
        const prepared = await service.prepareImportPaths(scope.sessionId, paths, execution);
        return commit(() => service.commitImport(prepared, execution));
      }
      case "media.importPath": {
        const prepared = await service.prepareImportPath(mediaImportPathSchema.parse(scoped), execution);
        return commit(() => service.commitImport(prepared, execution));
      }
      case "media.bind": return commit(() => service.bind(mediaIdSchema.parse(scoped), execution));
      case "media.unbind": return commit(() => service.unbind(mediaIdSchema.parse(scoped), execution));
      case "media.setEnabled": return commit(() => service.setEnabled(mediaSetEnabledSchema.parse(scoped), execution));
      case "media.delete": return commit(() => service.delete(mediaMutationSchema.parse(scoped), execution));
      case "media.restore": return commit(() => service.restore(mediaMutationSchema.parse(scoped), execution));
      default: throw new AevorenBotError("INVALID_REQUEST");
    }
  });
}
