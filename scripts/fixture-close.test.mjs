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
    assert.equal((await ended)[1], "SIGKILL");
    assert.ok(performance.now() - started < 5_000, "bounded close must leave time for temporary-directory cleanup");
    assert.equal(sibling.exitCode, null); assert.equal(sibling.signalCode, null);
    assert.equal(globalThis.process.kill(sibling.pid, 0), true);
  } finally { await stop(owned); await stop(sibling); }
});

test("a close transport failure still releases its exact fixture process", async () => {
  const owned = await child(); const ended = once(owned, "exit");
  try {
    await closeTestApplication({ process: () => owned, close: async () => { throw new Error("fixture close transport failed"); } });
    assert.equal((await ended)[1], "SIGKILL");
  } finally { await stop(owned); }
});
