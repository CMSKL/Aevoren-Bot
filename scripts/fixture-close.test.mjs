import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { closeTestApplication } from "../tests/smoke/test-cleanup.ts";

async function child() {
  const fixtureProcess = spawn(globalThis.process.execPath, ["-e", "process.stdout.write('fixture-ready\\n');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  await once(fixtureProcess.stdout, "data");
  return fixtureProcess;
}

async function stop(ownedProcess) {
  if (ownedProcess.exitCode !== null || ownedProcess.signalCode !== null) return;
  const ended = once(ownedProcess, "exit"); ownedProcess.kill("SIGKILL"); await ended;
}

function alive(pid) {
  try { return globalThis.process.kill(pid, 0); } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function assertForcedExit(exit) {
  if (globalThis.process.platform === "win32") {
    assert.equal(exit[0], 1); assert.equal(exit[1], null);
  } else assert.equal(exit[1], "SIGKILL");
}

test("a stalled Electron-shaped fixture closes its inherited pipes and owned descendant while preserving a sibling", async () => {
  const source = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});process.stdout.write(JSON.stringify({pid:child.pid})+'\\n');setInterval(()=>{},1000);`;
  // Playwright starts Electron in an isolated process group on POSIX.
  const owned = spawn(globalThis.process.execPath, ["-e", source], { detached: globalThis.process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const ready = once(owned.stdout, "data");
  const sibling = await child();
  const descendantPid = JSON.parse((await ready)[0].toString()).pid;
  let pipesClosed = false;
  owned.once("close", () => { pipesClosed = true; });
  const started = performance.now();
  try {
    await closeTestApplication({ process: () => owned, close: () => new Promise(() => {}) });
    assert.equal(pipesClosed, true, "the owned exit and inherited stdio must finish before teardown returns");
    const deadline = performance.now() + 1_000;
    while (alive(descendantPid) && performance.now() < deadline) await delay(10);
    assert.equal(alive(descendantPid), false, "the descendant must not hold Playwright's transport open");
    assert.ok(performance.now() - started < 5_000, "owned tree teardown must remain bounded");
    assert.equal(sibling.exitCode, null); assert.equal(sibling.signalCode, null);
    assert.equal(alive(sibling.pid), true);
  } finally {
    if (alive(descendantPid)) globalThis.process.kill(descendantPid, "SIGKILL");
    await stop(owned); await stop(sibling);
  }
});

test("waits for delayed graceful fixture exit without killing its sibling", async () => {
  const owned = await child(), sibling = await child();
  const ended = once(owned, "exit");
  try {
    await closeTestApplication({ process: () => owned, close: async () => {
      await delay(1_250); owned.kill("SIGTERM"); await ended;
    } });
    assert.equal((await ended)[1], "SIGTERM");
    assert.equal(sibling.exitCode, null); assert.equal(sibling.signalCode, null);
    assert.equal(globalThis.process.kill(sibling.pid, 0), true);
  } finally { await stop(owned); await stop(sibling); }
});

test("a stalled close terminates only its owned fixture and returns within the teardown allowance", async () => {
  const owned = await child(), sibling = await child();
  const ended = once(owned, "exit");
  const started = performance.now();
  try {
    await closeTestApplication({ process: () => owned, close: () => new Promise(() => {}) });
    assertForcedExit(await ended);
    assert.ok(performance.now() - started < 5_000, "bounded close must leave time for temporary-directory cleanup");
    assert.equal(sibling.exitCode, null); assert.equal(sibling.signalCode, null);
    assert.equal(globalThis.process.kill(sibling.pid, 0), true);
  } finally { await stop(owned); await stop(sibling); }
});

test("a close transport failure still releases its exact fixture process", async () => {
  const owned = await child(); const ended = once(owned, "exit");
  try {
    await closeTestApplication({ process: () => owned, close: async () => { throw new Error("fixture close transport failed"); } });
    assertForcedExit(await ended);
  } finally { await stop(owned); }
});
