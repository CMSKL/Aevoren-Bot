import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "./finalize-notarized-macos-release.mjs";

const network = 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." UserInfo={NSErrorFailingURLStringKey=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup}\nCloudKit\'s response is inconsistent with expections: (null)\nThe validate action failed! Error 68.\n';

// These are real child-process exits through the same structured spawn runner.
// No signed artifact or successful Apple notarization is simulated.
async function fixture(plan, callback) {
  const directory = await mkdtemp(join(tmpdir(), "aevoren-stapler-command-"));
  const childPath = join(directory, "command.mjs"), planPath = join(directory, "plan.json"), tracePath = join(directory, "trace.jsonl");
  await writeFile(planPath, JSON.stringify(plan)); await writeFile(tracePath, "");
  await writeFile(childPath, `import {readFileSync,appendFileSync} from 'node:fs';
const [planPath,tracePath,command,...args]=process.argv.slice(2);
const trace=readFileSync(tracePath,'utf8').trim();const count=trace?trace.split('\\n').length:0;
const plan=JSON.parse(readFileSync(planPath,'utf8'));const result=plan[Math.min(count,plan.length-1)];
appendFileSync(tracePath,JSON.stringify({command,args})+'\\n');
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status);
`);
  const execute = (command, args, options) => spawnSync(process.execPath, [childPath, planPath, tracePath, command, ...args], options);
  const calls = async () => (await readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  try { await callback({ directory, childPath, planPath, tracePath, execute, calls }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

for (const action of ["staple", "validate"]) {
  test(`retries a genuine ${action} command exit only for observed CloudKit connection loss`, async () => fixture([
    { status: 68, stderr: network }, { status: 0 },
  ], async f => {
    const delays = [], logs = [], args = ["stapler", action, join(f.directory, "artifact with spaces.dmg")];
    await run("xcrun", args, { execute: f.execute, delay: ms => delays.push(ms), log: value => logs.push(value) });
    assert.deepEqual(await f.calls(), [{ command: "xcrun", args }, { command: "xcrun", args }]);
    assert.deepEqual(delays, [2_000]); assert.match(logs[0], /attempt 2\/4/);
  }));
}

test("stops after four network failures and preserves the final actual command exit status", async () => fixture([
  { status: 68, stdout: network },
], async f => {
  const delays = [];
  await assert.rejects(run("xcrun", ["stapler", "validate", "artifact.dmg"], {
    execute: f.execute, delay: ms => delays.push(ms), log: () => undefined,
  }), error => error.exitCode === 68 && /exit 68/.test(error.message) && error.message.includes("-1005"));
  assert.equal((await f.calls()).length, 4); assert.deepEqual(delays, [2_000, 4_000, 6_000]);
}));

for (const [label, result] of [
  ["ticket failure without a network error", { status: 68, stderr: "Could not validate ticket. The validate action failed! Error 68." }],
  ["different stapler status", { status: 65, stderr: network }],
  ["different URL error", { status: 68, stderr: network.replace("-1005", "-1001") }],
  ["invalid signature together with a network error", { status: 68, stderr: `${network}The code signature is invalid.\n` }],
  ["invalid ticket together with a network error", { status: 68, stderr: `${network}Ticket validation failed: digest mismatch.\n` }],
  ["rejected notarization together with a network error", { status: 68, stderr: `${network}Notarization rejected.\n` }],
  ["failed integrity together with a network error", { status: 68, stderr: `${network}Integrity check failed.\n` }],
  ["missing notarization together with a network error", { status: 68, stderr: `${network}The path has not been previously notarized.\n` }],
  ["revoked ticket together with a network error", { status: 68, stderr: `${network}The ticket has been revoked by the ticketing service.\n` }],
]) {
  test(`fails immediately on ${label}`, async () => fixture([result], async f => {
    await assert.rejects(run("xcrun", ["stapler", "validate", "artifact.dmg"], { execute: f.execute,
      delay: () => assert.fail("Permanent errors must not back off"), log: () => assert.fail("Permanent errors must not retry") }),
    error => error.exitCode === result.status);
    assert.equal((await f.calls()).length, 1);
  }));
}

for (const [command, args] of [["xcrun", ["notarytool", "submit", "artifact.dmg"]], ["spctl", ["--assess", "artifact.dmg"]]]) {
  test(`never retries ${command} ${args[0]}`, async () => fixture([{ status: 68, stderr: network }], async f => {
    await assert.rejects(run(command, args, { execute: f.execute, delay: () => assert.fail("Only stapler can retry") }), { exitCode: 68 });
    assert.equal((await f.calls()).length, 1);
  }));
}

test("does not retry a real spawn failure", async () => fixture([{ status: 0 }], async f => {
  let calls = 0;
  await assert.rejects(run("xcrun", ["stapler", "validate", "artifact.dmg"], {
    execute: (_command, _args, options) => { calls++; return spawnSync(join(f.directory, "does-not-exist", "command"), [], options); },
    delay: () => assert.fail("Spawn errors must not retry"),
  }), error => error.exitCode === 1 && error.message.includes("ENOENT"));
  assert.equal(calls, 1);
}));

test("does not retry a real command timeout", async () => {
  let calls = 0;
  await assert.rejects(run("xcrun", ["stapler", "validate", "artifact.dmg"], {
    execute: (_command, _args, options) => { calls++; return spawnSync(process.execPath, ["-e", "setInterval(()=>{},1000)"], { ...options, timeout: 50 }); },
    delay: () => assert.fail("A killed command must not retry"),
  }), error => error.exitCode === 1 && error.message.includes("ETIMEDOUT"));
  assert.equal(calls, 1);
});

test("a permanent failure following a network retry stops immediately with its own exit status", async () => fixture([
  { status: 68, stderr: network }, { status: 65, stderr: "Ticket validation failed: invalid signature." },
], async f => {
  const delays = [];
  await assert.rejects(run("xcrun", ["stapler", "validate", "artifact.dmg"], {
    execute: f.execute, delay: ms => delays.push(ms), log: () => undefined,
  }), { exitCode: 65 });
  assert.equal((await f.calls()).length, 2); assert.deepEqual(delays, [2_000]);
}));

test("the release CLI preserves network failure status without refreshing any updater assets", { timeout: 25_000 }, async () => fixture([
  { status: 0 }, { status: 68, stderr: network },
], async f => {
  const version = "0.0.0-beta.1", artifact = join(f.directory, `Aevoren-Bot-${version}-arm64.dmg`), manifest = join(f.directory, "beta-mac.yml"), blockmap = `${artifact}.blockmap`;
  await writeFile(artifact, "controlled unsigned fixture bytes"); await writeFile(manifest, "unchanged manifest\n"); await writeFile(blockmap, "unchanged blockmap\n");
  const preload = join(f.directory, "structured-runner.mjs");
  await writeFile(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const execute=cp.spawnSync;cp.spawnSync=(command,args,options)=>{
if(command!=='xcrun')throw new Error('Unexpected release command');
return execute(process.execPath,[${JSON.stringify(f.childPath)},${JSON.stringify(f.planPath)},${JSON.stringify(f.tracePath)},command,...args],options);
};syncBuiltinESMExports();`);
  const script = resolve(fileURLToPath(new URL("./finalize-notarized-macos-release.mjs", import.meta.url)));
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script, f.directory, version, "arm64"], { encoding: "utf8", timeout: 22_000 });
  assert.equal(result.status, 68); assert.equal(result.error, undefined); assert.match(result.stderr, /exit 68/);
  const calls = await f.calls(); assert.deepEqual(calls.map(call => call.args[1]), ["staple", "validate", "validate", "validate", "validate"]);
  assert.equal(await readFile(manifest, "utf8"), "unchanged manifest\n");
  assert.equal(await readFile(blockmap, "utf8"), "unchanged blockmap\n");
  assert.equal(await readFile(artifact, "utf8"), "controlled unsigned fixture bytes");
}));
