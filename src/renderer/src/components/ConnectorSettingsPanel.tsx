import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiResult } from "@shared/contracts";
import type { ConnectorProvider, NativeConnection } from "@shared/native-connector-contracts";
import { connectorLabels, connectorStateLabels } from "../connector-ui-state";
import "../styles/connectors.css";

export function ConnectorSettingsPanel({ active }: { active: boolean }): React.JSX.Element {
  return active ? <ActiveConnectorSettingsPanel /> : <section hidden aria-label="应用连接" />;
}

function ActiveConnectorSettingsPanel(): React.JSX.Element {
  const [connections, setConnections] = useState<NativeConnection[]>([]);
  const [provider, setProvider] = useState<ConnectorProvider>("gmail");
  const [editing, setEditing] = useState<NativeConnection | null>(null);
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [authorizingId, setAuthorizingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<NativeConnection | null>(null);
  const generation = useRef(0);
  const lifecycle = useRef(0);
  const activeRef = useRef(true);
  const cancelledAuthorization = useRef<string | null>(null);
  const load = useCallback(async (): Promise<void> => {
    const request = ++generation.current;
    try {
      const result = await window.aevorenBot.connectors.list({});
      if (request !== generation.current) return;
      if (result.ok) setConnections(result.data); else setError(result.error.safeMessage);
    } catch { if (request === generation.current) setError("暂时无法读取应用连接。"); }
  }, []);
  useEffect(() => {
    activeRef.current = true;
    const request = ++generation.current;
    void window.aevorenBot.connectors.list({}).then(result => {
      if (request !== generation.current || !activeRef.current) return;
      if (result.ok) setConnections(result.data); else setError(result.error.safeMessage);
    }).catch(() => { if (request === generation.current && activeRef.current) setError("暂时无法读取应用连接。"); });
    return () => { activeRef.current = false; generation.current += 1; lifecycle.current += 1; };
  }, []);
  useEffect(() => {
    if (!authorizingId) return;
    let disposed = false;
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await window.aevorenBot.connectors.list({});
        if (!disposed && activeRef.current && result.ok) setConnections(result.data);
      } catch { /* Authorization completion returns the final host status. */ }
      finally { inFlight = false; }
    };
    const timer = setInterval(() => void refresh(), 500);
    return () => { disposed = true; clearInterval(timer); };
  }, [authorizingId]);

  async function configure(): Promise<void> {
    if (pending) return;
    const current = lifecycle.current;
    setPending(true); setError(null); setNotice(null);
    try {
      const result = await window.aevorenBot.connectors.configure({ ...(editing ? { id: editing.id, expectedVersion: editing.version } : {}), provider, name: name.trim() || connectorLabels[provider], ...(provider === "notion" ? { token } : { clientId, ...(clientSecret ? { clientSecret } : {}) }) });
      if (!activeRef.current || current !== lifecycle.current) return;
      if (result.ok) { setEditing(null); setName(""); setClientId(""); setToken(""); setClientSecret(""); setNotice("连接配置已保存；请完成授权，再为聊天成员授权读取范围。"); await load(); }
      else setError(result.error.safeMessage);
    } catch { if (activeRef.current && current === lifecycle.current) setError("连接配置未能保存。"); }
    finally { if (current === lifecycle.current) setPending(false); }
  }

  async function act(connection: NativeConnection, action: "authorize" | "cancelAuthorization" | "revoke"): Promise<void> {
    if (action === "authorize" && authorizingId || action !== "cancelAuthorization" && pending) return;
    const current = lifecycle.current;
    if (action === "authorize") cancelledAuthorization.current = null;
    if (action === "cancelAuthorization") cancelledAuthorization.current = connection.id;
    setError(null); setNotice(null);
    if (action === "authorize") setAuthorizingId(connection.id); else setPending(true);
    try {
      const promise: Promise<ApiResult<NativeConnection>> = window.aevorenBot.connectors[action]({ id: connection.id, expectedVersion: connection.version });
      if (action === "authorize") {
        setConnections(items => items.map(item => item.id === connection.id ? { ...item, state: "authorizing" } : item));
        // The host owns OAuth; list supplies the current version for explicit cancellation.
        void load();
      }
      const result = await promise;
      if (!activeRef.current || current !== lifecycle.current) return;
      if (action === "authorize" && cancelledAuthorization.current === connection.id) { await load(); return; }
      if (result.ok) { setNotice(action === "revoke" ? "已撤销连接。原聊天授权与后续读取立即失效。" : action === "cancelAuthorization" ? "授权已取消。" : "账号已连接；聊天成员仍需单独授权。"); await load(); }
      else { setError(result.error.safeMessage); await load(); }
    } catch { if (activeRef.current && current === lifecycle.current) { if (!(action === "authorize" && cancelledAuthorization.current === connection.id)) setError("应用连接操作未完成，请刷新查看真实状态。"); await load(); } }
    finally { if (current === lifecycle.current) { if (action === "authorize") setAuthorizingId(null); else setPending(false); } }
  }
  async function enableSend(connection: NativeConnection): Promise<void> {
    if (pending || authorizingId) return;
    const current = lifecycle.current; setAuthorizingId(connection.id); cancelledAuthorization.current = null; setError(null); setNotice(null);
    try {
      const promise = window.aevorenBot.outbound.enableSend({ id: connection.id, expectedVersion: connection.version });
      setConnections(items => items.map(item => item.id === connection.id ? { ...item, state: "authorizing" } : item)); void load();
      const result = await promise;
      if (!activeRef.current || current !== lifecycle.current || cancelledAuthorization.current === connection.id) return;
      if (result.ok) setNotice("Gmail 读取与发送授权已重新验证。请重新授权聊天成员的读取与具体写入目标。"); else setError(result.error.safeMessage);
      await load();
    } catch { if (activeRef.current && current === lifecycle.current && cancelledAuthorization.current !== connection.id) { setError("Gmail 发送授权未完成，请刷新实际状态。"); await load(); } }
    finally { if (current === lifecycle.current) setAuthorizingId(null); }
  }

  return <section className="connector-panel" aria-label="应用连接">
    <div className="settings-section-heading"><h2>应用连接</h2><p>配置自己的 Gmail、Google Drive 或 Notion。账号连接与聊天成员的读取授权分别管理。</p></div>
    {error ? <p className="connector-error" role="alert">{error}</p> : null}
    {notice ? <p className="connector-note" role="status">{notice}</p> : null}
    <div className="connector-actions"><button className="secondary-button" type="button" onClick={() => void load()}>刷新连接</button></div>
    <div className="connector-connections">{connections.length ? connections.map(connection => <article className="connector-card" key={connection.id}>
      <div className="connector-heading"><strong>{connection.name} · {connectorLabels[connection.provider]}</strong><span>{connectorStateLabels[connection.state]}</span></div>
      <p className="connector-note">{connection.account ? `${connection.account.displayName}${connection.account.email ? ` · ${connection.account.email}` : ""}` : "账号尚未确认"}</p>
      <p className="connector-note">{connection.provider === "gmail" ? `读取邮件：${connection.scopes.includes("https://www.googleapis.com/auth/gmail.readonly") && connection.state === "connected" ? "已授权" : "未授权"} · 发送邮件：${connection.scopes.includes("https://www.googleapis.com/auth/gmail.send") && connection.state === "connected" ? "已授权" : "未授权"}。本地草稿保存不会发送。` : connection.provider === "drive" ? "应用范围：仅选择的文件与应用创建的文件（drive.file）。写入目标仍需单独授权。" : "应用范围：此内部连接已共享的页面。写入具体父页面仍需单独授权。"}</p>
      {connection.scopes.length ? <details><summary>已授权范围</summary><ul>{connection.scopes.map(scope => <li key={scope}>{scope}</li>)}</ul></details> : null}
      {connection.provider === "drive" ? <details><summary>已选择 {connection.selectedFileIds.length} 个文件 · 应用创建 {connection.createdFileIds.length} 个文件</summary><ul>{[...connection.selectedFileIds, ...connection.createdFileIds].map(id => <li key={id}>{id}</li>)}</ul></details> : null}
      <div className="connector-actions">
        {connection.state !== "authorizing" ? <button className="secondary-button" type="button" disabled={pending || Boolean(authorizingId)} onClick={() => void act(connection, "authorize")}>{connection.provider === "notion" ? "验证连接" : connection.provider === "drive" ? "授权并选择文件" : "授权读取邮件"}</button> : <button className="secondary-button" type="button" disabled={pending} onClick={() => void act(connection, "cancelAuthorization")}>取消授权</button>}
        {connection.provider === "gmail" && connection.state === "connected" ? <button className="secondary-button" type="button" disabled={pending || Boolean(authorizingId)} onClick={() => void enableSend(connection)}>启用发送并重新授权</button> : null}
        {connection.state !== "revoked" ? <button className="text-button danger" type="button" disabled={pending || Boolean(authorizingId)} onClick={() => setConfirmRevoke(connection)}>撤销连接</button> : null}
        <button className="text-button" type="button" disabled={pending || Boolean(authorizingId)} onClick={() => { setEditing(connection); setProvider(connection.provider); setName(connection.name); setClientId(""); setClientSecret(""); setToken(""); setNotice("请重新输入配置；保存将使原成员授权失效。已保存的凭据不会显示在界面中。"); }}>重新配置</button>
      </div>
    </article>) : <p className="connector-note">尚未配置应用连接。</p>}</div>
    {confirmRevoke ? <div className="connector-confirm" role="group" aria-label="确认撤销连接"><p>撤销「{confirmRevoke.name}」后，所有聊天成员的该连接授权将失效。已保存的本地草稿仍会保留。</p><div className="connector-actions"><button className="secondary-button danger" type="button" disabled={pending} onClick={() => { const connection = confirmRevoke; setConfirmRevoke(null); void act(connection, "revoke"); }}>确认撤销连接</button><button className="secondary-button" type="button" onClick={() => setConfirmRevoke(null)}>保留连接</button></div></div> : null}
    <section className="connector-section" aria-label="添加应用连接"><h3>{editing ? `重新配置「${editing.name}」` : "添加连接"}</h3>
      <label className="field"><span>应用</span><select aria-label="应用提供方" value={provider} disabled={pending || Boolean(editing)} onChange={event => { setProvider(event.target.value as ConnectorProvider); setToken(""); setClientSecret(""); }}><option value="gmail">Gmail</option><option value="drive">Google Drive</option><option value="notion">Notion</option></select></label>
      <label className="field"><span>连接名称</span><input aria-label="连接名称" value={name} maxLength={200} disabled={pending} onChange={event => setName(event.target.value)} placeholder={connectorLabels[provider]} /></label>
      {provider === "notion" ? <><label className="field"><span>内部连接 Token</span><input aria-label="Notion 内部连接 Token" maxLength={4096} type="password" value={token} autoComplete="off" disabled={pending} onChange={event => setToken(event.target.value)} /></label><p className="connector-note">仅能访问已共享给此连接的页面。验证后会显示实际连接身份。</p></> : <><label className="field"><span>桌面 OAuth Client ID</span><input aria-label="Google 桌面 OAuth Client ID" maxLength={300} value={clientId} autoComplete="off" disabled={pending} onChange={event => setClientId(event.target.value)} /></label><label className="field"><span>Client Secret（如有）</span><input aria-label="Google OAuth Client Secret" maxLength={2048} type="password" value={clientSecret} autoComplete="off" disabled={pending} onChange={event => setClientSecret(event.target.value)} /></label><p className="connector-note">使用自己的桌面应用 OAuth 配置。点击授权后将打开系统浏览器；Gmail 与 Drive 分别授权。</p></>}
      <button className="secondary-button" type="button" disabled={pending || (provider === "notion" ? !token.trim() : !clientId.trim())} onClick={() => void configure()}>{pending ? "保存中…" : "保存连接配置"}</button>
      {editing ? <button className="text-button" type="button" disabled={pending} onClick={() => { setEditing(null); setName(""); setClientId(""); setToken(""); setClientSecret(""); setNotice(null); }}>取消重新配置</button> : null}
    </section>
  </section>;
}
