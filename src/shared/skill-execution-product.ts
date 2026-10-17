import type { z } from "zod";
import type { ProductOperationDefinition } from "./product-operations";
import { SKILL_EXECUTION_CHANNELS } from "./skill-execution-channels";
import { skillScriptsSchema, skillGrantsSchema, skillGrantSchema, skillRevokeSchema, skillRunSchema, skillExecutionInputSchema } from "./skill-execution-schemas";

const scope = { sessionId: true, executorBotId: true } as const;
export const SKILL_EXECUTION_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "skills.scripts": skillScriptsSchema.partial(scope),
  "skills.executionGrants": skillGrantsSchema.partial(scope).optional(),
  "skills.grantExecution": skillGrantSchema.partial(scope),
  "skills.revokeExecution": skillRevokeSchema.partial(scope),
  "skills.runScript": skillRunSchema.omit({ clientNonce: true }).partial(scope),
  "skills.scriptExecution": skillExecutionInputSchema.partial(scope),
};
const descriptions = {
  scripts: "列出指定固定 Skill 版本中已核验真实字节的脚本入口；声明工具不会授予执行权限",
  executionGrants: "列出当前会话 Bot 和隔离环境的精确脚本执行授权",
  grantExecution: "经用户批准，为指定环境镜像、固定 Skill 版本和脚本入口授予执行权限",
  revokeExecution: "撤销指定脚本授权，并取消该授权尚未结束的任务，不停止兄弟任务",
  runScript: "经本次审批执行已授权固定脚本，使用隔离环境与参数数组；unknown 状态不得盲目重试",
  scriptExecution: "读取原脚本执行的固定版本来源和真实任务状态；日志和取消使用 execution 接口",
};
export const SKILL_EXECUTION_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = Object.entries(SKILL_EXECUTION_CHANNELS)
  .map(([method, channel]) => ({ name: `skills.${method}`, channel, description: descriptions[method as keyof typeof descriptions],
    effectClass: method === "runScript" || method === "revokeExecution" ? "irreversible" : method === "grantExecution" ? "write-reversible" : "read-local", interaction: "none" }));
