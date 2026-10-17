import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parserAssetComponents, selectedParserLicense } from "./media-parser-assets.mjs";

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
    license: selectedParserLicense(entry.name, version, license),
    homepage: typeof entry.homepage === "string" ? entry.homepage : "",
  }));
})).toSorted((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

const lines = [
  "# Third-Party Notices",
  "",
  "Aevoren Bot includes the following production dependencies. This inventory is generated from the locked dependency graph with `pnpm licenses list --prod --long --json`.",
  "",
  "The license identifiers below are informational; the corresponding license texts distributed inside dependency packages remain controlling.",
  "JSZip 3.10.2 declares MIT OR GPL-3.0-or-later. Aevoren selects the offered MIT alternative; its complete, hash-checked upstream license text is also retained in `media-parser/licenses/jszip-LICENSE.markdown`. This exact selection does not permit GPL-only dependencies or change the GPL rejection policy.",
  "",
  "| Package | Version | License | Project |",
  "| --- | --- | --- | --- |",
  ...rows.map((row) => `| ${escapeCell(row.name)} | ${escapeCell(row.version)} | ${escapeCell(row.license)} | ${row.homepage ? `[link](${row.homepage})` : "—"} |`),
  "",
  "## Bundled media parser assets",
  "",
  "The browser parser bundles the following independently licensed assets in addition to the npm code above. Complete source licenses, the unmodified Liberation Fonts provenance and the deterministic asset hash manifest are distributed under `media-parser/licenses` and `media-parser/manifest.json`. The four GPL-licensed Liberation Sans 1.07.4 files from pdfjs-dist are excluded; the same filenames contain the verified, unmodified OFL 1.1 version 2.1.5 fonts instead. PDF scripting sandbox and QuickJS assets are excluded.",
  "",
  "| Asset | Version | License | Source |",
  "| --- | --- | --- | --- |",
  ...parserAssetComponents.map(component => `| ${escapeCell(component.name)} | ${escapeCell(component.version)} | ${escapeCell(component.license)} | [source](${component.source}) |`),
  "",
  "## Separately built execution image",
  "",
  "The optional local Docker execution image includes independently licensed Linux tools outside this npm inventory. See [execution image versions, base digest and license notices](docs/EXECUTION_ENVIRONMENT.md#images-and-third-party-licenses). Docker is user-provided; the app does not bundle its distribution.",
  "The separately built browser companion also includes Chromium, Playwright, Xvfb, Openbox, x11vnc, xdotool and FFmpeg. See [browser image versions and isolation](docs/BROWSER_COMPUTER.md#isolation-and-lifecycle); these distributions retain their own notices in the image.",
];
const target = resolve("THIRD_PARTY_NOTICES.md");
writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`generated ${target} packages=${rows.length}\n`);

function escapeCell(value) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
