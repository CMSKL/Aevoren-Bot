import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

async function finalize() {
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

  await run("xcrun", ["stapler", "staple", artifactPath]);
  await run("xcrun", ["stapler", "validate", artifactPath]);
  const { buildBlockMap } = await import("app-builder-lib/out/targets/blockmap/blockmap.js");
  await buildBlockMap(artifactPath, "gzip", blockmapPath);

  const size = statSync(artifactPath).size;
  const sha512 = createHash("sha512").update(readFileSync(artifactPath)).digest("base64");
  const source = readFileSync(manifestPath, "utf8");
  const escapedName = artifactName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entry = new RegExp(`(- url: ${escapedName}\\n\\s+sha512: )([^\\n]+)(\\n\\s+size: )(\\d+)`);
  if (!entry.test(source)) throw new Error(`Manifest does not contain ${artifactName}`);
  const updated = source.replace(entry, `$1${sha512}$3${size}`);
  writeFileSync(manifestPath, updated, "utf8");

  await run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", artifactPath]);
  process.stdout.write(`finalized notarized macOS artifact=${artifactName} size=${size}\n`);
}

export async function run(command, args, { execute = spawnSync, delay = wait, log = message => process.stderr.write(message) } = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = execute(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    if (result.status === 0 && !result.error && !result.signal) return;
    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    // Error 68 alone also covers permanent ticket failures. Retry only the
    // observed CloudKit connection loss, never signing or ticket validation.
    const permanent = /(?:signature|ticket|notari[sz]ation|integrity)[^\n]*(?:invalid|failed|rejected|mismatch|missing|not found|revoked|not accepted)|(?:invalid|rejected|mismatch|missing|not found|revoked)[^\n]*(?:signature|ticket|notari[sz]ation|integrity)|\bnot (?:been (?:previously )?)?notari[sz]ed\b/iu.test(output);
    const network = command === "xcrun" && args[0] === "stapler" && ["staple", "validate"].includes(args[1]) && result.status === 68
      && !result.error && !result.signal && /Error Domain=NSURLErrorDomain Code=-1005(?:\s|")/u.test(output) && !permanent;
    if (network && attempt < 4) {
      const backoff = attempt * 2_000;
      log(`Retrying stapler ${args[1]} after network connection loss (-1005): attempt ${attempt + 1}/4 in ${backoff}ms.\n`);
      await delay(backoff); continue;
    }
    const error = new Error(`${command} ${args.join(" ")} failed${result.status === null ? "" : ` (exit ${result.status})`}: ${output || result.error?.message || result.signal || "unknown command failure"}`);
    error.exitCode = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await finalize(); }
  catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = error.exitCode ?? 1; }
}
