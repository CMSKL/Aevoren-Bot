import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { prerelease, valid } from "semver";

const outputDirectory = resolve(process.argv[2] ?? "dist");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = process.argv[3] ?? packageJson.version;
const architecture = process.argv[4] ?? "x64";

if (!valid(version)) throw new Error(`Invalid release version: ${version}`);
const channel = prerelease(version) ? "beta" : "latest";
const manifestName = `${channel}.yml`;
const artifactName = `Aevoren-Bot-${version}-${architecture}.exe`;
const blockmapName = `${artifactName}.blockmap`;
const requiredFiles = [artifactName, blockmapName, manifestName];

for (const fileName of requiredFiles) {
  if (!existsSync(join(outputDirectory, fileName))) throw new Error(`Missing release asset: ${fileName}`);
}

const manifest = readFileSync(join(outputDirectory, manifestName), "utf8");
const manifestVersion = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(manifest)?.[1];
if (manifestVersion !== version) {
  throw new Error(`Manifest version ${manifestVersion ?? "<missing>"} does not match ${version}`);
}

const filePattern = new RegExp(
  `- url: ${escapeRegExp(artifactName)}\\n\\s+sha512: ([^\\s]+)\\n\\s+size: (\\d+)`,
);
const fileEntry = filePattern.exec(manifest);
if (!fileEntry) throw new Error(`Manifest does not contain a complete entry for ${artifactName}`);
const artifactPath = join(outputDirectory, artifactName);
const actualSize = statSync(artifactPath).size;
const actualSha512 = createHash("sha512").update(readFileSync(artifactPath)).digest("base64");
if (Number(fileEntry[2]) !== actualSize) throw new Error(`Manifest size mismatch for ${artifactName}`);
if (fileEntry[1] !== actualSha512) throw new Error(`Manifest SHA-512 mismatch for ${artifactName}`);

const checksumFiles = [...requiredFiles].sort();
const checksumText = checksumFiles
  .map((fileName) => {
    const digest = createHash("sha256").update(readFileSync(join(outputDirectory, fileName))).digest("hex");
    return `${digest}  ${basename(fileName)}`;
  })
  .join("\n");
writeFileSync(join(outputDirectory, "SHASUMS256-win.txt"), `${checksumText}\n`, "utf8");

process.stdout.write(
  `verified Windows release version=${version} channel=${channel} arch=${architecture} assets=${requiredFiles.length}\n`,
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
