import { createServer, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionWorkerClient } from "./execution-worker-client";
import { ENV_HTTP_BODY_MAX_BYTES } from "@shared/environment-contracts";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const token = "a".repeat(64), environmentId = "fixture-environment";
async function server(handler: RequestListener) {
  const value = createServer(handler); servers.push(value);
  await new Promise<void>(resolve => value.listen(0, "127.0.0.1", resolve));
  const address = value.address(); if (!address || typeof address === "string") throw new Error("Fixture failed");
  return new ExecutionWorkerClient(address.port, token, environmentId);
}

describe("execution Worker transport over actual HTTP", () => {
  it("sends the credential only in the Authorization header and checks environment identity", async () => {
    let observed = "";
    const client = await server((request, response) => {
      observed = request.headers.authorization ?? "";
      expect(request.url).not.toContain(token);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ protocolVersion: 1, workerVersion: "1.0.0", environmentId, bootId: "boot", capabilities: ["execution"] }));
    });
    expect(await client.health()).toMatchObject({ environmentId });
    expect(observed).toBe(`Bearer ${token}`);
  });

  it("does not follow a redirect to a different server with the credential", async () => {
    let leaked = false;
    const destination = createServer((_request, response) => { leaked = true; response.end("{}"); }); servers.push(destination);
    await new Promise<void>(resolve => destination.listen(0, "127.0.0.1", resolve));
    const address = destination.address(); if (!address || typeof address === "string") throw new Error("Fixture failed");
    const client = await server((_request, response) => { response.writeHead(302, { location: `http://127.0.0.1:${address.port}/v1/health` }); response.end(); });
    await expect(client.health()).rejects.toMatchObject({ code: "WORKER_CONNECTION_FAILED" });
    expect(leaked).toBe(false);
  });

  it("rejects another environment or unsupported protocol instead of reporting healthy", async () => {
    const client = await server((_request, response) => { response.end(JSON.stringify({ protocolVersion: 2, workerVersion: "1.0.0", environmentId: "another", bootId: "boot", capabilities: [] })); });
    await expect(client.health()).rejects.toMatchObject({ code: "WORKER_IDENTITY_INVALID" });
  });

  it("decodes fragmented real SSE events without treating a path as bytes", async () => {
    const client = await server((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('event: log\ndata: {"seq":1,"text":"真实');
      response.write('输出"}\n\n');
      response.end('event: end\ndata: {"state":"completed","exitCode":0}\n\n');
    });
    const events: unknown[] = [];
    await client.events("/v1/executions/id/events", (event, value) => events.push({ event, value }), new AbortController().signal);
    expect(events).toEqual([{ event: "log", value: { seq: 1, text: "真实输出" } }, { event: "end", value: { state: "completed", exitCode: 0 } }]);
  });

  it("bounds oversized responses and propagates current cancellation", async () => {
    const client = await server((_request, response) => response.end(JSON.stringify({ output: "x".repeat(ENV_HTTP_BODY_MAX_BYTES) })));
    await expect(client.request("/v1/executions/id")).rejects.toMatchObject({ code: "WORKER_RESPONSE_TOO_LARGE" });
    const controller = new AbortController(); controller.abort();
    await expect(client.request("/v1/health", "GET", undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("preserves only a validated expired-log cursor without exposing arbitrary error details", async () => {
    const client = await server((_request, response) => {
      response.statusCode = 410;
      response.end(JSON.stringify({ error: { code: "WORKER_LOG_CURSOR_EXPIRED", firstSeq: 42, token: "private-control-token", path: "/private/state" } }));
    });
    try { await client.request("/v1/executions/id/logs?after=1"); throw new Error("Expected an expired cursor"); }
    catch (error) {
      expect(error).toMatchObject({ code: "WORKER_LOG_CURSOR_EXPIRED", status: 410, firstSeq: 42 });
      expect(JSON.stringify(error)).not.toMatch(/private-control-token|private\/state/);
    }
  });
});
