import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { BROWSER_PROTOCOL_VERSION, BROWSER_WORKER_VERSION } from "@shared/browser-contracts";
import { ENV_HTTP_BODY_MAX_BYTES } from "@shared/environment-contracts";
import {
  browserClickSchema, browserTypeSchema, browserKeySchema, browserScrollSchema, browserNavigateSchema, browserNewTabSchema,
  browserObserveSchema, browserReadSchema, browserPageMutationSchema, computerScreenshotSchema, computerClickSchema, computerTypeSchema, computerScrollSchema,
  browserWorkerAccessSchema, browserWorkerMutationAccessSchema,
} from "@shared/browser-schemas";
import type { BrowserWorker } from "./browser-worker";
import { BrowserWorkerError } from "./worker-error";
import { RfbDemonstrationParser } from "./rfb-demonstration-parser";

async function body(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers["content-length"] ?? 0) > ENV_HTTP_BODY_MAX_BYTES) throw new BrowserWorkerError("BROWSER_REQUEST_TOO_LARGE", 413);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
    if (size > ENV_HTTP_BODY_MAX_BYTES) throw new BrowserWorkerError("BROWSER_REQUEST_TOO_LARGE", 413);
    chunks.push(bytes);
  }
  try { return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new BrowserWorkerError("BROWSER_INVALID_REQUEST"); }
}

