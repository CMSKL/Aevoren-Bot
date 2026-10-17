import type { ToolInvocation, TranscriptEntry } from "@shared/contracts";

export { briefCandidateOptions, type BriefCandidate, type BriefCandidateOption } from "@shared/brief-candidates";

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
    entry.role === "user" && entry.createdAt >= latestBriefAt && STOP_ACTION.test(entry.body)
  ));
}
