import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import type { DemonstrationCapture, DemonstrationSnapshot } from "@shared/demonstration-contracts";
import type { BrowserObservation, BrowserPage, BrowserWorkerControl, BrowserWorkerFrame, BrowserWorkerHealth, BrowserDownloadsPage } from "@shared/browser-contracts";
import { browserWorkerFrameSchema, browserWorkerHealthSchema, browserObservationSchema, browserWorkerDownloadSchema, browserDownloadsPageSchema } from "@shared/browser-schemas";

const execute = promisify(execFile), enabled = process.env.AEVOREN_BROWSER_DOCKER_TEST === "1";
const image = process.env.AEVOREN_BROWSER_TEST_IMAGE ?? "aevoren-browser-fixture:stage3";
async function docker(args: string[]): Promise<string> { return (await execute("docker", args, { maxBuffer: 2_097_152 })).stdout.trim(); }
type Fixture = { name: string; url: string; token: string; environmentId: string; browserSessionId: string;
  request<T>(path: string, method?: string, input?: unknown): Promise<T>; reconnect(): Promise<void> };

async function withContainer(callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const id = randomUUID(), name = `aevoren-browser-test-${id}`, environmentId = randomUUID(), browserSessionId = randomUUID(), token = randomBytes(32).toString("hex");
  const volumes = ["profile", "state", "downloads"].map(part => `${name}-${part}`);
  let url = "";
  const reconnect = async () => {
    const bindings = JSON.parse(await docker(["inspect", "--format", '{{json (index .NetworkSettings.Ports "8081/tcp")}}', name])) as { HostPort: string }[];
    url = `http://127.0.0.1:${bindings[0]!.HostPort}`;
  };
  const request = async <T>(path: string, method = "GET", input?: unknown): Promise<T> => {
    const response = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(20_000) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error((result as { error: { code: string } }).error.code), { status: response.status });
    return result as T;
  };
  try {
    await execute("docker", ["run", "--detach", "--name", name, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "CHOWN", "--cap-add", "KILL", "--security-opt", "no-new-privileges", "--memory", "768m", "--pids-limit", "256", "--publish", "127.0.0.1::8081",
      ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      ...(process.env.AEVOREN_BROWSER_DIAGNOSTICS === "1" ? ["--env", "AEVOREN_BROWSER_DIAGNOSTICS=1"] : []),
      "--mount", `type=volume,source=${volumes[0]},target=/var/lib/aevoren-browser-profile`, "--mount", `type=volume,source=${volumes[1]},target=/var/lib/aevoren-browser-state`, "--mount", `type=volume,source=${volumes[2]},target=/var/lib/aevoren-browser-downloads`,
      "--env", "AEVOREN_BROWSER_TOKEN", "--env", `AEVOREN_BROWSER_ENVIRONMENT_ID=${environmentId}`, "--env", `AEVOREN_BROWSER_SESSION_ID=${browserSessionId}`, image], { env: { ...process.env, AEVOREN_BROWSER_TOKEN: token } });
    await reconnect();
    await expect.poll(async () => { try { return browserWorkerHealthSchema.parse(await request("/v1/health")).browserSessionId; } catch { return null; } }, { timeout: 50_000 }).toBe(browserSessionId);
    const fixture: Fixture = { name, get url() { return url; }, token, environmentId, browserSessionId, request, reconnect };
    await callback(fixture);
  } catch (error) {
    if (process.env.AEVOREN_BROWSER_DIAGNOSTICS === "1") {
      const diagnostic = await docker(["exec", "--user", "1000", name, "node", "-e", "try{console.log(require('fs').readFileSync('/tmp/aevoren-ffmpeg-diagnostics.json','utf8'))}catch{console.log('No ffmpeg failure diagnostic')}" ]).catch(() => "Diagnostic container unavailable");
      console.error("Controlled browser capture diagnostic:", diagnostic);
      const frameDiagnostic = await docker(["exec", "--user", "1000", name, "node", "-e", "try{console.log(require('fs').readFileSync('/tmp/aevoren-frame-diagnostics.json','utf8'))}catch{console.log('No stale frame diagnostic')}" ]).catch(() => "Diagnostic container unavailable");
      console.error("Controlled browser stale frame diagnostic:", frameDiagnostic);
      const memory = await docker(["exec", "--user", "1000", name, "node", "-e", `const fs=require('fs');const read=p=>{try{return fs.readFileSync(p,'utf8').trim()}catch{return null}};const cgroup=Object.fromEntries(['memory.events','memory.peak','memory.current','memory.max'].map(file=>[file,read('/sys/fs/cgroup/'+file)]));const processes=fs.readdirSync('/proc').filter(pid=>/^\\d+$/.test(pid)).flatMap(pid=>{const comm=read('/proc/'+pid+'/comm'),status=read('/proc/'+pid+'/status');if(!comm||!status)return [];const rssKiB=Number(/^VmRSS:\\s+(\\d+)/mu.exec(status)?.[1])||0;return [{pid:Number(pid),comm:comm.slice(0,48),rssKiB}]});processes.sort((a,b)=>b.rssKiB-a.rssKiB);console.log(JSON.stringify({cgroup,processes:processes.slice(0,16)}))`]).catch(() => "Memory diagnostic unavailable");
      console.error("Controlled browser cgroup and process RSS:", memory);
      const stats = await docker(["stats", "--no-stream", "--format", "{{.MemUsage}} CPU={{.CPUPerc}} PIDs={{.PIDs}}", name]).catch(() => "Stats unavailable");
      const state = await docker(["inspect", "--format", "status={{.State.Status}} oomKilled={{.State.OOMKilled}}", name]).catch(() => "State unavailable");
      console.error("Controlled browser resources:", stats, state);
    }
    throw error;
  } finally {
    await docker(["rm", "--force", name]).catch(() => undefined);
    await docker(["volume", "rm", ...volumes]).catch(() => undefined);
  }
}

