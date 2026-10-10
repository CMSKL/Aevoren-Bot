import { memo, useEffect, useId, useMemo, useState } from "react";
import type { BriefApprovalView, ToolInvocation } from "@shared/contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { briefCandidateOptions, type BriefCandidate } from "../brief-approval-state";
import { conversationArtifacts, type ConversationArtifact } from "../conversation-view-model";
import { ArrowRightIcon, ChatIcon, CheckCircleIcon, CheckIcon, DocumentIcon, EyeIcon, WarningIcon } from "./Icons";

export type WorkflowAction =
  | { kind: "approve"; candidate: "A" | "B" | "C"; sourceRuntimeRunId: string; briefInvocationId: string; sha256: string }
  | { kind: "return" }
  | { kind: "abandon" };

export const BriefApprovalCard = memo(function BriefApprovalCard({
  roomId,
  sourceRuntimeRunId,
  briefInvocationId,
  busy,
  onAction,
}: {
  roomId: string;
  sourceRuntimeRunId: string;
  briefInvocationId: string;
  busy: boolean;
  onAction(action: WorkflowAction): Promise<boolean>;
}): React.JSX.Element | null {
  const [candidate, setCandidate] = useState<BriefCandidate | null>(null);
  const [request, setRequest] = useState(0);
  const [view, setView] = useState<{ request: number; data: BriefApprovalView | null } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const radioName = useId();
  const data = view?.request === request ? view.data : null;
  const loading = view?.request !== request;
  const options = useMemo(() => data ? briefCandidateOptions(data.content) : [], [data]);
  const disabled = busy || submitting || submitted;

  useEffect(() => {
    let cancelled = false;
    void window.aevorenBot.rooms.getBriefApproval({ roomId, sourceRuntimeRunId }).then((result) => {
      if (cancelled) return;
      const verified = result.ok && result.data.sourceRuntimeRunId === sourceRuntimeRunId && result.data.briefInvocationId === briefInvocationId;
      setView({ request, data: verified ? result.data : null });
    }).catch(() => {
      if (!cancelled) setView({ request, data: null });
    });
    return () => { cancelled = true; };
  }, [roomId, sourceRuntimeRunId, briefInvocationId, request]);

  async function submit(action: WorkflowAction): Promise<void> {
    if (disabled) return;
    setSubmitting(true);
    setActionFailed(false);
    try {
      const accepted = await onAction(action);
      setSubmitted(accepted);
      setActionFailed(!accepted);
    } catch {
      setActionFailed(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (data?.approved) return null;
  if (submitted) return <div className="brief-decision-status" role="status">决定已提交，正在更新协作状态。</div>;
  return (
    <section className="brief-approval-card" aria-label="Brief 审批" aria-busy={loading || submitting} data-testid="brief-approval-card">
      <header className="brief-approval-heading">
        <span>需要你的决定</span>
        <strong>批准哪个 Brief 候选？</strong>
        <p>以下内容来自已保存的 Brief。选择后确认，系统才会交给内容主笔继续执行。</p>
        {data ? <code className="brief-source-path" title={data.path}>{data.path}</code> : null}
      </header>
      {loading ? <p className="brief-load-status" role="status">正在核对已保存的 Brief…</p> : !data ? (
        <div className="brief-load-status" role="alert">
          <p>暂时无法核对这份 Brief，请重新读取后再批准。</p>
          <button type="button" className="secondary-button" onClick={() => { setCandidate(null); setRequest((value) => value + 1); }}>重新读取 Brief</button>
        </div>
      ) : options.length === 0 ? <p className="brief-load-status" role="status">已读取文件，但未找到包含标题的候选项。请退回补充清晰的候选内容后再批准。</p> : null}
      <div className="brief-candidate-options" role="radiogroup" aria-label="Brief 候选">
        {options.map((option) => (
          <label className={candidate === option.id ? "selected" : ""} key={option.id}>
            <input
              type="radio"
              name={radioName}
              aria-label={`候选 ${option.id}：${option.title}`}
              value={option.id}
              checked={candidate === option.id}
              disabled={disabled}
              onChange={() => setCandidate(option.id)}
            />
            <span className="brief-option-letter">{option.id}</span>
            <span className="brief-option-copy">
              <strong>{option.title}</strong>
              <small>角度：{option.angle ?? "文件未标注"}</small>
              {candidate === option.id ? (
                <span className="brief-option-details">
                  <span><b>证据</b><span>{option.evidence ?? "文件未标注"}</span></span>
                  <span><b>风险</b><span>{option.risk ?? "文件未标注"}</span></span>
                  <span><b>推荐</b><span>{option.recommendation ?? "文件未标注推荐理由"}</span></span>
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      {data ? <details className="brief-source-details"><summary>查看已保存的 Brief 原文</summary><AssistantMarkdown body={data.content} /></details> : null}
      {actionFailed ? <p className="brief-load-status" role="alert">本次决定未能提交，候选内容仍保留。请重试。</p> : null}
      <footer className="brief-approval-actions">
        <button type="button" className="text-button brief-abandon" disabled={disabled} onClick={() => void submit({ kind: "abandon" })}>放弃本轮</button>
        <div>
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => void submit({ kind: "return" })}>退回补证</button>
          <button
            type="button"
            className="primary-button"
            disabled={disabled || !data || !options.some((option) => option.id === candidate)}
            onClick={() => {
              if (data && candidate) void submit({ kind: "approve", candidate, sourceRuntimeRunId: data.sourceRuntimeRunId, briefInvocationId: data.briefInvocationId, sha256: data.sha256 });
            }}
          >
            {submitting ? "正在提交…" : "批准并交给主笔"}
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
      <span className={body.trim() ? "verified" : "neutral"}><ChatIcon aria-hidden="true" />{body.trim() ? "文字已生成" : "没有文字结果"}<small>非执行证据</small></span>
      <span className={succeeded.length > 0 ? "verified" : "neutral"}><CheckIcon aria-hidden="true" />{succeeded.length > 0 ? `工具成功 ${succeeded.length} 次` : "未执行工具"}</span>
      <span className={files.length > 0 ? "verified" : "neutral"}><DocumentIcon aria-hidden="true" />{files.length > 0 ? `文件已保存 ${files.length} 个` : "没有文件写入"}</span>
      <span className={externalReads.length > 0 ? "verified" : "neutral"}><EyeIcon aria-hidden="true" />{externalReads.length > 0 ? `外部读取 ${externalReads.length} 次` : "未执行外部动作"}</span>
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
      <span className="handoff-event-icon" aria-hidden="true"><ArrowRightIcon /></span>
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
      <span className="run-status-icon" aria-hidden="true"><WarningIcon /></span>
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
  onRevealWorkspace,
  onOpenWorkspaces,
}: {
  writes: ToolInvocation[];
  onRevealWorkspace(workspaceId: string, path: string): void;
  onOpenWorkspaces(): void;
}): React.JSX.Element | null {
  const artifacts = conversationArtifacts(writes);
  if (artifacts.length === 0) return null;
  return (
    <section className="artifact-status-bar" aria-label="交付物状态">
      <div className="artifact-card-list">
        {artifacts.map((artifact) => (
          <ArtifactCard
            artifact={artifact}
            key={artifact.id}
            onOpen={() => artifact.invocation.workspaceId
              ? onRevealWorkspace(artifact.invocation.workspaceId, artifact.invocation.targetPath)
              : onOpenWorkspaces()}
          />
        ))}
      </div>
    </section>
  );
});

function formatArtifactBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const ArtifactCard = memo(function ArtifactCard({
  artifact,
  onOpen,
}: {
  artifact: ConversationArtifact;
  onOpen(): void;
}): React.JSX.Element {
  const size = formatArtifactBytes(artifact.bytes);
  const typeLabel = artifact.extension === "MD" ? "Markdown" : artifact.extension ?? "文件";
  return (
    <article className="artifact-card">
      <span className="artifact-card-mark" aria-hidden="true"><DocumentIcon weight="duotone" /></span>
      <span className="artifact-card-copy">
        <strong>{artifact.name}</strong>
        <small className="artifact-card-metadata"><span>{typeLabel}{size ? ` · ${size}` : ""}</span><span className="artifact-card-saved"><CheckCircleIcon weight="fill" />已保存</span></small>
        <code className="artifact-card-path" title={artifact.invocation.targetPath}>{artifact.invocation.targetPath}</code>
      </span>
      <button type="button" className="secondary-button" aria-label="打开文件位置" title={artifact.invocation.targetPath} onClick={onOpen}>打开</button>
    </article>
  );
});
