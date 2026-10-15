import type { ProductOperationDefinition } from "./product-operations";
import { SEARCH_CHANNELS } from "./search-channels";
import { searchOpenSchema, searchQuerySchema } from "./search-schemas";
export const SEARCH_OPERATION_SCHEMAS = { "search.query": searchQuerySchema, "search.open": searchOpenSchema };
export const SEARCH_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = [
  { name: "search.query", channel: SEARCH_CHANNELS.query, description: "检索当前授权范围的消息、固定资料与 Skill、媒体转录、任务、Routine 和本地应用草稿；不会扩大授权", effectClass: "read-local", interaction: "none" },
  { name: "search.open", channel: SEARCH_CHANNELS.open, description: "重新核验搜索结果的原始会话、世代、版本及授权；内容变化或撤权后不跳转到其他内容", effectClass: "read-local", interaction: "none" },
];
