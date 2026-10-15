import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolInvocation } from "@shared/contracts";
import type { ExternalDraftReviewSnapshot } from "@shared/native-outbound-contracts";
import { isOutboundSend, outboundReviewMatches } from "./outbound-approval-review";
import { ExternalDraftReview } from "./components/ExternalDraftReview";
import { loadScriptApprovalReview } from "./script-approval-review";
import type { ApiResult } from "@shared/contracts";
import type { ApprovalReviewResult } from "@shared/skill-execution-contracts";
import { RunFailureCard } from "./components/CollaborationFeedback";

const snapshot: ExternalDraftReviewSnapshot = { kind: "external-draft", connectionName: "Fixed connection", provider: "gmail", account: { accountId: "account", displayName: "Fixed account", email: "sender@example.com" }, connectionId: "connection", authVersion: 2, grantId: "grant", grantVersion: 3, draftId: "draft", revisionId: "revision", revisionNumber: 4, revisionDigest: "1".repeat(64), operation: "gmail-send", targetIds: ["target@example.com"], content: { kind: "gmail-message", to: ["target@example.com"], cc: [], subject: "FIXED SUBJECT <script>", body: "FIXED BODY <img onerror=alert(1)>" }, intentId: "intent", expectedIntentVersion: 1, targetDigest: "2".repeat(64) };
const invocation = { arguments: { kind: "product-call", action: "execute", operation: "outbound.send", input: { id: "intent", expectedVersion: 1 } } } as ToolInvocation;

describe("immutable outbound approval review", () => {
  it("requires the same fixed intent and version, and current host authorization", () => {
    expect(isOutboundSend(invocation)).toBe(true);
    expect(outboundReviewMatches(invocation, { executable: true, snapshot })).toBe(true);
    expect(outboundReviewMatches(invocation, { executable: false, snapshot })).toBe(false);
    expect(outboundReviewMatches(invocation, { executable: true, snapshot: { ...snapshot, intentId: "other" } })).toBe(false);
    expect(outboundReviewMatches(invocation, { executable: true, snapshot: { ...snapshot, expectedIntentVersion: 2 } })).toBe(false);
    expect(outboundReviewMatches(invocation, { executable: true, snapshot: null })).toBe(false);
  });
  it("renders only persisted account, targets and content as escaped text", () => {
    const html = renderToStaticMarkup(<ExternalDraftReview snapshot={snapshot} />);
    expect(html).toContain("sender@example.com"); expect(html).toContain("target@example.com");
    expect(html).toContain("FIXED SUBJECT &lt;script&gt;");
    expect(html).toContain("FIXED BODY &lt;img onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<img");
    expect(html).toContain("v4");
  });
  it("ignores a late external review after the account or dialog changes", async () => {
    let finish!: (result: ApiResult<ApprovalReviewResult>) => void;
    const received: unknown[] = [];
    const stop = loadScriptApprovalReview({ sessionId: "scope", executorBotId: "bot", id: "approval", expectedVersion: 1 }, () => new Promise(resolve => { finish = resolve; }), result => received.push(result));
    stop(); finish({ ok: true, data: { executable: true, snapshot } }); await Promise.resolve();
    expect(received).toEqual([]);
  });
  it("presents host outbound failures as fixed business tasks without model retry claims", () => {
    const html = renderToStaticMarkup(<RunFailureCard step="应用外发" errorCode="INTERRUPTED_AFTER_DISPATCH" invocations={[]} canRetry={false} onRetry={() => undefined} hostOutbound />);
    expect(html).toContain("固定草稿审批或提交阶段"); expect(html).toContain("系统不会自动重发");
    expect(html).not.toContain("模型文字阶段"); expect(html).not.toContain("模型回复"); expect(html).not.toContain("重试此步骤</button>");
  });
});