function respond(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

const uuid = z.string().uuid();
const pageRead = browserObserveSchema.omit({ sessionId: true, executorBotId: true }).extend(browserWorkerAccessSchema.shape).strict();
const contentRead = browserReadSchema.omit({ sessionId: true, executorBotId: true }).extend(browserWorkerAccessSchema.shape).strict();
const pageMutation = browserPageMutationSchema.omit({ sessionId: true, executorBotId: true, clientNonce: true }).extend(browserWorkerMutationAccessSchema.shape).strict();
const newTab = browserNewTabSchema.omit({ sessionId: true, executorBotId: true, clientNonce: true }).extend(browserWorkerMutationAccessSchema.shape).strict();
const navigate = browserNavigateSchema.omit({ sessionId: true, executorBotId: true, clientNonce: true }).extend(browserWorkerMutationAccessSchema.shape).strict();
const screenshot = computerScreenshotSchema.omit({ sessionId: true, executorBotId: true }).extend(browserWorkerAccessSchema.shape).strict();
const browserActions = {
  click: browserClickSchema.omit({ sessionId: true, executorBotId: true, clientNonce: true }).extend(browserWorkerMutationAccessSchema.shape).strict(),
  type: browserTypeSchema.omit({ sessionId: true, executorBotId: true, clientNonce: true }).extend(browserWorkerMutationAccessSchema.shape).strict(),
  key: browserKeySchema.omit({ sessionId: true, executorBotId: true, clientNonce: true }).extend(browserWorkerMutationAccessSchema.shape).strict(),
  scroll: browserScrollSchema.omit({ sessionId: true, executorBotId: true, clientNonce: true }).extend(browserWorkerMutationAccessSchema.shape).strict(),
};
const computerActions = {
  click: computerClickSchema.omit({ sessionId: true, executorBotId: true, clientNonce: true }).extend(browserWorkerMutationAccessSchema.shape).strict(),
  type: computerTypeSchema.omit({ sessionId: true, executorBotId: true, clientNonce: true }).extend(browserWorkerMutationAccessSchema.shape).strict(),
  key: browserActions.key,
  scroll: computerScrollSchema.omit({ sessionId: true, executorBotId: true, clientNonce: true }).extend(browserWorkerMutationAccessSchema.shape).strict(),
};

export function createBrowserServer(worker: BrowserWorker, token: string, vncPort = 5900) {
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new BrowserWorkerError("BROWSER_TOKEN_INVALID", 503);
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (request: IncomingMessage): boolean => {
    const value = Buffer.from(request.headers.authorization ?? "");
    return request.headers.origin === undefined && value.length === expected.length && timingSafeEqual(value, expected);
  };
  const server = createServer(async (request, response) => {
    if (!authorized(request)) { respond(response, { error: { code: "BROWSER_UNAUTHORIZED" } }, 401); return; }
    try {
      const url = new URL(request.url ?? "/", "http://companion.invalid"), parts = url.pathname.split("/").filter(Boolean);
      const method = request.method;
      if (method === "GET" && url.pathname === "/v1/health") {
        worker.assertHealthy();
        respond(response, { environmentId: worker.options.environmentId, browserSessionId: worker.options.browserSessionId, bootId: worker.bootId,
          protocolVersion: BROWSER_PROTOCOL_VERSION, workerVersion: BROWSER_WORKER_VERSION, capabilities: ["browser", "desktop", "images", "downloads", "control", "vnc", "demonstration"], control: worker.control() }); return;
      }
      if (method === "GET" && url.pathname === "/v1/demonstrations/status") { respond(response, worker.demonstrations.status()); return; }
      if (method === "POST" && ["/v1/demonstrations/start", "/v1/demonstrations/stop", "/v1/demonstrations/discard"].includes(url.pathname)) {
        const input = z.object({ actor: z.enum(["ai", "user"]), expectedEpoch: z.number().int().positive(), id: uuid }).strict().parse(await body(request));
        respond(response, worker.demonstration({ ...input, action: parts[2] as "start" | "stop" | "discard" })); return;
      }
      if (method === "GET" && url.pathname === "/v1/computer/control") { respond(response, worker.control()); return; }
      if (method === "POST" && parts[0] === "v1" && parts[1] === "operations" && parts.length === 4 && parts[3] === "cancel") { respond(response, await worker.cancelOperation(uuid.parse(parts[2]))); return; }
      if (method === "GET" && ["/v1/browser/pages", "/v1/browser/pages/access"].includes(url.pathname)) {
        const access = browserWorkerAccessSchema.parse({ actor: url.searchParams.get("actor"), expectedEpoch: Number(url.searchParams.get("expectedEpoch")) });
        respond(response, await worker.perform("pages", access)); return;
      }
      if (method === "POST" && url.pathname === "/v1/browser/pages") { respond(response, await worker.perform("create", newTab.parse(await body(request)), true)); return; }
      if (parts[0] === "v1" && parts[1] === "browser" && parts[2] === "pages" && parts.length === 5 && method === "POST") {
        const pageId = uuid.parse(parts[3]), operation = parts[4]!;
        const raw = await body(request);
        const input = { ...(raw as object), pageId };
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BrowserWorkerError("BROWSER_INVALID_REQUEST");
        if ("pageId" in raw && (raw as { pageId: unknown }).pageId !== pageId) throw new BrowserWorkerError("BROWSER_SCOPE_INVALID", 409);
        if (operation === "observe" || operation === "read") { respond(response, await worker.perform("observe", (operation === "read" ? contentRead : pageRead).parse(input))); return; }
        if (operation === "navigate") { respond(response, await worker.perform("navigate", navigate.parse(input), true)); return; }
        if (operation === "close") { respond(response, await worker.perform("close-page", pageMutation.parse(input), true)); return; }
        if (operation === "screenshot") { respond(response, await worker.perform("frame", screenshot.parse(input))); return; }
        if (Object.hasOwn(browserActions, operation)) {
          const schema = browserActions[operation as keyof typeof browserActions];
          respond(response, await worker.perform("action", { ...schema.parse(input), method: operation }, true)); return;
        }
      }
      if (parts[0] === "v1" && parts[1] === "computer" && parts.length === 3 && method === "POST") {
        const operation = parts[2]!;
        if (operation === "takeover" || operation === "return") { respond(response, await worker.changeControl(operation === "takeover" ? "user" : "ai", browserWorkerMutationAccessSchema.parse(await body(request)))); return; }
        if (operation === "screenshot") { respond(response, await worker.perform("desktop-frame", screenshot.parse(await body(request)))); return; }
        if (Object.hasOwn(computerActions, operation)) {
          const schema = computerActions[operation as keyof typeof computerActions];
          respond(response, await worker.perform("computer-action", { ...schema.parse(await body(request)), method: operation }, true)); return;
        }
      }
      if ((method === "GET" && url.pathname === "/v1/browser/downloads") || (method === "POST" && url.pathname === "/v1/browser/downloads/list")) {
        const input = browserWorkerAccessSchema.parse(method === "POST" ? await body(request) : { actor: url.searchParams.get("actor"), expectedEpoch: Number(url.searchParams.get("expectedEpoch")) });
        respond(response, worker.listDownloads(input)); return;
      }
      if (parts[0] === "v1" && parts[1] === "browser" && parts[2] === "downloads" && parts[4] === "content" && parts.length === 5 && method === "POST") {
        const input = browserWorkerAccessSchema.extend({ id: uuid }).parse({ ...await body(request) as object, id: uuid.parse(parts[3]) });
        respond(response, await worker.download(input)); return;
      }
      throw new BrowserWorkerError("BROWSER_ROUTE_NOT_FOUND", 404);
    } catch (error) {
      respond(response, { error: { code: error instanceof BrowserWorkerError ? error.code : error instanceof z.ZodError ? "BROWSER_INVALID_REQUEST" : "BROWSER_INTERNAL_ERROR" } },
        error instanceof BrowserWorkerError ? error.status : error instanceof z.ZodError ? 400 : 500);
    }
  });
  server.requestTimeout = 20_000; server.headersTimeout = 10_000;
  const viewers = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
  worker.setViewerCloser(() => { for (const viewer of viewers.clients) viewer.terminate(); });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://companion.invalid"), epoch = Number(url.searchParams.get("epoch"));
    if (!authorized(request) || url.pathname !== "/v1/computer/vnc" || !Number.isSafeInteger(epoch) || !worker.canConnectViewer(epoch) || viewers.clients.size > 0) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
    }
    viewers.handleUpgrade(request, socket, head, viewer => {
      const target = connect(vncPort, "127.0.0.1");
      worker.viewerConnected();
      const parser = new RfbDemonstrationParser(event => worker.acceptedViewerInput(epoch, event), () => worker.viewerInputUnsupported());
      target.on("connect", () => { if (!worker.canConnectViewer(epoch)) { target.destroy(); viewer.terminate(); } });
      target.on("data", bytes => {
        if (!worker.canConnectViewer(epoch) || viewer.readyState !== WebSocket.OPEN || viewer.bufferedAmount > 1_048_576) { viewer.terminate(); return; }
        viewer.send(bytes, { binary: true });
      });
      target.on("error", () => viewer.terminate());
      target.on("close", () => viewer.terminate());
      target.on("drain", () => viewer.resume());
      viewer.on("message", (bytes, binary) => {
        if (!binary || !worker.canConnectViewer(epoch)) { viewer.terminate(); return; }
        const payload = Array.isArray(bytes) ? Buffer.concat(bytes) : bytes instanceof ArrayBuffer ? Buffer.from(bytes) : bytes;
        const writable = target.write(payload);
        parser.accepted(payload);
        if (!writable) viewer.pause();
      });
      viewer.once("close", () => { target.destroy(); worker.viewerDisconnected(); });
      viewer.on("error", () => target.destroy());
    });
  });
  return server;
}
