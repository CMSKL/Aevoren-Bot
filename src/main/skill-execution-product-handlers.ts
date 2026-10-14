import { createHash } from "node:crypto";
import { SKILL_EXECUTION_OPERATION_SCHEMAS, SKILL_EXECUTION_PRODUCT_OPERATIONS } from "@shared/skill-execution-product";
import { skillExecutionInputSchema, skillGrantSchema, skillGrantsSchema, skillRevokeSchema, skillRunSchema, skillScriptsSchema } from "@shared/skill-execution-schemas";
import type { AppRepository } from "./database";
import type { SkillExecutionService } from "./skill-execution-service";
import type { LibraryExecutionContext } from "./library-product-handlers";
import { AevorenBotError } from "./errors";

export type SkillExecutionProductDependencies = { repository: AppRepository; skillExecutionService?: SkillExecutionService };
export function addSkillExecutionProductHandlers(handlers: Map<string, (input?: unknown) => unknown>, dependencies: SkillExecutionProductDependencies,
  commit: <T>(operation: () => T) => T = work => work(), context?: LibraryExecutionContext): void {
  const service = (): SkillExecutionService => {
    if (!dependencies.skillExecutionService) throw new AevorenBotError("SKILL_SCRIPT_UNSUPPORTED"); return dependencies.skillExecutionService;
  };
  for (const definition of SKILL_EXECUTION_PRODUCT_OPERATIONS) {
    handlers.set(definition.channel, async input => {
      context?.signal?.throwIfAborted();
      const supplied = (input ?? {}) as Record<string, unknown>;
      if (context && (supplied.sessionId !== undefined && supplied.sessionId !== context.sessionId || supplied.executorBotId !== undefined && supplied.executorBotId !== context.executorBotId)) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
      const scoped = context ? { ...supplied, sessionId: context.sessionId, executorBotId: context.executorBotId } : supplied;
      const parsed = context ? SKILL_EXECUTION_OPERATION_SCHEMAS[definition.name]!.parse(scoped) as Record<string, unknown> : scoped;
      switch (definition.name) {
        case "skills.scripts": return service().scripts(skillScriptsSchema.parse(parsed), context?.signal);
        case "skills.executionGrants": return service().executionGrants(skillGrantsSchema.parse(parsed));
        case "skills.grantExecution": return service().grantExecution(skillGrantSchema.parse(parsed), context?.signal, commit);
        case "skills.revokeExecution": return service().revokeExecution(skillRevokeSchema.parse(parsed), context?.signal, commit);
        case "skills.scriptExecution": return service().scriptExecution(skillExecutionInputSchema.parse(parsed));
        case "skills.runScript": {
          let clientNonce = parsed.clientNonce;
          if (context) {
            const run = dependencies.repository.getRuntimeRun(context.runtimeRunId);
            const root = dependencies.repository.getUserMessage(run.clientNonce).origin?.rootClientNonce ?? run.clientNonce;
            const hash = createHash("sha256").update(`${root}:${context.sessionId}:${context.executorBotId}:${definition.name}:${JSON.stringify(parsed)}`).digest("hex");
            clientNonce = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          }
          const result = await service().runScript(skillRunSchema.parse({ ...parsed, clientNonce }), { runtimeRunId: context?.runtimeRunId, signal: context?.signal });
          return commit(() => result);
        }
      }
    });
  }
}
