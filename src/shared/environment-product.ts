import { z } from "zod";
import type { ProductOperationDefinition } from "./product-operations";
import { ENVIRONMENT_CHANNELS, EXECUTION_CHANNELS, PROCESS_CHANNELS } from "./environment-channels";
import { ENV_FILE_MAX_BYTES } from "./environment-contracts";
export { ENVIRONMENT_CHANNELS, EXECUTION_CHANNELS, PROCESS_CHANNELS } from "./environment-channels";
import {
  environmentScopeSchema, environmentMutationSchema, executionIdSchema, executionListSchema, executionRunSchema,
  processStartSchema, executionLogsSchema, executionWaitSchema, environmentFileListSchema,
  environmentFileReadSchema, environmentFileWriteSchema, environmentPickUploadSchema, registerPortSchema, environmentContentBytes,
} from "./environment-schemas";

const optionalScope = { sessionId: true, executorBotId: true } as const;
const aiWriteFile = z.object({ ...environmentFileWriteSchema.shape, sessionId: z.string().uuid().optional(), executorBotId: z.string().uuid().optional() }).strict()
  .refine((input) => environmentContentBytes(input.content, input.encoding ?? "utf8") <= ENV_FILE_MAX_BYTES, "Invalid file content");

/** Host supplies scope and intent nonces. Model input never chooses a Runtime id or nonce. */
export const ENVIRONMENT_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "environments.probe": z.undefined(), "environments.initialize": z.undefined(),
  "environments.list": environmentScopeSchema.partial(optionalScope).optional(),
  "environments.get": environmentScopeSchema.partial(optionalScope).optional(),
  "environments.start": environmentMutationSchema.partial(optionalScope).optional(),
  "environments.stop": environmentMutationSchema.partial(optionalScope).optional(),
  "environments.rebuild": environmentMutationSchema.partial(optionalScope).optional(),
  "execution.list": executionListSchema.partial(optionalScope).optional(),
  "execution.get": executionIdSchema.partial(optionalScope),
  "execution.run": executionRunSchema.omit({ clientNonce: true }).partial(optionalScope),
  "execution.cancel": executionIdSchema.partial(optionalScope),
  "execution.logs": executionLogsSchema.partial(optionalScope),
  "execution.wait": executionWaitSchema.partial(optionalScope),
  "execution.listFiles": environmentFileListSchema.partial(optionalScope).optional(),
  "execution.readFile": environmentFileReadSchema.partial(optionalScope).extend({ offset: z.number().int().min(0).max(1_048_576).optional(), maxCharacters: z.number().int().min(1).max(64_000).optional() }),
  "execution.writeFile": aiWriteFile,
  "execution.pickUpload": environmentPickUploadSchema.partial(optionalScope).optional(),
  "execution.downloadFile": environmentFileReadSchema.partial(optionalScope),
  "processes.list": environmentScopeSchema.partial(optionalScope).optional(),
  "processes.start": processStartSchema.omit({ clientNonce: true }).partial(optionalScope),
  "processes.stop": executionIdSchema.partial(optionalScope),
  "processes.registerPort": registerPortSchema.partial(optionalScope),
  "processes.listPorts": environmentScopeSchema.partial(optionalScope).optional(),
};

const descriptions: Record<string, string> = {
  "environments.probe": "检查本机 Docker 和受控执行镜像的实际状态",
  "environments.initialize": "初始化本机受控 Linux 执行镜像",
  "environments.list": "列出当前会话和执行 Bot 的隔离环境",
  "environments.get": "读取当前隔离环境状态，不返回控制令牌或地址",
  "environments.start": "启动或恢复本会话 Bot 的环境，不自动重跑旧任务",
  "environments.stop": "停止本会话 Bot 的环境并保留工作区数据",
  "environments.rebuild": "重建当前环境容器，保留工作区，不重放旧副作用",
  "execution.list": "列出当前环境任务的真实状态",
  "execution.get": "查询指定任务、退出码和真实执行状态",
  "execution.run": "在隔离 Linux 环境启动前台命令；返回 running 时用 wait/logs 查询真实结果，当前 Runtime 结束会取消未完成任务",
  "execution.cancel": "取消指定前台任务及其后代，不取消其他任务",
  "execution.logs": "按游标读取有界 stdout/stderr 和状态日志",
  "execution.wait": "等待当前任务状态变化，最长 10 秒，可取消等待",
  "execution.listFiles": "列出隔离工作区的文件与目录，不跟随符号链接",
  "execution.readFile": "读取隔离文件的真实内容；AI 文本分页，二进制不假装成图片理解",
  "execution.writeFile": "写入最多 1 MiB 文件；默认只创建，覆盖需 expectedSha256",
  "execution.pickUpload": "由用户选择文件上传到本隔离工作区",
  "execution.downloadFile": "由用户选择位置下载本隔离工作区文件",
  "processes.list": "列出本环境已登记后台进程",
  "processes.start": "启动独立后台进程，结束当前模型回复不会自动停止它",
  "processes.stop": "停止指定后台进程及其后代",
  "processes.registerPort": "登记真正属于指定后台进程、已监听并检测的端口",
  "processes.listPorts": "读取实际登记端口及最新检测状态",
};
const reads = new Set(["probe", "list", "get", "logs", "wait", "listFiles", "readFile", "listPorts"]);
const irreversible = new Set(["execution.run", "processes.start", "execution.cancel", "processes.stop", "environments.stop", "environments.rebuild"]);
export const ENVIRONMENT_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = [
  ...Object.entries(ENVIRONMENT_CHANNELS).map(([method, channel]) => ({ name: `environments.${method}`, channel, method })),
  ...Object.entries(EXECUTION_CHANNELS).map(([method, channel]) => ({ name: `execution.${method}`, channel, method })),
  ...Object.entries(PROCESS_CHANNELS).map(([method, channel]) => ({ name: `processes.${method}`, channel, method })),
].map(({ name, channel, method }) => ({ name, channel, description: descriptions[name]!,
  effectClass: reads.has(method) ? "read-local" : irreversible.has(name) ? "irreversible" : "write-reversible",
  interaction: method === "pickUpload" || method === "downloadFile" ? "native" : "none" }));
