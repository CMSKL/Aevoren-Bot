import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { verifyReleaseVersion } = require("./release-version-policy.cjs");

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const result = verifyReleaseVersion(packageJson.version, tag);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${result.version}\nchannel=${result.channel}\nrelease_type=${result.releaseType}\nexpected_branch=${result.expectedBranch}\n`,
  );
}
process.stdout.write(
  `release version=${result.version} channel=${result.channel} releaseType=${result.releaseType} expectedBranch=${result.expectedBranch}\n`,
);
