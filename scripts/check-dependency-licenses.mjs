import { execFileSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const output = execFileSync(pnpm, ["licenses", "list", "--prod", "--long", "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
const catalog = JSON.parse(output);
const forbidden = /(?:^|\W)(?:AGPL|GPL|LGPL|SSPL|BUSL|UNLICENSED|UNKNOWN)(?:$|\W)|Commons Clause/iu;
const findings = [];
let packages = 0;

for (const [license, entries] of Object.entries(catalog)) {
  if (!Array.isArray(entries)) throw new Error(`Unexpected pnpm license output for ${license}`);
  packages += entries.length;
  if (!license.trim() || forbidden.test(license)) {
    findings.push(`${license || "<missing>"}: ${entries.map((entry) => entry.name).join(", ")}`);
  }
}

if (findings.length > 0) {
  throw new Error(`Disallowed or unreviewed production dependency licenses:\n${findings.join("\n")}`);
}

process.stdout.write(`dependency license check passed packages=${packages} license_groups=${Object.keys(catalog).length}\n`);
