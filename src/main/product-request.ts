import type { ProductToolRequest } from "@shared/contracts";
import { PRODUCT_OPERATION_SCHEMAS } from "./product-operation-schemas";
import { AevorenBotError } from "./errors";

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
  return value;
}

/** Normalize defaults and field order before approvals, receipts and deduplication. */
export function normalizeProductRequest(tool: ProductToolRequest): ProductToolRequest {
  if (tool.action !== "execute") return tool;
  const schema = PRODUCT_OPERATION_SCHEMAS[tool.operation];
  if (!schema) throw new AevorenBotError("INVALID_REQUEST");
  const input = ordered(schema.parse(tool.input === null ? undefined : tool.input));
  return { kind: "product-call", action: "execute", operation: tool.operation, ...(input === undefined ? {} : { input }) };
}
