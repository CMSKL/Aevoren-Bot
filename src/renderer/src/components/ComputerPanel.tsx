import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { ApiResult } from "@shared/contracts";
import type { BrowserChangedEvent, BrowserDownload, BrowserDownloadFailure, BrowserDownloadsPage, BrowserObservation, BrowserPage, BrowserSession, ComputerScreenshot, ComputerView, ComputerVncTicket, ServicePreview } from "@shared/browser-contracts";
import type RFB from "@novnc/novnc";
import { DemonstrationPanel } from "./DemonstrationPanel";
import { pollBrowserDownloads } from "./browser-download-poller";
import "../styles/computer.css";

type BrowserDraft = { url: string; ref: string; text: string; key: string };
const emptyDraft: BrowserDraft = { url: "", ref: "", text: "", key: "Enter" };
const scopeDrafts = new Map<string, BrowserDraft>();
// An unconfirmed mutation keeps the original nonce and payload for an explicit retry.
const mutationNonces = new Map<string, { key: string; nonce: string }>();
const stateLabels: Record<BrowserSession["state"], string> = { starting: "正在启动", running: "运行中", stopped: "已停止", error: "浏览器异常", unknown: "连接未确认" };

export type ComputerPanelProps = { sessionId: string; executorBotId: string; ownerName?: string; active?: boolean; mode?: "browser" | "computer"; initialPageId?: string };

