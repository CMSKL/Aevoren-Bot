import { once } from "node:events";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { chromium } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { createPrivateCdpBridge, OwnedChromium } from "./chromium-control";

async function rejected(endpoint: string, origin?: string): Promise<boolean> {
  const socket = new WebSocket(endpoint, origin ? { origin } : {});
  return new Promise(resolve => {
    socket.once("error", () => resolve(true));
    socket.once("open", () => { socket.terminate(); resolve(false); });
  });
}

describe("private Chrome pipe bridge with actual HTTP and WebSocket sockets", () => {
  it("rejects website Origins, unknown capabilities and HTTP control while forwarding only one SDK connection", async () => {
    const input = new PassThrough(), output = new PassThrough(), bridge = await createPrivateCdpBridge(input, output);
    let socket: WebSocket | undefined;
    try {
      const url = new URL(bridge.endpoint), http = `http://${url.host}`;
      expect(await rejected(bridge.endpoint, "https://untrusted.example")).toBe(true);
      expect(await rejected(`ws://${url.host}/unknown`)).toBe(true);
      for (const path of ["/json/list", "/json/new", "/json/close/known-target", url.pathname]) {
        expect((await fetch(`${http}${path}`)).status).toBe(403);
      }
      socket = new WebSocket(bridge.endpoint); await once(socket, "open");
      expect(await rejected(bridge.endpoint)).toBe(true);
      const command = once(input, "data"); socket.send('{"id":1,"method":"Browser.getVersion"}');
      expect((await command)[0].toString()).toBe('{"id":1,"method":"Browser.getVersion"}\0');
      const reply = once(socket, "message"); output.write('{"id":1,"result":{"product":"controlled"}}\0');
      expect((await reply)[0].toString()).toBe('{"id":1,"result":{"product":"controlled"}}');
    } finally { socket?.terminate(); await bridge.close(); input.destroy(); output.destroy(); }
  });

  it("rejects a NUL-injected command before any bytes reach the Chrome pipe", async () => {
    const input = new PassThrough(), output = new PassThrough(), bridge = await createPrivateCdpBridge(input, output);
    const received: Buffer[] = []; input.on("data", value => received.push(value));
    const socket = new WebSocket(bridge.endpoint);
    try {
      await once(socket, "open"); const closed = once(socket, "close"); socket.send('{"id":1}\0{"id":2}');
      expect((await closed)[0]).toBe(1003); expect(received).toHaveLength(0);
    } finally { socket.terminate(); await bridge.close(); input.destroy(); output.destroy(); }
  });

  it("closes the SDK socket on oversized Chrome output and joins repeated close calls", async () => {
    const input = new PassThrough(), output = new PassThrough(), bridge = await createPrivateCdpBridge(input, output);
    const socket = new WebSocket(bridge.endpoint);
    try {
      await once(socket, "open"); const closed = once(socket, "close"); output.write(Buffer.alloc(16_777_217, 0x20));
      await closed;
      const first = bridge.close(); expect(bridge.close()).toBe(first); await first;
    } finally { socket.terminate(); await bridge.close(); input.destroy(); output.destroy(); }
  });

  it("rejects failed owned-child startup without returning a control endpoint", async () => {
    const path = vi.spyOn(chromium, "executablePath").mockReturnValue("/aevoren-controlled-missing-chrome");
    const browser = new OwnedChromium("/aevoren-controlled-profile", undefined, () => undefined);
    try { await expect(browser.start()).rejects.toMatchObject({ code: "BROWSER_ENGINE_START_FAILED" }); }
    finally { await browser.close(); path.mockRestore(); }
  });
});
