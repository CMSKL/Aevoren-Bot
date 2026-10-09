const QUOTED = /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|“([^”\n]+)”|‘([^’\n]+)’/gu;
const WRITE_VERB = /workspace_write(?=\s|[({:：]|$)|(?:保存|写入|写成|写为|新建|创建|生成|输出|整理)(?:为|到|至|成|进)?|\b(?:write|save|create|generate|output)\b(?=\s|[:：]|$)/giu;
const FILE_END = /\.(?:md|markdown|txt|csv|tsv|json|jsonc|ya?ml|toml|xml|html?|css|[cm]?[jt]sx?|py|go|rs|java|swift|c|cpp|h|sh|sql|log)$/iu;
const FILE_TOKEN = /^[\p{L}\p{N}_.-]+?(?:\/[\p{L}\p{N}_.-]+?)*?\.(?:md|markdown|txt|csv|tsv|json|jsonc|ya?ml|toml|xml|html?|css|[cm]?[jt]sx?|py|go|rs|java|swift|c|cpp|h|sh|sql|log)(?=$|[^A-Za-z0-9_.-])/iu;

function maskQuotes(text: string): string {
  return text.replace(QUOTED, (quoted) => " ".repeat(quoted.length));
}

function safePath(path: string): boolean {
  return FILE_END.test(path) && !path.includes("\\") && ![...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !path.startsWith("/") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/** Conservative named output requirements, never paths mentioned only as sources or examples. */
export function requestedWritePaths(text: string): string[] {
  const paths = new Set<string>();
  const input = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, " ")
    .replace(/https?:\/\/[^\s`"'<>，。；]+/giu, " ")
    .replace(/^\s*>[^\n]*/gmu, " ");
  const masked = maskQuotes(input);
  const verbs = [...masked.matchAll(WRITE_VERB)];
  for (const [index, verb] of verbs.entries()) {
    const before = masked.slice(0, verb.index);
    const sentence = before.split(/[。！？!?\n]|\.(?=\s)/u).at(-1)!;
    const prefix = sentence.split(/[；;,，]/u).at(-1)!;
    if (/例如|示例|举例|假设|解释|讨论|提到|标题|文档中|字符串|引用|^(?:请)?说明|\b(?:example|explain|quoted?|documentation|sample|hypothetical)\b/iu.test(sentence) ||
      /(?:不要|不得|禁止|无需|不必|不能|不需要|不允许|别|未要求)[^。！？；;,\n，]{0,16}$|不(?:再|应|可)?\s*$/u.test(prefix) ||
      /(?:尚未|已经|已|未曾|曾经)(?:真实|成功|完整)?\s*$/u.test(prefix) ||
      /\b(?:do\s+not|don't|never|without|avoid|already|must\s+not|no\s+need\s+to)(?:\s+\w+){0,3}\s*$/iu.test(prefix)) continue;
    const start = verb.index! + verb[0].length;
    let clause = input.slice(start, Math.min(verbs[index + 1]?.index ?? input.length, start + 512));
    const clauseMask = maskQuotes(clause);
    const boundary = clauseMask.search(/读取|读入|阅读|\b(?:read|from|using|based\s+on)\b|[；;。！？!?\n]|\.(?=\s|$)/iu);
    if (boundary >= 0) clause = clause.slice(0, boundary);
    // In “write a summary of source.md to result.md”, only the named destination is output.
    const destinations = [...maskQuotes(clause).matchAll(/\b(?:to|into|as)\s+|\bpath\s*=\s*|(?:到|至|为|成|进)(?=\s|[`"'“‘])\s*/giu)];
    const destination = destinations.filter((match) => clause.slice(match.index! + match[0].length).trim()).at(-1);
    if (destination) clause = clause.slice(destination.index! + destination[0].length);
    clause = clause.trimStart().replace(/^(?:(?:一个|一份|新的|唯一的?|Markdown|CSV)\s*)*(?:文件|文档|报告)(?:\s+|(?=[`"'“‘A-Za-z]))/iu, "")
      .replace(/^(?:(?:a|an|the|new|markdown|csv)\s+)*(?:(?:file|document|report)\s+)?(?:(?:named|called)\s+)?/iu, "")
      .replace(/^[:：]\s*/u, "");
    while (clause) {
      const quoted = new RegExp(`^(?:${QUOTED.source})`, "u").exec(clause);
      const unquoted = quoted ? null : FILE_TOKEN.exec(clause);
      const match = quoted ?? unquoted;
      if (!match) break;
      const path = (quoted ? quoted.slice(1).find((part) => part !== undefined)! : match[0]).normalize("NFC");
      const tail = clause.slice(match[0].length);
      if (!safePath(path) || /^\s*(?:的(?:路径|文件名|名称|内容|摘要)|(?:内容|摘要)|\b(?:path|contents?|summary)\b)/iu.test(tail)) break;
      paths.add(path);
      const separator = /^\s*(?:、|，|,|和|及|与|\band\b)\s*/iu.exec(tail);
      if (!separator) break;
      clause = tail.slice(separator[0].length);
    }
  }
  return [...paths];
}
