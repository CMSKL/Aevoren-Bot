import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { ApiResult } from "@shared/contracts";
import type { ServicePreview } from "@shared/browser-contracts";
import type { BackgroundProcess, Environment, EnvironmentChangedEvent, EnvironmentFileContent, EnvironmentFileList, EnvironmentProbe, Execution, ExecutionLogsPage, RegisteredPort } from "@shared/environment-contracts";
import "../styles/environment.css";

type EnvironmentDraft = { command: string; cwd: string; directory: string; filePath: string; fileContent: string; port: string; portLabel: string };
const emptyDraft: EnvironmentDraft = { command: "", cwd: ".", directory: ".", filePath: "", fileContent: "", port: "", portLabel: "" };
// Unsent command drafts are kept only in this window's memory. They are never replayed.
const scopeDrafts = new Map<string, EnvironmentDraft>();
const requestNonces = new Map<string, { key: string; nonce: string; executionId?: string }>();
const environmentStates: Record<Environment["state"], string> = { starting: "正在启动", running: "运行中", stopped: "已休眠", error: "环境异常", unknown: "环境连接未确认" };
const executionStates: Record<Execution["state"], string> = { running: "运行中", completed: "已完成", failed: "失败", cancelled: "已停止", interrupted: "已中断", unknown: "结果未确认" };

function probeLabel(probe: EnvironmentProbe): string {
  if (!probe.dockerInstalled) return "未找到 Docker";
  if (!probe.daemonReachable) return "Docker 引擎未运行";
  if (!probe.available) return "当前 Docker 环境不可用";
  return probe.workerImagePresent ? "Docker 与 Linux 镜像可用" : "需要准备 Linux 镜像";
}

export function DockerStatusCard({ active = true }: { active?: boolean }): React.JSX.Element {
  const [probe, setProbe] = useState<EnvironmentProbe | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const refresh = useCallback(async (initialize = false): Promise<void> => {
    const request = ++requestRef.current;
    setPending(true); setError(null);
    try {
      const result = initialize ? await window.aevorenBot.environments.initialize() : await window.aevorenBot.environments.probe();
      if (!mountedRef.current || request !== requestRef.current) return;
      if (result.ok) setProbe("probe" in result.data ? result.data.probe : result.data);
      else setError(result.error.safeMessage);
    } catch { if (mountedRef.current && request === requestRef.current) setError("无法读取 Docker 状态，请重试。"); }
    finally { if (mountedRef.current && request === requestRef.current) setPending(false); }
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    queueMicrotask(() => { if (active && !cancelled) void refresh(); });
    return () => { cancelled = true; mountedRef.current = false; requestRef.current += 1; };
  }, [active, refresh]);
  return <section className="settings-card docker-status-card" aria-label="Docker 执行环境">
    <div className="environment-heading"><h3>Linux 执行环境</h3><button className="secondary-button" type="button" disabled={pending} onClick={() => void refresh()}>{pending ? "检查中…" : "检查 Docker"}</button></div>
    <p>使用本机 Docker，在按聊天和 Bot 隔离的 Linux 环境中运行命令与后台服务。</p>
    {probe ? <><strong>{probeLabel(probe)}</strong>{probe.reason ? <p>{probe.reason}</p> : null}<dl><dt>引擎版本</dt><dd>{probe.serverVersion ?? "未确认"}</dd><dt>Linux 平台</dt><dd>{probe.platform ?? "未确认"}</dd></dl><button type="button" className="secondary-button" disabled={pending || !probe.available} onClick={() => void refresh(true)}>准备 Linux 镜像</button></> : <p role="status">{pending ? "正在读取本机状态…" : "尚未读取本机状态。"}</p>}
    {error ? <p className="environment-error" role="alert">{error}</p> : null}
  </section>;
}

export type EnvironmentPanelProps = { sessionId: string; executorBotId: string; ownerName?: string; active?: boolean; initialExecutionId?: string; onOpenPreview?(pageId?: string): void };

