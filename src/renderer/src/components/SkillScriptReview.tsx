import type { SkillScriptApprovalReviewSnapshot } from "@shared/skill-execution-contracts";
import "../styles/skill-scripts.css";

export function SkillScriptReview({ snapshot }: { snapshot: SkillScriptApprovalReviewSnapshot }): React.JSX.Element {
  const target = snapshot.target;
  return <section className="skill-script-review" aria-label="本次脚本执行快照">
    <h3>{snapshot.resourceName} · v{snapshot.revisionNumber}</h3>
    <p>以下内容来自本次审批保存的固定快照。</p>
    <dl><dt>脚本入口</dt><dd>{target.entryPath}</dd><dt>解释器</dt><dd>{target.interpreter}</dd>
      <dt>参数</dt><dd><pre>{JSON.stringify(target.args, null, 2)}</pre></dd><dt>工作目录</dt><dd>{target.cwd}</dd><dt>超时</dt><dd>{target.timeoutMs / 1000} 秒</dd>
      <dt>授权版本</dt><dd>{target.grantId} · v{target.grantVersion}</dd><dt>隔离环境</dt><dd>{target.environmentId}</dd>
      <dt>环境镜像</dt><dd>{target.imageDigest}</dd><dt>Worker</dt><dd>{target.workerVersion}</dd>
      <dt>资源版本</dt><dd>{target.reference.revisionId}</dd><dt>资源摘要</dt><dd>{target.reference.digest}</dd><dt>入口摘要</dt><dd>{target.entrySha256}</dd></dl>
  </section>;
}
