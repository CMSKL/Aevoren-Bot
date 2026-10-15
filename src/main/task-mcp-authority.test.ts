import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { TaskExecutorSelection } from "@shared/task-session-contracts";
import { AppRepository } from "./database";
import { McpService } from "./mcp-service";
import { registerTaskMcpAuthority } from "./task-mcp-authority";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  let calls = 0, hold = false, changedSchema = false, release: (() => void) | undefined;
  const transports = new Map<string, StreamableHTTPServerTransport>(), remotes: McpServer[] = [];
  const http: Server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const id = request.headers["mcp-session-id"], existing = typeof id === "string" ? transports.get(id) : null;
      if (existing) { void existing.handleRequest(request, response, body); return; }
      if (body?.method !== "initialize") { response.writeHead(404).end(); return; }
      const remote = new McpServer({ name: "task-read-only-fixture", version: "1" }); remotes.push(remote);
      for (const name of ["lookup", "other"]) remote.registerTool(name, { inputSchema: { query: z.string(), ...(changedSchema ? { changed: z.boolean().optional() } : {}) }, annotations: { readOnlyHint: true } }, async ({ query }) => {
        calls++; if (hold) await new Promise<void>(resolve => { release = resolve; });
        return { content: [{ type: "text", text: `CONTROLLED:${query}` }] };
      });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: id => { transports.set(id, transport); } });
      void remote.connect(transport).then(() => transport.handleRequest(request, response, body));
    });
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { release?.(); await Promise.allSettled(remotes.map(remote => remote.close())); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture bind failed");
  const repository = new AppRepository(":memory:"), owner = repository.createBot(); cleanup.push(async () => repository.close());
  const service = new McpService(repository, { isAvailable: () => true, encrypt: text => Buffer.from(text).toString("base64"), decrypt: text => Buffer.from(text, "base64").toString() }, "test");
  cleanup.push(() => service.dispose()); registerTaskMcpAuthority(repository, service);
  const config = { transport: "streamable-http" as const, url: `http://127.0.0.1:${address.port}/mcp`, headers: {} };
  const saved = await service.save({ name: "fixture", config });
  const probe = await service.probe(saved.id);
  const reviewed = await service.save({ id: saved.id, expectedVersion: probe.version, name: "fixture", config, trustedReadOnlyTools: ["lookup", "other"] });
  const enabled = await service.setEnabled(saved.id, reviewed.version, true);
  const selection: TaskExecutorSelection = { executorBotId: owner.bot.id, memories: [], history: [], workspaces: [], mcp: [{ serverId: saved.id, expectedVersion: enabled.version, toolNames: ["lookup"] }], resourceRefs: [], mediaRefs: [], productOperations: [], network: false, clipboard: false };
  function runtime(selected = selection) {
    const task = repository.tasks.create({ parentSessionId: owner.session.id, expectedScopeVersion: repository.tasks.scopeVersion(owner.session.id), clientNonce: randomUUID(), title: "Controlled task", selections: [selected] });
    const nonce = randomUUID(); repository.prepareMessage({ sessionId: task.session.id, clientNonce: nonce, text: "Read the selected fixture" });
    const entry = repository.getUserMessage(nonce);
    return repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: owner.bot.id, profileVersion: 1, sessionId: task.session.id, generation: entry.generation, inputSeq: entry.seq, blocks: [], digest: "task-mcp" });
  }
  return { repository, service, enabled, runtime, selection, config, calls: () => calls, changeSchema: (value: boolean) => { changedSchema = value; }, hold: () => { hold = true; }, release: () => { hold = false; release?.(); }, tool: { kind: "mcp-call" as const, serverId: saved.id, toolName: "lookup", arguments: { query: "original" }, readOnly: true as const } };
}

describe("TASK MCP explicit host authority", () => {
  it("uses only the selected read-only tool through a fresh real scoped transport", async () => {
    const f = await fixture(), run = f.runtime();
    expect(f.service.availableTools()).toHaveLength(2);
    expect(f.service.availableTaskTools(run.id).map(tool => tool.name)).toEqual(["lookup"]);
    expect(JSON.parse((await f.service.runTask(f.tool, new AbortController().signal, run.id)).content).content).toEqual([{ type: "text", text: "CONTROLLED:original" }]);
    await expect(f.service.runTask({ ...f.tool, toolName: "other" }, new AbortController().signal, run.id)).rejects.toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
    const empty = f.runtime({ ...f.selection, mcp: [] });
    expect(f.service.availableTaskTools(empty.id)).toEqual([]);
    await expect(f.service.runTask(f.tool, new AbortController().signal, empty.id)).rejects.toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
    expect(f.calls()).toBe(1);
  });
  it("retires the original task after a changed remote schema even if the old schema returns", async () => {
    const f = await fixture(), run = f.runtime(); f.changeSchema(true);
    await expect(f.service.runTask(f.tool, new AbortController().signal, run.id)).rejects.toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
    f.changeSchema(false);
    expect(() => f.service.availableTaskTools(run.id)).toThrowError(expect.objectContaining({ code: "APPROVAL_SCOPE_INVALID" }));
    await expect(f.service.runTask(f.tool, new AbortController().signal, run.id)).rejects.toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
    expect(f.calls()).toBe(0);
  });
  it("discards a late result and permanently retires the old task after disable/re-enable", async () => {
    const f = await fixture(), run = f.runtime(); f.hold();
    const pending = f.service.runTask(f.tool, new AbortController().signal, run.id); const outcome = pending.catch(error => error);
    await expect.poll(f.calls).toBe(1);
    const disabled = await f.service.setEnabled(f.enabled.id, f.enabled.version, false);
    f.release();
    expect(await outcome).toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
    await f.service.setEnabled(disabled.id, disabled.version, true);
    expect(() => f.service.availableTaskTools(run.id)).toThrowError(expect.objectContaining({ code: "APPROVAL_SCOPE_INVALID" }));
    await expect(f.service.runTask(f.tool, new AbortController().signal, run.id)).rejects.toMatchObject({ code: "APPROVAL_SCOPE_INVALID" });
    expect(f.calls()).toBe(1);
  });
});
