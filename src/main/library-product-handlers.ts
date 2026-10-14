import type {
  LibraryChangedEvent, LibraryContent, LibraryExportResult, LibraryReadInput,
  LibraryResourceKind, SessionResourceBinding,
} from "@shared/library-contracts";
import { LIBRARY_OPERATION_SCHEMAS, LIBRARY_PRODUCT_OPERATIONS } from "@shared/library-product";
import {
  libraryAvailableSchema, libraryBindingSchema, libraryCreateSchema, libraryExportSchema,
  libraryImportPathSchema, libraryListSchema, libraryMutationSchema, libraryPickImportSchema,
  libraryReadSchema, libraryRestoreVersionSchema, librarySetEnabledSchema, libraryUpdateSchema,
  libraryVersionsSchema,
} from "@shared/library-schemas";
import type { AppRepository } from "./database";
import type { LibraryService } from "./library-service";
import { assertLibraryNotCancelled } from "./library-blob-store";
import { AevorenBotError } from "./errors";

export type LibraryProductContext = { runtimeRunId: string; executorBotId: string; sessionId: string; signal?: AbortSignal };
export type LibraryExecutionContext = LibraryProductContext;
export type LibraryProductDependencies = {
  repository: AppRepository;
  libraryService?: LibraryService;
  pickLibraryPaths?(input: { sessionId: string; kind: LibraryResourceKind; directory?: boolean }, signal?: AbortSignal): Promise<string[] | null>;
  exportLibraryResource?(input: { sessionId: string; id: string; revisionId?: string }, signal?: AbortSignal): Promise<LibraryExportResult | null>;
  libraryChanged?(event: LibraryChangedEvent): void;
};

function page(body: string, input: { offset?: number; maxCharacters?: number }): { body: string; offset: number; fullLength: number; truncated: boolean; nextOffset: number | null } {
  const offset = input.offset ?? 0;
  const end = Math.min(body.length, offset + (input.maxCharacters ?? 18_000));
  return { body: body.slice(offset, end), offset, fullLength: body.length,
    truncated: offset > 0 || end < body.length, nextOffset: end < body.length ? end : null };
}

