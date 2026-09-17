import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap.js";

const outputDirectory = resolve(process.argv[2] ?? "dist");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = process.argv[3] ?? packageJson.version;
const architecture = process.argv[4] ?? "arm64";
const channel = version.includes("-") ? "beta" : "latest";
const artifactName = `Aevoren-Bot-${version}-${architecture}.dmg`;
const artifactPath = join(outputDirectory, artifactName);
const blockmapPath = `${artifactPath}.blockmap`;
const manifestPath = join(outputDirectory, `${channel}-mac.yml`);

for (const path of [artifactPath, manifestPath]) {
  if (!existsSync(path)) throw new Error(`Missing macOS release asset: ${basename(path)}`);
}

run("xcrun", ["stapler", "staple", artifactPath]);
run("xcrun", ["stapler", "validate", artifactPath]);
await buildBlockMap(artifactPath, "gzip", blockmapPath);

const size = statSync(artifactPath).size;
const sha512 = createHash("sha512").update(readFileSync(artifactPath)).digest("base64");
const source = readFileSync(manifestPath, "utf8");
const escapedName = artifactName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const entry = new RegExp(`(- url: ${escapedName}\\n\\s+sha512: )([^\\n]+)(\\n\\s+size: )(\\d+)`);
if (!entry.test(source)) throw new Error(`Manifest does not contain ${artifactName}`);
const updated = source.replace(entry, `$1${sha512}$3${size}`);
writeFileSync(manifestPath, updated, "utf8");

run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", artifactPath]);
process.stdout.write(`finalized notarized macOS artifact=${artifactName} size=${size}\n`);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}
