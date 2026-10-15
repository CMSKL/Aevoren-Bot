import { createHash } from "node:crypto";
import type { EnvironmentScope } from "@shared/environment-contracts";
import { connectorDraftCreateSchema } from "@shared/native-connector-schemas";
import { NATIVE_CONNECTOR_OPERATION_SCHEMAS, NATIVE_CONNECTOR_PRODUCT_OPERATIONS } from "@shared/native-connector-product";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import type { LibraryExecutionContext } from "./library-product-handlers";
import type { NativeConnectorService } from "./native-connector-service";

export type NativeConnectorProductDependencies = { repository: AppRepository; nativeConnectorService?: NativeConnectorService };
export function addNativeConnectorProductHandlers(handlers: Map<string, (input?: unknown) => unknown>, dependencies: NativeConnectorProductDependencies,
  commit: <T>(operation: () => T) => T = operation => operation(), context?: LibraryExecutionContext): void {
  const service = (): NativeConnectorService => { if (!dependencies.nativeConnectorService) throw new AevorenBotError("INVALID_REQUEST"); return dependencies.nativeConnectorService; };
  const assertCurrent = (): void => {
    context?.signal?.throwIfAborted();
    if (context) {
      dependencies.repository.connectors.assertRuntimeCurrent(context.runtimeRunId, { sessionId: context.sessionId, executorBotId: context.executorBotId });
    }
  };
  for (const definition of NATIVE_CONNECTOR_PRODUCT_OPERATIONS) handlers.set(definition.channel, async input => {
    assertCurrent();
    const scopedOperation = definition.name.startsWith("drafts.") || ["connectors.bindings", "connectors.bind", "connectors.unbind", "connectors.search", "connectors.read"].includes(definition.name);
    let scoped = input;
    if (context && scopedOperation) {
      const supplied = (input ?? {}) as Record<string, unknown>;
      if (supplied.sessionId !== undefined && supplied.sessionId !== context.sessionId || supplied.executorBotId !== undefined && supplied.executorBotId !== context.executorBotId) throw new AevorenBotError("INVALID_REQUEST");
      scoped = { ...supplied, sessionId: context.sessionId, executorBotId: context.executorBotId };
    }
    const parsed = (!context && definition.name === "drafts.create" ? connectorDraftCreateSchema : NATIVE_CONNECTOR_OPERATION_SCHEMAS[definition.name]!).parse(scoped) as Record<string, unknown> | undefined;
    const target = parsed as unknown;
    const execution = { signal: context?.signal, assertCurrent };
    let result: unknown;
    switch (definition.name) {
      case "connectors.list": result = service().list(target as import("@shared/native-connector-contracts").ConnectorListInput | undefined); break;
      case "connectors.authorize": result = await service().authorize(target as import("@shared/native-connector-contracts").ConnectorIdInput, execution); break;
      case "connectors.cancelAuthorization": result = service().cancelAuthorization(target as import("@shared/native-connector-contracts").ConnectorIdInput); break;
      case "connectors.revoke": result = service().revoke(target as import("@shared/native-connector-contracts").ConnectorIdInput); break;
      case "connectors.bindings": result = service().bindings(target as import("@shared/native-connector-contracts").ConnectorBindingsInput); break;
      case "connectors.bind": result = service().bind(target as import("@shared/native-connector-contracts").ConnectorBindInput); break;
      case "connectors.unbind": result = service().unbind(target as import("@shared/native-connector-contracts").ConnectorUnbindInput); break;
      case "connectors.search": result = await service().search(target as import("@shared/native-connector-contracts").ConnectorSearchInput, execution); break;
      case "connectors.read": result = await service().read(target as import("@shared/native-connector-contracts").ConnectorReadInput, execution); break;
      case "drafts.list": result = service().listDrafts(target as EnvironmentScope); break;
      case "drafts.create": {
        let clientNonce: string | undefined;
        if (context) {
          const run = dependencies.repository.getRuntimeRun(context.runtimeRunId);
          const root = dependencies.repository.getUserMessage(run.clientNonce).origin?.rootClientNonce ?? run.clientNonce;
          const digest = createHash("sha256").update(`${root}:${context.sessionId}:${context.executorBotId}:${JSON.stringify(parsed)}`).digest("hex");
          clientNonce = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        }
        result = service().createDraft({ ...parsed, ...(clientNonce ? { clientNonce } : {}) } as import("@shared/native-connector-contracts").ConnectorDraftCreateInput); break;
      }
      case "drafts.update": result = service().updateDraft(target as import("@shared/native-connector-contracts").ConnectorDraftUpdateInput); break;
      case "drafts.read": result = service().readDraft(target as import("@shared/native-connector-contracts").ConnectorDraftReadInput); break;
      case "drafts.versions": result = service().draftVersions(target as import("@shared/native-connector-contracts").ConnectorDraftReadInput); break;
      case "drafts.delete": result = service().deleteDraft(target as import("@shared/native-connector-contracts").ConnectorDraftDeleteInput); break;
      default: throw new AevorenBotError("INVALID_REQUEST");
    }
    assertCurrent(); return commit(() => { assertCurrent(); return result; });
  });
}
