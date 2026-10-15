import { z } from "zod";
import type { ProductOperationDefinition } from "./product-operations";
import { VOICE_CHANNELS } from "./voice-channels";
import { voiceConfigurationPatchSchema, voiceSpeechSchema, voiceTaskListSchema, voiceTaskSchema, voiceTranscribeSchema } from "./voice-schemas";
const sessionId = z.string().uuid().optional();
export const VOICE_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "voice.configurations": z.undefined().optional(),
  "voice.configure": voiceConfigurationPatchSchema,
  "voice.transcribe": voiceTranscribeSchema.omit({ clientNonce: true }).extend({ sessionId }),
  "voice.speak": voiceSpeechSchema.omit({ clientNonce: true }).extend({ sessionId }),
  "voice.get": voiceTaskSchema.extend({ sessionId }), "voice.list": voiceTaskListSchema.extend({ sessionId }),
  "voice.stop": voiceTaskSchema.extend({ sessionId }), "voice.audio": voiceTaskSchema.extend({ sessionId }),
};
const descriptions = {
  configure: "经批准修改独立语音服务的模型、音色和启停，保留已有宿主密钥引用；不接受密钥或清除密钥参数",
  configurations: "查看独立语音服务的配置状态、模型及版本；不返回密钥，也不启用麦克风",
  transcribe: "经批准将固定授权音频提交给已配置的云服务转写；取消只停止本任务，结果未知不重复发送",
  speak: "经批准将固定消息或指定文字生成 AI 合成语音；返回真实音频引用，播放由用户界面处理",
  get: "读取当前任务范围的语音结果；正文以可撤销工具附件传输",
  list: "列出当前任务范围的语音任务元信息", stop: "停止当前范围的语音生成或转写任务",
  audio: "校验已完成语音的真实字节并返回引用；当前模型通道不直接传入音频",
};
export const VOICE_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = Object.entries(descriptions).map(([method, description]) => ({
  name: `voice.${method}`, channel: method === "configure" ? "product:voice-configure" : VOICE_CHANNELS[method as Exclude<keyof typeof descriptions, "configure">], description,
  effectClass: ["stop", "configure"].includes(method) ? "write-reversible" : ["transcribe", "speak"].includes(method) ? "read-remote" : "read-local", interaction: "none",
}));
