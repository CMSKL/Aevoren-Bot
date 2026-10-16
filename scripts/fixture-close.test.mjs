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

test("an already closed application does not read its disposed process channel", async () => {
  let processReads = 0;
  await closeTestApplication({
    close: async () => {},
    process: () => { processReads++; throw new TypeError("Disposed Electron process channel"); },
  });
  assert.equal(processReads, 0);
});

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
  const phases = [];
  const observedAlive = pid => { try { return alive(pid); } catch { return null; } };
  const record = phase => { if (phases.length < 40) phases.push({ phase, elapsedMs: Math.round(performance.now() - started), ownedPid: owned.pid, descendantPid,
    ownedExitCode: owned.exitCode, ownedSignalCode: owned.signalCode, ownedKilled: owned.killed, pipesClosed,
    ownedAlive: observedAlive(owned.pid), descendantAlive: observedAlive(descendantPid), siblingAlive: observedAlive(sibling.pid),
    stdio: owned.stdio.map(stream => stream ? { destroyed: stream.destroyed } : null) }); };
  const onExit = () => record("owned-exit"), onClose = () => record("owned-close");
  owned.once("exit", onExit); owned.once("close", onClose);
  const commandMeasurements = [];
  const measureWindowsCommand = globalThis.process.platform === "win32" ? event => { if (commandMeasurements.length < 20) commandMeasurements.push({ ...event,
    ownedAlive: observedAlive(owned.pid), descendantAlive: observedAlive(descendantPid), siblingAlive: observedAlive(sibling.pid), pipesClosed }); } : undefined;
  let failed = false;
  record("close-request");
  try {
    await closeTestApplication({ process: () => owned, close: () => new Promise(() => {}) }, measureWindowsCommand);
    record("close-returned");
    assert.equal(pipesClosed, true, "the owned exit and inherited stdio must finish before teardown returns");
    const deadline = performance.now() + 1_000;
    while (alive(descendantPid) && performance.now() < deadline) await delay(10);
    assert.equal(alive(descendantPid), false, "the descendant must not hold Playwright's transport open");
    assert.ok(performance.now() - started < 5_000, "owned tree teardown must remain bounded");
    assert.equal(sibling.exitCode, null); assert.equal(sibling.signalCode, null);
    assert.equal(alive(sibling.pid), true);
    if (measureWindowsCommand) {
      const created = commandMeasurements.find(event => event.phase === "created"), settled = commandMeasurements.find(event => event.phase === "resolved");
      assert.ok(created && settled && settled.elapsedMs - created.elapsedMs < 1_500, "the unchanged taskkill command budget must remain 1500ms");
      assert.equal(commandMeasurements.some(event => event.phase === "original-1500ms-budget-elapsed"), false);
    }
  } catch (error) {
    failed = true;
    record("close-or-assertion-failed");
    globalThis.console.error("Controlled fixture tree close state:", JSON.stringify({ phases, error: { code: error.code ?? null, killed: error.killed ?? null, signal: error.signal ?? null } }));
    throw error;
  } finally {
    if (measureWindowsCommand) globalThis.console.error("Controlled Windows taskkill measurement:", JSON.stringify({ commandMeasurements }));
    record("cleanup-start");
    let cleanupTimer;
    const cleanup = Promise.allSettled([Promise.resolve().then(() => { if (alive(descendantPid)) globalThis.process.kill(descendantPid, "SIGKILL"); }), stop(owned), stop(sibling)]);
    const result = await Promise.race([cleanup, new Promise(resolve => { cleanupTimer = globalThis.setTimeout(() => resolve(null), 2_000); })]);
    globalThis.clearTimeout(cleanupTimer);
    record(result ? "cleanup-finished" : "cleanup-timed-out");
    for (const fixtureProcess of [owned, sibling]) { for (const stream of fixtureProcess.stdio) stream?.destroy(); fixtureProcess.unref(); }
    owned.removeListener("exit", onExit); owned.removeListener("close", onClose);
    if (!result || result.some(value => value.status === "rejected")) {
      globalThis.console.error("Controlled fixture cleanup did not complete:", JSON.stringify({ phases }));
      if (!failed) assert.fail("all owned fixture cleanup must finish within its 2s bound");
    }
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
