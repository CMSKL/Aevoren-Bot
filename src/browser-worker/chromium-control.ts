import { chromium } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Readable, Writable } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserWorkerError } from "./worker-error";

const MAX_CDP_MESSAGE = 16_777_216;

/** A single private SDK connection; website Origins and ordinary HTTP never reach Chrome. */
export async function createPrivateCdpBridge(input: Writable, output: Readable): Promise<{ endpoint: string; close(): Promise<void> }> {
  const capability = randomBytes(32).toString("hex");
  const server = createServer((_request, response) => { response.writeHead(403); response.end("Forbidden"); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CDP_MESSAGE });
  let client: WebSocket | null = null, pending = Buffer.alloc(0), closing = false, closePromise: Promise<void> | null = null;
  const stopClient = (): void => { client?.terminate(); client = null; };
  const onData = (chunk: Buffer): void => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_CDP_MESSAGE) { stopClient(); pending = Buffer.alloc(0); return; }
    let end: number;
    while ((end = pending.indexOf(0)) !== -1) {
      if (client?.readyState === WebSocket.OPEN) {
        if (client.bufferedAmount + end > MAX_CDP_MESSAGE) { stopClient(); pending = Buffer.alloc(0); return; }
        try { client.send(new TextDecoder("utf8", { fatal: true }).decode(pending.subarray(0, end))); }
        catch { stopClient(); pending = Buffer.alloc(0); return; }
      }
      pending = pending.subarray(end + 1);
    }
  };
  output.on("data", onData); output.on("end", stopClient); output.on("error", stopClient); input.on("error", stopClient);
  server.on("upgrade", (request, socket, head) => {
    if (closing || client || request.headers.origin !== undefined || request.url !== `/${capability}`) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, connection => {
      client = connection;
      connection.on("error", () => undefined);
      connection.on("message", (data, binary) => {
        const bytes = Buffer.from(data as Buffer);
        if (binary || bytes.includes(0)) { connection.close(1003); return; }
        try { JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)); }
        catch { connection.close(1003); return; }
        if (!input.write(Buffer.concat([bytes, Buffer.from([0])]))) {
          connection.pause(); input.once("drain", () => { if (connection.readyState === WebSocket.OPEN) connection.resume(); });
        }
      });
      connection.once("close", () => { if (client === connection) client = null; });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new BrowserWorkerError("BROWSER_ENGINE_START_FAILED", 503);
  return { endpoint: `ws://127.0.0.1:${address.port}/${capability}`, close() {
    if (closePromise) return closePromise;
    closing = true; stopClient();
    output.removeListener("data", onData); output.removeListener("end", stopClient);
    sockets.close(); server.closeAllConnections(); closePromise = new Promise<void>(resolve => server.close(() => resolve()));
    return closePromise;
  } };
}

export class OwnedChromium {
  private child: ChildProcess | null = null;
  private bridge: Awaited<ReturnType<typeof createPrivateCdpBridge>> | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  constructor(private readonly profileDirectory: string, private readonly resolverRule: string | undefined, private readonly onStopped: () => void) {}

  async start(): Promise<string> {
    const child = spawn(chromium.executablePath(), [
      `--user-data-dir=${this.profileDirectory}`, "--remote-debugging-pipe", "--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions",
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--password-store=basic", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
      "--window-size=1280,800", "--window-position=0,0", ...(this.resolverRule ? [`--host-resolver-rules=${this.resolverRule}`] : []), "about:blank",
    ], { env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", DISPLAY: ":99", HOME: process.env.HOME }, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    this.child = child; child.stderr?.resume();
    let failed = false;
    const stopped = (): void => { failed = true; void this.bridge?.close(); if (!this.closing) this.onStopped(); };
    child.once("error", stopped); child.once("exit", stopped);
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      this.bridge = await createPrivateCdpBridge(child.stdio[3] as Writable, child.stdio[4] as Readable);
      if (failed || child.exitCode !== null || child.signalCode !== null) throw new BrowserWorkerError("BROWSER_ENGINE_START_FAILED", 503);
      return this.bridge.endpoint;
    } catch {
      await this.close(); throw new BrowserWorkerError("BROWSER_ENGINE_START_FAILED", 503);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeOwned(); return this.closePromise;
  }

  private async closeOwned(): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const wait = (): Promise<void> => new Promise(resolve => {
        const timer = setTimeout(() => { child.removeListener("close", done); resolve(); }, 3_000);
        const done = (): void => { clearTimeout(timer); resolve(); }; child.once("close", done);
      });
      // The public Browser.close command can still be flushing profile data.
      await wait();
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await wait(); }
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await wait(); }
    }
    await this.bridge?.close();
  }
}