async function withSite(callback: (url: string, clicks: () => number, focused: () => Record<string, boolean>) => Promise<void>): Promise<void> {
  let clicks = 0;
  const focused: Record<string, boolean> = {};
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/clicked") { clicks++; response.end("counted"); return; }
    if (url.pathname === "/focused") { focused[url.searchParams.get("page")!] = url.searchParams.get("value") === "1"; response.end("counted"); return; }
    if (url.pathname === "/download" || url.pathname === "/large") {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="controlled.bin"' });
      response.end(Buffer.alloc(url.pathname === "/large" ? 1_048_577 : 1_024, 0xab)); return;
    }
    if (url.searchParams.has("login")) response.setHeader("set-cookie", `fixture_login=${url.searchParams.get("login")}; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax`);
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (url.searchParams.has("focusFixture")) {
      const label = url.searchParams.get("focusFixture")!, background = label === "A" ? "rgb(23,145,213)" : "white";
      const spoof = url.searchParams.has("spoofFocus") ? "document.hasFocus=()=>true;" : "";
      response.end(`<!doctype html><html><head><title>focus fixture ${label}</title><style>html,body,button{width:100%;height:100%;margin:0;padding:0;border:0}button{background:${background};font:30px sans-serif}</style></head><body><button onclick="fetch('/clicked')">focus fixture ${label}</button><script>${spoof}const report=()=>fetch('/focused?page=${label}&value='+(document.hasFocus()?'1':'0'));setInterval(report,100);report();</script></body></html>`);
      return;
    }
    response.end(`<!doctype html><html><head><title>controlled browser fixture</title><style>html,body{background:rgb(23,145,213);margin:0;min-height:100%;}input,button,a{font:20px sans-serif;margin:8px}h1{margin:8px}${url.searchParams.has("wait") ? "#late{pointer-events:none}" : ""}</style></head><body><h1>controlled browser fixture</h1><p>COOKIE ${String(request.headers.cookie ?? "ABSENT")}</p><input aria-label="Draft" oninput="document.getElementById('typed').textContent=this.value"><span id="typed"></span><button id="late" onclick="fetch('/clicked');this.textContent='Clicked'">Click fixture</button><a href="/download">Download fixture</a><a href="/large">Oversized fixture</a><script>if(location.search.includes('wait=1'))setTimeout(()=>document.getElementById('late').style.pointerEvents='auto',1500)</script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture bind failed");
  try { await callback(`http://host.docker.internal:${address.port}`, () => clicks, () => ({ ...focused })); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

const access = (expectedEpoch: number, actor: "ai" | "user" = "ai") => ({ actor, expectedEpoch });
const mutation = (expectedEpoch: number, actor: "ai" | "user" = "ai") => ({ ...access(expectedEpoch, actor), operationId: randomUUID() });
async function pages(f: Fixture, epoch: number, actor: "ai" | "user" = "ai"): Promise<BrowserPage[]> {
  return f.request(`/v1/browser/pages?expectedEpoch=${epoch}&actor=${actor}`);
}
async function navigate(f: Fixture, url: string, epoch = 1, actor: "ai" | "user" = "user"): Promise<BrowserPage> {
  const page = (await pages(f, epoch, actor))[0]!;
  return f.request(`/v1/browser/pages/${page.id}/navigate`, "POST", { ...mutation(epoch, actor), url });
}
async function observe(f: Fixture, pageId: string, epoch = 1, actor: "ai" | "user" = "ai"): Promise<BrowserObservation> {
  return browserObservationSchema.parse(await f.request(`/v1/browser/pages/${pageId}/observe`, "POST", access(epoch, actor)));
}
async function screenshotPixel(f: Fixture, frame: BrowserWorkerFrame, x: number, y: number): Promise<number[]> {
  const bytes = Buffer.from(frame.dataBase64, "base64");
  const result = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", f.name, "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("fixture image decode failed")));
    child.stdin.end(bytes);
  });
  return [...result];
}

