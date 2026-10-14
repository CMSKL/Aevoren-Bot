import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApiResult } from "@shared/contracts";
import { ENV_EXECUTION_MAX_TIMEOUT_MS, type Environment, type EnvironmentScope } from "@shared/environment-contracts";
import type { ResourceReference } from "@shared/library-contracts";
import { SKILL_SCRIPT_WORKER_VERSION, type SkillExecutionGrant, type SkillGrantInput, type SkillScriptDescriptor, type SkillScriptExecution, type SkillScriptRunInput } from "@shared/skill-execution-contracts";
import { createScriptExecutionRequests } from "../script-execution-requests";
import "../styles/skill-scripts.css";

type Draft = { entryPath: string; args: string; cwd: string; seconds: string };
type Source = { key: string; text: string };
type Confirmation = { kind: "grant"; input: SkillGrantInput; descriptor: SkillScriptDescriptor; source: string }
  | { kind: "revoke"; grant: SkillExecutionGrant }
  | { kind: "run"; input: Omit<SkillScriptRunInput, "clientNonce">; grant: SkillExecutionGrant };
const emptyDraft: Draft = { entryPath: "", args: "[]", cwd: ".", seconds: "120" };
const drafts = new Map<string, Draft>();
const executionLabels = { running: "运行中", completed: "已完成", failed: "失败", cancelled: "已停止", interrupted: "已中断", unknown: "结果未确认" } as const;
export type SkillScriptsSectionProps = EnvironmentScope & { reference: ResourceReference; resourceName: string; revisionNumber: number; ownerName?: string; active?: boolean; disabled?: boolean; onOpenExecution?(input: EnvironmentScope & { id: string }): void };

