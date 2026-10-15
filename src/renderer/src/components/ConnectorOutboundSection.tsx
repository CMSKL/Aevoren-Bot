import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalRequest, ApprovalResolution, ToolPrepareResult } from "@shared/contracts";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { ConnectorDraftResult, NativeConnection } from "@shared/native-connector-contracts";
import type { NativeOutboundIntent, NativeWriteGrant, NativeWriteOperation } from "@shared/native-outbound-contracts";
import { outboundOperationLabels, outboundResultNotice, outboundStateLabel, outboundTargetStateNotice } from "../outbound-approval-review";
import { ExternalDraftReview } from "./ExternalDraftReview";
import { ToolPermissionDialog } from "./ToolPermissionDialog";

type Props = EnvironmentScope & { connection: NativeConnection | null; saved: ConnectorDraftResult | null; dirty: boolean; active: boolean; ownerName?: string };
const operationFor = (draft: ConnectorDraftResult): NativeWriteOperation => {
  const content = draft.revision.content;
  if (content.kind === "gmail-message") return "gmail-send";
  if (content.kind === "notion-page") return "notion-create-page";
  if (content.kind === "notion-page-title") return "notion-update-page-title";
  if (content.kind === "notion-page-append") return "notion-append-page";
  return content.targetFileId ? "drive-update-text" : "drive-create-text";
};
const targetsFor = (draft: ConnectorDraftResult): string[] => {
  const content = draft.revision.content;
  if (content.kind === "gmail-message") return [...new Set([...content.to, ...content.cc])];
  if (content.kind === "notion-page") return [content.parentPageId];
  if (content.kind === "notion-page-title" || content.kind === "notion-page-append") return [content.pageId];
  return content.targetFileId ? [content.targetFileId] : [];
};

