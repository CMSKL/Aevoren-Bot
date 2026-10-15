import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ApprovalRequest, ApprovalResolution, ToolInvocation } from "@shared/contracts";
import { isPublicReadTool } from "@shared/tool-automation";
import { isScriptRun, loadScriptApprovalReview, scriptReviewMatches, type ScriptReviewLoad } from "../script-approval-review";
import { SkillScriptReview } from "./SkillScriptReview";
import { externalReview, isOutboundSend, outboundReviewMatches } from "../outbound-approval-review";
import { ExternalDraftReview } from "./ExternalDraftReview";
import { CloseIcon } from "./Icons";

type Props = {
  approval: ApprovalRequest;
  invocation: ToolInvocation;
  label: string;
  botName: string;
  onResolve(approval: ApprovalRequest, resolution: ApprovalResolution): Promise<boolean>;
  onRememberPublicRead?(approval: ApprovalRequest): Promise<boolean>;
  onStop(): void;
};

export function ToolPermissionDialog({ approval, invocation, label, botName, onResolve, onRememberPublicRead, onStop }: Props): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [review, setReview] = useState<{ key: string; request: number; data: ScriptReviewLoad } | null>(null);
  const reviewRequestRef = useRef(0);
  const [reloadReview, setReloadReview] = useState(0);
  const script = isScriptRun(invocation);
  const outbound = isOutboundSend(invocation);
  const needsReview = script || outbound;
  const reviewKey = `${approval.sessionId}:${approval.executorBotId}:${approval.id}:${approval.version}:${approval.argumentsDigest}:${approval.targetDigest}`;
  const currentReview = review?.key === reviewKey ? review.data : null;
  const externalSnapshot = externalReview(currentReview?.status === "ready" ? currentReview.result : undefined);
  const canAllow = !needsReview || currentReview?.status === "ready" && (script ? scriptReviewMatches(invocation, currentReview.result) : outboundReviewMatches(invocation, currentReview.result));
  const publicRead = isPublicReadTool(invocation.toolKind);
  const localRead = invocation.toolKind === "workspace-read" || invocation.toolKind === "clipboard-read";
  const target = invocation.arguments.kind === "web-search" || invocation.arguments.kind === "workspace-search"
    ? invocation.arguments.query : invocation.targetPath || "文件夹根目录";

  async function decide(resolution: ApprovalResolution | "remember"): Promise<void> {
    if (busyRef.current || resolution !== "deny" && (!canAllow || needsReview && review?.request !== reviewRequestRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const accepted = resolution === "remember"
        ? publicRead && onRememberPublicRead ? await onRememberPublicRead(approval) : false
        : await onResolve(approval, resolution);
      setFailed(!accepted);
    } catch { setFailed(true); }
    finally { busyRef.current = false; setBusy(false); }
  }

  useEffect(() => {
    if (!needsReview) return;
    const request = ++reviewRequestRef.current;
    return loadScriptApprovalReview({ sessionId: approval.sessionId, executorBotId: approval.executorBotId, id: approval.id, expectedVersion: approval.version }, input => window.aevorenBot.approvals.review(input), data => { if (request === reviewRequestRef.current) setReview({ key: reviewKey, request, data }); });
  }, [needsReview, approval.sessionId, approval.executorBotId, approval.id, approval.version, reviewKey, reloadReview]);
  const scriptSnapshot = currentReview?.status === "ready" && currentReview.result.snapshot?.kind === "skill-script" ? currentReview.result.snapshot : null;
  const reviewGrantId = scriptSnapshot?.target.grantId;
  const reviewResourceId = scriptSnapshot?.target.reference.resourceId;
  useEffect(() => {
    if (!script) return;
    const invalidate = (): void => { reviewRequestRef.current += 1; setReview(null); setReloadReview(count => count + 1); };
    const stops = [window.aevorenBot.skillsExecution.onChanged(event => { if (event.sessionId === approval.sessionId && event.executorBotId === approval.executorBotId && (!reviewGrantId || event.grantId === reviewGrantId) && event.type !== "execution") invalidate(); }),
      window.aevorenBot.library.onChanged(event => { if (!reviewResourceId || event.resourceId === reviewResourceId) invalidate(); }),
      window.aevorenBot.environments.onChanged(event => { if (event.sessionId === approval.sessionId && event.executorBotId === approval.executorBotId && event.type === "environment") invalidate(); })];
    return () => { for (const stop of stops) stop(); };
  }, [script, approval.sessionId, approval.executorBotId, reviewGrantId, reviewResourceId]);
  useEffect(() => {
    if (!outbound) return;
    let disposed = false;
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      const request = ++reviewRequestRef.current;
      try {
        const result = await window.aevorenBot.approvals.review({ sessionId: approval.sessionId, executorBotId: approval.executorBotId, id: approval.id, expectedVersion: approval.version });
        if (disposed || request !== reviewRequestRef.current) return;
        setReview({ key: reviewKey, request, data: result.ok ? { status: "ready", result: result.data } : { status: "unavailable", reason: result.error.safeMessage } });
      } catch { if (!disposed && request === reviewRequestRef.current) { reviewRequestRef.current += 1; setReview(null); } }
      finally { inFlight = false; }
    };
    const timer = setInterval(() => void refresh(), 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [outbound, approval.sessionId, approval.executorBotId, approval.id, approval.version, reviewKey]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  return createPortal(
    <div className="tool-permission-backdrop">
      <section
        ref={dialogRef}
        className="tool-permission-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
        data-testid="tool-permission-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void decide("deny"); }
          if (event.key !== "Tab") return;
          const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
          const first = buttons[0];
          const last = buttons.at(-1);
          if (!first || !last) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
        }}
      >
        <header>
          <div><span>{botName}</span><h2 id={titleId}>{publicRead ? "允许公开信息查询？" : `允许${label}？`}</h2></div>
          <button type="button" className="tool-permission-close dialog-close-button" aria-label="拒绝" title="拒绝此次操作" disabled={busy} onClick={() => void decide("deny")}><CloseIcon /></button>
        </header>
        <p id={descriptionId}>{invocation.toolKind === "time-now" ? "本次只读取本机系统时间，不会访问外部网络。" : publicRead
          ? "搜索关键词或网页地址会发送至相应服务。你可以记住公开查询授权，后续无需逐次确认。"
          : "仅授权当前操作，不会扩大这个 Bot 的其他权限。"}</p>
        <div className="tool-permission-target"><strong>{label}</strong><span>{target}</span></div>
        {needsReview ? currentReview?.status === "ready" && (scriptSnapshot || externalSnapshot) ? <>{scriptSnapshot ? <SkillScriptReview snapshot={scriptSnapshot} /> : externalSnapshot ? <ExternalDraftReview snapshot={externalSnapshot} /> : null}{!canAllow ? <p className="tool-permission-error" role="alert">{currentReview.result.reason ?? "快照与本次请求不一致，或授权已失效；此操作不能批准。"}</p> : null}</> : <p role="status">{currentReview?.status === "unavailable" ? currentReview.reason : outbound ? "正在核对本次外发的固定账号、目标与草稿版本…" : "正在核对本次审批的固定脚本、参数与环境…"}</p> : null}
        {needsReview && !canAllow ? <button type="button" className="text-button" disabled={busy} onClick={() => { reviewRequestRef.current += 1; setReview(null); setReloadReview(count => count + 1); }}>{outbound ? "重新核对外发审批" : "重新核对脚本审批"}</button> : null}
        {invocation.arguments.kind === "product-call" && invocation.arguments.action === "execute" ? <details><summary>查看本次操作内容</summary><pre>{JSON.stringify(invocation.arguments.input ?? null, null, 2)}</pre></details> : null}
        {localRead ? <p className="tool-permission-privacy">读取结果会进入模型上下文；使用云端模型时会发送至模型服务。请勿授权密码、密钥等敏感内容。</p> : null}
        {publicRead && onRememberPublicRead ? <p className="tool-permission-privacy">记住的范围仅包括公开网页搜索、抓取、天气与时间。文件、剪贴板、MCP 和外部写操作不包含在内，可在设置中随时关闭。</p> : null}
        {failed ? <p role="alert" className="tool-permission-error">授权未能提交，请重试。未确认的操作不会执行。</p> : null}
        <footer>
          <button type="button" className="text-button" disabled={busy} onClick={onStop}>停止任务</button>
          <div>
            <button type="button" className={publicRead && onRememberPublicRead ? "secondary-button" : "primary-button"} disabled={busy || !canAllow} onClick={() => void decide("allow-once")}>仅允许一次</button>
            {publicRead && onRememberPublicRead ? <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("remember")}>{busy ? "正在保存…" : "允许公开查询并记住"}</button> : null}
          </div>
        </footer>
      </section>
    </div>, document.body,
  );
}
