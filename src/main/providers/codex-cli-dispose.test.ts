import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectCodexCli } from "./codex-cli";
import * as cliUtils from "./cli-utils";

const execute = promisify(execFile);
type OwnedPids = { server: number; descendant: number | null };
function live(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function installFixture(directory: string, forced: boolean): string {
  const script = join(directory, "persistent-codex.mjs");
  writeFileSync(script, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
if(process.argv.includes('--version')){console.log('codex-cli 0.162.1');process.exit(0)}
const forced=${forced};
const descendant=forced&&process.platform==='win32'?spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),stdio:'inherit'}):null;
writeFileSync('owned-pids.json',JSON.stringify({server:process.pid,descendant:descendant?.pid??null}));
if(forced)setInterval(()=>{},1000);
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const input=createInterface({input:process.stdin});
input.on('line',line=>{const message=JSON.parse(line);if(message.method==='initialize')send({jsonrpc:'2.0',id:message.id,result:{}});else if(message.method==='account/read')send({jsonrpc:'2.0',id:message.id,result:{account:{type:'chatgpt',email:'fixture@invalid.test'},requiresOpenaiAuth:true}});else if(message.method==='model/list')send({jsonrpc:'2.0',id:message.id,result:{data:[{id:'fixture-model',displayName:'Fixture',isDefault:true}],nextCursor:null}})});
input.once('close',()=>writeFileSync('received-eof.txt','EOF received by persistent server'));
`, "utf8");
  if (process.platform !== "win32") { chmodSync(script, 0o700); return script; }
  const wrapper = join(directory, "persistent-codex.cmd");
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "%~dp0persistent-codex.mjs" %*\r\n`);
  return wrapper;
}
afterEach(() => vi.restoreAllMocks());

describe("Codex RPC shutdown with real persistent fixture processes", () => {
  it.each([false, true])("releases the server, Windows wrapper tree and working directory (forced=%s)", async forced => {
    const root = mkdtempSync(join(tmpdir(), "aevoren-codex-dispose-"));
    const directory = join(root, "working directory"); mkdirSync(directory);
    const path = installFixture(root, forced);
    vi.spyOn(cliUtils, "isolatedCodexEnvironment").mockImplementation(runtimeHome => ({ PATH: process.env.PATH, CODEX_HOME: runtimeHome }));
    vi.spyOn(cliUtils, "readCodexConfiguredSelection").mockReturnValue(null);
    let owned: OwnedPids | undefined;
    try {
      const inspected = await inspectCodexCli(path, directory);
      expect(inspected.models.default).toBe("fixture-model");
      expect(readFileSync(join(directory, "received-eof.txt"), "utf8")).toContain("EOF received");
      owned = JSON.parse(readFileSync(join(directory, "owned-pids.json"), "utf8")) as OwnedPids;
      expect(live(owned.server)).toBe(false);
      if (forced && process.platform === "win32") {
        expect(owned.descendant).not.toBeNull();
        expect(live(owned.descendant!)).toBe(false);
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      expect(existsSync(directory)).toBe(false);
    } finally {
      // Only fixture-owned PIDs are eligible for emergency cleanup after a failed assertion.
      if (!owned && existsSync(join(directory, "owned-pids.json"))) owned = JSON.parse(readFileSync(join(directory, "owned-pids.json"), "utf8")) as OwnedPids;
      if (owned && live(owned.server)) {
        if (process.platform === "win32") await execute("taskkill", ["/PID", String(owned.server), "/T", "/F"], { timeout: 5_000, windowsHide: true }).catch(() => undefined);
        else process.kill(owned.server, "SIGKILL");
      }
      if (owned?.descendant && live(owned.descendant)) process.kill(owned.descendant, "SIGKILL");
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 15_000);
});
