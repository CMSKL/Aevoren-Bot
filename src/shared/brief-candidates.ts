export type BriefCandidate = "A" | "B" | "C";

export type BriefCandidateOption = {
  id: BriefCandidate;
  title: string;
  angle: string | null;
  evidence: string | null;
  risk: string | null;
  recommendation: string | null;
};

const CANDIDATE_HEADING = /^(?:候选(?:项|选题)?|方案|选题|candidate|option)\s*([ABC])(?:\s*[（(][^）)\r\n]{1,40}[）)])?(?:\s*[：:、.）)—–|｜-]\s*|\s+|$)(.*)$/iu;
const FIELD_LABELS = ["标题", "title", "核心角度", "单一角度", "角度", "angle", "证据来源", "证据链接/溯源", "证据链接", "群内溯源", "来源", "证据", "sources?", "evidence", "风险", "risks?", "推荐理由", "推荐原因", "推荐", "recommendation", "rationale"];
const FIELD_ANNOTATION = "(?:\\s*[（(][^）)\\r\\n]{1,40}[）)])?";
const FIELD_START = new RegExp(`^(?:${FIELD_LABELS.join("|")})${FIELD_ANNOTATION}\\s*[：:]`, "iu");

function plainLine(line: string): string {
  return line.trim().replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/u, "").replace(/\*\*|__/gu, "").trim();
}

function fieldValue(lines: string[], labels: string[]): string | null {
  const pattern = new RegExp(`^(?:${labels.join("|")})${FIELD_ANNOTATION}\\s*[：:]\\s*(.*)$`, "iu");
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(plainLine(lines[index] ?? ""));
    if (!match) continue;
    const values = match[1]?.trim() ? [match[1].trim()] : [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const raw = lines[next] ?? "";
      const line = plainLine(raw);
      if (!line || FIELD_START.test(line) || /^#{1,6}\s/u.test(raw.trim()) || /^[\p{L}_\s/]+[：:]/u.test(line)) break;
      values.push(line);
    }
    if (values.length > 0) return values.join("\n");
  }
  return null;
}

/** Only candidates actually carrying a title in the saved Brief are approvable. */
export function briefCandidateOptions(body: string): BriefCandidateOption[] {
  const candidates = new Map<BriefCandidate, BriefCandidateOption>();
  const lines = body.split(/\r?\n/gu);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const match = CANDIDATE_HEADING.exec(plainLine(line));
    const idText = match?.[1];
    if (!match || !idText) continue;
    const id = idText.toUpperCase() as BriefCandidate;
    const nextHeadingOffset = lines.slice(index + 1).findIndex((line) => CANDIDATE_HEADING.test(plainLine(line)) || /^(?:推荐|总体推荐|最终推荐|总结|汇总|交付物|下一步|HANDOFF)(?:\s|[：:]|$)/iu.test(plainLine(line)));
    const blockEnd = nextHeadingOffset < 0 ? lines.length : index + 1 + nextHeadingOffset;
    const block = lines.slice(index + 1, blockEnd);
    const title = (fieldValue(block, ["标题", "title"]) ?? (match[2] ?? "").trim()).replace(/^[`'“”‘’《》「」]+|[`'“”‘’《》「」]+$/gu, "").trim();
    if (candidates.has(id) || !title) continue;
    candidates.set(id, {
      id,
      title,
      angle: fieldValue(block, ["核心角度", "单一角度", "角度", "angle"]),
      evidence: fieldValue(block, ["证据来源", "证据链接/溯源", "证据链接", "群内溯源", "来源", "证据", "sources?", "evidence"]),
      risk: fieldValue(block, ["风险", "risks?"]),
      recommendation: fieldValue(block, ["推荐理由", "推荐原因", "推荐", "recommendation", "rationale"]),
    });
  }
  return (["A", "B", "C"] as const).flatMap((id) => candidates.get(id) ?? []);
}
