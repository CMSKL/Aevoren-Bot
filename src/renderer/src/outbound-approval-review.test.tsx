import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolInvocation } from "@shared/contracts";
import type { ExternalDraftReviewSnapshot } from "@shared/native-outbound-contracts";
import { isOutboundSend, outboundResultNotice, outboundReviewMatches, outboundStateLabel } from "./outbound-approval-review";
import { ExternalDraftReview } from "./components/ExternalDraftReview";
import { loadScriptApprovalReview } from "./script-approval-review";
import type { ApiResult } from "@shared/contracts";
import type { ApprovalReviewResult } from "@shared/skill-execution-contracts";
import { RunFailureCard } from "./components/CollaborationFeedback";

const snapshot: ExternalDraftReviewSnapshot = { kind: "external-draft", connectionName: "Fixed connection", provider: "gmail", account: { accountId: "account", displayName: "Fixed account", email: "sender@example.com" }, connectionId: "connection", authVersion: 2, grantId: "grant", grantVersion: 3, draftId: "draft", revisionId: "revision", revisionNumber: 4, revisionDigest: "1".repeat(64), operation: "gmail-send", targetIds: ["target@example.com"], content: { kind: "gmail-message", to: ["target@example.com"], cc: [], subject: "FIXED SUBJECT <script>", body: "FIXED BODY <img onerror=alert(1)>" }, intentId: "intent", expectedIntentVersion: 1, targetDigest: "2".repeat(64) };
const invocation = { arguments: { kind: "product-call", action: "execute", operation: "outbound.send", input: { id: "intent", expectedVersion: 1 } } } as ToolInvocation;

describe("immutable outbound approval review", () => {
  it("distinguishes current target state evidence from an accepted submission receipt", () => {
    const observed = { state: "confirmed" as const, lastErrorCode: "TARGET_STATE_MATCH" };
    expect(outboundStateLabel(observed)).toBe("已核对目标当前状态");
    expect(outboundResultNotice(observed)).toContain("无法证明由原请求造成此变化");
    expect(outboundResultNotice(observed)).toContain("没有再次提交");
    const submitted = { state: "confirmed" as const, lastErrorCode: null };
    expect(outboundStateLabel(submitted)).toBe("已确认提交");
    expect(outboundResultNotice(submitted)).toBe("已核对到第三方实际提交结果。");
    const unknown = { state: "unknown" as const, lastErrorCode: "TARGET_STATE_MATCH" };
    expect(outboundStateLabel(unknown)).toContain("结果未确认");
    expect(outboundResultNotice(unknown)).toContain("尚无可验证的提交结果");
  });
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
  it("reviews the frozen Notion title property and new title without claiming a body overwrite", () => {
    const html = renderToStaticMarkup(<ExternalDraftReview snapshot={{ ...snapshot, provider: "notion", operation: "notion-update-page-title", targetIds: ["page-1"], content: { kind: "notion-page-title", pageId: "page-1", title: "New <title>" }, observedNotionTarget: { pageId: "page-1", titlePropertyId: "title-property-1", title: "Original <title>", lastEditedTime: "2026-10-14T00:00:00Z", parentType: "page_id" } }} />);
    expect(html).toContain("title-property-1");
    expect(html).toContain("Original &lt;title&gt;");
    expect(html).toContain("New &lt;title&gt;");
    expect(html).toContain("仅修改上述标题属性，保留页面正文");
    expect(html).toContain("没有充分证据时仍保持结果未知");
    expect(html).not.toContain("FIXED BODY");
  });
  it("reviews an append as end-of-page paragraphs with a read-only proof limit", () => {
    const html = renderToStaticMarkup(<ExternalDraftReview snapshot={{ ...snapshot, provider: "notion", operation: "notion-append-page", targetIds: ["page-2"], content: { kind: "notion-page-append", pageId: "page-2", text: "Append <img>" } }} />);
    expect(html).toContain("在页面末尾追加的段落");
    expect(html).toContain("Append &lt;img&gt;");
    expect(html).toContain("不会覆盖页面内容");
    expect(html).toContain("不能证明由本次操作独占产生");
    expect(html).not.toContain("新标题");
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
