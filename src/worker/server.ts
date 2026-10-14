import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { z } from "zod";
import { ENV_HTTP_BODY_MAX_BYTES, ENV_PROTOCOL_VERSION, ENV_WORKER_VERSION } from "@shared/environment-contracts";
import {
  workerExecutionRequestSchema, workerFileListSchema, workerFileReadSchema, workerFileWriteSchema,
  workerRegisterPortSchema,
} from "@shared/environment-schemas";
import type { ExecutionWorker } from "./execution-worker";
import { WorkerError } from "./worker-error";
import { PreviewProxy } from "./preview-proxy";
import { SKILL_SCRIPT_CAPABILITY } from "@shared/skill-execution-contracts";
import { workerSkillInstallSchema, workerSkillRunSchema } from "@shared/skill-execution-schemas";

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > ENV_HTTP_BODY_MAX_BYTES) throw new WorkerError("WORKER_REQUEST_TOO_LARGE", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > ENV_HTTP_BODY_MAX_BYTES) throw new WorkerError("WORKER_REQUEST_TOO_LARGE", 413);
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new WorkerError("WORKER_INVALID_REQUEST"); }
}

function respond(response: ServerResponse, result: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(result));
}

const uuid = z.string().uuid();
const cursor = z.coerce.number().int().min(0);

async function streamLogs(worker: ExecutionWorker, id: string, after: number, response: ServerResponse): Promise<void> {
  const firstSeq = worker.store.firstSeq(id);
  const reset = worker.store.get(id).truncated && after < firstSeq - 1;
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  response.flushHeaders();
  let seq = reset ? firstSeq - 1 : after;
  const write = async (event: string, value: unknown): Promise<void> => {
    if (!response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)) await Promise.race([once(response, "drain"), once(response, "close")]);
  };
  if (reset) await write("reset", { firstSeq, truncated: true });
  while (!response.destroyed) {
    let logs;
    try { logs = worker.store.logs(id, seq); }
    catch (error) {
      if (error instanceof WorkerError && error.code === "WORKER_LOG_CURSOR_EXPIRED") {
        const firstSeq = worker.store.firstSeq(id);
        await write("reset", { firstSeq, truncated: true });
        seq = firstSeq - 1;
        continue;
      }
      break;
    }
    for (const log of logs) {
      await write("log", log);
      seq = log.seq;
      if (response.destroyed) return;
    }
    const job = worker.store.get(id);
    if (job.state !== "running" && seq >= job.lastSeq) { await write("end", job); break; }
    if (seq < job.lastSeq) continue;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  response.end();
}

