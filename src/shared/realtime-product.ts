import { z } from "zod";
import type { ProductOperationDefinition } from "./product-operations";
import { realtimeInputSchema } from "./realtime-schemas";
const input = realtimeInputSchema.extend({ sessionId: z.string().uuid().optional() });
export const REALTIME_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "voice.realtime.snapshot": input, "voice.realtime.stop": input, "voice.realtime.stopTask": input,
};
export const REALTIME_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = [
  { name: "voice.realtime.snapshot", channel: "product:voice-realtime-snapshot", description: "查看当前任务来源的实时语音状态及委派链接；不返回音频或启用麦克风", effectClass: "read-local", interaction: "none" },
  { name: "voice.realtime.stop", channel: "product:voice-realtime-stop", description: "停止当前任务来源的语音连接与播放；已接受的业务任务独立继续", effectClass: "write-reversible", interaction: "none" },
  { name: "voice.realtime.stopTask", channel: "product:voice-realtime-stop-task", description: "停止当前语音轮次链接的业务任务；不取消其他成员或其他批次", effectClass: "write-reversible", interaction: "none" },
];
