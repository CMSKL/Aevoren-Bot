import { useCallback, useEffect, useRef, useState } from "react";
import type { McpServerInfo } from "@shared/contracts";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { McpAppView, McpScopedTool, McpToolGrant, McpWriteIntent } from "@shared/mcp-write-contracts";
import { canonicalMcpArguments, mcpIntentLabels, parseMcpArguments } from "../mcp-write-review";
import { McpAppViewer } from "./McpAppViewer";
import { McpWriteReview } from "./McpWriteReview";
import "../styles/mcp-write.css";

type Props = EnvironmentScope & { active?: boolean; ownerName?: string };
type State = { scope: string; servers: McpServerInfo[]; grants: McpToolGrant[]; intents: McpWriteIntent[] };

export function McpToolPanel({ sessionId, executorBotId, active = true, ownerName }: Props): React.JSX.Element {
  const scopeKey = `${sessionId}:${executorBotId}`;
  const [state, setState] = useState<State | null>(null);
  const [serverId, setServerId] = useState("");
  const [catalog, setCatalog] = useState<{ serverId: string; serverVersion: number; tools: McpScopedTool[] } | null>(null);
  const [toolName, setToolName] = useState("");
  const [argumentsText, setArgumentsText] = useState("{}");
  const [target, setTarget] = useState("");
  const [confirmation, setConfirmation] = useState<{ tool: McpScopedTool } | { grant: McpToolGrant } | null>(null);
  const [view, setView] = useState<McpAppView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const loadSequence = useRef(0);
  const viewRef = useRef(view);
  const nonces = useRef(new Map<string, string>());
  const server = state?.scope === scopeKey ? state.servers.find(value => value.id === serverId) : undefined;
  const tools = catalog?.serverId === serverId && catalog.serverVersion === server?.version ? catalog.tools : [];
  const tool = tools.find(value => value.name === toolName);
  const grant = state?.scope === scopeKey ? state.grants.find(value => value.serverId === serverId && value.serverVersion === server?.version && value.toolName === toolName && value.schemaDigest === tool?.schemaDigest && value.revokedAt === null) : undefined;
  const parsed = parseMcpArguments(argumentsText);
  const sameParameters = (intent: McpWriteIntent): boolean => intent.review.serverId === serverId && intent.review.toolName === toolName && parsed.ok && canonicalMcpArguments(intent.review.arguments) === canonicalMcpArguments(parsed.arguments);
  const currentIntent = state?.scope === scopeKey ? state.intents.find(sameParameters) : undefined;
  useEffect(() => { viewRef.current = view; }, [view]);

  const closeView = useCallback(async (value: McpAppView): Promise<void> => {
    await window.aevorenBot.mcpWrites.closeApp({ sessionId: value.sessionId, executorBotId: value.executorBotId, id: value.id, expectedEpoch: value.epoch }).catch(() => undefined);
  }, []);
  const load = useCallback(async (): Promise<void> => {
    const request = generation.current;
    const sequence = ++loadSequence.current;
    try {
      const [servers, grants, intents] = await Promise.all([
        window.aevorenBot.mcp.list(), window.aevorenBot.mcpWrites.toolGrants({ sessionId, executorBotId }),
        window.aevorenBot.mcpWrites.listToolIntents({ sessionId, executorBotId }),
      ]);
      if (request !== generation.current || sequence !== loadSequence.current) return;
      const failed = [servers, grants, intents].find(value => !value.ok);
      if (failed && !failed.ok) { setError(failed.error.safeMessage); return; }
      if (!servers.ok || !grants.ok || !intents.ok) return;
      setError(null);
      setState({ scope: scopeKey, servers: servers.data, grants: grants.data, intents: intents.data });
      const open = viewRef.current;
      if (open) {
        const origin = intents.data.find(value => value.id === open.intentId);
        const permission = origin && grants.data.find(value => value.id === origin.review.grantId && value.version === origin.review.grantVersion && value.revokedAt === null);
        const connection = servers.data.find(value => value.id === open.serverId && value.version === open.serverVersion && value.enabled);
        if (!permission || !connection) { setView(null); void closeView(open); }
      }
    } catch { if (request === generation.current && sequence === loadSequence.current) setError("暂时无法读取当前成员的 MCP 授权与操作记录。"); }
  }, [sessionId, executorBotId, scopeKey, closeView]);

  useEffect(() => {
    generation.current += 1;
    const request = generation.current;
    if (!active) return;
    let disposed = false;
    queueMicrotask(() => { if (!disposed) { setState(null); setServerId(""); setToolName(""); setCatalog(null); setArgumentsText("{}"); setTarget(""); setConfirmation(null); setView(null); setPending(false); setError(null); setNotice(null); void load(); } });
    let inFlight = false;
    const refresh = (): void => { if (!inFlight) { inFlight = true; void load().finally(() => { inFlight = false; }); } };
    const timer = setInterval(refresh, 2000);
    window.addEventListener("aevoren:mcp-changed", refresh);
    return () => { disposed = true; if (request === generation.current) generation.current += 1; clearInterval(timer); window.removeEventListener("aevoren:mcp-changed", refresh); const open = viewRef.current; if (open) void closeView(open); };
  }, [active, scopeKey, load, closeView]);
  useEffect(() => {
    if (!active || !server?.enabled) return;
    const request = generation.current;
    let disposed = false;
    void window.aevorenBot.mcpWrites.toolCatalog({ sessionId, executorBotId, serverId: server.id, expectedServerVersion: server.version }).then(result => {
      if (disposed || request !== generation.current) return;
      if (result.ok) setCatalog({ serverId: server.id, serverVersion: server.version, tools: result.data }); else setError(result.error.safeMessage);
    }).catch(() => { if (!disposed && request === generation.current) setError("无法读取所选 MCP 工具目录。"); });
    return () => { disposed = true; };
  }, [active, sessionId, executorBotId, server?.id, server?.version, server?.enabled]);

  async function mutateGrant(): Promise<void> {
    if (!confirmation || pending) return;
    const request = generation.current; setPending(true); setError(null);
    try {
      const old = "tool" in confirmation ? state?.grants.find(value => value.serverId === confirmation.tool.serverId && value.toolName === confirmation.tool.name) : null;
      const result = "grant" in confirmation
        ? await window.aevorenBot.mcpWrites.revokeTool({ sessionId, executorBotId, id: confirmation.grant.id, expectedVersion: confirmation.grant.version })
        : await window.aevorenBot.mcpWrites.grantTool({ sessionId, executorBotId, serverId: confirmation.tool.serverId, expectedServerVersion: confirmation.tool.serverVersion, toolName: confirmation.tool.name, schemaDigest: confirmation.tool.schemaDigest, ...(old ? { expectedVersion: old.version } : {}) });
      if (request !== generation.current) return;
      if (result.ok) { setConfirmation(null); setNotice(result.data.revokedAt ? "当前成员的 MCP 工具授权已撤销。" : "已授权当前成员使用此固定工具；每次操作仍需批准具体参数与目标。"); await load(); } else setError(result.error.safeMessage);
    } catch { if (request === generation.current) setError("工具授权操作未完成，请刷新核对。"); }
    finally { if (request === generation.current) setPending(false); }
  }
  async function prepare(): Promise<void> {
    if (!grant || !tool || !parsed.ok || !target.trim() || pending || currentIntent && currentIntent.state !== "prepared") return;
    const request = generation.current; setPending(true); setError(null); setNotice(null);
    const key = `${scopeKey}:${grant.id}:${grant.version}:${canonicalMcpArguments(parsed.arguments)}:${target.trim()}`;
    const clientNonce = nonces.current.get(key) ?? crypto.randomUUID(); nonces.current.set(key, clientNonce);
    try {
      const result = await window.aevorenBot.mcpWrites.prepareTool({ sessionId, executorBotId, grantId: grant.id, expectedGrantVersion: grant.version, arguments: parsed.arguments, targetPreview: target.trim(), clientNonce });
      if (request !== generation.current) return;
      if (result.ok) { setNotice(result.data.state === "prepared" ? "固定操作已保存，请在审批中核对完整内容。" : "已找到原操作记录，请核对实际状态。"); await load(); } else setError(result.error.safeMessage);
    } catch { if (request === generation.current) setError("固定操作未能准备；请刷新查询原记录，参数不会自动重发。"); }
    finally { if (request === generation.current) setPending(false); }
  }
  async function act(intent: McpWriteIntent, action: "requestToolApproval" | "cancelTool" | "openApp"): Promise<void> {
    if (pending) return;
    const request = generation.current; setPending(true); setError(null);
    try {
      const input = { sessionId, executorBotId, id: intent.id, expectedVersion: intent.version };
      if (action === "openApp") {
        const result = await window.aevorenBot.mcpWrites.openApp(input);
        if (request !== generation.current) { if (result.ok) void closeView(result.data); return; }
        if (result.ok) { const old = viewRef.current; if (old) void closeView(old); setView(result.data); } else setError(result.error.safeMessage);
      } else {
        const result = action === "cancelTool" ? await window.aevorenBot.mcpWrites.cancelTool(input) : await window.aevorenBot.mcpWrites.requestToolApproval(input);
        if (request !== generation.current) return;
        if (result.ok) { window.dispatchEvent(new Event("aevoren:apps-approval-changed")); await load(); } else setError(result.error.safeMessage);
      }
    } catch { if (request === generation.current) setError("请求未能完成，请查询固定操作记录。未知结果不会自动重发。"); }
    finally { if (request === generation.current) setPending(false); }
  }

  if (!active) return <section hidden aria-label="聊天 MCP 工具" />;
  if (state?.scope !== scopeKey) return <section className="mcp-tool-panel" aria-label="聊天 MCP 工具"><p className="mcp-note" role="status">正在读取当前成员的 MCP 范围…</p></section>;
  return <section className="mcp-tool-panel" aria-label="聊天 MCP 工具">
    <div className="mcp-heading"><h3>MCP 工具与交互 Apps</h3><button className="text-button" type="button" disabled={pending} onClick={() => void load()}>刷新 MCP 操作记录</button></div>
    <p className="mcp-note">{ownerName ?? "当前成员"} · 工具授权仅属于此聊天与成员。目录和工具的只读声明不授予权限；写入前须核对具体目标和完整参数。</p>
    <p className="mcp-note">先在设置的 MCP 页配置服务器。此处不会假定服务器使用了哪个外部账号。</p>
    {error ? <p className="mcp-error" role="alert">{error}</p> : null}{notice ? <p className="mcp-note" role="status">{notice}</p> : null}
    <label className="field"><span>MCP 服务器</span><select aria-label="当前聊天的 MCP 服务器" value={serverId} disabled={pending} onChange={event => { setServerId(event.target.value); setToolName(""); setCatalog(null); setConfirmation(null); setError(null); }}><option value="">选择服务器…</option>{state.servers.map(value => <option key={value.id} value={value.id}>{value.name} · {value.enabled ? "已启用" : "未启用"}</option>)}</select></label>
    {server && !server.enabled ? <p className="mcp-note">请先在 MCP 设置中启用此服务器。</p> : null}
    <label className="field"><span>MCP 工具</span><select aria-label="当前 MCP 工具" value={toolName} disabled={pending || !server?.enabled} onChange={event => { setToolName(event.target.value); setConfirmation(null); setError(null); }}><option value="">选择工具…</option>{tools.map(value => <option key={value.name} value={value.name}>{value.name}</option>)}</select></label>
    {tool ? <><p className="mcp-note">{tool.description}</p><p className="mcp-note">{tool.readOnlyClaim ? "服务器声明只读；该声明未替代成员授权或本次审批。" : "服务器未声明只读；按外部操作逐次审批。"}</p><details><summary>查看工具输入格式</summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details><div className="mcp-actions"><button className="secondary-button" type="button" disabled={pending} onClick={() => setConfirmation({ tool })}>{grant ? "更新成员 MCP 工具授权" : "授权当前成员使用此工具"}</button>{grant ? <button className="text-button danger" type="button" disabled={pending} onClick={() => setConfirmation({ grant })}>撤销成员 MCP 工具授权</button> : null}</div></> : null}
    {confirmation ? <div className="mcp-confirm" role="group" aria-label="确认成员 MCP 工具授权"><p>{"tool" in confirmation ? `允许「${ownerName ?? "当前成员"}」在此聊天使用「${confirmation.tool.serverName} / ${confirmation.tool.name}」？每次具体目标与参数仍需另行批准。` : `撤销「${confirmation.grant.toolName}」授权？未派发请求将失效；已派发结果仍须核对。`}</p><div className="mcp-actions"><button className="secondary-button" type="button" disabled={pending} onClick={() => void mutateGrant()}>确认 MCP 工具授权</button><button className="text-button" type="button" disabled={pending} onClick={() => setConfirmation(null)}>取消授权操作</button></div></div> : null}
    <label className="field"><span>完整工具参数 JSON</span><textarea aria-label="MCP 工具参数 JSON" maxLength={128_000} value={argumentsText} disabled={pending} onChange={event => setArgumentsText(event.target.value)} /></label>
    {!parsed.ok ? <p className="mcp-error" role="alert">{parsed.message}</p> : null}
    <label className="field"><span>具体操作目标</span><input aria-label="MCP 写入目标说明" maxLength={2000} placeholder="填写具体文件、页面、收件人或其他目标" value={target} disabled={pending} onChange={event => setTarget(event.target.value)} /></label>
    <button className="secondary-button" type="button" disabled={pending || !grant || !parsed.ok || !target.trim() || Boolean(currentIntent && currentIntent.state !== "prepared")} onClick={() => void prepare()}>准备固定 MCP 操作</button>
    {currentIntent && currentIntent.state !== "prepared" ? <p className="mcp-note">这份参数已有操作记录，请查看原结果。相同记录不会重发。</p> : null}
    <div aria-label="MCP 操作记录">{state.intents.map(intent => <article className="mcp-intent" key={intent.id}><div className="mcp-heading"><strong>{intent.review.serverName} · {intent.review.toolName}</strong><span>{mcpIntentLabels[intent.state]}</span></div><McpWriteReview snapshot={intent.review} />{intent.state === "prepared" ? <div className="mcp-actions"><button className="primary-button" type="button" disabled={pending} onClick={() => void act(intent, "requestToolApproval")}>审阅并批准固定 MCP 操作</button><button className="text-button" type="button" disabled={pending} onClick={() => void act(intent, "cancelTool")}>拒绝此 MCP 操作</button></div> : intent.state === "dispatching" ? <button className="secondary-button" type="button" disabled={pending} onClick={() => void act(intent, "cancelTool")}>停止此 MCP 操作</button> : intent.state === "unknown" ? <p className="mcp-note">调用结果未知，可能已经生效。请人工核对外部系统；本应用不会自动重新调用。</p> : intent.state === "confirmed" ? <><p className="mcp-note">结果由 MCP 服务器报告，未独立验证外部系统中的最终状态。</p><details><summary>查看服务器返回结果</summary><pre>{JSON.stringify(intent.result, null, 2)}</pre></details><button className="secondary-button" type="button" disabled={pending} onClick={() => void act(intent, "openApp")}>打开此结果的交互 App</button></> : null}</article>)}</div>
    {view ? <McpAppViewer key={`${view.id}:${view.epoch}`} view={view} onClose={() => { setView(null); void closeView(view); }} /> : null}
  </section>;
}
