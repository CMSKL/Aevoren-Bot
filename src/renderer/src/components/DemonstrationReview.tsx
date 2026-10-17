import type { DemonstrationApprovalReviewSnapshot } from "@shared/demonstration-contracts";
export function DemonstrationReview({ snapshot }: { snapshot: DemonstrationApprovalReviewSnapshot }): React.JSX.Element {
  return <section aria-label="本次示范 Skill 发布快照" className="skill-script-review"><h3>{snapshot.resourceName} · v{snapshot.revisionNumber}</h3><p>本次发布来自审批时已保存的固定草稿。初始停用，不授权脚本或自动执行。</p><dl><dt>当前会话</dt><dd>{snapshot.target.sessionId}</dd><dt>执行成员</dt><dd>{snapshot.target.executorBotId}</dd><dt>草稿摘要</dt><dd>{snapshot.target.draftDigest}</dd></dl><pre>{snapshot.target.body}</pre></section>;
}
