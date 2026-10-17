import type { ToolInvocation } from "@shared/contracts";
import type { ExternalDraftReviewSnapshot, NativeOutboundIntent, NativeWriteOperation } from "@shared/native-outbound-contracts";
import type { ApprovalReviewResult } from "@shared/skill-execution-contracts";

export const outboundOperationLabels: Record<NativeWriteOperation, string> = {
  "gmail-send": "发送 Gmail 邮件", "drive-create-text": "创建 Drive 文本文件", "drive-update-text": "更新 Drive 文本文件", "notion-create-page": "创建 Notion 页面",
  "notion-update-page-title": "仅修改 Notion 页面标题", "notion-append-page": "在 Notion 页面末尾追加正文",
};
export const outboundStateLabels: Record<NativeOutboundIntent["state"], string> = {
  prepared: "待批准", dispatching: "正在提交", confirmed: "已确认提交", rejected: "已拒绝", unknown: "结果未确认，可能已提交",
};
type OutboundStatus = Pick<NativeOutboundIntent, "state" | "lastErrorCode">;
export const outboundTargetStateNotice = "已核对目标当前状态，但无法证明由原请求造成此变化。此次核对没有再次提交。";
export function outboundStateLabel(intent: OutboundStatus): string {
  return intent.state === "confirmed" && intent.lastErrorCode === "TARGET_STATE_MATCH" ? "已核对目标当前状态" : outboundStateLabels[intent.state];
}
export function outboundResultNotice(intent: OutboundStatus): string {
  if (intent.state === "unknown") return "尚无可验证的提交结果。原意图没有重发。";
  if (intent.state === "confirmed") return intent.lastErrorCode === "TARGET_STATE_MATCH" ? outboundTargetStateNotice : "已核对到第三方实际提交结果。";
  return "外发意图已拒绝。";
}
export function isOutboundSend(invocation: ToolInvocation): boolean {
  return invocation.arguments.kind === "product-call" && invocation.arguments.action === "execute" && invocation.arguments.operation === "outbound.send";
}
export function outboundReviewMatches(invocation: ToolInvocation, review: ApprovalReviewResult): boolean {
  if (!isOutboundSend(invocation)) return true;
  if (!review.executable || review.snapshot?.kind !== "external-draft" || invocation.arguments.kind !== "product-call" || invocation.arguments.action !== "execute") return false;
  const input = invocation.arguments.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const fields = input as Record<string, unknown>;
  return review.snapshot.intentId === fields.id && review.snapshot.expectedIntentVersion === fields.expectedVersion;
}
export function externalReview(review: ApprovalReviewResult | undefined): ExternalDraftReviewSnapshot | null {
  return review?.snapshot?.kind === "external-draft" ? review.snapshot : null;
}
