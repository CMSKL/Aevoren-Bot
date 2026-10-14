import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { ENV_WORKER_VERSION } from "@shared/environment-contracts";
import type { WorkerExecution, WorkerHealth } from "@shared/environment-contracts";
import type { PreviewTicket } from "./preview-proxy";

const execute = promisify(execFile), enabled = process.env.AEVOREN_WORKER_DOCKER_TEST === "1";
async function docker(args: string[], environment?: NodeJS.ProcessEnv): Promise<string> { return (await execute("docker", args, { ...(environment ? { env: environment } : {}), maxBuffer: 2_097_152 })).stdout.trim(); }
const application = (label: string) => `node - <<'JS'\nconst http=require('node:http'),crypto=require('node:crypto');const label=${JSON.stringify(label)};const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;if(req.url==='/absolute/api'){res.end('ABSOLUTE_FETCH_OK '+label);return}if(req.url==='/headers'){res.setHeader('content-type','application/json');res.end(JSON.stringify(req.headers));return}if(req.method==='POST'){console.log('WRITE',body);res.end('WRITE_OK '+label);return}res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><title>'+label+'</title></head><body><h1>'+label+'</h1><p id="fetch"></p><p id="ws"></p><script>history.pushState({},"","/absolute/spa/path");fetch("/absolute/api").then(r=>r.text()).then(t=>document.getElementById("fetch").textContent=t);const socket=new WebSocket("ws://"+location.host+"/absolute/ws");socket.onopen=()=>socket.send("fixture-message");socket.onmessage=e=>document.getElementById("ws").textContent="WS_ECHO_OK "+e.data;</script></body></html>')});server.on('upgrade',(req,socket)=>{const key=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+key+'\\r\\n\\r\\n');socket.on('data',b=>{if((b[0]&15)===8){socket.end();return}const n=b[1]&127;if(n>=126||b.length<6+n)return;const data=Buffer.alloc(n);for(let i=0;i<n;i++)data[i]=b[6+i]^b[2+i%4];socket.write(Buffer.concat([Buffer.from([0x81,n]),data]))})});server.listen(3131,'0.0.0.0',()=>console.log('READY',process.getuid()));\nJS`;

type ExecutionFixture = { name: string; environmentId: string; token: string; url: string; network: string;
  request<T>(path: string, method?: string, body?: unknown): Promise<T>; processId: string; registeredPortId: string; ticket: PreviewTicket };
async function fixture(callback: (f: ExecutionFixture) => Promise<void>): Promise<void> {
  const name = `aevoren-preview-test-${randomUUID()}`, environmentId = randomUUID(), token = randomBytes(32).toString("hex"), network = `${name}-network`, work = `${name}-work`, state = `${name}-state`;
  try {
    await docker(["network", "create", network]);
    await docker(["run", "--detach", "--name", name, "--network", network, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "CHOWN", "--cap-add", "KILL", "--security-opt", "no-new-privileges", "--mount", `type=volume,source=${work},target=/workspace`, "--mount", `type=volume,source=${state},target=/var/lib/aevoren`, "--publish", "127.0.0.1::8080", "--env", "AEVOREN_WORKER_TOKEN", "--env", `AEVOREN_WORKER_ENVIRONMENT_ID=${environmentId}`, process.env.AEVOREN_WORKER_TEST_IMAGE ?? "aevoren-worker-fixture:stage3"], { ...process.env, AEVOREN_WORKER_TOKEN: token });
    const port = (JSON.parse(await docker(["inspect", "--format", '{{json (index .NetworkSettings.Ports "8080/tcp")}}', name])) as { HostPort: string }[])[0]!.HostPort;
    const url = `http://127.0.0.1:${port}`;
    const request = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
      const response = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
      const result = await response.json(); if (!response.ok) throw Object.assign(new Error((result as { error: { code: string } }).error.code), { status: response.status }); return result as T;
    };
    await expect.poll(async () => { try { return (await request<WorkerHealth>("/v1/health")).workerVersion; } catch { return null; } }).toBe(ENV_WORKER_VERSION);
    const processId = randomUUID(), registeredPortId = randomUUID();
    await request("/v1/processes", "POST", { id: processId, sessionId: randomUUID(), runtimeRunId: null, kind: "background", command: application("ORIGINAL_APP"), cwd: "." });
    await expect.poll(async () => { try { return (await request<{ state: string }>("/v1/ports", "POST", { id: registeredPortId, processId, port: 3_131, label: "actual original process" })).state; } catch { return null; } }).toBe("listening");
    const ticket = await request<PreviewTicket>("/v1/previews", "POST", { id: randomUUID(), registeredPortId });
    await callback({ name, environmentId, token, url, network, request, processId, registeredPortId, ticket });
  } finally { await docker(["rm", "--force", name]).catch(() => undefined); await docker(["volume", "rm", work, state]).catch(() => undefined); await docker(["network", "rm", network]).catch(() => undefined); }
}

