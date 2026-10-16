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
    {snapshot.observedNotionTarget ? <><h4>准备时观察到的目标页面</h4><dl><dt>页面 ID</dt><dd>{snapshot.observedNotionTarget.pageId}</dd><dt>标题属性 ID</dt><dd>{snapshot.observedNotionTarget.titlePropertyId}</dd><dt>原页面标题</dt><dd>{snapshot.observedNotionTarget.title}</dd><dt>最后编辑时间</dt><dd>{snapshot.observedNotionTarget.lastEditedTime}</dd><dt>父级类型</dt><dd>{snapshot.observedNotionTarget.parentType}</dd></dl></> : null}
    {content.kind === "gmail-message" ? <><dl><dt>收件人</dt><dd>{content.to.join("、")}</dd><dt>抄送</dt><dd>{content.cc.join("、") || "无"}</dd><dt>主题</dt><dd>{content.subject}</dd></dl><pre>{content.body}</pre></> : content.kind === "notion-page-title" ? <><dl><dt>目标页面</dt><dd>{content.pageId}</dd><dt>新标题</dt><dd>{content.title}</dd></dl><p className="connector-note">仅修改上述标题属性，保留页面正文。</p></> : content.kind === "notion-page-append" ? <><dl><dt>目标页面</dt><dd>{content.pageId}</dd></dl><h4>在页面末尾追加的段落</h4><pre>{content.text}</pre><p className="connector-note">追加到页面末尾，保留已有正文；不会覆盖页面内容。</p></> : <><dl>{content.kind === "notion-page" ? <><dt>父页面</dt><dd>{content.parentPageId}</dd></> : <><dt>目标文件</dt><dd>{content.targetFileId ?? "新建文本文件"}</dd></>}<dt>标题</dt><dd>{content.title}</dd></dl><pre>{content.text}</pre></>}
    {content.kind === "notion-page-title" || content.kind === "notion-page-append" ? <p className="connector-note">提交后的只读核对只能证明目标页面当前可观察的状态，不能证明由本次操作独占产生；没有充分证据时仍保持结果未知，不会自动重发。</p> : null}
    <details><summary>固定授权与内容摘要</summary><dl><dt>账号 ID</dt><dd>{snapshot.account.accountId}</dd><dt>授权版本</dt><dd>{snapshot.authVersion}</dd><dt>写授权</dt><dd>{snapshot.grantId} · v{snapshot.grantVersion}</dd><dt>草稿版本 ID</dt><dd>{snapshot.revisionId}</dd><dt>内容摘要</dt><dd>{snapshot.revisionDigest}</dd><dt>目标摘要</dt><dd>{snapshot.targetDigest}</dd><dt>外发意图</dt><dd>{snapshot.intentId}</dd></dl></details>
  </section>;
}
