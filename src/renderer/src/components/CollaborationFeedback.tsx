import { memo, useState } from "react";
import type { ArtifactSaveResult, ToolInvocation } from "@shared/contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { briefCandidateOptions, type BriefCandidate } from "../brief-approval-state";

export type WorkflowAction =
  | { kind: "approve"; candidate: "A" | "B" | "C" }
  | { kind: "return" }
  | { kind: "abandon" };

export type ArtifactSaveState = {
  state: "unsaved" | "saving" | "saved" | "failed";
  result?: ArtifactSaveResult;
  message?: string;
};

export const BriefApprovalCard = memo(function BriefApprovalCard({
  body,
  busy,
  onAction,
}: {
  body: string;
  busy: boolean;
  onAction(action: WorkflowAction): void;
}): React.JSX.Element {
  const [candidate, setCandidate] = useState<BriefCandidate | null>(null);
  const options = briefCandidateOptions(body);
  return (
    <section className="brief-approval-card" aria-label="Brief 审批" data-testid="brief-approval-card">
      <header className="brief-approval-heading">
        <span>需要你的决定</span>
        <strong>批准哪个 Brief 候选？</strong>
        <p>选择后确认，系统才会交给内容主笔继续执行。</p>
      </header>
      <div className="brief-candidate-options" role="radiogroup" aria-label="Brief 候选">
        {options.map((option) => (
          <label className={candidate === option.id ? "selected" : ""} key={option.id}>
            <input
              type="radio"
              name="brief-candidate"
              value={option.id}
              checked={candidate === option.id}
              disabled={busy}
              onChange={() => setCandidate(option.id)}
            />
            <span className="brief-option-letter">{option.id}</span>
            <span className="brief-option-copy">
              <strong>{option.label}</strong>
              {option.label === `候选 ${option.id}` ? null : <small>候选 {option.id}</small>}
            </span>
          </label>
        ))}
      </div>
      <footer className="brief-approval-actions">
        <button type="button" className="text-button brief-abandon" disabled={busy} onClick={() => onAction({ kind: "abandon" })}>放弃本轮</button>
        <div>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => onAction({ kind: "return" })}>退回补证</button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || candidate === null}
            onClick={() => { if (candidate) onAction({ kind: "approve", candidate }); }}
          >
            {busy ? "正在提交…" : "批准并交给主笔"}
          </button>
        </div>
      </footer>
    </section>
  );
});

export const ExecutionEvidenceBar = memo(function ExecutionEvidenceBar({
  body,
  invocations,
}: {
  body: string;
  invocations: ToolInvocation[];
}): React.JSX.Element {
  const succeeded = invocations.filter((invocation) => invocation.state === "succeeded");
  const files = succeeded.filter((invocation) => invocation.toolKind === "workspace-write");
  const externalReads = succeeded.filter((invocation) => ["web-search", "web-fetch", "weather-current", "mcp-call"].includes(invocation.toolKind));
  return (
    <div className="execution-evidence" aria-label="可验证执行状态">
      <span className={body.trim() ? "verified" : "neutral"}><i aria-hidden="true">◇</i>{body.trim() ? "文字已生成" : "没有文字结果"}<small>非执行证据</small></span>
      <span className={succeeded.length > 0 ? "verified" : "neutral"}><i aria-hidden="true">✓</i>{succeeded.length > 0 ? `工具成功 ${succeeded.length} 次` : "未执行工具"}</span>
      <span className={files.length > 0 ? "verified" : "neutral"}><i aria-hidden="true">▣</i>{files.length > 0 ? `文件已保存 ${files.length} 个` : "没有文件写入"}</span>
      <span className={externalReads.length > 0 ? "verified" : "neutral"}><i aria-hidden="true">↗</i>{externalReads.length > 0 ? `外部读取 ${externalReads.length} 次` : "未执行外部动作"}</span>
    </div>
  );
});

export const HandoffEventCard = memo(function HandoffEventCard({
  fromName,
  toName,
  task,
  delivery,
  execution,
  tone,
  createdAt,
}: {
  fromName: string;
  toName: string;
  task: string;
  delivery: string;
  execution?: string | null;
  tone: string;
  createdAt: string;
}): React.JSX.Element {
  const compactTask = task.replace(/\s+/gu, " ").trim();
  return (
    <article className={`handoff-event-card tone-${tone}`} aria-label={`Bot 交接：${fromName} 到 ${toName}`}>
      <span className="handoff-event-icon" aria-hidden="true">→</span>
      <div className="handoff-event-copy">
        <header><strong>{fromName}</strong><span>交给</span><strong>{toName}</strong><time>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(createdAt))}</time></header>
        <p title={compactTask}>{compactTask.length > 180 ? `${compactTask.slice(0, 179)}…` : compactTask}</p>
        <footer><span>投递：{delivery}</span>{execution ? <span>执行：{execution}</span> : null}</footer>
      </div>
    </article>
  );
});

function errorSummary(code: string | null | undefined): string {
  if (!code) return "执行未完成，请重试当前步骤。";
  if (code.includes("TIMEOUT") || code.includes("STALE")) return "模型或工具响应超时，已停止当前步骤。";
  if (code.includes("NETWORK")) return "联网读取失败，已有本地结果仍然保留。";
  if (code.includes("TOOL_ROUND")) return "当前步骤尝试次数达到安全上限。";
  if (code.includes("HANDOFF")) return "Bot 交接未完成，未启动下一位 Bot。";
  if (code.includes("WORKSPACE")) return "文件操作未完成，已有文件不会被覆盖。";
  if (code.includes("INTERRUPTED") || code.includes("APP_INTERRUPTED")) return "运行被应用中断，没有自动重新发送。";
  return "模型回复未完整完成，系统已保留可验证结果。";
}

