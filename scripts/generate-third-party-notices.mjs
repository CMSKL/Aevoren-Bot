import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const output = execFileSync(pnpm, ["licenses", "list", "--prod", "--long", "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
const catalog = JSON.parse(output);
const rows = Object.entries(catalog).flatMap(([license, entries]) => entries.flatMap((entry) => {
  const versions = Array.isArray(entry.versions) ? entry.versions : entry.version ? [entry.version] : ["unknown"];
  return versions.map((version) => ({
    name: String(entry.name),
    version: String(version),
    license,
    homepage: typeof entry.homepage === "string" ? entry.homepage : "",
  }));
})).toSorted((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

const lines = [
  "# Third-Party Notices",
  "",
  "Aevoren Bot includes the following production dependencies. This inventory is generated from the locked dependency graph with `pnpm licenses list --prod --long --json`.",
  "",
  "The license identifiers below are informational; the corresponding license texts distributed inside dependency packages remain controlling.",
  "",
  "| Package | Version | License | Project |",
  "| --- | --- | --- | --- |",
  ...rows.map((row) => `| ${escapeCell(row.name)} | ${escapeCell(row.version)} | ${escapeCell(row.license)} | ${row.homepage ? `[link](${row.homepage})` : "—"} |`),
  "",
];
const target = resolve("THIRD_PARTY_NOTICES.md");
writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`generated ${target} packages=${rows.length}\n`);

function escapeCell(value) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
