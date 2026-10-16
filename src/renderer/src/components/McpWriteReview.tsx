import type { McpWriteReview as Review } from "@shared/mcp-write-contracts";
import "../styles/mcp-write.css";

export function McpWriteReview({ snapshot }: { snapshot: Review }): React.JSX.Element {
  return <section className="mcp-fixed-review" aria-label="本次 MCP 固定快照">
    <h3>{snapshot.serverName} · {snapshot.toolName}</h3>
    <p className="mcp-note">以下连接、工具、目标与完整参数来自本次审批保存的固定内容。</p>
    <dl><dt>连接身份</dt><dd>{snapshot.accountNotice}</dd><dt>目标说明</dt><dd>{snapshot.targetPreview}</dd><dt>连接版本</dt><dd>v{snapshot.serverVersion} · {snapshot.transport}</dd></dl>
    <pre aria-label="本次 MCP 固定参数">{JSON.stringify(snapshot.arguments, null, 2)}</pre>
    <details><summary>固定授权与内容摘要</summary><dl><dt>服务器 ID</dt><dd>{snapshot.serverId}</dd><dt>工具格式摘要</dt><dd>{snapshot.schemaDigest}</dd><dt>写授权</dt><dd>{snapshot.grantId} · v{snapshot.grantVersion}</dd><dt>参数摘要</dt><dd>{snapshot.argumentsDigest}</dd><dt>操作意图</dt><dd>{snapshot.intentId}</dd></dl></details>
  </section>;
}