class RfbFixture {
  readonly socket: WebSocket;
  private buffer = Buffer.alloc(0);
  private changed: (() => void) | null = null;
  constructor(f: Fixture, epoch: number) {
    this.socket = new WebSocket(`${f.url.replace("http:", "ws:")}/v1/computer/vnc?epoch=${epoch}`, { headers: { authorization: `Bearer ${f.token}` } });
    this.socket.on("error", () => undefined);
    this.socket.on("message", value => { this.buffer = Buffer.concat([this.buffer, Buffer.from(value as Buffer)]); this.changed?.(); });
  }
  async read(size: number): Promise<Buffer> {
    while (this.buffer.length < size) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.changed = null; reject(new Error("fixture RFB timeout")); }, 10_000);
        this.changed = () => { clearTimeout(timer); this.changed = null; resolve(); };
      });
    }
    const value = this.buffer.subarray(0, size); this.buffer = this.buffer.subarray(size); return value;
  }
  send(bytes: Buffer): void { this.socket.send(bytes, { binary: true }); }
  async handshake(): Promise<{ width: number; height: number }> {
    expect((await this.read(12)).toString("ascii")).toMatch(/^RFB 003\./);
    this.send(Buffer.from("RFB 003.008\n"));
    const count = (await this.read(1))[0]!;
    expect([...await this.read(count)]).toContain(1);
    this.send(Buffer.from([1])); expect((await this.read(4)).readUInt32BE()).toBe(0);
    this.send(Buffer.from([1]));
    const initial = await this.read(24), nameSize = initial.readUInt32BE(20);
    await this.read(nameSize);
    return { width: initial.readUInt16BE(0), height: initial.readUInt16BE(2) };
  }
  type(text: string): void {
    for (const character of text) {
      const event = Buffer.alloc(8); event[0] = 4; event[1] = 1; event.writeUInt32BE(character.codePointAt(0)!, 4); this.send(event);
      event[1] = 0; this.send(Buffer.from(event));
    }
  }
  click(x: number, y: number): void {
    const event = Buffer.alloc(6); event[0] = 5; event[1] = 1; event.writeUInt16BE(x, 2); event.writeUInt16BE(y, 4); this.send(event);
    event[1] = 0; this.send(Buffer.from(event));
  }
  nextTab(): void {
    const event = Buffer.alloc(8); event[0] = 4;
    for (const [key, down] of [[0xffe3, 1], [0xff09, 1], [0xff09, 0], [0xffe3, 0]]) { event[1] = down!; event.writeUInt32BE(key!, 4); this.send(Buffer.from(event)); }
  }
  close(): void { this.socket.terminate(); }
}

