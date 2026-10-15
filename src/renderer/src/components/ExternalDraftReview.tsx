import type { ExternalDraftReviewSnapshot } from "@shared/native-outbound-contracts";
import { connectorLabels } from "../connector-ui-state";
import { outboundOperationLabels } from "../outbound-approval-review";
import "../styles/connectors.css";

export function ExternalDraftReview({ snapshot }: { snapshot: ExternalDraftReviewSnapshot }): React.JSX.Element {
  const content = snapshot.content;
  return <section className="connector-outbound-review" aria-label="本次外发固定快照">
    <h3>{outboundOperationLabels[snapshot.operation]}</h3>
    <p className="connector-note">以下账号、目标与正文来自本次审批保存的固定版本。批准后将提交到外部应用。</p>
    <dl><dt>应用账号</dt><dd>{connectorLabels[snapshot.provider]} · {snapshot.account.displayName}{snapshot.account.email ? ` · ${snapshot.account.email}` : ""}</dd>
      <dt>连接</dt><dd>{snapshot.connectionName}</dd><dt>目标</dt><dd>{snapshot.targetIds.length ? snapshot.targetIds.join("、") : "创建新文件"}</dd>
      <dt>草稿版本</dt><dd>v{snapshot.revisionNumber}</dd>{snapshot.observedTargetVersion ? <><dt>已观察目标版本</dt><dd>{snapshot.observedTargetVersion}</dd></> : null}</dl>
    {content.kind === "gmail-message" ? <><dl><dt>收件人</dt><dd>{content.to.join("、")}</dd><dt>抄送</dt><dd>{content.cc.join("、") || "无"}</dd><dt>主题</dt><dd>{content.subject}</dd></dl><pre>{content.body}</pre></> : <><dl>{content.kind === "notion-page" ? <><dt>父页面</dt><dd>{content.parentPageId}</dd></> : <><dt>目标文件</dt><dd>{content.targetFileId ?? "新建文本文件"}</dd></>}<dt>标题</dt><dd>{content.title}</dd></dl><pre>{content.text}</pre></>}
    <details><summary>固定授权与内容摘要</summary><dl><dt>账号 ID</dt><dd>{snapshot.account.accountId}</dd><dt>授权版本</dt><dd>{snapshot.authVersion}</dd><dt>写授权</dt><dd>{snapshot.grantId} · v{snapshot.grantVersion}</dd><dt>草稿版本 ID</dt><dd>{snapshot.revisionId}</dd><dt>内容摘要</dt><dd>{snapshot.revisionDigest}</dd><dt>目标摘要</dt><dd>{snapshot.targetDigest}</dd><dt>外发意图</dt><dd>{snapshot.intentId}</dd></dl></details>
  </section>;
}