export function ComputerPanel({ sessionId, executorBotId, ownerName, active = true, mode = "computer", initialPageId }: ComputerPanelProps): React.JSX.Element {
  const scopeKey = `${sessionId}:${executorBotId}`;
  const [visibleScope, setVisibleScope] = useState(scopeKey);
  const [draft, setDraft] = useState<BrowserDraft>(() => scopeDrafts.get(scopeKey) ?? { ...emptyDraft });
  const draftRef = useRef(draft);
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [view, setView] = useState<ComputerView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pages, setPages] = useState<BrowserPage[]>([]);
  const [downloads, setDownloads] = useState<BrowserDownload[]>([]);
  const [downloadFailures, setDownloadFailures] = useState<BrowserDownloadFailure[]>([]);
  const [previews, setPreviews] = useState<ServicePreview[]>([]);
  const [pageId, setPageId] = useState(initialPageId ?? "");
  const pageRef = useRef(pageId);
  const [observation, setObservation] = useState<BrowserObservation | null>(null);
  const [screenshot, setScreenshot] = useState<ComputerScreenshot | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [retryMutation, setRetryMutation] = useState<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [ticket, setTicket] = useState<ComputerVncTicket | null>(null);
  const [vncState, setVncState] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const vncTarget = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const scopeRef = useRef(scopeKey);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const mutationPendingRef = useRef(false);
  const snapshotRequestRef = useRef(0);
  const observationRequestRef = useRef(0);
  const frameRequestRef = useRef(0);
  const framePendingRef = useRef<number | null>(null);
  const current = useCallback((key: string, generation: number): boolean => mountedRef.current && scopeRef.current === key && generationRef.current === generation, []);

  function updateDraft(field: keyof BrowserDraft, value: string): void {
    const next = { ...draftRef.current, [field]: value };
    draftRef.current = next; scopeDrafts.set(scopeRef.current, next); setDraft(next);
  }

  const load = useCallback(async (): Promise<void> => {
    if (!active) return;
    const generation = generationRef.current;
    const request = ++snapshotRequestRef.current;
    try {
      const scope = { sessionId, executorBotId };
      const [sessionResult, viewResult] = await Promise.all([window.aevorenBot.browser.get(scope), window.aevorenBot.computer.view(scope)]);
      if (!current(scopeKey, generation) || request !== snapshotRequestRef.current) return;
      if (!sessionResult.ok || !viewResult.ok) { setError(!sessionResult.ok ? sessionResult.error.safeMessage : !viewResult.ok ? viewResult.error.safeMessage : "无法读取浏览器状态。"); return; }
      const nextSession = sessionResult.data; const nextView = viewResult.data;
      setLoaded(true); setSession(nextSession); setView(nextView);
      if (nextSession?.state !== "running" || !nextView || nextView.browserSessionId !== nextSession.id || nextView.epoch !== nextSession.controlEpoch) { setPages([]); setDownloads([]); setDownloadFailures([]); setPreviews([]); return; }
      const input = { ...scope, expectedEpoch: nextView.epoch };
      const results = await Promise.allSettled([window.aevorenBot.browser.tabs(input), window.aevorenBot.preview.list(input)]);
      if (!current(scopeKey, generation) || request !== snapshotRequestRef.current) return;
      const messages: string[] = [];
      const inspect = <T,>(result: PromiseSettledResult<ApiResult<T>>, apply: (data: T) => void): void => {
        if (result.status === "fulfilled") { if (result.value.ok) apply(result.value.data); else messages.push(result.value.error.safeMessage); }
        else messages.push("暂时无法读取浏览器资源，请刷新实际状态。");
      };
      inspect(results[0]!, data => {
        setPages(data);
        const selected = data.some(page => page.id === pageRef.current) ? pageRef.current : data.some(page => page.id === initialPageId) ? initialPageId! : data.some(page => page.id === nextSession.activePageId) ? nextSession.activePageId! : data[0]?.id ?? "";
        if (selected !== pageRef.current) { pageRef.current = selected; setPageId(selected); setObservation(null); setScreenshot(null); }
      });
      inspect(results[1]!, setPreviews);
      if (messages.length) setError([...new Set(messages)].join(" "));
    } catch { if (current(scopeKey, generation) && request === snapshotRequestRef.current) setError("无法确认浏览器连接，请刷新实际状态。草稿仍然保留。"); }
  }, [active, sessionId, executorBotId, scopeKey, initialPageId, current]);

  const resetScope = useEffectEvent((): void => {
    const nextDraft = scopeDrafts.get(scopeKey) ?? { ...emptyDraft };
    draftRef.current = nextDraft; setDraft(nextDraft); setVisibleScope(scopeKey);
    setSession(null); setView(null); setLoaded(false); setPages([]); setDownloads([]); setDownloadFailures([]); setPreviews([]);
    pageRef.current = initialPageId ?? ""; setPageId(pageRef.current); setObservation(null); setScreenshot(null);
    mutationPendingRef.current = false; setPending(null); setRetryMutation(null); setError(null); setNotice(null); setConfirmStop(false); setTicket(null); setVncState("disconnected");
    void load();
  });
  useLayoutEffect(() => {
    mountedRef.current = true; scopeRef.current = scopeKey; generationRef.current += 1;
    snapshotRequestRef.current += 1; observationRequestRef.current += 1; frameRequestRef.current += 1; framePendingRef.current = null;
    rfbRef.current?.disconnect(); rfbRef.current = null;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) resetScope(); });
    return () => { cancelled = true; mountedRef.current = false; generationRef.current += 1; rfbRef.current?.disconnect(); rfbRef.current = null; };
  }, [scopeKey, active]);
  useEffect(() => { let cancelled = false; queueMicrotask(() => { if (active && !cancelled) void load(); }); return () => { cancelled = true; }; }, [active, load]);
  const changed = useEffectEvent((event: BrowserChangedEvent): void => {
    if (!active || event.sessionId !== sessionId || event.executorBotId !== executorBotId) return;
    if (event.type === "control") { rfbRef.current?.disconnect(); rfbRef.current = null; setTicket(null); setVncState("disconnected"); setScreenshot(null); setObservation(null); frameRequestRef.current += 1; observationRequestRef.current += 1; }
    if (event.type === "pages" || event.type === "browser") { setObservation(null); setScreenshot(null); observationRequestRef.current += 1; frameRequestRef.current += 1; }
    void load();
  });
  useEffect(() => { if (!active) return; return window.aevorenBot.browser.onChanged(event => changed(event)); }, [active, sessionId, executorBotId]);

  async function mutate<T>(name: string, payload: object, operation: (clientNonce: string) => Promise<ApiResult<T>>, apply?: (data: T) => void): Promise<void> {
    if (mutationPendingRef.current) return;
    mutationPendingRef.current = true;
    const generation = generationRef.current;
    const nonceScope = `${scopeKey}:${name}`; const key = JSON.stringify(payload);
    const previous = mutationNonces.get(nonceScope);
    const record = previous?.key === key ? previous : { key, nonce: crypto.randomUUID() };
    mutationNonces.set(nonceScope, record);
    setPending(name); setRetryMutation(null); setError(null); setNotice(null);
    try {
      const result = await operation(record.nonce);
      if (result.ok && !(typeof result.data === "object" && result.data !== null && "state" in result.data && result.data.state === "unknown") && mutationNonces.get(nonceScope) === record) mutationNonces.delete(nonceScope);
      if (!current(scopeKey, generation)) return;
      if (!result.ok) { setError(result.error.safeMessage); if (result.error.retryable) setRetryMutation(() => () => { void mutate(name, payload, operation, apply); }); return; }
      if (typeof result.data === "object" && result.data !== null && "state" in result.data && result.data.state === "unknown") setRetryMutation(() => () => { void mutate(name, payload, operation, apply); });
      apply?.(result.data); void load();
    } catch { if (current(scopeKey, generation)) { setError("操作结果未确认。请刷新实际状态；重试同一操作会沿用原请求，不会自动重放。"); setRetryMutation(() => () => { void mutate(name, payload, operation, apply); }); } }
    finally { if (current(scopeKey, generation)) { mutationPendingRef.current = false; setPending(null); } }
  }

  const readPage = useCallback(async (): Promise<void> => {
    if (!view || !pageRef.current) return;
    const generation = generationRef.current; const request = ++observationRequestRef.current; const target = pageRef.current;
    try {
      const result = await window.aevorenBot.browser.observe({ sessionId, executorBotId, expectedEpoch: view.epoch, pageId: target });
      if (!current(scopeKey, generation) || request !== observationRequestRef.current || pageRef.current !== target) return;
      if (result.ok) {
        setObservation(result.data);
        setPages(pages => pages.map(page => page.id === result.data.pageId ? { ...page, url: result.data.url, title: result.data.title, documentVersion: result.data.documentVersion, updatedAt: result.data.observedAt } : page));
        setNotice(result.data.truncated ? "页面文本已截断，可再次读取页面。" : null);
      } else setError(result.error.safeMessage);
    } catch { if (current(scopeKey, generation) && request === observationRequestRef.current) setError("读取页面失败，请重新观察。"); }
  }, [view, sessionId, executorBotId, scopeKey, current]);

  const viewEpoch = view?.epoch;
  const viewOwner = view?.owner;
  const viewSessionId = view?.browserSessionId;
  const sessionState = session?.state;
  const sessionBrowserId = session?.id;
  const sessionEpoch = session?.controlEpoch;
  const applyDownloadReceipt = useEffectEvent((key: string, generation: number, epoch: number, browserId: string, result: BrowserDownloadsPage | string): void => {
    if (!active || !current(key, generation) || session?.state !== "running" || session.id !== browserId || session.controlEpoch !== epoch || view?.browserSessionId !== browserId || view.epoch !== epoch) return;
    if (typeof result === "string") setError(result);
    else { setDownloads(result.items); setDownloadFailures(result.errors); }
  });
  useEffect(() => {
    if (!active || sessionState !== "running" || !viewSessionId || viewSessionId !== sessionBrowserId || viewEpoch === undefined || viewEpoch !== sessionEpoch) return;
    const generation = generationRef.current;
    return pollBrowserDownloads({ sessionId, executorBotId, expectedEpoch: viewEpoch }, input => window.aevorenBot.browser.downloads(input), data => {
      applyDownloadReceipt(scopeKey, generation, viewEpoch, viewSessionId, data);
    }, message => { applyDownloadReceipt(scopeKey, generation, viewEpoch, viewSessionId, message); });
  }, [active, sessionState, sessionBrowserId, sessionEpoch, viewSessionId, viewEpoch, sessionId, executorBotId, scopeKey]);
  const readFrame = useCallback(async (): Promise<void> => {
    if (!active || viewEpoch === undefined || viewOwner !== "ai" || sessionState !== "running" || framePendingRef.current !== null) return;
    const generation = generationRef.current; const request = ++frameRequestRef.current; framePendingRef.current = request;
    try {
      const result = await window.aevorenBot.computer.screenshot({ sessionId, executorBotId, expectedEpoch: viewEpoch });
      if (!current(scopeKey, generation) || request !== frameRequestRef.current) return;
      if (result.ok && result.data.frame.browserSessionId === viewSessionId && result.data.frame.controlEpoch === viewEpoch) setScreenshot(result.data);
      else if (!result.ok) setError(result.error.safeMessage);
    } catch { if (current(scopeKey, generation) && request === frameRequestRef.current) setError("无法读取真实屏幕，请刷新连接。"); }
    finally { if (framePendingRef.current === request) framePendingRef.current = null; }
  }, [active, viewEpoch, viewOwner, viewSessionId, sessionState, sessionId, executorBotId, scopeKey, current]);
  useEffect(() => {
    if (!active || view?.owner !== "ai" || session?.state !== "running") return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void readFrame(); });
    const timer = setInterval(() => { if (!cancelled) void readFrame(); }, 3000);
    return () => { cancelled = true; clearInterval(timer); frameRequestRef.current += 1; };
  }, [active, view?.owner, view?.epoch, session?.state, pageId, readFrame]);

  useEffect(() => {
    if (!active || !ticket || viewOwner !== "user" || ticket.browserSessionId !== viewSessionId || ticket.epoch !== viewEpoch || Date.parse(ticket.expiresAt) <= Date.now()) return;
    const generation = generationRef.current;
    let disposed = false; let rfb: RFB | null = null;
    void import("@novnc/novnc").then(({ default: Client }) => {
      if (disposed || !current(scopeKey, generation) || !vncTarget.current) return;
      rfb = new Client(vncTarget.current, ticket.url); rfbRef.current = rfb;
      rfb.scaleViewport = true; rfb.resizeSession = false; rfb.viewOnly = false; rfb.focusOnClick = true;
      rfb.addEventListener("connect", () => { if (!disposed && current(scopeKey, generation)) setVncState("connected"); });
      rfb.addEventListener("disconnect", () => { if (!disposed && current(scopeKey, generation)) { setVncState("disconnected"); setNotice("电脑连接已断开，控制权仍由你持有。可重新连接，或明确归还 AI。"); } });
      const failed = (): void => { rfb?.disconnect(); if (!disposed && current(scopeKey, generation)) { setVncState("disconnected"); setError("电脑连接认证失败，控制权仍由你持有。请检查浏览器环境并重新连接。"); } };
      rfb.addEventListener("credentialsrequired", failed); rfb.addEventListener("securityfailure", failed);
    }).catch(() => { if (!disposed && current(scopeKey, generation)) { setVncState("disconnected"); setError("无法启动电脑连接，控制权仍由你持有。"); } });
    const expiry = setTimeout(() => { rfb?.disconnect(); if (!disposed && current(scopeKey, generation)) { setTicket(null); setVncState("disconnected"); setNotice("电脑连接已到期，控制权仍由你持有。请重新连接，或明确归还 AI。"); } }, Math.max(0, Date.parse(ticket.expiresAt) - Date.now()));
    return () => { disposed = true; clearTimeout(expiry); rfb?.disconnect(); if (rfbRef.current === rfb) rfbRef.current = null; };
  }, [active, ticket, viewOwner, viewEpoch, viewSessionId, scopeKey, current]);

  function selectPage(id: string): void { pageRef.current = id; setPageId(id); setObservation(null); setScreenshot(null); observationRequestRef.current += 1; frameRequestRef.current += 1; }
  function connectComputer(): void {
    if (!view || view.owner !== "user") return;
    const payload = { sessionId, executorBotId, expectedEpoch: view.epoch };
    void mutate("vnc-ticket", payload, clientNonce => window.aevorenBot.computer.vncTicket({ ...payload, clientNonce }), data => { if (data.browserSessionId !== view.browserSessionId || data.epoch !== view.epoch || Date.parse(data.expiresAt) <= Date.now()) { setVncState("disconnected"); setError("电脑连接票据已失效，请重新连接。控制权仍由你持有。"); return; } setTicket(data); setVncState("connecting"); });
  }
  function changeOwner(owner: "ai" | "user"): void {
    if (!view) return;
    rfbRef.current?.disconnect(); rfbRef.current = null; setTicket(null); setVncState("disconnected"); setObservation(null); setScreenshot(null); frameRequestRef.current += 1; observationRequestRef.current += 1;
    const payload = { sessionId, executorBotId, expectedEpoch: view.epoch, expectedVersion: view.version };
    void mutate(owner === "user" ? "takeover" : "return", payload, clientNonce => window.aevorenBot.computer[owner === "user" ? "takeover" : "returnControl"]({ ...payload, clientNonce }), data => { setView(data); setNotice(data.owner === "user" ? "你已接管电脑。AI 输入、读取与画面上传已暂停；连接电脑后可操作。" : "控制权已归还 AI。下一次操作必须重新观察页面。"); });
  }
  function pageAction(action: "click" | "type" | "key" | "scroll", deltaY = 0): void {
    if (!view || !observation || view.owner !== "user" || observation.pageId !== pageId || observation.controlEpoch !== view.epoch) return;
    const proof = { sessionId, executorBotId, expectedEpoch: view.epoch, pageId, observationId: observation.id, documentVersion: observation.documentVersion };
    const payload = action === "click" ? { ...proof, ref: draft.ref } : action === "type" ? { ...proof, ref: draft.ref, text: draft.text, replace: true } : action === "key" ? { ...proof, key: draft.key } : { ...proof, deltaX: 0, deltaY };
    void mutate(action, payload, clientNonce => action === "click" ? window.aevorenBot.browser.click({ ...proof, clientNonce, ref: draft.ref }) : action === "type" ? window.aevorenBot.browser.type({ ...proof, clientNonce, ref: draft.ref, text: draft.text, replace: true }) : action === "key" ? window.aevorenBot.browser.key({ ...proof, clientNonce, key: draft.key }) : window.aevorenBot.browser.scroll({ ...proof, clientNonce, deltaX: 0, deltaY }), () => { setObservation(null); setScreenshot(null); });
  }

  if (!active || visibleScope !== scopeKey) return <section className="computer-panel" hidden />;
  const running = session?.state === "running" && view?.browserSessionId === session.id && view.epoch === session.controlEpoch;
  const userControl = running && view?.owner === "user";
  const selectedPage = pages.find(page => page.id === pageId);
  const hasProof = userControl && observation?.pageId === pageId && observation.controlEpoch === view?.epoch && observation.documentVersion === selectedPage?.documentVersion;
  return <section className="computer-panel" aria-label={mode === "browser" ? "浏览器" : "电脑"}>
    <div className="computer-heading"><h3>{mode === "browser" ? "浏览器" : "电脑"}</h3><span role="status">{pending === "start" ? "正在准备镜像并启动电脑" : loaded ? session ? stateLabels[session.state] : "尚未创建浏览器" : "状态未确认"}</span></div>
    <p className="computer-note">{ownerName ? `${ownerName} · ` : ""}浏览器登录数据与电脑按当前聊天和执行成员隔离。私聊、群聊与其他成员分别授权。</p>
    <div className="computer-actions"><button type="button" className="secondary-button" onClick={() => void load()}>刷新状态</button><button type="button" className="secondary-button" disabled={!loaded || Boolean(pending) || session?.state === "running" || session?.state === "starting"} onClick={() => { const payload = { sessionId, executorBotId, ...(session ? { expectedVersion: session.version } : {}) }; void mutate("start", payload, clientNonce => window.aevorenBot.browser.start({ ...payload, clientNonce })); }}>{pending === "start" ? "正在启动…" : "启动浏览器与电脑"}</button>{running ? <button type="button" className="text-button danger-text-button" disabled={Boolean(pending)} onClick={() => setConfirmStop(true)}>停止浏览器</button> : null}</div>
    {pending === "start" ? <p className="computer-note" role="status">首次启动需要下载 Chromium 和 Linux 图形组件；准备完成后会自动启动。</p> : null}
    {confirmStop ? <div className="computer-confirm" role="group" aria-label="确认停止浏览器"><p>停止当前成员的浏览器与电脑，会中断页面操作与接管连接；持久登录数据保留。</p><div className="computer-actions"><button type="button" className="secondary-button" disabled={Boolean(pending)} onClick={() => { const payload = { sessionId, executorBotId, expectedVersion: session?.version }; void mutate("stop", payload, clientNonce => window.aevorenBot.browser.stop({ ...payload, clientNonce }), () => setConfirmStop(false)); }}>确认停止</button><button type="button" className="text-button" onClick={() => setConfirmStop(false)}>保留运行</button></div></div> : null}
    {view && running ? <><p className="computer-control-status" role="status">{view.owner === "user" ? "你持有控制权 · AI 输入、观察与画面上传暂停" : "AI 持有控制权"} · {view.connectionState === "connected" ? "接管连接已连接" : "无接管连接"}</p><div className="computer-actions"><button type="button" className="secondary-button" disabled={Boolean(pending)} onClick={() => changeOwner(view.owner === "user" ? "ai" : "user")}>{view.owner === "user" ? "归还 AI" : "接管电脑"}</button>{view.owner === "user" ? <button type="button" className="secondary-button" disabled={Boolean(pending) || vncState === "connecting" || vncState === "connected"} onClick={connectComputer}>{vncState === "connecting" ? "正在连接…" : vncState === "connected" ? "电脑已连接" : "连接电脑"}</button> : <button type="button" className="text-button" onClick={() => void readFrame()}>刷新画面</button>}</div><p className="computer-note">关闭此面板或断线不会自动归还控制权。请使用“归还 AI”明确交还。</p></> : <p className="computer-note">先在执行环境页启动 Linux 环境，再启动浏览器与电脑。Docker、镜像或 Worker 不可用时会显示实际错误。</p>}
    {error ? <p className="computer-error" role="alert">{error}</p> : null}{retryMutation ? <button type="button" className="text-button" disabled={Boolean(pending)} onClick={retryMutation}>重试上次操作（沿用原请求）</button> : null}{notice ? <p className="computer-note" role="status">{notice}</p> : null}
    <DemonstrationPanel sessionId={sessionId} executorBotId={executorBotId} epoch={view?.epoch} userControl={Boolean(userControl)} connected={vncState === "connected"} active={active} />
    <label className="field"><span>网址</span><input aria-label="浏览器网址" value={draft.url} maxLength={4000} placeholder="https://" onChange={event => updateDraft("url", event.target.value)} /></label>
    <p className="computer-note">网址草稿不会自动打开页面；接管后点击“打开网址”才会执行。</p>
    {running ? <>
      <section className="computer-screen" aria-label="当前成员屏幕">
        <div ref={vncTarget} className="computer-vnc" hidden={!userControl} aria-label="接管电脑屏幕" />
        {userControl ? <p className="computer-note">{vncState === "connected" ? "已连接到当前成员的真实电脑。" : "点击“连接电脑”查看并操作屏幕。"}</p> : screenshot ? <><img src={`data:${screenshot.frame.mimeType};base64,${screenshot.frame.dataBase64}`} width={screenshot.frame.width} height={screenshot.frame.height} alt="当前聊天与成员的真实浏览器屏幕" /><p className="computer-note">画面采集于 {new Date(screenshot.frame.capturedAt).toLocaleTimeString()} · {screenshot.frame.width} × {screenshot.frame.height}</p></> : <p className="computer-note">真实画面尚未读取。</p>}
      </section>
      <section className="computer-section" aria-label="浏览器页面"><h4>浏览器页面</h4><label className="field"><span>当前页面</span><select aria-label="当前浏览器页面" value={selectedPage?.id ?? ""} onChange={event => selectPage(event.target.value)}><option value="">选择页面…</option>{pages.map(page => <option key={page.id} value={page.id}>{page.title || page.url}</option>)}</select></label>{selectedPage ? <p className="computer-url">{selectedPage.url}</p> : null}<div className="computer-actions"><button type="button" className="secondary-button" disabled={!userControl || Boolean(pending) || !selectedPage || !draft.url.trim()} onClick={() => { if (!view) return; const payload = { sessionId, executorBotId, expectedEpoch: view.epoch, pageId, url: draft.url.trim() }; void mutate("navigate", payload, clientNonce => window.aevorenBot.browser.navigate({ ...payload, clientNonce }), () => setObservation(null)); }}>打开网址</button><button type="button" className="text-button" disabled={!userControl || Boolean(pending)} onClick={() => { if (!view) return; const payload = { sessionId, executorBotId, expectedEpoch: view.epoch, ...(draft.url.trim() ? { url: draft.url.trim() } : {}) }; void mutate("new-tab", payload, clientNonce => window.aevorenBot.browser.newTab({ ...payload, clientNonce }), data => selectPage(data.id)); }}>新建页面</button><button type="button" className="text-button" disabled={!userControl || Boolean(pending) || !selectedPage} onClick={() => { if (!view) return; const payload = { sessionId, executorBotId, expectedEpoch: view.epoch, pageId }; void mutate("close-tab", payload, clientNonce => window.aevorenBot.browser.closeTab({ ...payload, clientNonce }), () => setObservation(null)); }}>关闭页面</button><button type="button" className="text-button" disabled={!userControl || Boolean(pending) || !selectedPage} onClick={() => void readPage()}>读取页面</button></div>{!userControl ? <p className="computer-note">先接管电脑，再使用页面操作。接管期间这些操作由你发起。</p> : null}
        {observation ? <><pre className="computer-page-text">{observation.text}</pre><label className="field"><span>页面元素</span><select aria-label="浏览器页面元素" value={draft.ref} onChange={event => updateDraft("ref", event.target.value)}><option value="">选择已观察到的元素…</option>{observation.elements.map(element => <option key={element.ref} value={element.ref}>{element.role} · {element.name || element.ref}</option>)}</select></label><div className="computer-actions"><button type="button" className="secondary-button" disabled={!hasProof || Boolean(pending) || !observation.elements.some(element => element.ref === draft.ref)} onClick={() => pageAction("click")}>点击元素</button></div><label className="field"><span>输入内容</span><textarea aria-label="浏览器输入内容" rows={3} value={draft.text} maxLength={32_000} onChange={event => updateDraft("text", event.target.value)} /></label><button type="button" className="secondary-button" disabled={!hasProof || Boolean(pending) || !observation.elements.some(element => element.ref === draft.ref)} onClick={() => pageAction("type")}>填写元素</button><label className="field"><span>按键</span><input aria-label="浏览器按键" value={draft.key} maxLength={80} onChange={event => updateDraft("key", event.target.value)} /></label><div className="computer-actions"><button type="button" className="secondary-button" disabled={!hasProof || Boolean(pending) || !draft.key.trim()} onClick={() => pageAction("key")}>发送按键</button><button type="button" className="text-button" disabled={!hasProof || Boolean(pending)} onClick={() => pageAction("scroll", -500)}>向上滚动</button><button type="button" className="text-button" disabled={!hasProof || Boolean(pending)} onClick={() => pageAction("scroll", 500)}>向下滚动</button></div><p className="computer-note">页面变化后请重新读取页面，再执行下一步。</p></> : null}
      </section>
      <section className="computer-section" aria-label="浏览器下载"><h4>下载文件</h4>{downloads.length ? downloads.map(file => <div className="computer-resource-row" key={file.id}><span>{file.name} · {file.size} bytes</span><button type="button" className="text-button" disabled={Boolean(pending)} onClick={() => { if (!view) return; const payload = { sessionId, executorBotId, expectedEpoch: view.epoch, id: file.id }; void mutate("download", payload, clientNonce => window.aevorenBot.browser.download({ ...payload, clientNonce }), data => { if (data) setNotice(`已保存 ${data.name}（${data.size} bytes）。`); }); }}>保存下载文件</button></div>) : <p className="computer-note">暂无可保存的下载文件。</p>}{downloadFailures.map(file => <p className="computer-error" key={file.id}>{file.name || "文件"} · 下载失败（{file.errorCode}）。文件未保存。</p>)}</section>
      <section className="computer-section" aria-label="已打开服务预览"><h4>服务预览</h4>{previews.filter(preview => preview.state !== "closed").map(preview => <div className="computer-resource-row" key={preview.id}><button type="button" className="text-button" onClick={() => selectPage(preview.pageId)}>{preview.url}</button><button type="button" className="text-button" disabled={!userControl || Boolean(pending)} onClick={() => { if (!view) return; const payload = { sessionId, executorBotId, expectedEpoch: view.epoch, id: preview.id }; void mutate("close-preview", payload, clientNonce => window.aevorenBot.preview.close({ ...payload, clientNonce })); }}>关闭预览</button></div>)}<p className="computer-note">在执行环境中登记真实后台服务端口后，可打开服务预览。</p></section>
    </> : null}
  </section>;
}
