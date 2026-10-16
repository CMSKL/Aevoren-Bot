import { z } from "zod";
import type { ProductOperationDefinition } from "./product-operations";
import { MEDIA_CHANNELS } from "./media-channels";
import { mediaAvailableSchema, mediaIdSchema, mediaImportPathSchema, mediaListSchema, mediaMutationSchema, mediaPreviewSchema, mediaReadSchema, mediaScopeSchema, mediaSetEnabledSchema } from "./media-schemas";

const optionalSession = { sessionId: z.string().uuid().optional() };
// Rebuild the input shape because safeExtend may not weaken a required field.
const optionalScope = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => z.object({ ...schema.shape, ...optionalSession }).strict();
const sameReference = (input: { id: string; reference?: { mediaId: string } }) => !input.reference || input.reference.mediaId === input.id;
export const MEDIA_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "media.list": optionalScope(mediaListSchema), "media.available": mediaAvailableSchema.optional(),
  "media.metadata": optionalScope(mediaIdSchema), "media.read": optionalScope(z.object(mediaReadSchema.shape)).refine(sameReference),
  "media.preview": optionalScope(z.object(mediaPreviewSchema.shape)).refine(sameReference), "media.pickImport": optionalScope(mediaScopeSchema),
  "media.importPath": optionalScope(mediaImportPathSchema), "media.bind": optionalScope(mediaIdSchema),
  "media.unbind": optionalScope(mediaIdSchema), "media.setEnabled": optionalScope(mediaSetEnabledSchema),
  "media.delete": optionalScope(mediaMutationSchema), "media.restore": optionalScope(mediaMutationSchema),
};
const descriptions: Record<keyof typeof MEDIA_CHANNELS, string> = {
  list: "列出当前会话和任务准入的媒体元信息", available: "经批准列出可复用媒体元信息；不读取其他会话正文或图片",
  metadata: "读取当前范围媒体的固定引用与元信息", read: "分页读取任务已准入媒体的固定解析版本；图片通过真实像素通道发送",
  preview: "读取授权图片或生成 PDF 指定页的有界图片预览；原文件保持不变",
  pickImport: "由用户选择 PNG、JPEG、PDF 或 DOCX，校验后导入当前会话",
  importPath: "从当前会话已授权工作区导入媒体，保存应用拥有的内容与固定解析版本",
  bind: "将媒体明确授权给当前会话的后续任务；不刷新旧任务准入", unbind: "撤销当前会话媒体授权，立即阻止后续读取",
  setEnabled: "按版本启用或停用媒体；旧任务授权不自动恢复", delete: "按版本软删除媒体，阻止读取并保留恢复记录",
  restore: "按版本恢复媒体；后续新任务使用当前授权，旧任务不自动恢复",
};
export const MEDIA_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = Object.entries(MEDIA_CHANNELS).map(([method, channel]) => ({
  name: `media.${method}`, channel, description: descriptions[method as keyof typeof MEDIA_CHANNELS],
  effectClass: ["list", "available", "metadata", "read", "preview"].includes(method) ? "read-local" : "write-reversible",
  interaction: method === "pickImport" ? "native" : "none",
}));
