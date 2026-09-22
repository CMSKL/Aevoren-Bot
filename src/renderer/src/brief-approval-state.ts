import type { ToolInvocation, TranscriptEntry } from "@shared/contracts";

export type BriefCandidate = "A" | "B" | "C";

export type BriefCandidateOption = {
  id: BriefCandidate;
  label: string;
};

const APPROVAL_ACTION = /^(?:\s*\bAPPROVED\b|\s*(?:我|用户)?(?:已|明确)?批准(?:候选|选题|方案|第)|\s*选择.{0,8}(?:候选|选题|方案|第))/iu;
const STOP_ACTION = /^\s*(?:RETURN\b|退回补证|放弃本轮|放弃任务)/iu;

export function shouldShowBriefApproval(invocations: ToolInvocation[], entries: TranscriptEntry[]): boolean {
  const successfulWrites = invocations.filter((invocation) => invocation.toolKind === "workspace-write" && invocation.state === "succeeded");
  const briefs = successfulWrites.filter((invocation) => invocation.targetPath.startsWith("02-briefs/"));
  if (briefs.length === 0) return false;
  const latestBriefAt = briefs.reduce((latest, invocation) => invocation.createdAt > latest ? invocation.createdAt : latest, "");
  const hasDownstreamArtifact = successfulWrites.some((invocation) => (
    invocation.createdAt >= latestBriefAt && ["03-drafts/", "04-review/", "05-data/", "06-reports/"].some((prefix) => invocation.targetPath.startsWith(prefix))
  ));
  if (hasDownstreamArtifact) return false;
  return !entries.some((entry) => (
    entry.role === "user" && entry.createdAt >= latestBriefAt && (APPROVAL_ACTION.test(entry.body) || STOP_ACTION.test(entry.body))
  ));
}

const CANDIDATE_HEADING = /^\s*(?:#{1,6}\s*)?(?:候选|方案|选题)\s*([ABC])(?:\s*[：:]\s*|\s+)?(.*)$/iu;
const MARKDOWN_PREFIX = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/u;

export function briefCandidateOptions(body: string): BriefCandidateOption[] {
  const labels = new Map<BriefCandidate, string>();
  const lines = body.split(/\r?\n/gu);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const match = CANDIDATE_HEADING.exec(line);
    const idText = match?.[1];
    if (!match || !idText) continue;
    const id = idText.toUpperCase() as BriefCandidate;
    let label = (match[2] ?? "").replace(MARKDOWN_PREFIX, "").trim();
    if (!label) {
      const next = lines.slice(index + 1).find((line) => line.trim().length > 0 && !CANDIDATE_HEADING.test(line));
      label = next?.replace(MARKDOWN_PREFIX, "").trim() ?? "";
    }
    labels.set(id, label.replace(/^['“”《》]+|['“”《》]+$/gu, "").slice(0, 72));
  }
  return (["A", "B", "C"] as const).map((id) => ({
    id,
    label: labels.get(id) || `候选 ${id}`,
  }));
}