function publicRequest(f: ExecutionFixture, ticket: PreviewTicket, path = "/", headers: Record<string, string> = {}, method = "GET", body?: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${f.url}${path}`, { method, headers: { host: `${ticket.host}:8080`, ...headers } }, response => { const chunks: Buffer[] = []; response.on("data", c => chunks.push(Buffer.from(c))); response.once("end", () => resolve({ status: response.statusCode!, data: Buffer.concat(chunks).toString("utf8") })); });
    request.once("error", reject); request.end(body);
  });
}

describe.skipIf(!enabled)("real registered-process HTTP and WS preview", () => {
  it("blocks an old capability and closes its WS when another real job reuses the same port", async () => {
    await fixture(async f => {
      expect((await publicRequest(f, f.ticket)).data).toContain("ORIGINAL_APP");
      const headers = JSON.parse((await publicRequest(f, f.ticket, "/headers", { authorization: `Bearer ${f.token}`, "x-aevoren-session-id": "secret-namespace" })).data) as Record<string, string>;
      expect(headers.authorization).toBeUndefined(); expect(headers["x-aevoren-session-id"]).toBeUndefined();
      expect(await f.request("/v1/previews", "POST", { id: f.ticket.id, registeredPortId: f.registeredPortId })).toEqual(f.ticket);
      const socket = new WebSocket(f.url.replace("http:", "ws:") + "/absolute/ws", { headers: { host: `${f.ticket.host}:8080`, origin: `http://${f.ticket.host}:8080` } }); socket.on("error", () => undefined);
      try {
        await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
        const echoed = new Promise<string>(resolve => socket.once("message", data => resolve(String(data)))); socket.send("REAL_WEBSOCKET"); expect(await echoed).toBe("REAL_WEBSOCKET");
        expect((await f.request<WorkerExecution>(`/v1/processes/${f.processId}/stop`, "POST")).state).toBe("cancelled");
        await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED);
        const next = randomUUID(), nextPort = randomUUID();
        await f.request("/v1/processes", "POST", { id: next, sessionId: randomUUID(), runtimeRunId: null, kind: "background", command: application("DIFFERENT_JOB_SAME_PORT"), cwd: "." });
        await expect.poll(async () => { try { return (await f.request<{ state: string }>("/v1/ports", "POST", { id: nextPort, processId: next, port: 3_131, label: "different job" })).state; } catch { return null; } }).toBe("listening");
        expect((await publicRequest(f, f.ticket)).status).toBe(503);
        await expect(f.request("/v1/previews", "POST", { id: f.ticket.id, registeredPortId: f.registeredPortId })).rejects.toThrow("WORKER_PREVIEW_UNAVAILABLE");
        const fresh = await f.request<PreviewTicket>("/v1/previews", "POST", { id: randomUUID(), registeredPortId: nextPort });
        expect(fresh.host).not.toBe(f.ticket.host); expect((await publicRequest(f, fresh)).data).toContain("DIFFERENT_JOB_SAME_PORT");
        await f.request(`/v1/previews/${fresh.id}/close`, "POST"); expect((await publicRequest(f, fresh)).status).toBe(503);
      } finally { socket.terminate(); }
    });
  }, 90_000);

  it("loads a real Chrome SPA with absolute fetch and WS paths through scoped hostname resolution", async () => {
    await fixture(async f => {
      const name = `${f.name}-browser`, browserSessionId = randomUUID(), token = randomBytes(32).toString("hex"), volumes = ["state", "profile", "downloads"].map(kind => `${name}-${kind}`);
      try {
        const networks = JSON.parse(await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", f.name])) as Record<string, { IPAddress: string }>;
        await docker(["run", "--detach", "--name", name, "--network", f.network, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "CHOWN", "--cap-add", "KILL", "--security-opt", "no-new-privileges", "--publish", "127.0.0.1::8081",
          ...["state", "profile", "downloads"].flatMap((kind, index) => ["--mount", `type=volume,source=${volumes[index]},target=/var/lib/aevoren-browser-${kind}`]),
          "--env", "AEVOREN_BROWSER_TOKEN", "--env", `AEVOREN_BROWSER_ENVIRONMENT_ID=${f.environmentId}`, "--env", `AEVOREN_BROWSER_SESSION_ID=${browserSessionId}`, "--env", `AEVOREN_PREVIEW_EXECUTION_IP=${networks[f.network]!.IPAddress}`, process.env.AEVOREN_BROWSER_TEST_IMAGE ?? "aevoren-browser-fixture:stage3"], { ...process.env, AEVOREN_BROWSER_TOKEN: token });
        const port = (JSON.parse(await docker(["inspect", "--format", '{{json (index .NetworkSettings.Ports "8081/tcp")}}', name])) as { HostPort: string }[])[0]!.HostPort, url = `http://127.0.0.1:${port}`;
        const request = async <T>(path: string, body?: unknown): Promise<T> => {
          const response = await fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
          const data = await response.json(); if (!response.ok) throw new Error((data as { error: { code: string } }).error.code); return data as T;
        };
        await expect.poll(async () => { try { return (await request<{ browserSessionId: string }>("/v1/health")).browserSessionId; } catch { return null; } }, { timeout: 50_000 }).toBe(browserSessionId);
        const page = (await request<{ id: string }[]>("/v1/browser/pages?actor=user&expectedEpoch=1"))[0]!;
        await request(`/v1/browser/pages/${page.id}/navigate`, { actor: "user", expectedEpoch: 1, operationId: randomUUID(), url: `http://${f.ticket.host}:8080/` });
        await expect.poll(async () => (await request<{ text: string }>(`/v1/browser/pages/${page.id}/observe`, { actor: "ai", expectedEpoch: 1 })).text).toContain("WS_ECHO_OK fixture-message");
        const observation = await request<{ text: string; url: string }>(`/v1/browser/pages/${page.id}/observe`, { actor: "ai", expectedEpoch: 1 });
        expect(observation.text).toContain("ABSOLUTE_FETCH_OK ORIGINAL_APP"); expect(observation.url).toBe(`http://${f.ticket.host}:8080/absolute/spa/path`);
        const frame = await request<{ dataBase64: string; sha256: string }>("/v1/computer/screenshot", { actor: "ai", expectedEpoch: 1 });
        expect(createHash("sha256").update(Buffer.from(frame.dataBase64, "base64")).digest("hex")).toBe(frame.sha256);
      } finally { await docker(["rm", "--force", name]).catch(() => undefined); await docker(["volume", "rm", ...volumes]).catch(() => undefined); }
    });
  }, 90_000);
});
