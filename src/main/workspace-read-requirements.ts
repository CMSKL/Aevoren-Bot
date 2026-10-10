/** Extract explicit local source paths after a read verb, stopping before output instructions. */
export function requestedReadPaths(text: string): string[] {
  const paths = new Set<string>();
  let input = text.replace(/```[\s\S]*?```/gu, " ").replace(/https?:\/\/[^\s`"'<>，。；]+/giu, " ");
  input = input.replace(/[`"'“]([^`"'”\n]+)[`"'”]/gu, (quoted, content: string, offset: number) => {
    const before = input.slice(Math.max(0, offset - 30), offset);
    const namedSource = /(?:workspace_read|读取|读入|阅读|\bread\b)\s*$/iu.test(before);
    return !namedSource && /读取|读入|阅读|workspace_read|\bread\s/iu.test(content) ? " " : quoted;
  });
  const verbInput = input.replace(/[`"'“]([^`"'”\n]+)[`"'”]/gu, (quoted) => " ".repeat(quoted.length));
  const verbs = [...verbInput.matchAll(/workspace_read(?=\s|[({:：]|$)|读取|读入|阅读|\bread\b(?=\s|[:：]|$)/giu)];
  const file = /(?:[\p{L}\p{N}_.-]+\/)*[A-Za-z0-9_.-]+\.(?:md|markdown|txt|csv|tsv|json|jsonc|ya?ml|toml|xml|html?|css|[cm]?[jt]sx?|py|go|rs|java|swift|c|cpp|h|sh|sql|log)\b|\b(?:LICENSE|LICENCE|COPYING|README|NOTICE)\b/gu;
  for (const [index, verb] of verbs.entries()) {
    const prefix = input.slice(Math.max(0, verb.index! - 60), verb.index).split(/[。！？；;,\n，]/u).at(-1)!;
    if (/(?:不要|不得|禁止|无需|不必|不能|不需要|不允许|别|未要求)[^。！？；;,\n，]{0,16}$/u.test(prefix) ||
      /(?:尚未|已经|已|未曾|曾经)(?:真实|成功|完整)?\s*$/u.test(prefix) ||
      /\b(?:do\s+not|don't|never|without|avoid|already)(?:\s+\w+){0,3}\s*$/iu.test(prefix) ||
      /例如|示例|举例|假设|解释|讨论|提到|标题|文档中|字符串|引用|^(?:请)?说明|\b(?:example|explain|quoted?|documentation|sample|hypothetical)\b/iu.test(prefix)) continue;
    const start = verb.index! + verb[0].length;
    let clause = input.slice(start, Math.min(verbs[index + 1]?.index ?? input.length, start + 512));
    clause = clause.split(/workspace_write|保存|写入|写成|写为|新建|创建|生成|输出|整理为|→|->|；|;|。|\n|(?:，|,)\s*(?:将|把)|\b(?:write|save|create|generate|output)\b/iu, 1)[0]!;
    const unquoted = clause.replace(/[`"'“]([^`"'”\n]+)[`"'”]/gu, " ");
    for (const match of unquoted.matchAll(file)) {
      const path = match[0].normalize("NFC");
      if (!path.startsWith("/") && !path.split("/").includes("..")) paths.add(path);
    }
    // Quoted paths can contain non-ASCII file names or spaces.
    for (const match of clause.matchAll(/[`"'“]([^`"'”\n]+)[`"'”]/gu)) {
      const path = match[1]!.trim().normalize("NFC");
      if (/\.[a-z]{1,10}$/iu.test(path) && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..")) paths.add(path);
    }
  }
  return [...paths];
}
