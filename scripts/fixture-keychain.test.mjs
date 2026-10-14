import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { parse } from "yaml";
import { createFixtureKeychain, restoreFixtureKeychain } from "./fixture-keychain.mjs";

const execFile = promisify(execFileCallback);

async function fixture(callback, failAt) {
  const directory = await mkdtemp(join(tmpdir(), "aevoren-keychain-wrapper-"));
  const snapshot = join(directory, "aevoren-signed-fixture-keychain-test.json"), original = join(directory, "original login.keychain-db"), signing = join(directory, "signing.keychain-db");
  let currentDefault = original, currentList = [original, signing], masked = "", failed = false;
  const security = async args => {
    if (args[0] === failAt && (failAt !== "default-keychain" || args.includes("-s")) && !failed) { failed = true; throw new Error("Simulated OS operation failure"); }
    if (args[0] === "default-keychain") { if (args.includes("-s")) currentDefault = args.at(-1); else return `    "${currentDefault}"\n`; }
    if (args[0] === "list-keychains") { if (args.includes("-s")) currentList = args.slice(args.indexOf("-s") + 1); else return currentList.map(path => `    "${path}"`).join("\n"); }
    if (args[0] === "create-keychain") await writeFile(args.at(-1), "opaque fixture keychain");
    if (args[0] === "delete-keychain") await unlink(args.at(-1));
    return "";
  };
  try { await callback({ snapshot, directory, original, signing, security, mask: value => { masked = value; }, get: () => ({ currentDefault, currentList, masked }) }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("isolates lookup in a fresh chain and restores default/list without storing its password", async () => fixture(async f => {
  await createFixtureKeychain(f.snapshot, f.directory, f);
  const state = JSON.parse(await readFile(f.snapshot, "utf8"));
  assert.deepEqual(f.get().currentList, [state.keychain]); assert.equal(f.get().currentDefault, state.keychain);
  assert.ok(f.get().masked.length >= 32); assert.ok(!(await readFile(f.snapshot, "utf8")).includes(f.get().masked));
  await restoreFixtureKeychain(f.snapshot, f.directory, f);
  assert.equal(f.get().currentDefault, f.original); assert.deepEqual(f.get().currentList, [f.original, f.signing]);
  assert.equal(existsSync(state.keychain), false); assert.equal(existsSync(f.snapshot), false);
}));

test("restores the old settings when setup fails after creating the chain", async () => fixture(async f => {
  await assert.rejects(createFixtureKeychain(f.snapshot, f.directory, f), /Could not prepare/);
  assert.equal(f.get().currentDefault, f.original); assert.deepEqual(f.get().currentList, [f.original, f.signing]);
  assert.equal(existsSync(f.snapshot), false);
}, "default-keychain"));

test("keeps recovery metadata when restoration fails and permits a later cleanup retry", async () => fixture(async f => {
  await createFixtureKeychain(f.snapshot, f.directory, f);
  await assert.rejects(restoreFixtureKeychain(f.snapshot, f.directory, { security: async () => { throw new Error("Temporary OS failure"); } }));
  assert.equal(existsSync(f.snapshot), true);
  await restoreFixtureKeychain(f.snapshot, f.directory, f);
  assert.equal(f.get().currentDefault, f.original); assert.deepEqual(f.get().currentList, [f.original, f.signing]);
}));

test("refuses a snapshot outside the task temporary directory before any system change", async () => fixture(async f => {
  let called = false;
  await assert.rejects(createFixtureKeychain(join(f.directory, "..", "aevoren-signed-fixture-keychain-other.json"), f.directory, { security: async () => { called = true; return ""; } }), /RUNNER_TEMP/);
  assert.equal(called, false);
}));

for (const [smokeStatus, restoreStatus, expectedStatus] of [[0, 0, 0], [7, 0, 7], [0, 1, 1]]) {
  test(`workflow cleanup runs after smoke status ${smokeStatus}, restore status ${restoreStatus}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "aevoren-keychain-shell-"));
    try {
      const workflow = parse(await readFile(new URL("../.github/workflows/release-macos.yml", import.meta.url), "utf8"));
      const step = workflow.jobs["publish-macos"].steps.find(item => item.name === "Validate library and Skills in the signed macOS app");
      const bin = join(directory, "bin"), calls = join(directory, "calls.txt"), script = join(directory, "smoke.sh");
      await mkdir(bin); await mkdir(join(directory, "dist/mac-arm64/Aevoren Bot.app/Contents/MacOS"), { recursive: true });
      await writeFile(join(directory, "dist/mac-arm64/Aevoren Bot.app/Contents/MacOS/Aevoren Bot"), "fixture");
      await writeFile(script, step.run);
      await writeFile(join(bin, "node"), '#!/bin/bash\nprintf "%s\\n" "$2" >> "$FIXTURE_CALLS"\nif [[ "$2" == restore ]]; then exit "$FIXTURE_RESTORE_STATUS"; fi\n', { mode: 0o700 });
      await writeFile(join(bin, "pnpm"), '#!/bin/bash\nexit "$FIXTURE_SMOKE_STATUS"\n', { mode: 0o700 });
      let resultStatus = 0;
      try {
        await execFile("/bin/bash", ["-e", "-o", "pipefail", script], { cwd: directory, env: {
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, RUNNER_TEMP: directory, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1",
          FIXTURE_CALLS: calls, FIXTURE_SMOKE_STATUS: String(smokeStatus), FIXTURE_RESTORE_STATUS: String(restoreStatus),
        } });
      } catch (error) { resultStatus = error.code; }
      assert.equal(resultStatus, expectedStatus);
      assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), ["create", "restore"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
