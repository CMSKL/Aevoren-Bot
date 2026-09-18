import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const markdownFiles = walk(resolve(".")).filter((path) => extname(path).toLowerCase() === ".md");
const missing = [];
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/gu;

for (const file of markdownFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(linkPattern)) {
    const raw = match[1]?.trim().replace(/^<|>$/gu, "") ?? "";
    if (!raw || raw.startsWith("#") || /^(?:https?:|mailto:|codex:)/iu.test(raw)) continue;
    const target = decodeURIComponent(raw.split("#", 1)[0] ?? "");
    if (!existsSync(resolve(dirname(file), target))) missing.push(`${file}: ${raw}`);
  }
}

if (missing.length > 0) throw new Error(`Broken local Markdown links:\n${missing.join("\n")}`);
process.stdout.write(`documentation link check passed files=${markdownFiles.length}\n`);

function walk(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    if ([".git", "node_modules", "out", "dist", "coverage", "playwright-report", "test-results"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
