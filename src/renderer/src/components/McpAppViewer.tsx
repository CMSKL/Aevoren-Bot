import { useEffect, useRef, useState } from "react";
import type { McpAppView } from "@shared/mcp-write-contracts";
import { validMcpProxyReady } from "../mcp-write-review";
import "../styles/mcp-write.css";

export function McpAppViewer({ view, onClose }: { view: McpAppView; onClose(): void }): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const receive = (event: MessageEvent): void => { if (validMcpProxyReady(event, frame.current?.contentWindow ?? null, view)) setReady(true); };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [view]);
  return <section className="mcp-app-viewer" aria-label="隔离 MCP App">
    <div className="mcp-heading"><h4>{view.title}</h4><button className="text-button" type="button" onClick={onClose}>关闭交互 App</button></div>
    <p className="mcp-note">{view.permissionsNotice}</p>
    <p role="status" className="mcp-note">{ready ? "隔离 App 已就绪。工具请求仍需当前成员授权与逐次审批。" : "正在启动隔离 App…"}</p>
    <iframe ref={frame} title={`MCP App：${view.title}`} src={view.proxyUrl} sandbox="allow-scripts allow-same-origin" allow="camera 'none'; microphone 'none'; clipboard-read 'none'; clipboard-write 'none'; geolocation 'none'; display-capture 'none'" referrerPolicy="no-referrer" />
  </section>;
}
