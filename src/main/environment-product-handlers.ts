import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { EnvironmentFileDownloadResult, EnvironmentFileReadInput, EnvironmentFileWriteResult, EnvironmentScope } from "@shared/environment-contracts";
import { ENVIRONMENT_OPERATION_SCHEMAS, ENVIRONMENT_PRODUCT_OPERATIONS } from "@shared/environment-product";
import type { EnvironmentService } from "./environment-service";
import type { AppRepository } from "./database";
import type { LibraryExecutionContext } from "./library-product-handlers";
import { AevorenBotError } from "./errors";

export type EnvironmentProductDependencies = {
  repository: AppRepository;
  environmentService?: EnvironmentService;
  pickEnvironmentUpload?(scope: EnvironmentScope & { directory?: string }, signal?: AbortSignal): Promise<EnvironmentFileWriteResult[] | null>;
  downloadEnvironmentFile?(input: EnvironmentFileReadInput, signal?: AbortSignal): Promise<EnvironmentFileDownloadResult | null>;
};

function intentNonce(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function addEnvironmentProductHandlers(handlers: Map<string, (input?: unknown) => unknown>, dependencies: EnvironmentProductDependencies,
  commit: <T>(operation: () => T) => T = operation => operation(), context?: LibraryExecutionContext): void {
  const service = (): EnvironmentService => {
    if (!dependencies.environmentService) throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
    return dependencies.environmentService;
  };
  for (const definition of ENVIRONMENT_PRODUCT_OPERATIONS) {
    handlers.set(definition.channel, async (input) => {
      context?.signal?.throwIfAborted();
      const name = definition.name;
      if (name === "environments.probe" || name === "environments.initialize") {
        ENVIRONMENT_OPERATION_SCHEMAS[name]!.parse(input);
        if (name === "environments.probe") return service().probe(context?.signal);
        const result = await service().initialize(context?.signal);
        context?.signal?.throwIfAborted();
        return commit(() => result);
      }
      let scoped = input;
      if (context) {
        const supplied = (input ?? {}) as Record<string, unknown>;
        if (supplied.sessionId !== undefined && supplied.sessionId !== context.sessionId || supplied.executorBotId !== undefined && supplied.executorBotId !== context.executorBotId) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
        dependencies.repository.assertSessionExecutor(context.sessionId, context.executorBotId);
        scoped = { ...supplied, sessionId: context.sessionId, executorBotId: context.executorBotId };
      }
      const parsed = (context ? ENVIRONMENT_OPERATION_SCHEMAS[name]!.parse(scoped) : scoped) as EnvironmentScope & Record<string, unknown>;
      let result: unknown;
      switch (name) {
        case "environments.list": return service().list(parsed);
        case "environments.get": return service().get(parsed);
        case "environments.start": result = await service().start(parsed, context?.signal); break;
        case "environments.stop": result = await service().stop(parsed, context?.signal); break;
        case "environments.rebuild": result = await service().rebuild(parsed, context?.signal); break;
        case "execution.list": return service().listExecutions(parsed);
        case "processes.list": return service().listExecutions(parsed, "background");
        case "execution.get": return service().getExecution(parsed as import("@shared/environment-contracts").ExecutionIdInput);
        case "execution.run":
        case "processes.start": {
          const nonce = context ? intentNonce(`${dependencies.repository.getRuntimeRun(context.runtimeRunId).clientNonce}:${context.sessionId}:${context.executorBotId}:${name}:${JSON.stringify(parsed)}`) : parsed.clientNonce;
          result = await service().run({ ...parsed, clientNonce: nonce } as import("@shared/environment-contracts").ExecutionRunInput,
            context?.runtimeRunId ?? null, name === "processes.start", context?.signal);
          break;
        }
        case "execution.cancel":
        case "processes.stop": {
          const target = dependencies.repository.environments.getExecution(parsed, parsed.id as string);
          if (name === "processes.stop" ? target.kind !== "background" : target.kind !== "foreground") throw new AevorenBotError("ENVIRONMENT_EXECUTION_STATE_INVALID");
          result = await service().cancel(parsed as import("@shared/environment-contracts").ExecutionIdInput, context?.signal); break;
        }
        case "execution.logs": return service().logs(parsed as import("@shared/environment-contracts").ExecutionLogsInput);
        case "execution.wait": {
          const deadline = Date.now() + (parsed.timeoutMs as number ?? 10_000);
          const target = { sessionId: parsed.sessionId, executorBotId: parsed.executorBotId, id: parsed.id as string };
          let current = await service().getExecution(target);
          while (["running", "unknown"].includes(current.state) && Date.now() < deadline) {
            await delay(Math.min(250, deadline - Date.now()), undefined, { signal: context?.signal });
            current = await service().getExecution(target);
          }
          return current;
        }
        case "execution.listFiles": return service().listFiles(parsed as EnvironmentScope & { path?: string });
        case "execution.readFile": {
          const file = await service().readFile({ sessionId: parsed.sessionId, executorBotId: parsed.executorBotId, path: parsed.path as string });
          if (!context) return file;
          if (file.encoding === "base64") return { path: file.path, size: file.size, sha256: file.sha256, mimeType: file.mimeType, encoding: "binary", contentAvailable: false };
          const offset = parsed.offset as number ?? 0, max = parsed.maxCharacters as number ?? 18_000;
          return { ...file, content: file.content.slice(offset, offset + max), offset, fullLength: file.content.length,
            truncated: offset > 0 || offset + max < file.content.length, nextOffset: offset + max < file.content.length ? offset + max : null };
        }
        case "execution.writeFile": result = await service().writeFile(parsed as import("@shared/environment-contracts").EnvironmentFileWriteInput, context?.signal); break;
        case "execution.pickUpload": result = await dependencies.pickEnvironmentUpload?.(parsed as EnvironmentScope & { directory?: string }, context?.signal) ?? null; break;
        case "execution.downloadFile": result = await dependencies.downloadEnvironmentFile?.(parsed as EnvironmentFileReadInput, context?.signal) ?? null; break;
        case "processes.registerPort": result = await service().registerPort(parsed as import("@shared/environment-contracts").RegisterPortInput, context?.signal); break;
        case "processes.listPorts": return service().listPorts(parsed);
        default: throw new AevorenBotError("INVALID_REQUEST");
      }
      context?.signal?.throwIfAborted();
      return commit(() => { context?.signal?.throwIfAborted(); return result; });
    });
  }
}