describe.skipIf(!enabled)("real isolated Chromium and desktop Worker", () => {
  it("binds actual native tab pixels and input to one focused page and clicks at the unchanged cursor position", async () => {
    await withSite(async (site, clicks, focused) => withContainer(async f => {
      const first = await navigate(f, `${site}/?focusFixture=A`);
      const original = browserWorkerFrameSchema.parse(await f.request("/v1/computer/screenshot", "POST", { ...access(1), pageId: first.id }));
      const second = await f.request<BrowserPage>("/v1/browser/pages", "POST", { ...mutation(1), url: `${site}/?focusFixture=B` });
      // New native tabs can retain omnibox focus. Establish real content focus
      // through a known DOM target before requiring a page-bound desktop proof.
      const content = await observe(f, second.id);
      await f.request(`/v1/browser/pages/${second.id}/click`, "POST", { ...mutation(1), observationId: content.id,
        documentVersion: content.documentVersion, ref: content.elements.find(value => value.name === "focus fixture B")!.ref });
      await expect.poll(clicks).toBe(1);
      const baseline = clicks();
      await expect.poll(focused).toEqual({ A: false, B: true });
      await f.request("/v1/computer/screenshot", "POST", { ...access(1), pageId: second.id });
      const current = browserWorkerFrameSchema.parse(await f.request("/v1/computer/screenshot", "POST", access(1, "user")));
      expect(current.pageId).toBe(second.id);
      expect(await screenshotPixel(f, current, 700, 600)).toEqual([255, 255, 255]);
      await expect(f.request("/v1/computer/click", "POST", { ...mutation(1), pageId: first.id, observationId: original.observationId,
        documentVersion: original.documentVersion, x: 650, y: 500 })).rejects.toMatchObject({ message: "BROWSER_OBSERVATION_STALE", status: 409 });
      expect(clicks()).toBe(baseline);
      expect((await pages(f, 1)).find(page => page.id === first.id)?.documentVersion).toBe(original.documentVersion);
      await f.request("/v1/computer/takeover", "POST", mutation(1, "user"));
      const rfb = new RfbFixture(f, 2);
      try {
        await rfb.handshake(); rfb.click(650, 500); await expect.poll(clicks).toBe(baseline + 1);
        rfb.nextTab(); await expect.poll(focused).toEqual({ A: true, B: false });
        const native = browserWorkerFrameSchema.parse(await f.request("/v1/computer/screenshot", "POST", access(2, "user")));
        expect(native.pageId).toBe(first.id);
        const blue = await screenshotPixel(f, native, 700, 600);
        expect(blue[0]).toBeLessThan(40); expect(blue[1]).toBeGreaterThan(125); expect(blue[2]).toBeGreaterThan(190);
        rfb.nextTab(); await expect.poll(focused).toEqual({ A: false, B: true });
        const ready = browserWorkerFrameSchema.parse(await f.request("/v1/computer/screenshot", "POST", access(2, "user")));
        expect(ready.pageId).toBe(second.id);
        const mouse = await docker(["exec", "--user", "1000", f.name, "env", "DISPLAY=:99", "xdotool", "getmouselocation", "--shell"]);
        expect(mouse).toContain("X=650\nY=500");
        await f.request("/v1/computer/click", "POST", { ...mutation(2, "user"), pageId: second.id, observationId: ready.observationId,
          documentVersion: ready.documentVersion, x: 650, y: 500 });
        await expect.poll(clicks).toBe(baseline + 2);
        await f.request(`/v1/browser/pages/${first.id}/navigate`, "POST", { ...mutation(2, "user"), url: `${site}/?focusFixture=A&spoofFocus=1` });
        await expect.poll(focused).toEqual({ A: true, B: true });
        const spoofed = browserWorkerFrameSchema.parse(await f.request("/v1/computer/screenshot", "POST", access(2, "user")));
        expect(spoofed.pageId).toBe(second.id);
        expect(await screenshotPixel(f, spoofed, 700, 600)).toEqual([255, 255, 255]);
        expect((await f.request<BrowserWorkerControl>("/v1/computer/control")).observedEpoch).toBeNull();
      } finally { rfb.close(); }
    }));
  }, 90_000);

  it("records sanitized human RFB input in the actual desktop and seals captures across disconnect and restart", async () => {
    await withSite(async (site, clicks) => withContainer(async f => {
      const page = await navigate(f, `${site}/?focusFixture=A`);
      await f.request("/v1/computer/takeover", "POST", mutation(1, "user"));
      const rfb = new RfbFixture(f, 2), id = randomUUID();
      try {
        await rfb.handshake();
        await expect.poll(async () => (await f.request<BrowserWorkerControl>("/v1/computer/control")).connectionState).toBe("connected");
        expect(await f.request("/v1/demonstrations/start", "POST", { ...access(2, "user"), id })).toMatchObject({ id, epoch: 2, state: "recording", eventCount: 0 });
        await expect(observe(f, page.id, 2)).rejects.toThrow("BROWSER_USER_CONTROL");
        await expect(f.request("/v1/computer/screenshot", "POST", access(2))).rejects.toThrow("BROWSER_USER_CONTROL");
        rfb.click(650, 500);
        await expect.poll(clicks).toBe(1);
        rfb.type("SECRET_URL_token");
        const clipboard = Buffer.from("https://user:SECRET@example.test/?token=RAW_CLIPBOARD"), header = Buffer.alloc(8);
        header[0] = 6; header.writeUInt32BE(clipboard.length, 4); rfb.send(Buffer.concat([header, clipboard]));
        // A final pointer transition proves preceding text/clipboard messages reached the same real bridge.
        rfb.click(651, 501);
        await expect.poll(async () => (await f.request<DemonstrationCapture>("/v1/demonstrations/status")).eventCount).toBe(5);
        rfb.close();
        await expect.poll(async () => (await f.request<DemonstrationCapture>("/v1/demonstrations/status")).state).toBe("interrupted");
        const snapshot = await f.request<DemonstrationSnapshot>("/v1/demonstrations/stop", "POST", { ...access(2, "user"), id });
        expect(snapshot).toMatchObject({ id, state: "interrupted", reason: "disconnect", eventCount: 5 });
        expect(snapshot.events).toEqual([{ kind: "pointer", x: 650, y: 500, buttons: 1 }, { kind: "pointer", x: 650, y: 500, buttons: 0 }, { kind: "redacted-text" }, { kind: "pointer", x: 651, y: 501, buttons: 1 }, { kind: "pointer", x: 651, y: 501, buttons: 0 }]);
        expect(JSON.stringify(snapshot)).not.toMatch(/SECRET|RAW_CLIPBOARD|example/);
        expect((await f.request<BrowserWorkerControl>("/v1/computer/control")).owner).toBe("user");
        await expect(f.request("/v1/demonstrations/start", "POST", { ...access(2), id: randomUUID() })).rejects.toThrow("BROWSER_CONTROL_FORBIDDEN");
      } finally { rfb.close(); }
      const again = new RfbFixture(f, 2), interruptedId = randomUUID();
      try {
        await again.handshake();
        await f.request("/v1/demonstrations/start", "POST", { ...access(2, "user"), id: interruptedId });
        again.click(652, 502);
        await expect.poll(async () => (await f.request<DemonstrationCapture>("/v1/demonstrations/status")).eventCount).toBe(2);
        await docker(["restart", "--time", "10", f.name]); await f.reconnect();
        await expect.poll(async () => { try { return (await f.request<BrowserWorkerHealth>("/v1/health")).control.controlEpoch; } catch { return null; } }, { timeout: 50_000 }).toBe(3);
        expect((await f.request<DemonstrationCapture>("/v1/demonstrations/status"))).toMatchObject({ id: interruptedId, state: "interrupted", eventCount: 2 });
        expect((await f.request<BrowserWorkerControl>("/v1/computer/control")).owner).toBe("user");
        await expect(f.request("/v1/demonstrations/start", "POST", { ...access(2, "user"), id: randomUUID() })).rejects.toThrow("BROWSER_CONTROL_CHANGED");
        await expect(f.request("/v1/computer/screenshot", "POST", access(3))).rejects.toThrow("BROWSER_USER_CONTROL");
        const stale = new RfbFixture(f, 2); try { await expect.poll(() => stale.socket.readyState).toBe(WebSocket.CLOSED); } finally { stale.close(); }
        await f.request("/v1/computer/return", "POST", mutation(3, "user"));
        expect((await f.request<BrowserWorkerControl>("/v1/computer/control")).observedEpoch).toBeNull();
        await expect(f.request(`/v1/browser/pages/${page.id}/click`, "POST", { ...mutation(4), observationId: randomUUID(), documentVersion: 1, ref: "element-1" })).rejects.toBeDefined();
        const current = (await pages(f, 4))[0]!;
        await observe(f, current.id, 4);
        expect((await f.request<BrowserWorkerControl>("/v1/computer/control")).observedEpoch).toBe(4);
      } finally { again.close(); }
    }));
  }, 120_000);

  it("transfers real screenshot pixels and bounds downloads without publishing partial resources", async () => {
    await withSite(async site => withContainer(async f => {
      expect((await fetch(`${f.url}/v1/health`)).status).toBe(401);
      const page = await navigate(f, site);
      const frame = browserWorkerFrameSchema.parse(await f.request(`/v1/browser/pages/${page.id}/screenshot`, "POST", access(1)));
      expect(frame).toMatchObject({ browserSessionId: f.browserSessionId, pageId: page.id, width: 1_200, height: 700 });
      expect(createHash("sha256").update(Buffer.from(frame.dataBase64, "base64")).digest("hex")).toBe(frame.sha256);
      const pixel = await screenshotPixel(f, frame, 700, 400);
      [23, 145, 213].forEach((value, index) => expect(Math.abs(pixel[index]! - value)).toBeLessThan(10));
      let observation = await observe(f, page.id);
      const download = observation.elements.find(value => value.name === "Download fixture")!;
      await f.request(`/v1/browser/pages/${page.id}/click`, "POST", { ...mutation(1), observationId: observation.id, documentVersion: observation.documentVersion, ref: download.ref });
      await expect.poll(async () => browserDownloadsPageSchema.parse(await f.request("/v1/browser/downloads/list", "POST", access(1))).items.length).toBe(1);
      const item = (await f.request<BrowserDownloadsPage>("/v1/browser/downloads/list", "POST", access(1))).items[0]!;
      const content = browserWorkerDownloadSchema.parse(await f.request(`/v1/browser/downloads/${item.id}/content`, "POST", access(1)));
      expect(Buffer.from(content.dataBase64, "base64")).toEqual(Buffer.alloc(1_024, 0xab));
      observation = await observe(f, page.id);
      await f.request(`/v1/browser/pages/${page.id}/click`, "POST", { ...mutation(1), observationId: observation.id, documentVersion: observation.documentVersion, ref: observation.elements.find(value => value.name === "Oversized fixture")!.ref });
      await expect.poll(async () => (await f.request<BrowserDownloadsPage>("/v1/browser/downloads/list", "POST", access(1))).errors[0]?.errorCode).toBe("BROWSER_DOWNLOAD_TOO_LARGE");
      expect((await f.request<BrowserDownloadsPage>("/v1/browser/downloads/list", "POST", access(1))).items).toHaveLength(1);
      expect(await docker(["exec", "--user", "1000:1000", f.name, "find", "/var/lib/aevoren-browser-downloads", "-name", "*.partial"])).toBe("");
    }));
  }, 90_000);

  it("uses the same Chrome through RFB and retains human ownership and private cookies across restart", async () => {
    await withSite(async site => withContainer(async f => {
      const login = randomUUID(), page = await navigate(f, `${site}/?login=${login}`);
      const observation = await observe(f, page.id);
      await f.request(`/v1/browser/pages/${page.id}/click`, "POST", { ...mutation(1), observationId: observation.id, documentVersion: observation.documentVersion, ref: observation.elements.find(value => value.name === "Draft")!.ref });
      const taken = await f.request<BrowserWorkerControl>("/v1/computer/takeover", "POST", mutation(1, "user"));
      expect(taken).toMatchObject({ owner: "user", controlEpoch: 2 });
      await expect(observe(f, page.id, 2)).rejects.toThrow("BROWSER_USER_CONTROL");
      const vnc = new RfbFixture(f, 2);
      try {
        expect(await vnc.handshake()).toEqual({ width: 1_280, height: 800 });
        vnc.type("VNC_TYPED");
        await expect.poll(async () => (await observe(f, page.id, 2, "user")).text).toContain("VNC_TYPED");
      } finally { vnc.close(); }
      await expect.poll(async () => (await f.request<BrowserWorkerControl>("/v1/computer/control")).connectionState).toBe("disconnected");
      expect((await f.request<BrowserWorkerControl>("/v1/computer/control")).owner).toBe("user");
      await docker(["stop", "--time", "10", f.name]); await docker(["start", f.name]); await f.reconnect();
      await expect.poll(async () => { try { return (await f.request<BrowserWorkerHealth>("/v1/health")).control.controlEpoch; } catch { return null; } }, { timeout: 50_000 }).toBe(3);
      expect((await f.request<BrowserWorkerHealth>("/v1/health")).control.owner).toBe("user");
      const returned = await f.request<BrowserWorkerControl>("/v1/computer/return", "POST", mutation(3, "user"));
      expect(returned).toMatchObject({ owner: "ai", controlEpoch: 4, observedEpoch: null });
      const restored = (await pages(f, 4))[0]!;
      await f.request("/v1/computer/screenshot", "POST", access(4, "user"));
      expect((await f.request<BrowserWorkerControl>("/v1/computer/control")).observedEpoch).toBeNull();
      await expect(f.request(`/v1/browser/pages/${restored.id}/navigate`, "POST", { ...mutation(4), url: site })).rejects.toThrow("BROWSER_OBSERVATION_STALE");
      await observe(f, restored.id, 4);
      await f.request(`/v1/browser/pages/${restored.id}/navigate`, "POST", { ...mutation(4), url: site });
      expect((await observe(f, restored.id, 4)).text).toContain(`fixture_login=${login}`);
      const rootDenied = await docker(["exec", "--user", "1000:1000", f.name, "node", "-e", `const fs=require('fs');let denied=false;try{fs.readFileSync('/proc/1/environ')}catch(e){denied=e.code==='EACCES'}console.log(denied)`]);
      expect(rootDenied).toBe("true");
      // A trusted fixture diagnostic inspects the real engine environment, without printing its bytes.
      const engineNoToken = await docker(["exec", "--privileged", "--user", "0:0", f.name, "node", "-e", `const fs=require('fs');let checked=false;for(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{if(fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0')[1]==='/opt/aevoren-browser-worker/engine.mjs')checked=!fs.readFileSync('/proc/'+pid+'/environ','utf8').includes('AEVOREN_BROWSER_TOKEN')}catch{}}console.log(checked)`]);
      expect(engineNoToken).toBe("true");
    }));
  }, 120_000);

  it("starts six scopes in parallel with separate cookies, profiles and real frames", async () => {
    await withSite(async site => {
      const ids = Array.from({ length: 6 }, () => randomUUID()), arrived: string[] = [], release = (() => { let resolve!: () => void; const promise = new Promise<void>(ready => { resolve = ready; }); return { promise, resolve }; })();
      const results = await Promise.allSettled(ids.map(id => withContainer(async f => {
        arrived.push(f.browserSessionId); if (arrived.length === 6) release.resolve();
        await release.promise;
        const page = await navigate(f, `${site}/?login=${id}`);
        await navigate(f, site);
        const observation = await observe(f, page.id);
        expect(observation.text).toContain(`fixture_login=${id}`);
        for (const other of ids.filter(value => value !== id)) expect(observation.text).not.toContain(other);
        const frame = browserWorkerFrameSchema.parse(await f.request("/v1/computer/screenshot", "POST", { ...access(1), pageId: page.id }));
        expect(frame).toMatchObject({ browserSessionId: f.browserSessionId, width: 1_280, height: 800 });
      }).catch(error => { release.resolve(); throw error; })));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "Controlled parallel scopes failed");
      expect(new Set(arrived).size).toBe(6);
    });
  }, 150_000);

  it("cancels an auto-wait mutation without late clicks, replay or closing sibling pages", async () => {
    await withSite(async (site, clicks) => withContainer(async f => {
      const first = await navigate(f, `${site}/?wait=1`), observed = await observe(f, first.id);
      const sibling = await f.request<BrowserPage>("/v1/browser/pages", "POST", { ...mutation(1), url: site });
      const operationId = randomUUID();
      // The real button is visible, but CSS prevents its hit target until after cancellation.
      const ref = observed.elements.find(value => value.name === "Click fixture")!.ref;
      const pending = f.request(`/v1/browser/pages/${first.id}/click`, "POST", { ...mutation(1), operationId, observationId: observed.id, documentVersion: observed.documentVersion, ref }).catch(error => error as Error);
      await new Promise(resolve => setTimeout(resolve, 150));
      const ack = await f.request<{ state: string }>(`/v1/operations/${operationId}/cancel`, "POST");
      const result = await pending;
      expect(ack.state).toBe("unknown");
      expect(result).toBeInstanceOf(Error);
      expect((await pages(f, 1)).some(value => value.id === sibling.id)).toBe(true);
      const never = randomUUID();
      expect(await f.request(`/v1/operations/${never}/cancel`, "POST")).toEqual({ operationId: never, state: "cancelled" });
      await expect(f.request(`/v1/browser/pages/${sibling.id}/navigate`, "POST", { ...mutation(1), operationId: never, url: `${site}/clicked` })).rejects.toThrow("BROWSER_OPERATION_CANCELLED");
      await new Promise(resolve => setTimeout(resolve, 1_700)); expect(clicks()).toBe(0);
    }));
  }, 90_000);

  it("keeps UI captures from invalidating AI proofs and terminates an open RFB connection on return", async () => {
    await withSite(async site => withContainer(async f => {
      const page = await navigate(f, site), proof = await observe(f, page.id);
      await f.request(`/v1/browser/pages/${page.id}/screenshot`, "POST", access(1, "user"));
      await f.request("/v1/computer/screenshot", "POST", access(1, "user"));
      await f.request(`/v1/browser/pages/${page.id}/click`, "POST", { ...mutation(1), observationId: proof.id, documentVersion: proof.documentVersion, ref: proof.elements.find(value => value.name === "Draft")!.ref });
      await f.request("/v1/computer/takeover", "POST", mutation(1, "user"));
      const vnc = new RfbFixture(f, 2);
      try {
        await vnc.handshake();
        await expect.poll(async () => (await f.request<BrowserWorkerControl>("/v1/computer/control")).connectionState).toBe("connected");
        await f.request("/v1/computer/return", "POST", mutation(2, "user"));
        await expect.poll(() => vnc.socket.readyState).toBe(WebSocket.CLOSED);
        expect((await f.request<BrowserWorkerControl>("/v1/computer/control")).owner).toBe("ai");
      } finally { vnc.close(); }
    }));
  }, 90_000);

  it("stops a pending SDK action at takeover while leaving the other tab available to the human", async () => {
    await withSite(async (site, clicks) => withContainer(async f => {
      const first = await navigate(f, `${site}/?wait=1`), proof = await observe(f, first.id);
      const sibling = await f.request<BrowserPage>("/v1/browser/pages", "POST", { ...mutation(1), url: site });
      const pending = f.request(`/v1/browser/pages/${first.id}/click`, "POST", { ...mutation(1), observationId: proof.id, documentVersion: proof.documentVersion, ref: proof.elements.find(value => value.name === "Click fixture")!.ref }).catch(error => error as Error);
      await new Promise(resolve => setTimeout(resolve, 150));
      await f.request("/v1/computer/takeover", "POST", mutation(1, "user"));
      expect(await pending).toBeInstanceOf(Error);
      expect((await pages(f, 2, "user")).some(value => value.id === sibling.id)).toBe(true);
      await expect(f.request("/v1/computer/screenshot", "POST", access(2))).rejects.toThrow("BROWSER_USER_CONTROL");
      expect(browserWorkerFrameSchema.parse(await f.request("/v1/computer/screenshot", "POST", access(2, "user"))).controlEpoch).toBe(2);
      await new Promise(resolve => setTimeout(resolve, 1_700));
      expect(clicks()).toBe(0);
    }));
  }, 90_000);

  it("does not expose the profile, browser credential or Docker socket to the paired execution shell", async () => {
    await withContainer(async browser => {
      const name = `${browser.name}-execution`, work = `${name}-work`, state = `${name}-state`, token = randomBytes(32).toString("hex");
      try {
        await execute("docker", ["run", "--detach", "--name", name, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "CHOWN", "--cap-add", "KILL", "--security-opt", "no-new-privileges", "--publish", "127.0.0.1::8080", "--mount", `type=volume,source=${work},target=/workspace`, "--mount", `type=volume,source=${state},target=/var/lib/aevoren`, "--env", "AEVOREN_WORKER_TOKEN", "--env", `AEVOREN_WORKER_ENVIRONMENT_ID=${browser.environmentId}`, "aevoren-worker-fixture:stage2"], { env: { ...process.env, AEVOREN_WORKER_TOKEN: token } });
        const bindings = JSON.parse(await docker(["inspect", "--format", '{{json (index .NetworkSettings.Ports "8080/tcp")}}', name])) as { HostPort: string }[];
        const url = `http://127.0.0.1:${bindings[0]!.HostPort}`, headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        await expect.poll(async () => { try { return (await fetch(`${url}/v1/health`, { headers })).status; } catch { return null; } }).toBe(200);
        const id = randomUUID();
        const response = await fetch(`${url}/v1/executions`, { method: "POST", headers, body: JSON.stringify({ id, sessionId: randomUUID(), runtimeRunId: null, kind: "foreground", cwd: ".", command: "node -e 'const fs=require(\"fs\");console.log(JSON.stringify({profile:fs.existsSync(\"/var/lib/aevoren-browser-profile\"),browserToken:Boolean(process.env.AEVOREN_BROWSER_TOKEN),dockerSocket:fs.existsSync(\"/var/run/docker.sock\")}))'" }) });
        expect(response.status).toBe(202);
        await expect.poll(async () => (await (await fetch(`${url}/v1/executions/${id}`, { headers })).json() as { state: string }).state).toBe("completed");
        const logs = await (await fetch(`${url}/v1/executions/${id}/logs`, { headers })).json() as { logs: { stream: string; text: string }[] };
        expect(JSON.parse(logs.logs.filter(value => value.stream === "stdout").map(value => value.text).join(""))).toEqual({ profile: false, browserToken: false, dockerSocket: false });
        const mounts = JSON.parse(await docker(["inspect", "--format", "{{json .Mounts}}", name])) as { Name: string }[];
        expect(mounts.map(value => value.Name).sort()).toEqual([work, state].sort());
        expect(await docker(["inspect", "--format", "{{.HostConfig.PidMode}}", name])).toBe("");
      } finally { await docker(["rm", "--force", name]).catch(() => undefined); await docker(["volume", "rm", work, state]).catch(() => undefined); }
    });
  }, 90_000);

  it("fails health closed after the browser engine dies and keeps the human lease through recovery", async () => {
    await withContainer(async f => {
      await f.request("/v1/computer/takeover", "POST", mutation(1, "user"));
      await docker(["exec", f.name, "node", "-e", `const fs=require('fs');for(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{if(fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0')[1]==='/opt/aevoren-browser-worker/engine.mjs')process.kill(Number(pid),'SIGKILL')}catch{}}`]);
      await expect.poll(async () => (await fetch(`${f.url}/v1/health`, { headers: { authorization: `Bearer ${f.token}` } })).status).toBe(503);
      expect((await f.request<BrowserWorkerControl>("/v1/computer/control")).owner).toBe("user");
      await docker(["restart", "--time", "10", f.name]); await f.reconnect();
      await expect.poll(async () => { try { return (await f.request<BrowserWorkerHealth>("/v1/health")).control.controlEpoch; } catch { return null; } }, { timeout: 50_000 }).toBe(3);
      expect((await f.request<BrowserWorkerHealth>("/v1/health")).control.owner).toBe("user");
    });
  }, 90_000);
});