export function ConnectorOutboundSection({ sessionId, executorBotId, connection, saved, dirty, active, ownerName }: Props): React.JSX.Element {
  const scopeKey = `${sessionId}:${executorBotId}:${connection?.id ?? ""}`;
  const [grants, setGrants] = useState<NativeWriteGrant[]>([]);
  const [intents, setIntents] = useState<NativeOutboundIntent[]>([]);
  const [prepared, setPrepared] = useState<NativeOutboundIntent | null>(null);
  const [approval, setApproval] = useState<ToolPrepareResult | null>(null);
  const [approvalIntent, setApprovalIntent] = useState<NativeOutboundIntent | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: "grant"; operation: NativeWriteOperation; targetIds: string[] } | { kind: "revoke"; grant: NativeWriteGrant } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const operation = saved ? operationFor(saved) : null;
  const targets = saved ? targetsFor(saved) : [];
  const grant = grants.find(value => connection && value.connectionId === connection.id && value.accountId === connection.account?.accountId && value.authVersion === connection.authVersion && value.revokedAt === null && value.operation === operation && targets.every(id => value.targetIds.includes(id))) ?? null;
  const ready = Boolean(saved && !dirty && connection?.state === "connected" && saved.draft.connectionId === connection.id && saved.draft.authVersion === connection.authVersion && saved.draft.accountId === connection.account?.accountId);
  const writeCapabilityReady = ready && (operation !== "gmail-send" || Boolean(connection?.scopes.includes("https://www.googleapis.com/auth/gmail.send")));
  const unresolved = intents.find(intent => intent.draftId === saved?.draft.id && (intent.state === "unknown" || intent.state === "dispatching"));
  const currentIntent = intents.find(intent => intent.draftId === saved?.draft.id && intent.revisionId === saved?.revision.id);
  const load = useCallback(async (): Promise<void> => {
    const request = generation.current;
    try {
      const [loadedGrants, loadedIntents] = await Promise.all([window.aevorenBot.outbound.writeGrants({ sessionId, executorBotId }), window.aevorenBot.outbound.list({ sessionId, executorBotId })]);
      if (request !== generation.current) return;
      if (loadedGrants.ok) setGrants(loadedGrants.data); else setError(loadedGrants.error.safeMessage);
      if (loadedIntents.ok) { setIntents(loadedIntents.data); setPrepared(value => value ? loadedIntents.data.find(item => item.id === value.id) ?? null : null); } else setError(loadedIntents.error.safeMessage);
    } catch { if (request === generation.current) setError("无法核对外发状态，请刷新。"); }
  }, [sessionId, executorBotId]);
  useEffect(() => {
    generation.current += 1;
    const request = generation.current;
    if (!active) return;
    let disposed = false;
    queueMicrotask(() => { if (!disposed) { setPrepared(null); setApproval(null); setApprovalIntent(null); setConfirmation(null); setGrants([]); setIntents([]); setError(null); setNotice(null); setPending(false); void load(); } });
    let inFlight = false;
    const timer = setInterval(() => { if (!inFlight) { inFlight = true; void load().finally(() => { inFlight = false; }); } }, 2000);
    return () => { disposed = true; if (request === generation.current) generation.current += 1; clearInterval(timer); };
  }, [active, scopeKey, load]);
  useEffect(() => {
    queueMicrotask(() => { setConfirmation(null); setPrepared(value => dirty || value && (value.revisionId !== saved?.revision.id || value.revisionDigest !== saved?.revision.digest) ? null : value); });
  }, [dirty, saved?.revision.id, saved?.revision.digest, connection?.authVersion]);

  async function mutateGrant(): Promise<void> {
    if (!connection || !confirmation || pending) return;
    const request = generation.current; setPending(true); setError(null);
    try {
      const previous = confirmation.kind === "grant" ? grants.find(item => item.connectionId === connection.id && item.operation === confirmation.operation && JSON.stringify([...item.targetIds].sort()) === JSON.stringify([...confirmation.targetIds].sort())) : null;
      const result = confirmation.kind === "revoke"
        ? await window.aevorenBot.outbound.revokeWrite({ sessionId, executorBotId, id: confirmation.grant.id, expectedVersion: confirmation.grant.version })
        : await window.aevorenBot.outbound.grantWrite({ sessionId, executorBotId, connectionId: connection.id, expectedAuthVersion: connection.authVersion, operation: confirmation.operation, targetIds: confirmation.targetIds,
          ...(previous ? { expectedVersion: previous.version } : {}) });
      if (request !== generation.current) return;
      if (result.ok) { setNotice(confirmation.kind === "revoke" ? "当前成员的写授权已撤销。已派发结果仍需核对。" : "已授权此账号、操作和目标；每次外发仍需批准固定内容。"); setConfirmation(null); await load(); } else setError(result.error.safeMessage);
    } catch { if (request === generation.current) setError("写授权操作未完成，请刷新核对。"); }
    finally { if (request === generation.current) setPending(false); }
  }
  async function prepare(): Promise<void> {
    if (!ready || !saved || !grant || pending || unresolved || currentIntent && currentIntent.state !== "prepared") return;
    const request = generation.current; setPending(true); setError(null); setNotice(null);
    try {
      const result = await window.aevorenBot.outbound.prepare({ sessionId, executorBotId, draftId: saved.draft.id, revisionId: saved.revision.id, expectedDraftVersion: saved.draft.version, grantId: grant.id, expectedGrantVersion: grant.version });
      if (request !== generation.current) return;
      if (result.ok) { setPrepared(result.data); await load(); } else setError(result.error.safeMessage);
    } catch { if (request === generation.current) setError("外发意图未能准备，尚未提交。"); }
    finally { if (request === generation.current) setPending(false); }
  }
  async function requestApproval(): Promise<void> {
    if (!prepared || prepared.state !== "prepared" || !ready || pending) return;
    const request = generation.current; setPending(true); setError(null);
    try {
      const result = await window.aevorenBot.outbound.requestApproval({ sessionId, executorBotId, id: prepared.id, expectedVersion: prepared.version });
      if (request !== generation.current) return;
      if (result.ok) { setApprovalIntent(prepared); setApproval(result.data); } else setError(result.error.safeMessage);
    } catch { if (request === generation.current) setError("无法打开此固定版本的审批。"); }
    finally { if (request === generation.current) setPending(false); }
  }
  async function resolve(value: ApprovalRequest, resolution: ApprovalResolution): Promise<boolean> {
    const request = generation.current;
    const result = await window.aevorenBot.approvals.resolve({ sessionId: value.sessionId, id: value.id, expectedVersion: value.version, resolution });
    if (request !== generation.current) return false;
    if (!result.ok) { setError(result.error.safeMessage); return false; }
    setApproval(null); setApprovalIntent(null); setNotice(resolution === "deny" ? "已拒绝此次外发。" : "固定内容已批准；请以外发记录的实际状态为准。"); await load(); return true;
  }
  async function intentAction(intent: NativeOutboundIntent, action: "reconcile" | "reject" | "cancel"): Promise<boolean> {
    if (pending) return false;
    const request = generation.current; setPending(true); setError(null);
    try {
      const result = await window.aevorenBot.outbound[action]({ sessionId, executorBotId, id: intent.id, expectedVersion: intent.version });
      if (request !== generation.current) return false;
      if (result.ok) { setNotice(outboundResultNotice(result.data)); await load(); return true; }
      setError(result.error.safeMessage); return false;
    } catch { if (request === generation.current) setError("结果核对未完成，原意图不会重发。"); return false; }
    finally { if (request === generation.current) setPending(false); }
  }

  if (!active) return <section hidden aria-label="应用外发" />;
  return <section className="connector-section" aria-label="应用外发">
    <h4>写入授权与外发</h4><p className="connector-note">读取授权不包含写入。先保存草稿，再为当前账号、操作和目标授权；提交前仍需批准固定内容。</p>
    {error ? <p className="connector-error" role="alert">{error}</p> : null}{notice ? <p className="connector-note" role="status">{notice}</p> : null}
    {saved && operation ? <><p className="connector-note">操作：{outboundOperationLabels[operation]} · 目标：{targets.join("、") || "创建新文件"}</p>{operation === "gmail-send" && !writeCapabilityReady ? <p className="connector-note">请先在应用连接设置中启用 Gmail 发送并重新授权，再为当前成员授予具体收件人的写权限。</p> : null}<div className="connector-actions"><button type="button" className="secondary-button" disabled={pending || !writeCapabilityReady} onClick={() => setConfirmation({ kind: "grant", operation, targetIds: targets })}>{grant ? "更新当前成员写授权" : "授权当前成员写入此目标"}</button>{grant ? <button type="button" className="text-button danger" disabled={pending} onClick={() => setConfirmation({ kind: "revoke", grant })}>撤销成员写授权</button> : null}</div></> : <p className="connector-note">选择已保存的草稿后可配置具体写入目标。</p>}
    {confirmation ? <div className="connector-confirm" role="group" aria-label="确认成员写授权"><p>{confirmation.kind === "revoke" ? "撤销当前成员的此写授权？未提交操作将失效，已派发结果仍需核对。" : `授权「${ownerName ?? "当前成员"}」通过「${connection?.account?.email ?? connection?.account?.displayName ?? "未确认账号"}」${outboundOperationLabels[confirmation.operation]}？此授权仅包含下方目标。`}</p>{confirmation.kind === "grant" ? <pre>{confirmation.targetIds.join("\n") || "创建新文本文件"}</pre> : null}<div className="connector-actions"><button type="button" className="secondary-button" disabled={pending} onClick={() => void mutateGrant()}>确认成员写授权</button><button type="button" className="text-button" disabled={pending} onClick={() => setConfirmation(null)}>取消写授权操作</button></div></div> : null}
    <div className="connector-actions"><button type="button" className="secondary-button" disabled={pending || !ready || !grant || Boolean(unresolved) || Boolean(currentIntent && currentIntent.state !== "prepared")} onClick={() => void prepare()}>准备此保存版本外发</button><button type="button" className="text-button" disabled={pending} onClick={() => void load()}>刷新外发状态</button></div>
    {unresolved ? <p className="connector-note">此草稿仍有派发中或未知结果，不能准备新的提交。请先核对原外发记录。</p> : null}
    {dirty ? <p className="connector-note">当前编辑内容尚未保存，不能提交。保存后需要重新核对此版本。</p> : null}
    {prepared ? <article className="connector-card" aria-label="准备外发的固定版本"><ExternalDraftReview snapshot={prepared.review} /><p role="status">{outboundStateLabel(prepared)}</p>{prepared.state === "prepared" ? <div className="connector-actions"><button type="button" className="primary-button" disabled={pending || !ready || !grant} onClick={() => void requestApproval()}>审阅并批准此版本</button><button type="button" className="text-button" disabled={pending} onClick={() => void intentAction(prepared, "reject")}>拒绝此版本外发</button></div> : null}</article> : null}
    <div className="connector-outbound-list" aria-label="外发记录">{intents.filter(intent => !connection || intent.connectionId === connection.id).map(intent => <article className="connector-card" key={intent.id}><div className="connector-heading"><strong>{outboundOperationLabels[intent.operation]} · v{intent.review.revisionNumber}</strong><span>{outboundStateLabel(intent)}</span></div>{intent.state === "confirmed" && intent.lastErrorCode === "TARGET_STATE_MATCH" ? <p className="connector-note">{outboundTargetStateNotice}</p> : null}<p className="connector-note">{intent.account.email ?? intent.account.displayName} · {intent.updatedAt}</p>{intent.resultResourceId ? <p className="connector-note">第三方结果 ID：{intent.resultResourceId}</p> : null}{intent.state === "dispatching" ? <button type="button" className="secondary-button" disabled={pending} onClick={() => void intentAction(intent, "cancel")}>停止此次提交并核对</button> : null}{intent.state === "unknown" ? <><p className="connector-note">提交结果未知，可能已生效。只读核对不会再次提交；查无结果仍保持未知。</p><button type="button" className="secondary-button" disabled={pending} onClick={() => void intentAction(intent, "reconcile")}>只读核对此次结果</button></> : null}<details><summary>查看该记录固定内容</summary><ExternalDraftReview snapshot={intent.review} /></details></article>)}</div>
    {approval ? <ToolPermissionDialog approval={approval.approval} invocation={approval.invocation} label="外发固定草稿" botName={ownerName ?? "当前成员"} onResolve={resolve} onStop={() => { if (approvalIntent) void intentAction(approvalIntent, "cancel").then(accepted => { if (accepted) { setApproval(null); setApprovalIntent(null); } }); }} /> : null}
  </section>;
}
