import { execFile as execFileCallback } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, resolve, basename, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
async function executeSecurity(args) {
  try { return (await execFile("/usr/bin/security", args, { maxBuffer: 1_048_576 })).stdout; }
  catch { throw new Error(`Fixture Keychain command failed: ${args[0]}`); }
}
function paths(output) {
  return output.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(line => {
    if (!/^"[^"\r\n]+"$/u.test(line)) throw new Error("Unexpected Keychain path output");
    return line.slice(1, -1);
  });
}
function snapshotPath(path, temporaryRoot) {
  const absolute = resolve(path), root = resolve(temporaryRoot), child = relative(root, absolute);
  if (child.startsWith("..") || isAbsolute(child) || !/^aevoren-signed-fixture-keychain-[A-Za-z0-9-]+\.json$/u.test(basename(absolute))) throw new Error("Fixture Keychain snapshot must belong to RUNNER_TEMP");
  return absolute;
}
function validateState(state, path) {
  if (state.version !== 1 || !Array.isArray(state.searchList) || state.searchList.some(value => typeof value !== "string" || !isAbsolute(value))
    || typeof state.defaultKeychain !== "string" || !isAbsolute(state.defaultKeychain)
    || typeof state.keychain !== "string" || dirname(state.keychain) !== dirname(path)
    || !/^aevoren-signed-fixture-[a-f0-9-]+\.keychain-db$/u.test(basename(state.keychain))) throw new Error("Invalid fixture Keychain snapshot");
}

/** Only metadata is retained for the shell EXIT trap; the random password never enters a file. */
export async function createFixtureKeychain(path, temporaryRoot, options = {}) {
  const target = snapshotPath(path, temporaryRoot), security = options.security ?? executeSecurity;
  if (existsSync(target)) throw new Error("Fixture Keychain snapshot already exists");
  const defaults = paths(await security(["default-keychain", "-d", "user"]));
  if (defaults.length !== 1) throw new Error("Expected one original default Keychain");
  const state = { version: 1, defaultKeychain: defaults[0], searchList: paths(await security(["list-keychains", "-d", "user"])),
    keychain: join(dirname(target), `aevoren-signed-fixture-${randomUUID()}.keychain-db`) };
  await writeFile(target, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  const password = randomBytes(32).toString("hex");
  (options.mask ?? (value => process.stdout.write(`::add-mask::${value}\n`)))(password);
  try {
    await security(["create-keychain", "-p", password, state.keychain]);
    await security(["unlock-keychain", "-p", password, state.keychain]);
    await security(["set-keychain-settings", "-lut", "21600", state.keychain]);
    // Excluding the old user search list prevents an unsigned fixture's existing item winning a lookup.
    await security(["list-keychains", "-d", "user", "-s", state.keychain]);
    await security(["default-keychain", "-d", "user", "-s", state.keychain]);
  } catch {
    await restoreFixtureKeychain(target, temporaryRoot, { security }).catch(() => undefined);
    throw new Error("Could not prepare isolated signed-fixture Keychain; the cleanup trap will retry restoration");
  }
}

export async function restoreFixtureKeychain(path, temporaryRoot, options = {}) {
  const target = snapshotPath(path, temporaryRoot), security = options.security ?? executeSecurity;
  if (!existsSync(target)) return;
  const state = JSON.parse(await readFile(target, "utf8")); validateState(state, target);
  await security(["list-keychains", "-d", "user", "-s", ...state.searchList]);
  await security(["default-keychain", "-d", "user", "-s", state.defaultKeychain]);
  if (existsSync(state.keychain)) await security(["delete-keychain", state.keychain]);
  await unlink(target);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_OS !== "macOS" || !process.env.RUNNER_TEMP) throw new Error("Fixture Keychain isolation is restricted to the macOS GitHub Actions runner");
  const [mode, path] = process.argv.slice(2);
  if (!path || !["create", "restore"].includes(mode)) throw new Error("Usage: fixture-keychain.mjs create|restore RUNNER_TEMP/snapshot.json");
  if (mode === "create") await createFixtureKeychain(path, process.env.RUNNER_TEMP);
  else await restoreFixtureKeychain(path, process.env.RUNNER_TEMP);
}
