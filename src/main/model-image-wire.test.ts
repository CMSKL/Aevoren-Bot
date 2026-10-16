import { createHash, randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider, type ChatMessage, type ModelEvent, type ModelRunContext } from "./model";
import { ClaudeToolBridge } from "./providers/claude-tool-bridge";
import { CodexCliProvider } from "./providers/codex-cli";
import * as cliUtils from "./providers/cli-utils";
import type { ModelImageAttachment } from "./model-image";
import { AppRepository } from "./database";
import { ProviderService } from "./provider-service";

const pixels = readFileSync(join(process.cwd(), "resources/icon.png"));
function image(isAuthorized = () => true): ModelImageAttachment {
  return { reference: { id: randomUUID(), name: "real-project-icon.png", mimeType: "image/png", size: pixels.length, sha256: createHash("sha256").update(pixels).digest("hex") }, dataBase64: pixels.toString("base64"), isAuthorized };
}
const context = (): ModelRunContext => ({ executorBotId: randomUUID(), executionKey: randomUUID(), networkTools: true });
async function consume(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> { const result: ModelEvent[] = []; for await (const event of events) result.push(event); return result; }
function verifyPixels(dataBase64: string): void {
  const actual = Buffer.from(dataBase64, "base64");
  expect(actual.equals(pixels)).toBe(true);
  expect(createHash("sha256").update(actual).digest("hex")).toBe(createHash("sha256").update(pixels).digest("hex"));
}

async function withApi(callback: (baseUrl: string, requests: Record<string, unknown>[]) => Promise<void>): Promise<void> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "controlled-local-wire" });
    response.end('data: {"choices":[{"index":0,"delta":{"content":"wire fixture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture bind failed");
  try { await callback(`http://127.0.0.1:${address.port}/v1`, requests); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

function toolMessages(images: ModelImageAttachment[]): ChatMessage[] {
  return [{ role: "user", content: "Inspect the captured frames." }, { role: "assistant", content: "", tool_calls: images.map((_, index) => ({ id: `image-${index}`, type: "function", function: { name: "product_execute", arguments: '{"operation":"computer.screenshot","input":{}}' } })) },
    ...images.map((attachment, index): ChatMessage => ({ role: "tool", tool_call_id: `image-${index}`, content: JSON.stringify({ ok: true, media: attachment.reference }), images: [attachment] }))];
}

function config(bridge: ClaudeToolBridge): { url: string; headers: Record<string, string> } { return JSON.parse(readFileSync(bridge.configPath, "utf8")).mcpServers.aevoren_host; }
function isolateFixtureCli(): void {
  // Keep real user credentials/config out of the fixture subprocess; the JSON-RPC transport remains real.
  vi.spyOn(cliUtils, "isolatedCodexEnvironment").mockImplementation(runtimeHome => ({ PATH: process.env.PATH, LANG: "C.UTF-8", CODEX_HOME: runtimeHome }));
  vi.spyOn(cliUtils, "readCodexConfiguredSelection").mockReturnValue(null);
}

function createCodexFixture(directory: string, version = "0.162.1"): string {
  const script = join(directory, "controlled-codex.mjs");
  writeFileSync(script, `#!/usr/bin/env node\nimport {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('codex-cli ${version}');process.exit(0)}
const send=(value,done)=>process.stdout.write(JSON.stringify(value)+'\\n',done);
createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.method==='initialize')send({jsonrpc:'2.0',id:message.id,result:{}});else if(message.method==='account/read')send({jsonrpc:'2.0',id:message.id,result:{account:{type:'chatgpt',email:'fixture@invalid.test'},requiresOpenaiAuth:true}});else if(message.method==='model/list')send({jsonrpc:'2.0',id:message.id,result:{data:[{id:'fixture-model',displayName:'Fixture',isDefault:true}],nextCursor:null}});else if(message.method==='thread/start')send({jsonrpc:'2.0',id:message.id,result:{thread:{id:'image-thread'}}});else if(message.method==='turn/start'){send({jsonrpc:'2.0',id:message.id,result:{turn:{id:'image-turn'}}});send({jsonrpc:'2.0',id:'native-image-request',method:'item/tool/call',params:{threadId:'image-thread',turnId:'image-turn',callId:'captured-frame',namespace:null,tool:'time_now',arguments:{timezone:'UTC'}}})}else if(message.id==='native-image-request'){writeFileSync('received.json',JSON.stringify(message.result));send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'image-thread',turn:{id:'image-turn',status:'completed'}}})}else if(message.method==='turn/interrupt')send({jsonrpc:'2.0',id:message.id,result:{}})});\n`, "utf8");
  if (process.platform !== "win32") { chmodSync(script, 0o700); return script; }
  const wrapper = join(directory, "controlled-codex.cmd");
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "%~dp0controlled-codex.mjs" %*\r\n`); return wrapper;
}

// Frozen output-item fields from Codex 0.162.1 generate-json-schema, independently of this adapter.
const codexResponseSchema = z.object({ success: z.boolean(), contentItems: z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputText"), text: z.string() }).strict(),
  z.object({ type: z.literal("inputImage"), imageUrl: z.string() }).strict(),
  z.object({ type: z.literal("inputAudio"), audioUrl: z.string() }).strict(),
])) }).strict();
afterEach(() => vi.restoreAllMocks());

describe("real local model image wire", () => {
  it("closes the persistent controlled JSON-RPC process on EOF before removing its working directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-image-codex-exit-"));
    const path = createCodexFixture(directory);
    const child = spawn(path, ["app-server", "--stdio"], { cwd: directory, env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"], ...cliUtils.cliShellOptions(path) });
    const closed = once(child, "close"); child.stdout.resume(); child.stderr.resume();
    try {
      child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn/start" })}\n${JSON.stringify({ jsonrpc: "2.0", id: "native-image-request", result: { success: true, contentItems: [] } })}\n`);
      expect(await closed).toEqual([0, null]);
      expect(JSON.parse(readFileSync(join(directory, "received.json"), "utf8"))).toEqual({ success: true, contentItems: [] });
    } finally { if (child.exitCode === null) child.kill("SIGTERM"); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    expect(existsSync(directory)).toBe(false);
  });

  it("keeps all six parallel API tool replies textual and then uploads real pixels in one user image message", async () => {
    await withApi(async (url, requests) => {
      const attachments = Array.from({ length: 6 }, () => image());
      const provider = new OpenAiCompatibleProvider(url, "controlled-model", "local-fixture-key");
      expect(await consume(provider.run(toolMessages(attachments), new AbortController().signal))).toContainEqual({ type: "completed", finishReason: "stop" });
      expect(requests).toHaveLength(1);
      const messages = requests[0]!.messages as { role: string; content: string | { type: string; image_url?: { url: string } }[]; images?: unknown }[];
      expect(messages.map(message => message.role)).toEqual(["user", "assistant", ...Array.from({ length: 6 }, () => "tool"), "user"]);
      for (const reply of messages.filter(message => message.role === "tool")) { expect(typeof reply.content).toBe("string"); expect(reply.images).toBeUndefined(); }
      const blocks = messages.at(-1)!.content as { type: string; image_url?: { url: string } }[];
      const pictures = blocks.filter(block => block.type === "image_url");
      expect(pictures).toHaveLength(6);
      for (const picture of pictures) { expect(picture.image_url!.url).toMatch(/^data:image\/png;base64,/); verifyPixels(picture.image_url!.url.split(",")[1]!); }
    });
  });

  it("sends no API pixels and includes the revocation notice after takeover", async () => {
    await withApi(async (url, requests) => {
      let owned = true; const captured = image(() => owned); owned = false;
      await consume(new OpenAiCompatibleProvider(url, "controlled-model", "fixture-key").run(toolMessages([captured]), new AbortController().signal));
      const wire = JSON.stringify(requests[0]);
      expect(wire).not.toContain(captured.dataBase64); expect(wire).not.toContain("image_url"); expect(wire).toContain("图片已撤销");
    });
  });

  it("rechecks media text and pixels on later API rounds without serializing private attachment fields", async () => {
    await withApi(async (url, requests) => {
      let allowed = true;
      const captured = image(() => allowed); captured.origin = "media";
      const messages = toolMessages([captured]);
      const result = messages.at(-1)!;
      if (result.role !== "tool") throw new Error("Expected tool fixture");
      result.modelText = { text: "PRIVATE_PINNED_MEDIA_TEXT", isAuthorized: () => allowed };
      const provider = new OpenAiCompatibleProvider(url, "controlled-model", "fixture-key");
      await consume(provider.run(messages, new AbortController().signal));
      expect(JSON.stringify(requests[0])).toContain("PRIVATE_PINNED_MEDIA_TEXT");
      const blocks = (requests[0]!.messages as { content: unknown }[]).at(-1)!.content as { type: string; image_url?: { url: string } }[];
      verifyPixels(blocks.find(block => block.type === "image_url")!.image_url!.url.split(",")[1]!);
      allowed = false;
      await consume(provider.run(messages, new AbortController().signal));
      const revoked = JSON.stringify(requests[1]);
      expect(revoked).not.toContain("PRIVATE_PINNED_MEDIA_TEXT");
      expect(revoked).not.toContain(captured.dataBase64);
      expect(revoked).toContain("媒体授权已失效");
      for (const request of requests) {
        expect(JSON.stringify(request)).not.toContain("isAuthorized");
        expect(JSON.stringify(request)).not.toContain("modelText");
        expect(JSON.stringify(request)).not.toContain('"origin":"media"');
      }
      expect(result.content).not.toContain("PRIVATE_PINNED_MEDIA_TEXT");
    });
  });

  it("rejects an invalid image before any HTTP request reaches the provider", async () => {
    await withApi(async (url, requests) => {
      const invalid = image(); invalid.reference.sha256 = "0".repeat(64);
      await expect(consume(new OpenAiCompatibleProvider(url, "controlled-model", "fixture-key").run(toolMessages([invalid]), new AbortController().signal))).rejects.toBeTruthy();
      expect(requests).toHaveLength(0);
    });
  });

  it("transfers real image blocks through the MCP SDK and removes pixels if takeover occurs before respond", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-image-mcp-")), pending: Extract<ModelEvent, { type: "network-tool" }>[] = [];
    const bridge = new ClaudeToolBridge(context(), event => { if (event.type === "network-tool") pending.push(event); }, new AbortController().signal);
    const client = new Client({ name: "controlled-image-wire", version: "1" });
    try {
      await bridge.start(directory); const configuration = config(bridge);
      await client.connect(new StreamableHTTPClientTransport(new URL(configuration.url), { requestInit: { headers: configuration.headers } }));
      const first = client.callTool({ name: "time_now", arguments: { timezone: "UTC" } });
      await expect.poll(() => pending.length).toBe(1);
      await pending[0]!.respond?.('{"ok":true}', [image()]);
      const firstResult = await first;
      const pictures = (firstResult.content as { type: string; data?: string; mimeType?: string }[]).filter(block => block.type === "image");
      expect(pictures).toHaveLength(1); expect(pictures[0]!.mimeType).toBe("image/png"); verifyPixels(pictures[0]!.data!);
      let owner = true; const captured = image(() => owner);
      const second = client.callTool({ name: "time_now", arguments: { timezone: "Asia/Shanghai" } });
      await expect.poll(() => pending.length).toBe(2); owner = false;
      await pending[1]!.respond?.('{"ok":true}', [captured]);
      const denied = JSON.stringify(await second);
      expect(denied).not.toContain(captured.dataBase64); expect(denied).toContain("授权已失效");
    } finally { await client.close(); await bridge.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["browser", "media"] as const)("rechecks the %s lease when a completed MCP request is redelivered with the same id", async origin => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-image-mcp-retry-"));
    let owned = true, dispatched = 0; const captured = image(() => owned);
    captured.origin = origin;
    const modelText = origin === "media" ? { text: "PRIVATE_MCP_MEDIA_TEXT", isAuthorized: () => owned } : undefined;
    const bridge = new ClaudeToolBridge(context(), event => { if (event.type === "network-tool") { dispatched++; void event.respond?.('{"ok":true}', [captured], modelText); } }, new AbortController().signal);
    const client = new Client({ name: "controlled-image-redelivery", version: "1" });
    try {
      await bridge.start(directory); const configuration = config(bridge);
      const transport = new StreamableHTTPClientTransport(new URL(configuration.url), { requestInit: { headers: configuration.headers } });
      await client.connect(transport);
      const call = async () => (await fetch(configuration.url, { method: "POST", headers: { ...configuration.headers, "content-type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": transport.sessionId!, "mcp-protocol-version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: "same-frame-delivery", method: "tools/call", params: { name: "time_now", arguments: { timezone: "UTC" } } }) })).json() as Promise<{ result: { content: { type: string; data?: string; text?: string }[] } }>;
      const first = await call();
      expect(first.result.content.some(block => block.type === "image")).toBe(true);
      if (origin === "media") expect(JSON.stringify(first)).toContain("PRIVATE_MCP_MEDIA_TEXT");
      owned = false;
      const retry = await call(); expect(dispatched).toBe(1);
      expect(JSON.stringify(retry).includes(captured.dataBase64)).toBe(false);
      expect(JSON.stringify(retry)).toContain("授权已失效");
      expect(JSON.stringify(retry)).not.toContain("PRIVATE_MCP_MEDIA_TEXT");
    } finally { await client.close(); await bridge.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([true, false])("checks media text and actual pixels at Codex native dispatch: authorized=%s", async allowed => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-media-codex-wire-"));
    isolateFixtureCli();
    try {
      const captured = image(() => allowed); captured.origin = "media";
      for await (const event of new CodexCliProvider(createCodexFixture(directory), "fixture-model", directory).run([{ role: "user", content: "Read media" }], new AbortController().signal, context())) {
        if (event.type === "network-tool") await event.respond?.('{"ok":true}', [captured], { text: "PRIVATE_CODEX_MEDIA_TEXT", isAuthorized: () => allowed });
      }
      const reply = codexResponseSchema.parse(JSON.parse(readFileSync(join(directory, "received.json"), "utf8")));
      expect(JSON.stringify(reply).includes("PRIVATE_CODEX_MEDIA_TEXT")).toBe(allowed);
      const pictures = reply.contentItems.filter(item => item.type === "inputImage");
      expect(pictures).toHaveLength(allowed ? 1 : 0);
      if (pictures[0]?.type === "inputImage") verifyPixels(pictures[0].imageUrl.split(",")[1]!);
      expect(JSON.stringify(reply)).not.toContain("isAuthorized");
      if (!allowed) expect(JSON.stringify(reply)).toContain("媒体授权已失效");
    } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("sends the published Codex inputImage/imageUrl shape through an actual fixture JSON-RPC process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-image-codex-"));
    isolateFixtureCli();
    try {
      const provider = new CodexCliProvider(createCodexFixture(directory), "fixture-model", directory);
      const captured = image();
      for await (const event of provider.run([{ role: "user", content: "Inspect screenshot" }], new AbortController().signal, context())) {
        if (event.type === "network-tool") await event.respond?.('{"ok":true}', [captured]);
      }
      const reply = codexResponseSchema.parse(JSON.parse(readFileSync(join(directory, "received.json"), "utf8")));
      expect(reply.success).toBe(true);
      const pictures = reply.contentItems.filter(item => item.type === "inputImage");
      expect(pictures).toHaveLength(1); expect(pictures[0]!.imageUrl).toMatch(/^data:image\/png;base64,/); verifyPixels(pictures[0]!.imageUrl.split(",")[1]!);
    } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it("does not send stale Codex pixels after capture and before native respond", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-image-codex-stale-")); isolateFixtureCli();
    try {
      let owned = true; const captured = image(() => owned);
      for await (const event of new CodexCliProvider(createCodexFixture(directory), "fixture-model", directory).run([{ role: "user", content: "Inspect screenshot" }], new AbortController().signal, context())) {
        if (event.type === "network-tool") { owned = false; await event.respond?.('{"ok":true}', [captured]); }
      }
      const reply = codexResponseSchema.parse(JSON.parse(readFileSync(join(directory, "received.json"), "utf8")));
      expect(reply.contentItems.some(item => item.type === "inputImage")).toBe(false);
      expect(JSON.stringify(reply)).toContain("授权已失效");
    } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  it.each(["0.162.0", "0.162.1"])("reports image transport from the inspected Codex %s fixture version", async version => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-image-capability-")); isolateFixtureCli();
    const repository = new AppRepository(join(directory, "repository.sqlite"));
    const service = new ProviderService(repository, { isAvailable: () => true, encrypt: value => value, decrypt: value => value }, directory, false);
    try {
      const current = repository.getProviderInstanceConfig("codex.default");
      repository.updateProviderInstanceConfig(current.id, current.version, { ...current.config, cliPath: createCodexFixture(directory, version) });
      await service.reload(); await service.refresh("codex.default");
      expect(service.getCapabilities({ providerInstanceId: "codex.default", modelId: "fixture-model" }).toolImageInput).toBe(version === "0.162.1");
      expect(service.getCapabilities({ providerInstanceId: "claude.default", modelId: "fixture-model" }).toolImageInput).not.toBe(true);
    } finally { await service.dispose(); repository.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });

  const generatedProtocol = "/tmp/aevoren-codex-protocol-20261013/DynamicToolCallResponse.json";
  it.skipIf(!existsSync(generatedProtocol))("matches the locally generated Codex 0.162.1 protocol artifact", () => {
    const schema = JSON.parse(readFileSync(generatedProtocol, "utf8"));
    const imageVariant = schema.definitions.DynamicToolCallOutputContentItem.oneOf.find((item: { properties: { type: { enum: string[] } } }) => item.properties.type.enum.includes("inputImage"));
    expect(imageVariant.required.sort()).toEqual(["imageUrl", "type"]);
    expect(imageVariant.properties.imageUrl.type).toBe("string");
    expect(schema.required.sort()).toEqual(["contentItems", "success"]);
  });
});
