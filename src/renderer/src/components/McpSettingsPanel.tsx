import { useCallback, useEffect, useState } from "react";
import type { AppError, McpServerInfo } from "@shared/contracts";
import { CheckIcon, RefreshIcon, TrashIcon } from "./Icons";
import { draftForMcpServer, EMPTY_MCP_DRAFT, parseMcpSecretLines, type McpDraft } from "./mcp-form";

type McpSettingsPanelProps = {
  active: boolean;
};

const statusLabels: Record<McpServerInfo["status"], string> = {
  disabled: "未启用",
  connecting: "正在连接",
  available: "可用",
  unavailable: "不可用",
  "needs-auth": "需要授权",
};

function notifyMcpChange(): void {
  window.dispatchEvent(new Event("aevoren:mcp-changed"));
}

export function McpSettingsPanel({ active }: McpSettingsPanelProps): React.JSX.Element {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<McpDraft>(EMPTY_MCP_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setBusy("load");
    setError(null);
    const result = await window.aevorenBot.mcp.list();
    if (result.ok) setServers(result.data);
    else setError(result.error);
    setBusy(null);
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.aevorenBot.mcp.list().then((result) => {
      if (cancelled) return;
      if (result.ok) setServers(result.data);
      else setError(result.error);
    });
    return () => { cancelled = true; };
  }, [active]);

  const beginEdit = (server: McpServerInfo): void => {
    setEditing(server.id);
    setDraft(draftForMcpServer(server));
    setError(null);
    setLocalError(null);
  };

  const closeEditor = (): void => {
    setEditing(null);
    setDraft(EMPTY_MCP_DRAFT);
    setLocalError(null);
  };

  const save = async (): Promise<void> => {
    const existing = editing && editing !== "new" ? servers.find((server) => server.id === editing) : undefined;
    const secrets = parseMcpSecretLines(draft.secrets, draft.transport, existing?.secretKeys ?? []);
    if (!secrets.ok) {
      setLocalError(secrets.error);
      return;
    }
    setBusy("save");
    setError(null);
    setLocalError(null);
    const result = await window.aevorenBot.mcp.save({
      ...(existing ? { id: existing.id, expectedVersion: existing.version } : {}),
      name: draft.name.trim(),
      trustedReadOnlyTools: draft.trustedReadOnlyTools,
      config: draft.transport === "stdio"
        ? { transport: "stdio", command: draft.command.trim(), args: draft.args.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean), env: secrets.values }
        : { transport: "streamable-http", url: draft.url.trim(), headers: secrets.values },
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setServers((current) => [...current.filter((server) => server.id !== result.data.id), result.data].toSorted((left, right) => left.name.localeCompare(right.name)));
    notifyMcpChange();
    closeEditor();
  };

  const toggle = async (server: McpServerInfo): Promise<void> => {
    setBusy(`toggle:${server.id}`);
    setError(null);
    const result = await window.aevorenBot.mcp.setEnabled({ id: server.id, expectedVersion: server.version, enabled: !server.enabled });
    setBusy(null);
    if (result.ok) {
      setServers((current) => current.map((item) => item.id === result.data.id ? result.data : item));
      notifyMcpChange();
    }
    else setError(result.error);
  };

  const probe = async (server: McpServerInfo): Promise<void> => {
    setBusy(`probe:${server.id}`);
    setError(null);
    const result = await window.aevorenBot.mcp.probe(server.id);
    setBusy(null);
    if (result.ok) {
      setServers((current) => current.map((item) => item.id === result.data.id ? result.data : item));
      notifyMcpChange();
    }
    else setError(result.error);
  };

  const remove = async (server: McpServerInfo): Promise<void> => {
    if (!window.confirm(`删除 MCP Server“${server.name}”？保存的 Secret 也会失效。`)) return;
    setBusy(`delete:${server.id}`);
    const result = await window.aevorenBot.mcp.delete({ id: server.id, expectedVersion: server.version });
    setBusy(null);
    if (result.ok) {
      setServers((current) => current.filter((item) => item.id !== server.id));
      notifyMcpChange();
    }
    else setError(result.error);
  };

  const authorize = async (server: McpServerInfo): Promise<void> => {
    const busyKey = `auth:${server.id}`;
    setBusy(busyKey);
    setError(null);
    const result = await window.aevorenBot.mcp.authorize(server.id);
    setBusy((current) => current === busyKey ? null : current);
    if (result.ok) {
      setServers((current) => current.map((item) => item.id === result.data.id ? result.data : item));
      notifyMcpChange();
    } else if (result.error.code !== "MCP_AUTH_CANCELLED") setError(result.error);
  };

  const cancelAuthorization = async (server: McpServerInfo): Promise<void> => {
    const result = await window.aevorenBot.mcp.cancelAuthorization(server.id);
    if (!result.ok && result.error.code !== "MCP_AUTH_CANCELLED") setError(result.error);
    await load();
  };

  const clearAuthorization = async (server: McpServerInfo): Promise<void> => {
    if (!window.confirm(`清除“${server.name}”保存在本机的 OAuth 授权并停用这个 Server？`)) return;
    setBusy(`clear-auth:${server.id}`);
    setError(null);
    const result = await window.aevorenBot.mcp.clearAuthorization({ id: server.id, expectedVersion: server.version });
    setBusy(null);
    if (result.ok) {
      setServers((current) => current.map((item) => item.id === result.data.id ? result.data : item));
      notifyMcpChange();
    } else setError(result.error);
  };

  const addExaSearch = async (): Promise<void> => {
    if (servers.some((server) => server.name === "exa-search")) return;
    setBusy("preset:exa");
    setError(null);
    const result = await window.aevorenBot.mcp.save({
      name: "exa-search",
      trustedReadOnlyTools: [],
      config: { transport: "streamable-http", url: "https://mcp.exa.ai/mcp", headers: {} },
    });
    setBusy(null);
    if (result.ok) setServers((current) => [...current, result.data].toSorted((left, right) => left.name.localeCompare(right.name)));
    else setError(result.error);
  };

  return (
    <div className="settings-panel-form mcp-settings-panel">
      <div className="settings-section-heading capability-heading">
        <span>
          <h2>MCP</h2>
          <p>配置本机 stdio 或远程 Streamable HTTP Server。新 Server 默认关闭；只有 Server 声明只读且你逐项信任的工具才会进入模型调用面。</p>
        </span>
        <div className="mcp-heading-actions">
          <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void load()}><RefreshIcon />刷新</button>
          <button className="secondary-button" type="button" disabled={busy !== null || servers.some((server) => server.name === "exa-search")} onClick={() => void addExaSearch()}>{servers.some((server) => server.name === "exa-search") ? "已添加网页搜索" : "添加网页搜索"}</button>
          <button className="primary-button" type="button" disabled={busy !== null} onClick={() => { setEditing("new"); setDraft(EMPTY_MCP_DRAFT); setLocalError(null); }}>添加 Server</button>
        </div>
      </div>

      <p className="settings-security-note">第三方 Server 的只读声明不是安全证明；工具还需逐项信任且每次调用仍需确认。Secret、OAuth Token 和 Client Secret 只写入 Main 的系统安全存储，Renderer 不会读取其值。</p>

      {servers.length === 0 ? <div className="workspace-empty">尚未配置 MCP Server。</div> : (
        <div className="mcp-server-list">
          {servers.map((server) => (
            <article className="settings-card mcp-server-card" key={server.id} data-mcp-server={server.name}>
              <header>
                <span><strong>{server.name}</strong><small>{server.transport === "stdio" ? server.command : server.url}</small></span>
                <span className={`provider-status-pill provider-status-${server.status === "available" ? "ready" : server.status === "needs-auth" ? "unconfigured" : "unavailable"}`}>
                  {server.status === "available" ? <CheckIcon /> : <i />}{statusLabels[server.status]}
                </span>
              </header>
              <div className="mcp-tool-summary">
                <span>{server.tools.filter((tool) => tool.readOnly).length} 个已信任只读工具</span>
                <span>{server.tools.filter((tool) => tool.claimedReadOnly && !tool.readOnly).length} 个只读声明待审核</span>
                <span>{server.tools.filter((tool) => !tool.claimedReadOnly).length} 个写/未声明工具已阻止</span>
                <span>{server.secretKeys.length} 个 Secret</span>
                {server.transport === "streamable-http" ? <span>{server.oauthConfigured ? "OAuth 已授权" : "OAuth 未授权"}</span> : null}
              </div>
              {server.tools.length > 0 ? <div className="mcp-tool-list">{server.tools.map((tool) => <span className={tool.readOnly ? "readonly" : "blocked"} key={tool.name}>{tool.name}</span>)}</div> : null}
              {server.lastErrorCode ? <p className="provider-settings-reason">{server.lastErrorCode}</p> : null}
              <footer>
                <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => beginEdit(server)}>编辑</button>
                <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void probe(server)}>测试</button>
                {server.transport === "streamable-http" ? busy === `auth:${server.id}` || server.authenticating ? (
                  <button className="secondary-button danger" type="button" onClick={() => void cancelAuthorization(server)}>取消授权</button>
                ) : (
                  <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void authorize(server)}>{server.oauthConfigured ? "重新授权" : "OAuth 授权"}</button>
                ) : null}
                {server.oauthConfigured ? <button className="secondary-button danger" type="button" disabled={busy !== null} onClick={() => void clearAuthorization(server)}>清除授权</button> : null}
                <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void toggle(server)}>{server.enabled ? "停用" : "启用"}</button>
                <button className="icon-button danger" type="button" aria-label={`删除 ${server.name}`} disabled={busy !== null} onClick={() => void remove(server)}><TrashIcon /></button>
              </footer>
            </article>
          ))}
        </div>
      )}

      {editing ? (
        <div className="settings-card mcp-editor">
          <h3>{editing === "new" ? "添加 MCP Server" : "编辑 MCP Server"}</h3>
          <label className="settings-field-row"><span><strong>名称</strong><small>1～32 位小写字母、数字、下划线或连字符</small></span><input aria-label="MCP 名称" value={draft.name} disabled={editing !== "new"} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
          <label className="settings-field-row"><span><strong>连接方式</strong><small>本机进程或远程 HTTPS</small></span><select aria-label="MCP 连接方式" value={draft.transport} onChange={(event) => setDraft((current) => ({ ...current, transport: event.target.value as McpDraft["transport"] }))}><option value="streamable-http">Streamable HTTP</option><option value="stdio">stdio</option></select></label>
          {draft.transport === "stdio" ? <>
            <label className="settings-field-row"><span><strong>命令</strong><small>直接启动，不经过 Shell</small></span><input aria-label="MCP 命令" value={draft.command} onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} /></label>
            <label className="mcp-text-field"><span>参数（每行一个）</span><textarea aria-label="MCP 参数" rows={4} value={draft.args} onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))} /></label>
            <label className="mcp-text-field"><span>环境变量（NAME=value，每行一个）</span><textarea aria-label="MCP 环境变量" rows={4} value={draft.secrets} onChange={(event) => setDraft((current) => ({ ...current, secrets: event.target.value }))} /></label>
          </> : <>
            <label className="settings-field-row"><span><strong>URL</strong><small>生产环境必须使用 HTTPS</small></span><input aria-label="MCP URL" value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} /></label>
            <label className="mcp-text-field"><span>Headers（Name: value，每行一个）</span><textarea aria-label="MCP Headers" rows={4} value={draft.secrets} onChange={(event) => setDraft((current) => ({ ...current, secrets: event.target.value }))} /></label>
          </>}
          {editing !== "new" && servers.find((server) => server.id === editing)?.tools.some((tool) => tool.claimedReadOnly) ? (
            <fieldset className="mcp-tool-trust">
              <legend>信任的只读工具</legend>
              <p>只选择你已经核对用途的工具。Server 的声明和你的选择必须同时满足，模型才可请求；调用仍逐次确认。</p>
              {servers.find((server) => server.id === editing)!.tools.filter((tool) => tool.claimedReadOnly).map((tool) => (
                <label key={tool.name}>
                  <input
                    type="checkbox"
                    checked={draft.trustedReadOnlyTools.includes(tool.name)}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      trustedReadOnlyTools: event.target.checked
                        ? [...new Set([...current.trustedReadOnlyTools, tool.name])]
                        : current.trustedReadOnlyTools.filter((name) => name !== tool.name),
                    }))}
                  />
                  <span><strong>{tool.name}</strong><small>{tool.description || "Server 未提供说明"}</small></span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {localError ? <div className="dialog-error" role="alert">{localError}</div> : null}
          <div className="settings-panel-actions"><button className="secondary-button" type="button" onClick={closeEditor}>取消</button><button className="primary-button" type="button" disabled={busy !== null || !draft.name.trim()} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存（默认关闭）"}</button></div>
        </div>
      ) : null}

      {error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
    </div>
  );
}