export function EnvironmentPanel({ sessionId, executorBotId, ownerName, active = true, initialExecutionId, onOpenPreview }: EnvironmentPanelProps): React.JSX.Element {
  const scopeKey = `${sessionId}:${executorBotId}`;
  const [visibleScope, setVisibleScope] = useState(scopeKey);
  const [draft, setDraft] = useState<EnvironmentDraft>(() => scopeDrafts.get(scopeKey) ?? { ...emptyDraft });
  const draftRef = useRef(draft);
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [environmentLoaded, setEnvironmentLoaded] = useState(false);
  const [probe, setProbe] = useState<EnvironmentProbe | null>(null);
  const [executions, setExecutions] = useState<Execution[] | null>(null);
  const [background, setBackground] = useState<BackgroundProcess[] | null>(null);
  const [ports, setPorts] = useState<RegisteredPort[] | null>(null);
  const [files, setFiles] = useState<EnvironmentFileList | null>(null);
  const [fileBaseline, setFileBaseline] = useState<EnvironmentFileContent | null>(null);
  const [fileExpected, setFileExpected] = useState<{ path: string; sha256: string } | null>(null);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const selectedExecutionRef = useRef(selectedExecutionId);
  const [selectedExecution, setSelectedExecution] = useState<Execution | null>(null);
  const [logs, setLogs] = useState<ExecutionLogsPage | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"stop" | "rebuild" | null>(null);
  const [portProcessId, setPortProcessId] = useState("");
  const scopeRef = useRef(scopeKey);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const snapshotRequestRef = useRef(0);
  const fileRequestRef = useRef(0);
  const logRequestRef = useRef(0);
  const environmentVersionRef = useRef(0);
  const isCurrent = useCallback((key: string, generation: number): boolean => mountedRef.current && scopeRef.current === key && generationRef.current === generation, []);

  function replaceDraft(next: EnvironmentDraft): void {
    draftRef.current = next; scopeDrafts.set(scopeRef.current, next); setDraft(next);
  }
  function updateDraft(field: keyof EnvironmentDraft, value: string): void {
    replaceDraft({ ...draftRef.current, [field]: value });
    if (field === "filePath") { setFileBaseline(null); setFileExpected(null); }
  }

  const loadSnapshot = useCallback(async (): Promise<void> => {
    if (!active) return;
    const generation = generationRef.current;
    const request = ++snapshotRequestRef.current;
    setLoading(true);
    const scope = { sessionId, executorBotId };
    const results = await Promise.allSettled([window.aevorenBot.environments.get(scope), window.aevorenBot.environments.probe(), window.aevorenBot.execution.list(scope), window.aevorenBot.processes.list(scope), window.aevorenBot.processes.listPorts(scope)]);
    if (!isCurrent(scopeKey, generation) || request !== snapshotRequestRef.current) return;
    const messages: string[] = [];
    const inspect = <T,>(result: PromiseSettledResult<ApiResult<T>>, apply: (data: T) => void): void => {
      if (result.status === "fulfilled") { if (result.value.ok) apply(result.value.data); else messages.push(result.value.error.safeMessage); }
      else messages.push("暂时无法读取执行环境，请刷新状态。");
    };
    inspect(results[0]!, data => { setEnvironmentLoaded(true); if (!data || data.version >= environmentVersionRef.current) { environmentVersionRef.current = data?.version ?? 0; setEnvironment(data); } });
    inspect(results[1]!, setProbe); inspect(results[2]!, data => {
      setExecutions(data);
      for (const kind of ["foreground", "background"]) {
        const record = requestNonces.get(`${scopeKey}:${kind}`);
        if (record?.executionId && data.some(task => task.id === record.executionId && task.state !== "unknown")) requestNonces.delete(`${scopeKey}:${kind}`);
      }
    }); inspect(results[3]!, setBackground); inspect(results[4]!, setPorts);
    setLoadError(messages.length ? [...new Set(messages)].join(" ") : null);
    setLoading(false);
  }, [active, sessionId, executorBotId, scopeKey, isCurrent]);

  const loadFiles = useCallback(async (path: string): Promise<void> => {
    path = path.trim() || ".";
    const generation = generationRef.current;
    const request = ++fileRequestRef.current;
    try {
      const result = await window.aevorenBot.execution.listFiles({ sessionId, executorBotId, path });
      if (!isCurrent(scopeKey, generation) || request !== fileRequestRef.current || (draftRef.current.directory.trim() || ".") !== path) return;
      if (result.ok) setFiles(result.data); else setError(result.error.safeMessage);
    } catch { if (isCurrent(scopeKey, generation) && request === fileRequestRef.current) setError("无法读取环境目录，请重试。"); }
  }, [sessionId, executorBotId, scopeKey, isCurrent]);

  const loadLogs = useCallback(async (id: string, afterSeq = 0): Promise<void> => {
    const generation = generationRef.current;
    const request = ++logRequestRef.current;
    try {
      const [task, output] = await Promise.all([window.aevorenBot.execution.get({ sessionId, executorBotId, id }), window.aevorenBot.execution.logs({ sessionId, executorBotId, id, afterSeq, limit: 250, maxBytes: 65_536 })]);
      if (!isCurrent(scopeKey, generation) || request !== logRequestRef.current || selectedExecutionRef.current !== id) return;
      if (task.ok) setSelectedExecution(task.data); else setError(task.error.safeMessage);
      if (output.ok) setLogs(current => afterSeq > 0 && current?.executionId === id ? { ...output.data, logs: [...new Map([...current.logs, ...output.data.logs].map(log => [log.seq, log])).values()].slice(-500) } : output.data);
      else setError(output.error.safeMessage);
    } catch { if (isCurrent(scopeKey, generation) && request === logRequestRef.current) setError("无法读取任务输出，请重试。"); }
  }, [sessionId, executorBotId, scopeKey, isCurrent]);

  function viewExecution(id: string): void {
    selectedExecutionRef.current = id; setSelectedExecutionId(id); setSelectedExecution(null); setLogs(null); void loadLogs(id);
  }
  const openInitialExecution = useEffectEvent((): void => { if (active && initialExecutionId) viewExecution(initialExecutionId); });
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) openInitialExecution(); });
    return () => { cancelled = true; };
  }, [active, scopeKey, initialExecutionId]);

  const resetScope = useEffectEvent((): void => {
    setVisibleScope(scopeKey); replaceDraft(scopeDrafts.get(scopeKey) ?? { ...emptyDraft });
    setEnvironment(null); setEnvironmentLoaded(false); setProbe(null); setExecutions(null); setBackground(null); setPorts(null); setFiles(null); setFileBaseline(null); setFileExpected(null);
    setSelectedExecutionId(null); selectedExecutionRef.current = null; setSelectedExecution(null); setLogs(null);
    setError(null); setLoadError(null); setNotice(null); setConfirmation(null); setPending(null); setPortProcessId(""); environmentVersionRef.current = 0;
    void loadSnapshot();
  });
  useLayoutEffect(() => {
    mountedRef.current = true; scopeRef.current = scopeKey; generationRef.current += 1;
    snapshotRequestRef.current += 1; fileRequestRef.current += 1; logRequestRef.current += 1;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) resetScope(); });
    return () => { cancelled = true; mountedRef.current = false; generationRef.current += 1; };
  }, [scopeKey]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (active && !cancelled) void loadSnapshot(); });
    return () => { cancelled = true; };
  }, [active, loadSnapshot]);
  useEffect(() => {
    if (!active || environment?.state !== "running") return;
    void loadFiles(draftRef.current.directory);
  }, [active, environment?.state, scopeKey, loadFiles]);
  const changed = useEffectEvent((event: EnvironmentChangedEvent): void => {
    if (!active || event.sessionId !== sessionId || event.executorBotId !== executorBotId) return;
    if (event.type === "log") {
      if (event.executionId === selectedExecutionRef.current && event.log) setLogs(current => current && current.executionId === event.executionId ? { ...current, logs: [...new Map([...current.logs, event.log!].map(log => [log.seq, log])).values()].slice(-500), lastSeq: Math.max(current.lastSeq, event.log!.seq) } : current);
      return;
    }
    void loadSnapshot();
    if (selectedExecutionRef.current && (event.executionId === selectedExecutionRef.current || event.type === "environment")) void loadLogs(selectedExecutionRef.current);
  });
  useEffect(() => {
    if (!active) return;
    return window.aevorenBot.environments.onChanged(event => changed(event));
  }, [active, sessionId, executorBotId]);

  async function perform<T>(name: string, operation: () => Promise<ApiResult<T>>, apply?: (data: T) => void): Promise<void> {
    const generation = generationRef.current;
    setPending(name); setError(null); setNotice(null);
    try {
      const result = await operation();
      if (!isCurrent(scopeKey, generation)) return;
      if (!result.ok) { setError(result.error.safeMessage); return; }
      apply?.(result.data); void loadSnapshot();
    } catch { if (isCurrent(scopeKey, generation)) setError("操作未能确认完成，请刷新实际状态后再处理。命令草稿仍然保留。"); }
    finally { if (isCurrent(scopeKey, generation)) setPending(null); }
  }

  async function changeEnvironment(action: "start" | "stop" | "rebuild"): Promise<void> {
    await perform(action, () => window.aevorenBot.environments[action]({ sessionId, executorBotId, ...(environment ? { expectedVersion: environment.version } : {}) }), data => {
      environmentVersionRef.current = data.version; setEnvironment(data); setConfirmation(null);
    });
  }

  async function runCommand(kind: "foreground" | "background"): Promise<void> {
    const command = draftRef.current.command;
    const cwd = draftRef.current.cwd.trim() || ".";
    if (!command.trim()) return;
    const nonceScope = `${scopeKey}:${kind}`;
    const key = JSON.stringify({ command, cwd });
    const previous = requestNonces.get(nonceScope);
    const record: { key: string; nonce: string; executionId?: string } = previous?.key === key ? previous : { key, nonce: crypto.randomUUID() };
    requestNonces.set(nonceScope, record);
    const input = { sessionId, executorBotId, command, cwd, clientNonce: record.nonce };
    await perform(kind, async () => {
      const result = kind === "foreground" ? await window.aevorenBot.execution.run(input) : await window.aevorenBot.processes.start(input);
      if (result.ok && requestNonces.get(nonceScope) === record) {
        if (result.data.state === "unknown") record.executionId = result.data.id;
        else requestNonces.delete(nonceScope);
      }
      return result;
    }, data => {
      viewExecution(data.id);
      setNotice(data.state === "unknown" ? "远端接收结果未确认。请查看任务状态与输出，不会自动重发。" : `${kind === "background" ? "后台进程" : "命令"}已登记。`);
    });
  }

  async function openPreview(port: RegisteredPort): Promise<void> {
    await perform<ServicePreview>("preview", async (): Promise<ApiResult<ServicePreview>> => {
      const scope = { sessionId, executorBotId };
      const [browserResult, controlResult] = await Promise.all([window.aevorenBot.browser.get(scope), window.aevorenBot.computer.view(scope)]);
      if (!browserResult.ok) return browserResult;
      if (!controlResult.ok) return controlResult;
      if (!browserResult.data || browserResult.data.state !== "running" || !controlResult.data || controlResult.data.owner !== "user" || controlResult.data.browserSessionId !== browserResult.data.id || controlResult.data.epoch !== browserResult.data.controlEpoch) {
        return { ok: false, error: { domain: "runtime", code: "CONFLICT", retryable: true, safeMessage: "请先在浏览器页启动并接管电脑，再打开已登记的服务预览。" } };
      }
      const payload = { ...scope, expectedEpoch: controlResult.data.epoch, registeredPortId: port.id };
      const nonceScope = `${scopeKey}:preview`;
      const key = JSON.stringify(payload);
      const previous = requestNonces.get(nonceScope);
      const record = previous?.key === key ? previous : { key, nonce: crypto.randomUUID() };
      requestNonces.set(nonceScope, record);
      const result = await window.aevorenBot.preview.open({ ...payload, clientNonce: record.nonce });
      if (result.ok && result.data.state !== "unknown" && requestNonces.get(nonceScope) === record) requestNonces.delete(nonceScope);
      return result;
    }, data => { setNotice(data.state === "unknown" ? "预览结果未确认，请在浏览器页刷新实际状态。" : "已打开登记服务的真实浏览器页面。"); onOpenPreview?.(data.pageId); });
  }

  async function readFile(): Promise<void> {
    const path = draftRef.current.filePath.trim();
    const contentAtStart = draftRef.current.fileContent;
    if (!path) return;
    await perform("read-file", () => window.aevorenBot.execution.readFile({ sessionId, executorBotId, path }), data => {
      if (draftRef.current.filePath.trim() !== path) return;
      setFileBaseline(data);
      setFileExpected({ path: data.path, sha256: data.sha256 });
      if (data.encoding === "utf8" && draftRef.current.fileContent === contentAtStart) replaceDraft({ ...draftRef.current, fileContent: data.content });
      else if (data.encoding === "utf8") setNotice("文件已读取，读取期间修改的文本草稿仍然保留。");
      else setNotice("已读取二进制文件元信息，可下载保存。");
    });
  }

  async function writeFile(): Promise<void> {
    const path = draftRef.current.filePath.trim();
    const content = draftRef.current.fileContent;
    if (!path) return;
    await perform("write-file", () => window.aevorenBot.execution.writeFile({ sessionId, executorBotId, path, content, encoding: "utf8", ...(fileExpected?.path === path ? { expectedSha256: fileExpected.sha256 } : {}) }), data => {
      if (draftRef.current.filePath.trim() === path) setFileExpected({ path: data.path, sha256: data.sha256 });
      setNotice(`已保存 ${data.path}（${data.size} bytes）。`); void loadFiles(draftRef.current.directory);
    });
  }

  if (!active) return <section className="environment-panel" aria-label="执行环境" hidden />;
  if (visibleScope !== scopeKey) return <section className="environment-panel" aria-label="执行环境"><p role="status">正在切换执行范围…</p></section>;
  const ready = environment?.state === "running";
  const unknownRequest = [...(executions ?? []), ...(background ?? [])].some(task => task.state === "unknown");
  const foreground = executions?.filter(task => task.kind === "foreground");
  const selectedProcess = background?.find(process => process.id === portProcessId && process.state === "running");
  const stopping = environment?.state === "starting";
  return <section className="environment-panel" aria-label="执行环境" data-testid="environment-panel">
    <div className="environment-heading"><h3>执行环境</h3><span className={`environment-state state-${environment?.state ?? "uninitialized"}`} role="status">{environment ? environmentStates[environment.state] : loading ? "正在读取" : environmentLoaded ? "尚未创建" : "状态未确认"}</span></div>
    <p className="environment-scope">{ownerName ?? "当前会话与 Bot"}的独立 Linux 环境。命令、进程和文件按当前聊天与执行成员隔离。</p>
    {probe ? <p className="environment-note">{probeLabel(probe)}{probe.reason ? ` · ${probe.reason}` : ""}</p> : null}
    <div className="environment-actions"><button className="secondary-button" type="button" disabled={loading} onClick={() => void loadSnapshot()}>刷新状态</button><button className="secondary-button" type="button" disabled={Boolean(pending) || !probe?.available} onClick={() => void perform("initialize", () => window.aevorenBot.environments.initialize(), data => { setProbe(data.probe); setNotice(data.probe.workerImagePresent ? "Linux 镜像已准备。" : data.probe.reason ?? "Linux 镜像状态未确认。"); })}>{pending === "initialize" ? "准备镜像中…" : "准备 Linux 镜像"}</button><button className="primary-button" type="button" disabled={Boolean(pending) || ready || stopping || !probe?.available || !environmentLoaded} onClick={() => void changeEnvironment("start")}>{pending === "start" ? "正在启动…" : environment ? "唤醒环境" : "启动环境"}</button>{environment ? <><button className="text-button" type="button" disabled={Boolean(pending) || environment.state === "stopped"} onClick={() => setConfirmation("stop")}>休眠</button><button className="text-button danger-text-button" type="button" disabled={Boolean(pending)} onClick={() => setConfirmation("rebuild")}>重建环境</button></> : null}</div>
    {confirmation ? <div className="environment-confirm" role="alert"><p>{confirmation === "stop" ? "休眠会停止当前成员环境中的前台命令和后台服务，保留工作目录。" : "重建会停止当前成员环境中的任务与后台服务，并重新创建执行容器。任务不会自动重放。"}</p><div className="environment-actions"><button className="secondary-button" type="button" disabled={Boolean(pending)} onClick={() => void changeEnvironment(confirmation)}>确认{confirmation === "stop" ? "休眠" : "重建"}</button><button className="text-button" type="button" disabled={Boolean(pending)} onClick={() => setConfirmation(null)}>取消</button></div></div> : null}
    {error || loadError ? <p className="environment-error" role="alert">{error ?? loadError}</p> : null}
    {notice ? <p className="environment-notice" role="status">{notice}</p> : null}
    {environment ? <details className="environment-technical"><summary>环境详情</summary><p>{environment.platform} · Worker {environment.workerVersion}</p><p>镜像 {environment.imageRef}</p><p>摘要 {environment.imageDigest || "尚未确认"}</p></details> : null}
    <section className="environment-section" aria-label="运行命令"><div className="environment-section-heading"><h4>命令</h4></div><label className="field"><span>环境内工作目录</span><input aria-label="命令工作目录" value={draft.cwd} maxLength={500} onChange={event => updateDraft("cwd", event.target.value)} /></label><label className="field"><span>命令草稿</span><textarea className="environment-command" aria-label="执行命令" value={draft.command} maxLength={65_536} rows={4} onChange={event => updateDraft("command", event.target.value)} /></label><p className="environment-note">草稿在切换成员后保留。点击运行才执行；后台进程拥有独立的停止与日志入口。</p><div className="environment-actions"><button className="primary-button" type="button" disabled={!ready || Boolean(pending) || !draft.command.trim() || unknownRequest} onClick={() => void runCommand("foreground")}>运行命令</button><button className="secondary-button" type="button" disabled={!ready || Boolean(pending) || !draft.command.trim() || unknownRequest} onClick={() => void runCommand("background")}>后台运行</button></div>{unknownRequest ? <p className="environment-note" role="status">当前有接收结果未确认的任务，请刷新状态并核对输出后处理。</p> : null}</section>
    <section className="environment-section" aria-label="前台任务"><h4>前台任务</h4><div className="environment-task-list">{foreground?.map(task => <article className={`environment-task${selectedExecutionId === task.id ? " selected" : ""}`} key={task.id}><div className="environment-task-heading"><span>{executionStates[task.state]}{task.exitCode !== null ? ` · 退出码 ${task.exitCode}` : ""}</span><button className="text-button" type="button" onClick={() => viewExecution(task.id)}>查看输出</button></div><pre className="environment-task-command">{task.command}</pre>{task.state === "running" || task.state === "unknown" ? <button className="text-button danger-text-button" type="button" disabled={Boolean(pending)} onClick={() => void perform("cancel", () => window.aevorenBot.execution.cancel({ sessionId, executorBotId, id: task.id }), data => { if (selectedExecutionRef.current === data.id) void loadLogs(data.id); })}>停止此任务</button> : null}</article>)}{foreground?.length === 0 ? <p className="environment-note">暂无前台任务。</p> : foreground === undefined ? <p className="environment-note">{loading ? "正在读取任务…" : "任务记录尚未读取。"}</p> : null}</div></section>
    <section className="environment-section" aria-label="后台进程"><h4>后台进程</h4><div className="environment-task-list">{background?.map(process => <article className={`environment-task${selectedExecutionId === process.id ? " selected" : ""}`} key={process.id}><div className="environment-task-heading"><span>{executionStates[process.state]}{process.exitCode !== null ? ` · 退出码 ${process.exitCode}` : ""}</span><button className="text-button" type="button" onClick={() => viewExecution(process.id)}>查看日志</button></div><pre className="environment-task-command">{process.command}</pre>{process.state === "running" || process.state === "unknown" ? <button className="text-button danger-text-button" type="button" disabled={Boolean(pending)} onClick={() => void perform("stop-process", () => window.aevorenBot.processes.stop({ sessionId, executorBotId, id: process.id }), data => { if (selectedExecutionRef.current === data.id) void loadLogs(data.id); })}>停止后台进程</button> : null}</article>)}{background?.length === 0 ? <p className="environment-note">暂无后台进程。</p> : background === null ? <p className="environment-note">{loading ? "正在读取进程…" : "进程记录尚未读取。"}</p> : null}</div></section>
    {selectedExecutionId ? <section className="environment-section" aria-label="任务输出"><div className="environment-section-heading"><h4>任务输出</h4><button className="text-button" type="button" onClick={() => void loadLogs(selectedExecutionId)}>刷新输出</button></div>{selectedExecution ? <p className="environment-note">{executionStates[selectedExecution.state]}{selectedExecution.exitCode !== null ? ` · 退出码 ${selectedExecution.exitCode}` : ""}{selectedExecution.signal ? ` · ${selectedExecution.signal}` : ""}</p> : null}<pre className="environment-output" role="log" aria-live="polite">{logs ? logs.logs.map(log => <span key={log.seq} data-stream={log.stream}>{log.text}</span>) : "正在读取输出…"}</pre>{logs ? <div className="environment-actions"><button className="text-button" type="button" onClick={() => void loadLogs(selectedExecutionId, logs.lastSeq)}>读取后续输出</button>{logs.truncated ? <span className="environment-note">输出已达到保存上限，部分内容未保留。</span> : null}</div> : null}</section> : null}
    <section className="environment-section" aria-label="环境文件"><h4>环境文件</h4><label className="field"><span>目录</span><input aria-label="环境目录" value={draft.directory} maxLength={500} onChange={event => updateDraft("directory", event.target.value)} /></label><div className="environment-actions"><button className="secondary-button" type="button" disabled={!ready} onClick={() => void loadFiles(draft.directory.trim() || ".")}>读取目录</button><button className="secondary-button" type="button" disabled={!ready || Boolean(pending)} onClick={() => void perform("upload", () => window.aevorenBot.execution.pickUpload({ sessionId, executorBotId, directory: draft.directory.trim() || "." }), data => { if (data) { setNotice(`已上传 ${data.length} 个文件。`); void loadFiles(draftRef.current.directory); } })}>上传文件</button></div><div className="environment-file-list">{files?.entries.map(file => <div className="environment-file-row" key={file.path}><button className="text-button" type="button" onClick={() => { if (file.type === "directory") { updateDraft("directory", file.path); if (ready) void loadFiles(file.path); } else updateDraft("filePath", file.path); }}>{file.path}{file.type === "directory" ? "/" : ""}</button><span>{file.type === "directory" ? "目录" : `${file.size} bytes`}</span></div>)}{files?.truncated ? <p className="environment-note">目录条目已截断，请进入子目录查看。</p> : null}</div><label className="field"><span>文件路径</span><input aria-label="环境文件路径" value={draft.filePath} maxLength={500} onChange={event => updateDraft("filePath", event.target.value)} /></label><div className="environment-actions"><button className="secondary-button" type="button" disabled={!ready || Boolean(pending) || !draft.filePath.trim()} onClick={() => void readFile()}>读取文件</button><button className="text-button" type="button" disabled={!ready || Boolean(pending) || !draft.filePath.trim()} onClick={() => void perform("download", () => window.aevorenBot.execution.downloadFile({ sessionId, executorBotId, path: draft.filePath.trim() }), data => { if (data) setNotice(`已下载 ${data.name}（${data.size} bytes）。`); })}>下载文件</button></div>{fileBaseline ? <p className="environment-note">上次读取：{fileBaseline.path} · {fileBaseline.size} bytes · {fileBaseline.mimeType}</p> : null}{fileBaseline?.encoding !== "base64" ? <><label className="field"><span>文本文件内容</span><textarea className="environment-file-editor" aria-label="环境文件内容" value={draft.fileContent} rows={8} maxLength={1_048_576} onChange={event => updateDraft("fileContent", event.target.value)} /></label><button className="secondary-button" type="button" disabled={!ready || Boolean(pending) || !draft.filePath.trim()} onClick={() => void writeFile()}>保存文本文件</button></> : null}</section>
    <section className="environment-section" aria-label="登记服务端口"><h4>服务端口</h4><label className="field"><span>后台进程</span><select aria-label="端口所属进程" value={selectedProcess?.id ?? ""} onChange={event => setPortProcessId(event.target.value)}><option value="">选择运行中的后台进程…</option>{background?.filter(process => process.state === "running").map(process => <option key={process.id} value={process.id}>{process.command}</option>)}</select></label><label className="field"><span>环境内端口</span><input aria-label="环境服务端口" inputMode="numeric" value={draft.port} maxLength={5} onChange={event => updateDraft("port", event.target.value)} /></label><label className="field"><span>服务名称</span><input aria-label="环境服务名称" value={draft.portLabel} maxLength={120} onChange={event => updateDraft("portLabel", event.target.value)} /></label><button className="secondary-button" type="button" disabled={!ready || Boolean(pending) || !selectedProcess || !/^\d+$/.test(draft.port) || Number(draft.port) < 1 || Number(draft.port) > 65_535} onClick={() => { if (selectedProcess) void perform("register-port", () => window.aevorenBot.processes.registerPort({ sessionId, executorBotId, processId: selectedProcess.id, port: Number(draft.port), label: draft.portLabel }), data => setNotice(`端口 ${data.port} 已登记，状态：${data.state === "listening" ? "正在监听" : data.state === "stopped" ? "已停止" : "未确认"}。`)); }}>登记端口</button><ul className="environment-port-list">{ports?.map(port => <li key={port.id}>{port.label || "服务"} · {port.port} · {port.state === "listening" ? "正在监听" : port.state === "stopped" ? "已停止" : "状态未确认"}{port.checkedAt ? ` · 检查于 ${new Date(port.checkedAt).toLocaleTimeString()}` : ""} <button className="text-button" type="button" disabled={!ready || Boolean(pending) || port.state !== "listening"} onClick={() => void openPreview(port)}>打开服务预览</button></li>)}</ul><p className="environment-note">预览使用已登记且正在监听的进程端口。请先在浏览器页启动并接管电脑。</p></section>
  </section>;
}
