import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OpenAiCompatibleProvider, structuredModelToolDefinitions, type ModelEvent, type ModelRunContext } from "../model";
import { AevorenBotError } from "../errors";
import { CodexCliProvider } from "./codex-cli";
import { ClaudeCliProvider } from "./claude-cli";
import { ClaudeToolBridge } from "./claude-tool-bridge";
import * as cliUtils from "./cli-utils";

const directories: string[] = [];
const collect = async (events: AsyncIterable<ModelEvent>) => { const values: ModelEvent[] = []; for await (const event of events) values.push(event); return values; };
function directory() { const path = mkdtempSync(join(tmpdir(), "aevoren-task-wire-")); directories.push(path); return path; }
function lease(): { context: ModelRunContext; revoke(): void } {
  let allowed = true;
  return { context: { executorBotId: randomUUID(), executionKey: randomUUID(), assertAuthority: () => { if (!allowed) throw new AevorenBotError("APPROVAL_SCOPE_INVALID"); } }, revoke: () => { allowed = false; } };
}
function install(root: string, body: string) {
  const script = join(root, "fixture.mjs"); writeFileSync(script, `#!${process.execPath}\n${body}`);
  if (process.platform !== "win32") { chmodSync(script, 0o700); return script; }
  const wrapper = join(root, "fixture.cmd"); writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`); return wrapper;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

describe("TASK provider authority at the actual outgoing wire", () => {
  it("declares only scoped product discovery/execution for TASK while preserving MAIN legacy tools", () => {
    const context = { ...lease().context, projectTools: true };
    expect(structuredModelToolDefinitions({ ...context, taskScoped: true }).map(tool => tool.name)).toEqual(["product_catalog", "product_describe", "product_execute"]);
    expect(structuredModelToolDefinitions(context).map(tool => tool.name)).toContain("bot_create");
    expect(structuredModelToolDefinitions(context).map(tool => tool.name)).toContain("room_create");
    expect(structuredModelToolDefinitions(context).map(tool => tool.name)).toContain("project_list_bots");
  });

  it("blocks API fetch when a media lease revokes the task during request serialization", async () => {
    const guard = lease(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const provider = new OpenAiCompatibleProvider("https://fixture.invalid/v1", "fixture", "CONTROLLED");
    const stream = provider.run([{ role: "tool", tool_call_id: "read", content: "metadata", modelText: { text: "PRIVATE_TASK_TEXT", isAuthorized: () => { guard.revoke(); return true; } } }], new AbortController().signal, guard.context);
    await expect(collect(stream)).rejects.toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["initialize", "thread/start"])("does not send the next Codex request after authority is revoked while awaiting %s", async gate => {
    const root = directory(), guard = lease();
    const script = install(root, `import {createInterface} from 'node:readline';import {appendFileSync,writeFileSync,existsSync} from 'node:fs';\nconst send=x=>process.stdout.write(JSON.stringify(x)+'\\n');\ncreateInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync('wire.jsonl',line+'\\n');if(!m.method)return;const reply=()=>send({jsonrpc:'2.0',id:m.id,result:m.method==='thread/start'?{thread:{id:'thread'}}:{}});if(m.method===${JSON.stringify(gate)}){writeFileSync('gate','ready');const t=setInterval(()=>{if(existsSync('release')){clearInterval(t);reply()}},10)}else if(m.id!==undefined)reply()});`);
    vi.spyOn(cliUtils, "resolveCliPath").mockReturnValue(script);
    vi.spyOn(cliUtils, "isolatedCodexEnvironment").mockImplementation(runtimeHome => ({ PATH: process.env.PATH, CODEX_HOME: runtimeHome }));
    const outcome = collect(new CodexCliProvider(script, "fixture-model", root).run([{ role: "user", content: "PRIVATE_TASK_PROMPT" }], new AbortController().signal, guard.context)).catch(error => error);
    await vi.waitFor(() => expect(existsSync(join(root, "gate"))).toBe(true), { timeout: 5_000 });
    guard.revoke(); writeFileSync(join(root, "release"), "release");
    expect(await outcome).toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
    const messages = readFileSync(join(root, "wire.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(messages.some(message => message.method === (gate === "initialize" ? "thread/start" : "turn/start"))).toBe(false);
    expect(messages.some(message => message.method === "exec")).toBe(false);
  });

  it.each([false, true])("blocks a Codex dynamic result at serialization, including the same call ID (repeated=%s)", async repeated => {
    const root = directory(), guard = lease(); guard.context.networkTools = true;
    const script = install(root, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let attempt=0;const call=()=>{attempt++;send({jsonrpc:'2.0',id:'provider-call-'+attempt,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'same-host-call',namespace:null,tool:'time_now',arguments:{}}})};
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync('wire.jsonl',line+'\\n');if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{}});else if(m.method==='thread/start')send({jsonrpc:'2.0',id:m.id,result:{thread:{id:'thread'}}});else if(m.method==='turn/start'){send({jsonrpc:'2.0',id:m.id,result:{turn:{id:'turn'}}});call()}else if(String(m.id).startsWith('provider-call-')){if(${repeated}&&attempt===1)call();else send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}})}});`);
    vi.spyOn(cliUtils, "resolveCliPath").mockReturnValue(script);
    vi.spyOn(cliUtils, "isolatedCodexEnvironment").mockImplementation(runtimeHome => ({ PATH: process.env.PATH, CODEX_HOME: runtimeHome }));
    const events: ModelEvent[] = []; let responses = 0;
    const outcome = (async () => {
      for await (const event of new CodexCliProvider(script, "fixture-model", root).run([{ role: "user", content: "Use the selected tool" }], new AbortController().signal, guard.context)) {
        events.push(event);
        if ("respond" in event) {
          responses++;
          if (repeated && responses === 1) await event.respond?.("FIRST_ALLOWED_RESULT");
          else await event.respond?.("metadata", undefined, { text: "PRIVATE_REVOKED_RESULT", isAuthorized: () => { guard.revoke(); return true; } }).catch(() => undefined);
        }
      }
    })().catch(error => error);
    expect(await outcome).toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
    const wire = readFileSync(join(root, "wire.jsonl"), "utf8");
    expect(wire).not.toContain("PRIVATE_REVOKED_RESULT");
    const results = wire.trim().split("\n").map(line => JSON.parse(line)).filter(message => message.method === undefined && String(message.id).startsWith("provider-call-"));
    expect(results).toHaveLength(repeated ? 1 : 0); expect(events.some(event => event.type === "completed")).toBe(false);
  });

  it.each([false, true])("does not settle the revoked Codex iterator until its owned child finishes EOF teardown (release pre-exists=%s)", async preReleased => {
    const root = directory(), guard = lease(), controller = new AbortController(); let settled = false;
    let stage = "spawn";
    if (preReleased) {
      writeFileSync(join(root, "release"), "release");
      const assertAuthority = guard.context.assertAuthority!;
      guard.context.assertAuthority = () => { if (existsSync(join(root, "gate"))) guard.revoke(); assertAuthority(); };
    }
    // A pre-existing release needs an immediate check; publish readiness after watching.
    const script = install(root, `import {createInterface} from 'node:readline';import {existsSync,watch,writeFileSync} from 'node:fs';
writeFileSync('fixture-boot','ready');const input=createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
input.on('line',line=>{writeFileSync('fixture-wire',line);const m=JSON.parse(line);if(m.method==='initialize'){let answered=false;const finish=()=>{if(!answered&&existsSync('release')){answered=true;watcher.close();send({jsonrpc:'2.0',id:m.id,result:{}})}};const watcher=watch('.',finish);writeFileSync('gate','ready');finish()}});
input.on('close',()=>{writeFileSync('stdin-closed','ready');const finish=()=>{if(existsSync('exit-release')){writeFileSync('owned-exited','yes');process.exit(0)}};const watcher=watch('.',finish);finish()});`);
    vi.spyOn(cliUtils, "resolveCliPath").mockReturnValue(script);
    vi.spyOn(cliUtils, "isolatedCodexEnvironment").mockImplementation(runtimeHome => ({ PATH: process.env.PATH, CODEX_HOME: runtimeHome }));
    const outcome = collect(new CodexCliProvider(script, "fixture-model", root).run([{ role: "user", content: "Guarded prompt" }], controller.signal, guard.context)).then(value => { settled = true; return value; }, error => { settled = true; return error; });
    try {
      stage = "await-initialize-gate";
      await vi.waitFor(() => expect(existsSync(join(root, "gate"))).toBe(true));
      if (!preReleased) { guard.revoke(); writeFileSync(join(root, "release"), "release"); }
      stage = "await-stdin-eof";
      await vi.waitFor(() => expect(existsSync(join(root, "stdin-closed"))).toBe(true));
      expect(settled).toBe(false);
      writeFileSync(join(root, "exit-release"), "release");
      stage = "await-owned-exit";
      expect(await outcome).toMatchObject({ code: "APPROVAL_SCOPE_INVALID" }); expect(existsSync(join(root, "owned-exited"))).toBe(true);
    } catch (error) {
      console.error("[controlled-codex-eof]", { stage, settled, fixtureBoot: existsSync(join(root, "fixture-boot")), fixtureWire: existsSync(join(root, "fixture-wire")), gate: existsSync(join(root, "gate")), release: existsSync(join(root, "release")), stdinClosed: existsSync(join(root, "stdin-closed")), ownedExited: existsSync(join(root, "owned-exited")) });
      throw error;
    } finally { writeFileSync(join(root, "exit-release"), "release"); controller.abort(); await outcome; }
  });

  it("does not spawn or feed Claude after a revoked asynchronous bridge startup", async () => {
    const root = directory(), guard = lease(); guard.context.networkTools = true;
    const script = install(root, `import {writeFileSync} from 'node:fs';writeFileSync('spawned','yes');for await(const chunk of process.stdin)writeFileSync('wire',chunk);`);
    vi.spyOn(cliUtils, "resolveCliPath").mockReturnValue(script);
    let release!: () => void, entered = false;
    vi.spyOn(ClaudeToolBridge.prototype, "start").mockImplementation(async () => { entered = true; await new Promise<void>(resolve => { release = resolve; }); });
    const outcome = collect(new ClaudeCliProvider(script, "fixture", root, true).run([{ role: "user", content: "PRIVATE_TASK_PROMPT" }], new AbortController().signal, guard.context)).catch(error => error);
    await vi.waitFor(() => expect(entered).toBe(true)); guard.revoke(); release();
    expect(await outcome).toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
    expect(existsSync(join(root, "spawned"))).toBe(false); expect(existsSync(join(root, "wire"))).toBe(false);
  });

  it.each([false, true])("blocks Claude bridge private result delivery after revocation (cached=%s)", async cached => {
    const root = directory(), guard = lease(), received: ModelEvent[] = []; guard.context.networkTools = true;
    const bridge = new ClaudeToolBridge(guard.context, event => { received.push(event); if (cached && "respond" in event) void event.respond?.("PRIVATE_TASK_RESULT"); }, new AbortController().signal);
    const client = new Client({ name: "task-authority-fixture", version: "1" });
    try {
      await bridge.start(root);
      const config = JSON.parse(readFileSync(bridge.configPath, "utf8")).mcpServers.aevoren_host;
      const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }); await client.connect(transport);
      const headers = { ...config.headers, "content-type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": transport.sessionId!, "mcp-protocol-version": "2025-11-25" };
      const request = () => fetch(config.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "same-private-call", method: "tools/call", params: { name: "time_now", arguments: {} } }) }).then(response => response.text());
      if (cached) { expect(await request()).toContain("PRIVATE_TASK_RESULT"); expect(received).toHaveLength(1); guard.revoke(); await expect(request()).rejects.toThrow(); }
      else {
        const pending = request().catch(error => error); await vi.waitFor(() => expect(received).toHaveLength(1)); guard.revoke();
        const event = received[0]!; if (!("respond" in event)) throw new Error("Missing controlled tool response"); await event.respond?.("PRIVATE_TASK_RESULT");
        expect(await pending).toBeInstanceOf(Error);
      }
      expect(received).toHaveLength(1);
    } finally { await client.close(); await bridge.close(); }
  });
});
