import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalReviewSnapshot } from "@shared/skill-execution-contracts";
import { SkillScriptsSection } from "./SkillScriptsSection";
import { SkillScriptReview } from "./SkillScriptReview";

describe("Skill script surfaces", () => {
  it("does not invent grants, scripts, a ready environment or a successful execution before host data", () => {
    const html = renderToStaticMarkup(<SkillScriptsSection sessionId="session-a" executorBotId="bot-a" reference={{ resourceId: "resource-a", revisionId: "revision-a", digest: "1".repeat(64) }} resourceName="真实 Skill" revisionNumber={2} ownerName="当前成员" />);
    expect(html).toContain('aria-label="Skill 脚本"');
    expect(html).toContain("脚本与授权状态未确认");
    expect(html).toContain("仅当前聊天与执行成员的 Linux 环境");
    expect(html).not.toContain("运行已授权脚本");
    expect(html).not.toContain("已授权");
    expect(html).not.toContain("运行成功");
    expect(html).not.toContain("autofocus");
  });
  it("removes actionable script controls from an inactive panel", () => {
    const html = renderToStaticMarkup(<SkillScriptsSection sessionId="session-a" executorBotId="bot-a" reference={{ resourceId: "resource-a", revisionId: "revision-a", digest: "1".repeat(64) }} resourceName="真实 Skill" revisionNumber={2} active={false} />);
    expect(html).toContain('hidden=""');
    expect(html).not.toContain("<button"); expect(html).not.toContain("<textarea");
  });
  it("renders the original persisted name, revision, image, entry hash and argument array as escaped text", () => {
    const snapshot: ApprovalReviewSnapshot = { kind: "skill-script", resourceName: "原始<script>名称", revisionNumber: 2, target: { grantId: "original-grant", grantVersion: 3, environmentId: "original-environment", imageDigest: `sha256:${"1".repeat(64)}`, workerVersion: "1.2.0", reference: { resourceId: "original-resource", revisionId: "original-revision", digest: "2".repeat(64) }, entryPath: "scripts/original.py", entrySha256: "3".repeat(64), interpreter: "python", args: ["--literal", "$(not-a-shell-command);<script>"], cwd: "relative-directory", timeoutMs: 5000 } };
    const html = renderToStaticMarkup(<SkillScriptReview snapshot={snapshot} />);
    for (const text of ["原始&lt;script&gt;名称", "v2", "original-grant", "v3", "original-environment", "scripts/original.py", "relative-directory", "5 秒", snapshot.target.imageDigest, snapshot.target.entrySha256, "$(not-a-shell-command);&lt;script&gt;"]) expect(html).toContain(text);
    expect(html).not.toContain("<script>");
    expect(html).toContain("本次审批保存的固定快照");
  });
});