export function addLibraryProductHandlers(
  handlers: Map<string, (input?: unknown) => unknown>, dependencies: LibraryProductDependencies,
  commit: <T>(operation: () => T) => T = (operation) => operation(), context?: LibraryProductContext,
): void {
  const library = dependencies.repository.library;
  const actor = context?.executorBotId;
  const signal = context?.signal;
  const service = (): LibraryService => {
    if (!dependencies.libraryService) throw new AevorenBotError("INTERNAL_ERROR", "资料服务尚未初始化。");
    return dependencies.libraryService;
  };
  const scopedInput = (input: unknown): unknown => {
    assertLibraryNotCancelled(signal);
    if (!context) return input;
    if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new AevorenBotError("INVALID_REQUEST");
    const value = (input ?? {}) as Record<string, unknown>;
    if (value.sessionId !== undefined && value.sessionId !== context.sessionId) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    dependencies.repository.assertSessionExecutor(context.sessionId, context.executorBotId);
    return { ...value, sessionId: context.sessionId };
  };
  const contentResult = (content: LibraryContent, pagination: { offset?: number; maxCharacters?: number } = {}, alwaysPage = false): unknown => {
    if (!context && !alwaysPage) return content;
    if (context && (!content.resource.enabled || content.resource.deletedAt)) {
      const { id, number, name, description, digest, createdAt } = content.revision;
      return { resource: content.resource, reference: content.reference,
        revision: { id, number, name, description, digest, createdAt, fileCount: content.revision.files.length }, bodyAvailable: false };
    }
    const { body, ...details } = page(content.revision.body, pagination);
    return { ...content, revision: { ...content.revision, body }, ...details, digest: content.revision.digest };
  };
  const requireKind = (input: { sessionId: string; id: string }, kind?: LibraryResourceKind): void => {
    if (!kind) return;
    // A mutation can recover an inactive resource; this read stays internal and exposes no body to AI.
    const current = library.read({ sessionId: input.sessionId, id: input.id, includeDisabled: true, includeDeleted: true }, actor);
    if (current.resource.kind !== kind) throw new AevorenBotError("INVALID_REQUEST", "资源类型与操作不一致。");
  };
  const changed = <T>(action: LibraryChangedEvent["action"], sessionId: string, operation: () => T, ids: (value: T) => string[]): T => {
    let applied = false;
    const result = commit(() => {
      assertLibraryNotCancelled(signal);
      const value = operation();
      applied = true;
      return value;
    });
    if (applied) for (const resourceId of ids(result)) dependencies.libraryChanged?.({ sessionId, resourceId, action });
    return result;
  };

  for (const definition of LIBRARY_PRODUCT_OPERATIONS) {
    handlers.set(definition.channel, async (input?: unknown): Promise<unknown> => {
      const [namespace, action] = definition.name.split(".");
      const kind = namespace === "documents" ? "document" : namespace === "skills" ? "skill" : undefined;
      // The reuse directory is metadata-only and intentionally has no conversation body access.
      if (action === "available") return library.available(libraryAvailableSchema.parse(input ?? {}));
      const parsed = LIBRARY_OPERATION_SCHEMAS[definition.name]!.parse(scopedInput(input)) as Record<string, unknown>;
      const sessionId = libraryListSchema.parse({ sessionId: parsed.sessionId }).sessionId;
      if (action === "list" || action === "search") {
        return library.list(libraryListSchema.parse({ ...parsed, ...(kind ? { kind } : {}) }), actor);
      }
      if (action === "read" || action === "load") {
        const { offset, maxCharacters, ...fields } = parsed;
        const readInput = libraryReadSchema.parse({ ...fields, ...(context ? { includeDisabled: false, includeDeleted: false } : {}) });
        const content = library.read(readInput, actor);
        if (kind && content.resource.kind !== kind) throw new AevorenBotError("INVALID_REQUEST", "资源类型与操作不一致。");
        const result = contentResult(content, { offset: offset as number | undefined, maxCharacters: maxCharacters as number | undefined }, Boolean(kind));
        return action === "load" ? { ...(result as object), loaded: true, scriptsExecutable: false } : result;
      }
      if (action === "readFile") {
        const readInput = libraryReadSchema.parse({ sessionId, id: parsed.id, revisionId: parsed.revisionId });
        const content = library.read(readInput, actor);
        if (content.resource.kind !== "skill") throw new AevorenBotError("INVALID_REQUEST");
        const file = await service().readResourceFile({ sessionId, id: content.resource.id, revisionId: content.revision.id, path: parsed.path as string }, signal, actor);
        if (file.encoding === "base64") {
          const { relativePath, size, mimeType, sha256 } = file;
          const metadata = { relativePath, size, mimeType, sha256 };
          return { ...metadata, encoding: "binary", contentAvailable: false, scriptsExecutable: false };
        }
        const { data, ...metadata } = file;
        const { body, ...details } = page(data, { offset: parsed.offset as number | undefined, maxCharacters: parsed.maxCharacters as number | undefined });
        return { ...metadata, data: body, ...details, scriptsExecutable: false };
      }
      if (action === "create" || action === "importText") {
        const createInput = libraryCreateSchema.parse({ ...parsed, ...(kind ? { kind } : {}) });
        return changed("created", sessionId, () => contentResult(service().create(createInput, signal, actor)),
          (value) => [(value as LibraryContent).resource.id]);
      }
      if (action === "update") {
        const updateInput = libraryUpdateSchema.parse(parsed);
        requireKind(updateInput, kind);
        return changed("updated", sessionId, () => contentResult(service().update(updateInput, signal, actor)),
          (value) => [(value as LibraryContent).resource.id]);
      }
      if (action === "setEnabled") {
        const enabledInput = librarySetEnabledSchema.parse(parsed);
        requireKind(enabledInput, kind);
        return changed("enabled", sessionId, () => library.setEnabled(enabledInput, actor), (value) => [value.id]);
      }
      if (action === "delete" || action === "restore") {
        const mutation = libraryMutationSchema.parse(parsed);
        requireKind(mutation, kind);
        return changed(action === "delete" ? "deleted" : "restored", sessionId,
          () => action === "delete" ? library.delete(mutation, actor) : library.restore(mutation, actor), (value) => [value.id]);
      }
      if (action === "versions") {
        const versionsInput = libraryVersionsSchema.parse(parsed);
        requireKind(versionsInput, kind);
        return library.versions(versionsInput, actor);
      }
      if (action === "restoreVersion") {
        const restoreInput = libraryRestoreVersionSchema.parse(parsed);
        requireKind(restoreInput, kind);
        return changed("updated", sessionId, () => contentResult(library.restoreVersion(restoreInput, actor)),
          (value) => [(value as LibraryContent).resource.id]);
      }
      if (action === "bind" || action === "unbind") {
        const bindingInput = libraryBindingSchema.parse(parsed);
        return changed(action === "bind" ? "bound" : "unbound", sessionId,
          (): SessionResourceBinding | boolean => action === "bind" ? library.bind(bindingInput, actor) : library.unbind(bindingInput, actor),
          (value) => value === false ? [] : [bindingInput.id]);
      }
      if (action === "pickImport") {
        const pickInput = libraryPickImportSchema.parse(parsed);
        if (!dependencies.pickLibraryPaths) throw new AevorenBotError("INTERNAL_ERROR", "文件选择服务尚未初始化。");
        const paths = await dependencies.pickLibraryPaths(pickInput, signal);
        assertLibraryNotCancelled(signal);
        if (!paths) return null;
        const prepared = await service().prepareImportPaths(sessionId, paths, pickInput.kind, signal, actor);
        return changed("created", sessionId, () => {
          const result = service().commitImport(prepared, signal, actor);
          return { ...result, imported: result.imported.map((content) => contentResult(content)) };
        }, (value) => value.imported.map((content) => (content as LibraryContent).resource.id));
      }
      if (action === "importPath" || action === "import") {
        const importInput = libraryImportPathSchema.parse({ ...parsed, ...(kind ? { kind } : {}) });
        const prepared = await service().prepareImportPath(importInput, signal, actor);
        return changed("created", sessionId, () => {
          const result = service().commitImport(prepared, signal, actor);
          return { ...result, imported: result.imported.map((content) => contentResult(content)) };
        }, (value) => value.imported.map((content) => (content as LibraryContent).resource.id));
      }
      if (action === "export") {
        const exportInput = libraryExportSchema.parse(parsed);
        const readInput: LibraryReadInput = { ...exportInput };
        const content = library.read(readInput, actor);
        if (kind && content.resource.kind !== kind) throw new AevorenBotError("INVALID_REQUEST");
        if (!dependencies.exportLibraryResource) throw new AevorenBotError("INTERNAL_ERROR", "文件导出服务尚未初始化。");
        const result = await dependencies.exportLibraryResource({ ...exportInput, revisionId: content.revision.id }, signal);
        assertLibraryNotCancelled(signal);
        library.read({ ...readInput, revisionId: content.revision.id }, actor);
        return result;
      }
      throw new AevorenBotError("INVALID_REQUEST");
    });
  }
}