export function SkillScriptsSection({ sessionId, executorBotId, reference, resourceName, revisionNumber, ownerName, active = true, disabled = false, onOpenExecution }: SkillScriptsSectionProps): React.JSX.Element {
  const { resourceId, revisionId, digest } = reference;
  const scopeKey = `${sessionId}:${executorBotId}:${resourceId}:${revisionId}:${digest}`;
  const executionRequests = useMemo(() => createScriptExecutionRequests(scopeKey), [scopeKey]);
  const [visibleScope, setVisibleScope] = useState(scopeKey);
  const [draft, setDraft] = useState<Draft>(() => drafts.get(scopeKey) ?? { ...emptyDraft });
  const draftRef = useRef(draft);
  const [scripts, setScripts] = useState<SkillScriptDescriptor[] | null>(null);
  const [grants, setGrants] = useState<SkillExecutionGrant[] | null>(null);
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [environmentKnown, setEnvironmentKnown] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [loading, setLoading] = useState(false);
  const [metadataReady, setMetadataReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [execution, setExecution] = useState<SkillScriptExecution | null>(null);
  const [retry, setRetry] = useState<Confirmation | null>(null);
  const scopeRef = useRef(scopeKey);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const loadRequestRef = useRef(0);
  const sourceRequestRef = useRef(0);
  const mutationPendingRef = useRef(false);
  const current = useCallback((key: string, generation: number): boolean => mountedRef.current && scopeRef.current === key && generationRef.current === generation, []);
  function updateDraft(patch: Partial<Draft>): void { const next = { ...draftRef.current, ...patch }; draftRef.current = next; drafts.set(scopeRef.current, next); setDraft(next); }

  const load = useCallback(async (): Promise<void> => {
    if (!active) return;
    const generation = generationRef.current; const request = ++loadRequestRef.current;
    setLoading(true); setMetadataReady(false); setEnvironmentKnown(false);
    const scope = { sessionId, executorBotId };
    try {
      const results = await Promise.allSettled([window.aevorenBot.skillsExecution.scripts({ ...scope, reference: { resourceId, revisionId, digest } }), window.aevorenBot.skillsExecution.executionGrants({ ...scope, resourceId, includeRevoked: true }), window.aevorenBot.environments.get(scope)]);
      if (!current(scopeKey, generation) || request !== loadRequestRef.current) return;
      const messages: string[] = [];
      const inspect = <T,>(result: PromiseSettledResult<ApiResult<T>>, apply: (data: T) => void): void => {
        if (result.status === "fulfilled") { if (result.value.ok) apply(result.value.data); else messages.push(result.value.error.safeMessage); }
        else messages.push("无法读取脚本或授权的实际状态，请刷新。");
      };
      inspect(results[0]!, data => { setScripts(data); if (!data.some(entry => entry.entryPath === draftRef.current.entryPath)) updateDraft({ entryPath: data[0]?.entryPath ?? "" }); });
      inspect(results[1]!, setGrants); inspect(results[2]!, data => { setEnvironment(data); setEnvironmentKnown(true); });
      setMetadataReady(messages.length === 0);
      if (messages.length) setError([...new Set(messages)].join(" "));
    } catch { if (current(scopeKey, generation)) setError("无法读取脚本状态，请刷新实际连接。"); }
    finally { if (current(scopeKey, generation) && request === loadRequestRef.current) setLoading(false); }
  }, [active, sessionId, executorBotId, resourceId, revisionId, digest, scopeKey, current]);
  const reset = useEffectEvent((): void => {
    const next = drafts.get(scopeKey) ?? { ...emptyDraft }; draftRef.current = next; setDraft(next); setVisibleScope(scopeKey);
    setScripts(null); setGrants(null); setEnvironment(null); setEnvironmentKnown(false); setSource(null); setMetadataReady(false); setError(null); setNotice(null); setConfirmation(null); setExecution(null); setRetry(null); setPending(false); mutationPendingRef.current = false; executionRequests.invalidate();
    void load();
  });
  useLayoutEffect(() => {
    mountedRef.current = true; scopeRef.current = scopeKey; generationRef.current += 1; loadRequestRef.current += 1; sourceRequestRef.current += 1;
    let cancelled = false; queueMicrotask(() => { if (!cancelled) reset(); });
    return () => { cancelled = true; mountedRef.current = false; generationRef.current += 1; };
  }, [scopeKey, active]);
  const refresh = useEffectEvent((): void => { void load(); });
  useEffect(() => { if (!active) return; return window.aevorenBot.skillsExecution.onChanged(event => { if (event.sessionId === sessionId && event.executorBotId === executorBotId) refresh(); }); }, [active, sessionId, executorBotId]);
  useEffect(() => { if (!active) return; return window.aevorenBot.environments.onChanged(event => { if (event.type === "environment" && event.sessionId === sessionId && event.executorBotId === executorBotId) refresh(); }); }, [active, sessionId, executorBotId]);
  const selected = scripts?.find(entry => entry.entryPath === draft.entryPath);
  const sourceKey = selected ? `${scopeKey}:${selected.entryPath}:${selected.entrySha256}` : "";
  const selectedPath = selected?.entryPath; const selectedSha = selected?.entrySha256;
  useEffect(() => {
    if (!active || !selectedPath || !selectedSha) return;
    const generation = generationRef.current; const request = ++sourceRequestRef.current; let cancelled = false;
    void window.aevorenBot.library.readFile({ sessionId, id: resourceId, revisionId, path: selectedPath }).then(result => {
      if (cancelled || !current(scopeKey, generation) || request !== sourceRequestRef.current) return;
      if (!result.ok) { setError(result.error.safeMessage); return; }
      if (result.data.relativePath !== selectedPath || result.data.sha256 !== selectedSha || result.data.encoding !== "utf8") { setError("无法核对所选入口的完整 UTF-8 源码与摘要，授权和执行未开放。"); return; }
      setSource({ key: sourceKey, text: result.data.data });
    }).catch(() => { if (!cancelled && current(scopeKey, generation)) setError("无法读取保存版本的真实源码，请重试。"); });
    return () => { cancelled = true; sourceRequestRef.current += 1; };
  }, [active, selectedPath, selectedSha, sourceKey, scopeKey, sessionId, resourceId, revisionId, current]);

  const matching = grants?.find(grant => selected && environment && grant.environmentId === environment.id && grant.imageDigest === environment.imageDigest && grant.workerVersion === environment.workerVersion && grant.reference.resourceId === resourceId && grant.reference.revisionId === revisionId && grant.reference.digest === digest && grant.entryPath === selected.entryPath && grant.entrySha256 === selected.entrySha256 && grant.interpreter === selected.interpreter);
  const ready = !disabled && !pending && !loading && metadataReady && environment?.state === "running" && environment.workerVersion === SKILL_SCRIPT_WORKER_VERSION && selected && source?.key === sourceKey;

  async function perform(action: Confirmation): Promise<void> {
    if (mutationPendingRef.current || action.kind !== "revoke" && !ready) return;
    mutationPendingRef.current = true; setPending(true); setError(null); setNotice(null); setRetry(null); setConfirmation(null);
    const generation = generationRef.current;
    try {
      if (action.kind === "grant") {
        const result = await window.aevorenBot.skillsExecution.grantExecution(action.input);
        if (!current(scopeKey, generation)) return;
        if (!result.ok) { setError(result.error.safeMessage); return; }
        setNotice("已授权所列保存版本、脚本入口和环境镜像。修改版本或环境不会自动沿用此授权。");
      } else if (action.kind === "revoke") {
        const result = await window.aevorenBot.skillsExecution.revokeExecution({ sessionId, executorBotId, id: action.grant.id, expectedVersion: action.grant.version });
        if (!current(scopeKey, generation)) return;
        if (!result.ok) { setError(result.error.safeMessage); return; }
        setNotice("授权已撤销。任务是否停止请以执行环境中的实际状态为准。");
      } else {
        const record = executionRequests.beginRun(action.input);
        const result = await window.aevorenBot.skillsExecution.runScript({ ...action.input, clientNonce: record.nonce });
        if (result.ok) executionRequests.acceptRun(record, result.data.execution);
        if (!current(scopeKey, generation)) return;
        if (!result.ok) { setError(result.error.safeMessage); if (result.error.retryable) setRetry(action); return; }
        setExecution(result.data);
        setNotice(result.data.execution.state === "unknown" ? "执行结果未确认。请查询原任务，不会自动重跑。" : "脚本已交给所列隔离环境执行。输出与退出码来自真实任务。");
      }
      void load();
    } catch { if (current(scopeKey, generation)) { setError("操作结果未确认，请刷新实际状态。脚本不会自动重跑。"); if (action.kind === "run") setRetry(action); } }
    finally { if (current(scopeKey, generation)) { mutationPendingRef.current = false; setPending(false); } }
  }
  function prepareRun(): void {
    if (!ready || !matching || matching.revokedAt) return;
    try {
      const args: unknown = JSON.parse(draft.args);
      if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error("参数必须是 JSON 字符串数组，例如 [\"--limit\", \"10\"]。");
      const timeoutMs = Number(draft.seconds) * 1000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > ENV_EXECUTION_MAX_TIMEOUT_MS) throw new Error("超时应为 1 至 3600 秒。");
      setConfirmation({ kind: "run", grant: matching, input: { sessionId, executorBotId, grantId: matching.id, expectedGrantVersion: matching.version, args, cwd: draft.cwd.trim() || ".", timeoutMs } });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "请核对脚本参数。"); }
  }
  async function refreshExecution(): Promise<void> {
    if (!execution) return;
    const generation = generationRef.current; const id = execution.execution.id; const request = executionRequests.beginQuery();
    try {
      const result = await window.aevorenBot.skillsExecution.scriptExecution({ sessionId, executorBotId, id });
      if (!current(scopeKey, generation) || !executionRequests.isCurrentQuery(request)) return;
      if (result.ok) {
        if (executionRequests.acceptQuery(request, id, result.data.execution)) setExecution(result.data);
      } else setError(result.error.safeMessage);
    } catch { if (current(scopeKey, generation) && executionRequests.isCurrentQuery(request)) setError("无法确认原脚本任务的状态，请重试查询；不会重跑。"); }
  }
  if (!active || visibleScope !== scopeKey) return <section hidden />;
  return <section className="skill-scripts" aria-label="Skill 脚本">
    <header><h4>保存版本的脚本 · v{revisionNumber}</h4><button type="button" className="text-button" disabled={pending || loading} onClick={() => void load()}>刷新脚本与授权</button></header>
    <p className="library-scope-note">{ownerName ?? executorBotId} · 仅当前聊天与执行成员的 Linux 环境。Skill 元信息和工具声明不会授予执行权限。</p>
    {disabled ? <p className="library-scope-note">请先保存或丢弃当前 Skill 草稿，并启用该资源，再授权或执行保存版本。</p> : null}
    {error ? <p role="alert" className="library-error">{error}</p> : null}{notice ? <p role="status" className="library-notice">{notice}</p> : null}
    {scripts === null ? <p role="status">{loading ? "正在读取真实脚本与授权…" : "脚本与授权状态未确认。"}</p> : scripts.length === 0 ? <p>此保存版本没有可执行的 Bash、Python 或 Node 脚本。</p> : <>
      <label className="field"><span>脚本入口</span><select aria-label="Skill 脚本入口" disabled={pending} value={selected?.entryPath ?? ""} onChange={event => { updateDraft({ entryPath: event.target.value }); setConfirmation(null); setRetry(null); }}><option value="">选择脚本…</option>{scripts.map(entry => <option key={entry.entryPath} value={entry.entryPath}>{entry.entryPath} · {entry.interpreter}</option>)}</select></label>
      {selected ? <><p className="library-scope-note">{selected.interpreter} · {selected.size} bytes · 入口摘要 {selected.entrySha256}</p>{source?.key === sourceKey ? <details className="skill-script-code" open><summary>查看此保存版本的真实源码</summary><pre>{source.text}</pre></details> : <p>源码尚未核验，不能授权或执行。</p>}</> : null}
      <p className="library-scope-note">{!environmentKnown ? "当前成员环境状态未确认。" : environment ? `环境 ${environment.id} · Worker ${environment.workerVersion} · ${environment.state}` : "当前成员尚未建立 Linux 环境。"}</p>
      {environment && environment.workerVersion !== SKILL_SCRIPT_WORKER_VERSION ? <p className="library-scope-note">当前环境版本不支持脚本执行。请在执行环境页核对后台服务后重建环境。</p> : null}
      <div className="library-actions"><button type="button" className="secondary-button" disabled={!ready || matching?.revokedAt === null} onClick={() => { if (!ready || !selected || !environment || !source) return; setConfirmation({ kind: "grant", descriptor: selected, source: source.text, input: { sessionId, executorBotId, environmentId: environment.id, expectedImageDigest: environment.imageDigest, expectedWorkerVersion: environment.workerVersion, reference: { resourceId, revisionId, digest }, entryPath: selected.entryPath, interpreter: selected.interpreter, ...(matching ? { expectedVersion: matching.version } : {}) } }); }}>授权此保存版本脚本</button></div>
      <label className="field"><span>参数（JSON 字符串数组）</span><textarea aria-label="Skill 脚本参数" rows={2} maxLength={48_000} value={draft.args} onChange={event => updateDraft({ args: event.target.value })} /></label>
      <div className="skill-script-run-fields"><label className="field"><span>环境内工作目录</span><input aria-label="Skill 脚本工作目录" maxLength={1024} value={draft.cwd} onChange={event => updateDraft({ cwd: event.target.value })} /></label><label className="field"><span>超时（秒）</span><input type="number" aria-label="Skill 脚本超时" min={1} max={3600} value={draft.seconds} onChange={event => updateDraft({ seconds: event.target.value })} /></label></div>
      <button type="button" className="secondary-button" disabled={!ready || !matching || Boolean(matching.revokedAt) || execution?.execution.state === "unknown"} onClick={prepareRun}>运行已授权脚本</button>
    </>}
    {confirmation ? <div className="library-confirm skill-script-confirm" role="group" aria-label="确认脚本操作"><p>{confirmation.kind === "grant" ? `为「${resourceName}」v${revisionNumber} 的固定脚本、当前成员及所列环境镜像授权？` : confirmation.kind === "revoke" ? "撤销此授权及其尚未结束的任务？其他授权和兄弟任务保留。" : "运行以下固定版本脚本与参数？"}</p><pre>{JSON.stringify(confirmation.kind === "grant" ? { ...confirmation.input, entrySha256: confirmation.descriptor.entrySha256 } : confirmation.kind === "run" ? { ...confirmation.input, reference: confirmation.grant.reference, entryPath: confirmation.grant.entryPath, entrySha256: confirmation.grant.entrySha256, interpreter: confirmation.grant.interpreter, environmentId: confirmation.grant.environmentId, imageDigest: confirmation.grant.imageDigest, workerVersion: confirmation.grant.workerVersion } : confirmation.grant, null, 2)}</pre>{confirmation.kind === "grant" ? <details className="skill-script-code"><summary>此次授权的固定源码</summary><pre>{confirmation.source}</pre></details> : null}<div className="library-actions"><button type="button" className="primary-button" disabled={pending || confirmation.kind !== "revoke" && !ready} onClick={() => void perform(confirmation)}>确认脚本操作</button><button type="button" className="text-button" disabled={pending} onClick={() => setConfirmation(null)}>取消脚本操作</button></div></div> : null}
    {grants?.length ? <details className="skill-script-grants" open><summary>当前成员的脚本授权（含历史版本）</summary>{grants.map(grant => <div className="skill-script-grant" key={grant.id}><span>{grant.entryPath} · {grant.interpreter}<small>版本 ID {grant.reference.revisionId} · 授权 v{grant.version} · {grant.revokedAt ? "已撤销" : "已授权"}</small><small>环境 {grant.environmentId} · 镜像 {grant.imageDigest}</small></span>{!grant.revokedAt ? <button type="button" className="text-button danger-text-button" disabled={pending} onClick={() => setConfirmation({ kind: "revoke", grant })}>撤销脚本授权</button> : null}</div>)}</details> : null}
    {execution ? <div className="skill-script-result" role="status"><strong>{execution.entryPath} · {executionLabels[execution.execution.state]}{execution.execution.exitCode !== null ? ` · 退出码 ${execution.execution.exitCode}` : ""}</strong><div className="library-actions"><button type="button" className="text-button" onClick={() => void refreshExecution()}>查询脚本执行状态</button>{onOpenExecution ? <button type="button" className="text-button" onClick={() => onOpenExecution({ sessionId, executorBotId, id: execution.execution.id })}>查看脚本输出</button> : null}</div></div> : null}
    {retry ? <button type="button" className="text-button" disabled={!ready} onClick={() => setConfirmation(retry)}>重试同一脚本请求（沿用原标识）</button> : null}
  </section>;
}
