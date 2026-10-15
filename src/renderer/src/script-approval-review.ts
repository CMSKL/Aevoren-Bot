import type { ApiResult, ToolInvocation } from "@shared/contracts";
import { ENV_FOREGROUND_TIMEOUT_MS } from "@shared/environment-contracts";
import type { ApprovalReviewInput, ApprovalReviewResult } from "@shared/skill-execution-contracts";

export function isScriptRun(invocation: ToolInvocation): boolean {
  return invocation.arguments.kind === "product-call" && invocation.arguments.action === "execute" && invocation.arguments.operation === "skills.runScript";
}
export function scriptReviewMatches(invocation: ToolInvocation, review: ApprovalReviewResult): boolean {
  if (!isScriptRun(invocation)) return true;
  if (!review.executable || review.snapshot?.kind !== "skill-script" || invocation.arguments.kind !== "product-call" || invocation.arguments.action !== "execute") return false;
  const input = invocation.arguments.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const args = input as Record<string, unknown>; const target = review.snapshot.target;
  return target.grantId === args.grantId && target.grantVersion === args.expectedGrantVersion
    && JSON.stringify(target.args) === JSON.stringify(args.args ?? []) && target.cwd === (args.cwd ?? ".")
    && target.timeoutMs === (args.timeoutMs ?? ENV_FOREGROUND_TIMEOUT_MS);
}
export type ScriptReviewLoad = { status: "ready"; result: ApprovalReviewResult } | { status: "unavailable"; reason: string };
export function loadScriptApprovalReview(input: ApprovalReviewInput,
  read: (input: ApprovalReviewInput) => Promise<ApiResult<ApprovalReviewResult>>,
  receive: (result: ScriptReviewLoad) => void): () => void {
  let disposed = false;
  void read(input).then(result => {
    if (disposed) return;
    receive(result.ok ? { status: "ready", result: result.data } : { status: "unavailable", reason: result.error.safeMessage });
  }).catch(() => { if (!disposed) receive({ status: "unavailable", reason: "无法读取本次审批的保存快照，请重试。" }); });
  return () => { disposed = true; };
}
