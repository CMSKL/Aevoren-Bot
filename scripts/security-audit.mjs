import "./verify-http-cache-patch.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const audit = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["audit", "--audit-level", "high", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
  maxBuffer: 16 * 1024 * 1024,
});
if (audit.error || audit.signal || ![0, 1].includes(audit.status)) {
  throw audit.error ?? new Error(`Dependency audit could not complete: ${audit.stderr}`);
}
const report = JSON.parse(audit.stdout);
assert.ok(report.advisories && typeof report.advisories === "object" && !Array.isArray(report.advisories), "Unknown audit response");
assert.ok(report.metadata?.vulnerabilities, "Audit response is missing severity counts");
const findings = Object.values(report.advisories).filter((item) => item.severity === "high" || item.severity === "critical");
assert.equal(findings.length, report.metadata.vulnerabilities.high + report.metadata.vulnerabilities.critical, "Unaccounted high-severity advisory");
const blocking = findings.filter((item) => !(
  item.github_advisory_id === "GHSA-ch52-4w7c-c8xp" &&
  item.module_name === "http-cache-semantics" &&
  item.findings?.length > 0 &&
  item.findings.every((finding) => finding.version === "4.2.0" && finding.dev === true && finding.bundled === false)
));
if (blocking.length > 0) {
  for (const item of blocking) process.stderr.write(`${item.severity}: ${item.module_name} ${item.github_advisory_id}\n`);
  throw new Error("Dependency audit found an unmitigated high-severity vulnerability");
}
process.stdout.write(`dependency audit passed; ${findings.length} packaging advisory covered by verified local backport; moderate=${report.metadata.vulnerabilities.moderate}\n`);
