import { readFileSync } from "node:fs";
import { valid } from "semver";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
if (!valid(packageJson.version)) throw new Error(`package.json version is not valid SemVer: ${packageJson.version}`);
if (tag !== `v${packageJson.version}`) {
  throw new Error(`release tag ${tag || "<missing>"} must exactly match package version v${packageJson.version}`);
}
const expectedChannel = packageJson.version.includes("-") ? "beta" : "latest";
process.stdout.write(`release version=${packageJson.version} channel=${expectedChannel}\n`);