export const RunFailureCard = memo(function RunFailureCard({
  step,
  errorCode,
  invocations,
  canRetry,
  onRetry,
}: {
  step: string;
  errorCode?: string | null;
  invocations: ToolInvocation[];
  canRetry: boolean;
  onRetry(): void;
}): React.JSX.Element {
  const succeeded = invocations.filter((item) => item.state === "succeeded");
  const saved = succeeded.filter((item) => item.toolKind === "workspace-write");
  return (
    <section className="run-status-card status-error" role="alert">
      <span className="run-status-icon" aria-hidden="true">!</span>
      <div>
        <header><strong>{step}失败</strong><span>需要处理</span></header>
        <p>{errorSummary(errorCode)}</p>
        <dl>
          <div><dt>已完成到</dt><dd>{succeeded.length > 0 ? `${succeeded.length} 次真实工具执行` : "模型文字阶段"}</dd></div>
          <div><dt>仍然有效</dt><dd>{saved.length > 0 ? `${saved.length} 个已保存文件及成功工具结果` : succeeded.length > 0 ? "已成功的工具结果" : "仅保留未验证文字"}</dd></div>
          <div><dt>下一步</dt><dd>{canRetry ? "重试此步骤，系统不会重复覆盖已有文件" : "查看技术详情后重新发起当前步骤"}</dd></div>
        </dl>
        <div className="run-status-actions">
          {canRetry ? <button type="button" className="primary-button" onClick={onRetry}>重试此步骤</button> : null}
          <details><summary>技术详情</summary><code>{errorCode ?? "UNKNOWN_ERROR"}</code></details>
        </div>
      </div>
    </section>
  );
});

export const ArtifactStatusBar = memo(function ArtifactStatusBar({
  writes,
  saveState,
  onSave,
  onReveal,
  onRevealWorkspace,
  onOpenWorkspaces,
}: {
  writes: ToolInvocation[];
  saveState: ArtifactSaveState;
  onSave(): void;
  onReveal(path: string): void;
  onRevealWorkspace(workspaceId: string, path: string): void;
  onOpenWorkspaces(): void;
}): React.JSX.Element {
  const savedWrites = writes.filter((item) => item.toolKind === "workspace-write" && item.state === "succeeded");
  return (
    <section className="artifact-status-bar" aria-label="交付物状态">
      <header><span aria-hidden="true">▣</span><strong>交付物</strong></header>
      {savedWrites.map((item) => (
        <div className="artifact-status-row saved" key={item.id}>
          <span><i aria-hidden="true">✓</i><strong>已保存</strong><code>{item.targetPath}</code></span>
          <button type="button" className="text-button" onClick={() => item.workspaceId ? onRevealWorkspace(item.workspaceId, item.targetPath) : onOpenWorkspaces()}>{item.workspaceId ? "打开文件位置" : "查看工作区"}</button>
        </div>
      ))}
      {saveState.state === "saved" && saveState.result ? (
        <div className="artifact-status-row saved">
          <span><i aria-hidden="true">✓</i><strong>已导出</strong><code>{saveState.result.path}</code></span>
          <button type="button" className="text-button" onClick={() => onReveal(saveState.result!.path)}>打开所在位置</button>
        </div>
      ) : (
        <div className={`artifact-status-row ${saveState.state}`}>
          <span><i aria-hidden="true">{saveState.state === "failed" ? "!" : saveState.state === "saving" ? "…" : "○"}</i><strong>{saveState.state === "saving" ? "保存中" : saveState.state === "failed" ? "保存失败" : "未导出"}</strong>{saveState.message ? <small>{saveState.message}</small> : null}</span>
          <button type="button" className="text-button" disabled={saveState.state === "saving"} onClick={onSave}>{saveState.state === "failed" ? "重试保存" : "保存为 Markdown"}</button>
        </div>
      )}
    </section>
  );
});

function summaryLines(body: string): string[] {
  const lines = body.split(/\r?\n/gu).map((line) => line.replace(/^#{1,6}\s+|^[-*]\s+/u, "").trim()).filter(Boolean);
  const preferred = lines.filter((line) => /结论|交付|下一步|当前状态|推荐|汇总|完成/iu.test(line));
  const selected = preferred.length > 0 ? preferred : lines;
  return selected.slice(0, 3).map((line) => line.length > 140 ? `${line.slice(0, 139)}…` : line);
}

export const LongMessageView = memo(function LongMessageView({ body, collapsible }: { body: string; collapsible: boolean }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  if (!collapsible || expanded) {
    return <div className="long-message-view"><AssistantMarkdown body={body} />{collapsible ? <button type="button" className="text-button long-message-toggle" onClick={() => setExpanded(false)}>收起详细内容</button> : null}</div>;
  }
  return (
    <div className="long-message-view collapsed">
      <div className="message-priority-summary">
        <strong>结论、交付物与下一步</strong>
        <ul>{summaryLines(body).map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ul>
      </div>
      <button type="button" className="secondary-button long-message-toggle" aria-expanded="false" onClick={() => setExpanded(true)}>展开证据与完整过程</button>
    </div>
  );
});
