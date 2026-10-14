import { z } from "zod";
import type { ProductOperationDefinition } from "./product-operations";
import { LIBRARY_CHANNELS } from "./library-channels";
export { LIBRARY_CHANNELS } from "./library-channels";
import {
  libraryAvailableSchema, libraryBindingSchema, libraryCreateSchema, libraryExportSchema,
  libraryImportPathSchema, libraryListSchema, libraryMutationSchema, libraryPickImportSchema,
  libraryReadSchema, libraryRestoreVersionSchema, librarySetEnabledSchema, libraryUpdateSchema,
  libraryVersionsSchema, resourceFileRefSchema,
} from "./library-schemas";

const pagination = { offset: z.number().int().min(0).max(1_048_576).optional(), maxCharacters: z.number().int().min(1).max(64_000).optional() };
const aliasRead = libraryReadSchema.omit({ includeDisabled: true, includeDeleted: true }).partial({ sessionId: true }).extend(pagination);
const aliasList = libraryListSchema.omit({ kind: true }).partial({ sessionId: true });
const aliasCreate = libraryCreateSchema.omit({ kind: true }).partial({ sessionId: true });
const aliasUpdate = z.object({ ...libraryUpdateSchema.shape, sessionId: z.string().uuid().optional() }).strict()
  .refine((input) => input.name !== undefined || input.description !== undefined || input.body !== undefined, "At least one field is required");
const aliasMutation = libraryMutationSchema.partial({ sessionId: true });
const aliasImport = libraryImportPathSchema.omit({ kind: true }).partial({ sessionId: true });
const aliasExport = libraryExportSchema.partial({ sessionId: true });

/** UI uses strict shared schemas; runtime normalization supplies a missing session before dispatch. */
export const LIBRARY_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "library.list": libraryListSchema.partial({ sessionId: true }),
  "library.available": libraryAvailableSchema.optional(),
  "library.read": libraryReadSchema.partial({ sessionId: true }).extend(pagination),
  "library.create": libraryCreateSchema.partial({ sessionId: true }),
  "library.importText": libraryCreateSchema.partial({ sessionId: true }),
  "library.update": aliasUpdate,
  "library.setEnabled": librarySetEnabledSchema.partial({ sessionId: true }),
  "library.delete": aliasMutation, "library.restore": aliasMutation,
  "library.versions": libraryVersionsSchema.partial({ sessionId: true }),
  "library.restoreVersion": libraryRestoreVersionSchema.partial({ sessionId: true }),
  "library.bind": libraryBindingSchema.partial({ sessionId: true }),
  "library.unbind": libraryBindingSchema.partial({ sessionId: true }),
  "library.pickImport": libraryPickImportSchema.partial({ sessionId: true }),
  "library.importPath": libraryImportPathSchema.partial({ sessionId: true }),
  "library.export": aliasExport,
  "documents.list": aliasList,
  "documents.search": aliasList.extend({ query: z.string().trim().min(1).max(200) }),
  "documents.read": aliasRead, "documents.create": aliasCreate, "documents.update": aliasUpdate,
  "documents.import": aliasImport, "documents.export": aliasExport,
  "documents.delete": aliasMutation, "documents.restore": aliasMutation,
  "documents.versions": libraryVersionsSchema.partial({ sessionId: true }),
  "documents.restoreVersion": libraryRestoreVersionSchema.partial({ sessionId: true }),
  "skills.list": aliasList, "skills.read": aliasRead, "skills.load": aliasRead,
  "skills.readFile": z.object({ sessionId: z.string().uuid().optional(), id: z.string().uuid(),
    revisionId: z.string().uuid().optional(), path: resourceFileRefSchema.shape.relativePath, ...pagination }).strict(),
  "skills.create": aliasCreate, "skills.update": aliasUpdate,
  "skills.import": aliasImport, "skills.export": aliasExport,
  "skills.delete": aliasMutation, "skills.restore": aliasMutation,
  "skills.setEnabled": librarySetEnabledSchema.partial({ sessionId: true }),
};

const generic: ProductOperationDefinition[] = Object.entries(LIBRARY_CHANNELS).map(([method, channel]) => ({
  name: `library.${method}`, channel,
  description: ({ list: "列出本会话资料与 Skill", available: "列出可复用资源的元信息，不读取其他会话正文", read: "读取已授权资源的固定版本",
    create: "创建并绑定资料或文本 Skill", importText: "保存文本到资料库", update: "按版本修改资源，保留旧版本",
    setEnabled: "启用或停用资源", delete: "软删除资源，保留历史", restore: "恢复已删除资源", versions: "列出固定版本的摘要",
    restoreVersion: "将历史内容恢复为新版本", bind: "将资源授权给当前会话", unbind: "撤销当前会话资源授权",
    pickImport: "由用户选择并导入文本或 Skill 目录", importPath: "从本会话授权工作区导入资源", export: "由用户选择位置导出固定版本" } as Record<string, string>)[method]!,
  effectClass: ["list", "available", "read", "versions"].includes(method) ? "read-local" : "write-reversible",
  interaction: ["pickImport", "export"].includes(method) ? "native" : "none",
}));

const aliasDescriptions: Record<string, string> = {
  "documents.list": "列出本会话已授权文档", "documents.search": "搜索本会话文档的名称与正文",
  "documents.read": "分页读取文档固定版本，返回完整内容摘要与截断标记", "documents.create": "创建并绑定文档",
  "documents.update": "按 expectedVersion 修改文档", "documents.import": "从已授权工作区导入文档",
  "documents.export": "由用户选择位置导出文档", "documents.delete": "软删除文档", "documents.restore": "恢复文档",
  "documents.versions": "列出文档版本摘要", "documents.restoreVersion": "将文档历史版本恢复为新版本",
  "skills.list": "列出本会话文本 Skill", "skills.read": "分页读取 Skill 固定版本",
  "skills.load": "将本会话已授权文本 Skill 加载到当前任务；不执行脚本、不授予工具权限",
  "skills.readFile": "读取已授权 Skill 的辅助文本；二进制只返回元信息，脚本不执行",
  "skills.create": "创建并绑定文本 Skill", "skills.update": "按 expectedVersion 修改 Skill",
  "skills.import": "从已授权工作区导入 SKILL.md 及资源", "skills.export": "由用户选择位置导出 Skill 包",
  "skills.delete": "软删除 Skill", "skills.restore": "恢复 Skill", "skills.setEnabled": "启用或停用 Skill",
};

export const LIBRARY_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = [
  ...generic,
  ...Object.entries(aliasDescriptions).map(([name, description]): ProductOperationDefinition => ({
    name, description, channel: `product:${name.replace(".", "-")}`,
    effectClass: ["list", "search", "read", "load", "readFile", "versions"].includes(name.split(".")[1]!) ? "read-local" : "write-reversible",
    interaction: name.endsWith(".export") ? "native" : "none",
  })),
];
