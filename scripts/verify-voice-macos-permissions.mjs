import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), plist = createRequire(require.resolve("app-builder-lib"))("plist");
function readPlist(path) {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 6).toString() !== "bplist") return plist.parse(bytes.toString("utf8"));
  const result = spawnSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Cannot read packaged microphone privacy declaration");
  return plist.parse(result.stdout);
}
function signedEntitlements(path) {
  const result = spawnSync("/usr/bin/codesign", ["-d", "--entitlements", ":-", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Cannot inspect signed microphone entitlements");
  const output = result.stdout + result.stderr, start = output.indexOf("<?xml"), end = output.indexOf("</plist>", start);
  if (start < 0 || end < 0) throw new Error("Missing signed microphone entitlements");
  return plist.parse(output.slice(start, end + 8));
}
/** Unsigned builds prove the declaration; signed gates prove actual App/Helper entitlements. */
export function verifyVoiceMacPermissions(target, { signed = false, entitlements = signedEntitlements } = {}) {
  const app = resolve(target), info = readPlist(join(app, "Contents/Info.plist"));
  if (typeof info.NSMicrophoneUsageDescription !== "string" || !info.NSMicrophoneUsageDescription.trim()) throw new Error("Missing microphone usage description");
  const frameworkRoot = join(app, "Contents/Frameworks");
  const helpers = readdirSync(frameworkRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()
    && entry.name.startsWith(`${info.CFBundleName} Helper`) && entry.name.endsWith(".app")).map(entry => join(frameworkRoot, entry.name));
  if (!helpers.some(path => path.endsWith("Helper (Renderer).app"))) throw new Error("Missing packaged Renderer Helper");
  if (signed) for (const bundle of [app, ...helpers]) if (entitlements(bundle)["com.apple.security.device.audio-input"] !== true) throw new Error("Signed app or Helper lacks audio-input entitlement");
  return { usageDescription: true, helpers: helpers.length, signedEntitlementsVerified: signed, physicalMicrophoneVerified: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: verify-voice-macos-permissions.mjs <Mac.app> [--signed]");
  process.stdout.write(`${JSON.stringify(verifyVoiceMacPermissions(process.argv[2], { signed: process.argv[3] === "--signed" }))}\n`);
}
