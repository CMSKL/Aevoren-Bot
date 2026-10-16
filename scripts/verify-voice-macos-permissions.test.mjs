import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { verifyVoiceMacPermissions } from "./verify-voice-macos-permissions.mjs";
const require = createRequire(import.meta.url), plist = createRequire(require.resolve("app-builder-lib"))("plist");
function fixture(callback, usage = "User initiated recording") {
  const root = mkdtempSync(join(tmpdir(), "aevoren-mic-package-")), app = join(root, "Aevoren Bot.app");
  const frameworks = join(app, "Contents/Frameworks"); mkdirSync(frameworks, { recursive: true });
  mkdirSync(join(frameworks, "Aevoren Bot Helper (Renderer).app"));
  writeFileSync(join(app, "Contents/Info.plist"), plist.build({ CFBundleName: "Aevoren Bot", NSMicrophoneUsageDescription: usage }));
  try { callback(app); } finally { rmSync(root, { recursive: true, force: true }); }
}
test("unsigned declaration does not claim signed or physical access", () => fixture(app => {
  assert.deepEqual(verifyVoiceMacPermissions(app), { usageDescription: true, helpers: 1, signedEntitlementsVerified: false, physicalMicrophoneVerified: false });
}));
test("missing privacy declaration fails", () => fixture(app => assert.throws(() => verifyVoiceMacPermissions(app), /usage description/u), ""));
test("signed gate checks both the app and actual Renderer Helper", () => fixture(app => {
  let checked = 0;
  assert.equal(verifyVoiceMacPermissions(app, { signed: true, entitlements: () => { checked += 1; return { "com.apple.security.device.audio-input": true }; } }).signedEntitlementsVerified, true);
  assert.equal(checked, 2);
  assert.throws(() => verifyVoiceMacPermissions(app, { signed: true, entitlements: path => ({ "com.apple.security.device.audio-input": path === app }) }), /Helper lacks/u);
}));