export function createWorkerServer(worker: ExecutionWorker, token: string): Server {
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new WorkerError("WORKER_TOKEN_INVALID", 503);
  const expected = Buffer.from(`Bearer ${token}`);
  const previews = new PreviewProxy(join(worker.options.stateDirectory, "previews.sqlite"), worker.options.environmentId, token, id => worker.previewTarget(id));
  worker.events.once("closing", () => previews.close());
  const server = createServer(async (request, response) => {
    if (previews.handles(request)) { await previews.http(request, response); return; }
    const authorization = Buffer.from(request.headers.authorization ?? "");
    if (authorization.length !== expected.length || !timingSafeEqual(expected, authorization)) { respond(response, { error: { code: "WORKER_UNAUTHORIZED" } }, 401); return; }
    try {
      const url = new URL(request.url ?? "/", "http://worker.invalid");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "v1") throw new WorkerError("WORKER_ROUTE_NOT_FOUND", 404);
      if (request.method === "GET" && url.pathname === "/v1/health") {
        respond(response, { environmentId: worker.options.environmentId, bootId: worker.bootId, protocolVersion: ENV_PROTOCOL_VERSION,
          workerVersion: ENV_WORKER_VERSION, capabilities: ["execution", "processes", "files", "ports", "sse", "uid-isolation", "preview", SKILL_SCRIPT_CAPABILITY] }); return;
      }
      if (url.pathname === "/v1/skill-packages" && request.method === "POST") {
        respond(response, await worker.installSkill(workerSkillInstallSchema.parse(await jsonBody(request)))); return;
      }
      if (url.pathname === "/v1/skill-runs" && request.method === "POST") {
        respond(response, await worker.runSkill(workerSkillRunSchema.parse(await jsonBody(request))), 202); return;
      }
      if (url.pathname === "/v1/previews" && request.method === "POST") { respond(response, await previews.open(await jsonBody(request))); return; }
      if (parts[1] === "previews" && parts.length === 3 && request.method === "GET") { respond(response, await previews.get(uuid.parse(parts[2]))); return; }
      if (parts[1] === "previews" && parts.length === 4 && parts[3] === "close" && request.method === "POST") { respond(response, previews.closeTicket(uuid.parse(parts[2]))); return; }
      if (parts[1] === "execution-sessions" && parts.length === 4 && parts[3] === "cancel" && request.method === "POST") {
        respond(response, await worker.cancelSession(uuid.parse(parts[2]))); return;
      }
      if (["executions", "processes"].includes(parts[1] ?? "")) {
        const background = parts[1] === "processes";
        if (parts.length === 2 && request.method === "POST") {
          const input = workerExecutionRequestSchema.parse(await jsonBody(request));
          if (input.kind !== (background ? "background" : "foreground")) throw new WorkerError("WORKER_INVALID_REQUEST");
          respond(response, await worker.start(input), 202); return;
        }
        if (parts.length === 2 && request.method === "GET") { respond(response, worker.store.list(background ? "background" : undefined)); return; }
        const id = uuid.parse(parts[2]);
        if (parts.length === 4 && ["cancel", "stop"].includes(parts[3]!) && request.method === "POST") {
          respond(response, await worker.cancel(id, background ? "background" : "foreground")); return;
        }
        const job = worker.store.get(id);
        if (background && job.kind !== "background") throw new WorkerError("WORKER_JOB_NOT_FOUND", 404);
        if (parts.length === 3 && request.method === "GET") { respond(response, job); return; }
        if (parts.length === 4 && parts[3] === "events" && request.method === "GET") {
          await streamLogs(worker, id, cursor.parse(url.searchParams.get("after") ?? url.searchParams.get("afterSeq") ?? 0), response); return;
        }
        if (parts.length === 4 && parts[3] === "logs" && request.method === "GET") {
          const after = cursor.parse(url.searchParams.get("afterSeq") ?? url.searchParams.get("after") ?? 0);
          const limit = z.coerce.number().int().min(1).max(500).parse(url.searchParams.get("limit") ?? 100);
          const maxBytes = z.coerce.number().int().min(1).max(262_144).parse(url.searchParams.get("maxBytes") ?? 262_144);
          const logs = worker.store.logs(id, after, limit);
          let size = 0;
          const bounded = logs.filter(log => { size += Buffer.byteLength(JSON.stringify(log)); return size <= maxBytes; });
          respond(response, { executionId: id, logs: bounded, firstSeq: worker.store.firstSeq(id), lastSeq: job.lastSeq,
            truncated: job.truncated || bounded.length < logs.length }); return;
        }
      }
      if (parts[1] === "files" && request.method === "GET" && parts.length === 2) {
        const input = workerFileListSchema.parse({ path: url.searchParams.get("path") ?? "." });
        respond(response, await worker.file({ action: "list", ...input })); return;
      }
      if (url.pathname === "/v1/files/content" && request.method === "GET") {
        const input = workerFileReadSchema.parse({ path: url.searchParams.get("path") });
        respond(response, await worker.file({ action: "read", ...input })); return;
      }
      if (url.pathname === "/v1/files/content" && request.method === "PUT") {
        const body = await jsonBody(request);
        const input = workerFileWriteSchema.parse({ ...(body as object), ...(url.searchParams.has("path") ? { path: url.searchParams.get("path") } : {}) });
        respond(response, await worker.file({ action: "write", ...input })); return;
      }
      if (url.pathname === "/v1/ports" && request.method === "GET") { respond(response, await worker.ports()); return; }
      if (url.pathname === "/v1/ports" && request.method === "POST") {
        const input = workerRegisterPortSchema.parse(await jsonBody(request));
        respond(response, await worker.registerPort({ ...input, label: input.label ?? "" })); return;
      }
      throw new WorkerError("WORKER_ROUTE_NOT_FOUND", 404);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const known = error instanceof WorkerError;
      const invalid = error instanceof z.ZodError;
      if (!known && !invalid) process.stderr.write(`Worker request failed: ${error && typeof error === "object" && "code" in error ? String(error.code) : "INTERNAL"}\n`);
      respond(response, { error: { code: known ? error.code : invalid ? "WORKER_INVALID_REQUEST" : "WORKER_INTERNAL_ERROR", ...(known ? error.details : {}) } }, known ? error.status : invalid ? 400 : 500);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on("upgrade", (request, socket, head) => {
    if (previews.handles(request)) { void previews.upgrade(request, socket as import("node:net").Socket, head); return; }
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  server.once("close", () => previews.close());
  return server;
}
