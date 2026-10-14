import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ExecutionLogsPage, WorkerExecution, WorkerExecutionRequest, WorkerHealth, RegisteredPort, EnvironmentFileContent } from "@shared/environment-contracts";
import { ENV_FILE_MAX_BYTES, ENV_HTTP_BODY_MAX_BYTES, ENV_WORKER_VERSION } from "@shared/environment-contracts";
import { workerExecutionSchema, workerHealthSchema, workerLogsPageSchema, registeredPortSchema, workerPendingCancelAckSchema } from "@shared/environment-schemas";

const execute = promisify(execFile);
const enabled = process.env.AEVOREN_WORKER_DOCKER_TEST === "1";
const image = process.env.AEVOREN_WORKER_TEST_IMAGE ?? "aevoren-worker-fixture:stage3";
async function docker(args: string[], environment?: NodeJS.ProcessEnv): Promise<string> {
  return (await execute("docker", args, { ...(environment ? { env: environment } : {}), maxBuffer: 2_097_152 })).stdout.trim();
}

async function withContainer(callback: (fixture: { name: string; token: string; environmentId: string; request: <T>(path: string, method?: string, input?: unknown) => Promise<T>; url: string; reconnect: () => Promise<void> }) => Promise<void>): Promise<void> {
  const id = randomUUID();
  const name = `aevoren-worker-test-${id}`;
  const workspace = `${name}-workspace`;
  const state = `${name}-state`;
  const token = randomBytes(32).toString("hex");
  const environmentId = randomUUID();
  try {
    await docker(["run", "--detach", "--name", name, "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--cap-drop", "ALL",
      "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "KILL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges",
      "--pids-limit", "128", "--memory", "512m", "-p", "127.0.0.1::8080", "--mount", `type=volume,source=${workspace},target=/workspace`,
      "--mount", `type=volume,source=${state},target=/var/lib/aevoren`, "-e", "AEVOREN_WORKER_TOKEN", "-e", `AEVOREN_WORKER_ENVIRONMENT_ID=${environmentId}`, image],
    { ...process.env, AEVOREN_WORKER_TOKEN: token });
    let url = "";
    const reconnect = async () => {
      const binding = JSON.parse(await docker(["inspect", "--format", '{{json (index .NetworkSettings.Ports "8080/tcp")}}', name])) as { HostPort: string }[];
      url = `http://127.0.0.1:${binding[0]!.HostPort}`;
    };
    await reconnect();
    const request = async <T>(path: string, method = "GET", input?: unknown): Promise<T> => {
      const response = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10_000) });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error((body as { error: { code: string } }).error.code), { status: response.status });
      return body as T;
    };
    await expect.poll(async () => { try { return (await request<WorkerHealth>("/v1/health")).environmentId; } catch { return null; } }, { timeout: 20_000 }).toBe(environmentId);
    await callback({ name, token, environmentId, request, url, reconnect });
  } finally {
    await docker(["rm", "--force", name]).catch(() => undefined);
    await docker(["volume", "rm", workspace, state]).catch(() => undefined);
  }
}

const command = (script: string, kind: "foreground" | "background" = "foreground", sessionId = randomUUID()): WorkerExecutionRequest => ({
  id: randomUUID(), sessionId, runtimeRunId: kind === "foreground" ? randomUUID() : null, kind, command: script, cwd: ".",
});

describe.skipIf(!enabled)("real isolated Linux Worker", () => {
  it("authenticates, runs six independent UIDs and cancels a double-fork/setsid job without killing sibling tasks", async () => {
    await withContainer(async f => {
      const unauthorized = await fetch(`${f.url}/v1/health`);
      expect(unauthorized.status).toBe(401);
      expect(workerHealthSchema.parse(await f.request("/v1/health"))).toMatchObject({ environmentId: f.environmentId, protocolVersion: 1, workerVersion: ENV_WORKER_VERSION });
      const escaping = command(`python3 - <<'PY'\nimport os,time\nprint('UID',os.getuid(),flush=True)\nif os.fork() == 0:\n os.setsid()\n if os.fork() > 0: os._exit(0)\n print('DETACHED',os.getpid(),flush=True)\nwhile True: time.sleep(1)\nPY`);
      const commands = [escaping, ...Array.from({ length: 5 }, () => command("node -e 'console.log(\"UID\",process.getuid());setInterval(()=>{},1000)'"))];
      const jobs = await Promise.all(commands.map(input => f.request<WorkerExecution>("/v1/executions", "POST", input)));
      expect(jobs.every(job => workerExecutionSchema.parse(job).state === "running")).toBe(true);
      expect(new Set(jobs.map(job => job.pid)).size).toBe(6);
      const uidOf = async (id: string): Promise<number | null> => {
        const page = workerLogsPageSchema.parse(await f.request<ExecutionLogsPage>(`/v1/executions/${id}/logs?after=0`));
        return Number(/UID (\d+)/u.exec(page.logs.map(log => log.text).join(""))?.[1]) || null;
      };
      await expect.poll(async () => (await Promise.all(jobs.map(job => uidOf(job.id)))).filter(Boolean).length).toBe(6);
      const uids = await Promise.all(jobs.map(job => uidOf(job.id)));
      expect(new Set(uids).size).toBe(6);
      expect(uids.every(uid => uid !== null && uid >= 1_010 && uid <= 1_041)).toBe(true);
      await expect.poll(async () => (await f.request<ExecutionLogsPage>(`/v1/executions/${escaping.id}/logs?after=0`)).logs.some(log => log.text.includes("DETACHED"))).toBe(true);
      expect((await f.request<WorkerExecution>(`/v1/executions/${escaping.id}/cancel`, "POST")).state).toBe("cancelled");
      const remained = await docker(["exec", f.name, "python3", "-c", `import os\nuid=${uids[0]}\np=[]\nfor n in os.listdir('/proc'):\n if n.isdigit():\n  try:\n   s=open('/proc/'+n+'/status').read()\n   if '\\nUid:\\t'+str(uid)+'\\t' in s and '\\nState:\\tZ' not in s: p.append(n)\n  except FileNotFoundError: pass\nprint(len(p))`]);
      expect(remained).toBe("0");
      for (const job of jobs.slice(1)) expect((await f.request<WorkerExecution>(`/v1/executions/${job.id}`)).state).toBe("running");
      await Promise.all(jobs.slice(1).map(job => f.request(`/v1/executions/${job.id}/cancel`, "POST")));
    });
  }, 90_000);

  it("keeps registered background services alive across task cancellation, verifies port UID ownership and denies private root data", async () => {
    await withContainer(async f => {
      const sessionId = randomUUID();
      const service = command("python3 -m http.server 3100 --bind 0.0.0.0", "background", sessionId);
      await f.request("/v1/processes", "POST", service);
      const port = { id: randomUUID(), processId: service.id, port: 3_100, label: "real Python fixture" };
      await expect.poll(async () => { try { return registeredPortSchema.parse(await f.request("/v1/ports", "POST", port)).state; } catch { return null; } }).toBe("listening");
      const foreground = command("node -e 'setInterval(()=>{},1000)'", "foreground", sessionId);
      // This test deliberately uses one Runtime identity for its one execution session.
      foreground.runtimeRunId = null;
      await f.request("/v1/executions", "POST", foreground);
      await expect(f.request("/v1/ports", "POST", { ...port, id: randomUUID(), processId: foreground.id })).rejects.toMatchObject({ message: "WORKER_PORT_NOT_OWNED" });
      await f.request(`/v1/execution-sessions/${sessionId}/cancel`, "POST");
      expect((await f.request<WorkerExecution>(`/v1/processes/${service.id}`)).state).toBe("running");
      expect((await f.request<RegisteredPort[]>("/v1/ports"))[0]!.state).toBe("listening");
      const probe = command("python3 - <<'PY'\nimport os\nprint('TOKEN',os.getenv('AEVOREN_WORKER_TOKEN','ABSENT'))\ntry:\n open('/proc/1/environ','rb').read()\n print('ROOT_ENV_VISIBLE')\nexcept PermissionError: print('ROOT_ENV_DENIED')\nos.symlink('/var/lib/aevoren/worker.sqlite','/workspace/root-link')\nPY");
      await f.request("/v1/executions", "POST", probe);
      await expect.poll(async () => (await f.request<WorkerExecution>(`/v1/executions/${probe.id}`)).state).toBe("completed");
      const logs = await f.request<ExecutionLogsPage>(`/v1/executions/${probe.id}/logs?after=0`);
      const output = logs.logs.map(log => log.text).join("");
      expect(output).toContain("TOKEN ABSENT");
      expect(output).toContain("ROOT_ENV_DENIED");
      expect(output.includes(f.token)).toBe(false);
      await expect(f.request("/v1/files/content?path=root-link")).rejects.toMatchObject({ message: "WORKER_PATH_INVALID" });
      const written = await f.request<{ sha256: string }>("/v1/files/content", "PUT", { path: "nested/project.py", content: "print('REAL_FILE_BYTES')\n" });
      expect((await f.request<{ content: string; sha256: string }>("/v1/files/content?path=nested/project.py")).sha256).toBe(written.sha256);
      await expect(f.request("/v1/files/content", "PUT", { path: "nested/project.py", content: "overwrite" })).rejects.toMatchObject({ status: 409 });
      await f.request(`/v1/processes/${service.id}/stop`, "POST");
      expect((await f.request<RegisteredPort[]>("/v1/ports"))[0]!.state).toBe("stopped");
    });
  }, 90_000);

  it("streams real stdout bytes, preserves idempotency and marks active jobs interrupted after container death", async () => {
    await withContainer(async f => {
      const input = command("python3 -c 'import sys;sys.stdout.buffer.write(bytes([0,255,128,65]));sys.stdout.flush()'");
      await f.request("/v1/executions", "POST", input);
      const stream = await fetch(`${f.url}/v1/executions/${input.id}/events?after=0`, { headers: { authorization: `Bearer ${f.token}` }, signal: AbortSignal.timeout(10_000) });
      const frames = (await stream.text()).split("\n\n").filter(Boolean);
      const logs = frames.filter(frame => frame.startsWith("event: log")).map(frame => JSON.parse(frame.split("\ndata: ")[1]!)) as ExecutionLogsPage["logs"];
      expect(Buffer.concat(logs.filter(log => log.stream === "stdout" && log.bytesBase64).map(log => Buffer.from(log.bytesBase64!, "base64")))).toEqual(Buffer.from([0, 255, 128, 65]));
      expect(frames.at(-1)).toContain("event: end");
      expect((await f.request<WorkerExecution>("/v1/executions", "POST", input)).state).toBe("completed");
      await expect(f.request("/v1/executions", "POST", { ...input, command: "different" })).rejects.toMatchObject({ status: 409 });
      const live = command("node -e 'setInterval(()=>{},1000)'");
      await f.request("/v1/executions", "POST", live);
      const firstBoot = (await f.request<WorkerHealth>("/v1/health")).bootId;
      await docker(["kill", "--signal", "KILL", f.name]);
      await docker(["start", f.name]);
      await f.reconnect();
      await expect.poll(async () => { try { return (await f.request<WorkerHealth>("/v1/health")).bootId !== firstBoot; } catch { return false; } }, { timeout: 10_000 }).toBe(true);
      expect((await f.request<WorkerExecution>(`/v1/executions/${live.id}`)).state).toBe("interrupted");
      expect((await f.request<WorkerExecution>("/v1/executions", "POST", live)).state).toBe("interrupted");
    });
  }, 90_000);

  it("bounds actual retained stdout, resets an expired SSE cursor and reports a real timeout failure", async () => {
    await withContainer(async f => {
      const large = command("python3 -c 'import sys;sys.stdout.write(\"x\"*2097152);sys.stdout.flush()'");
      await f.request("/v1/executions", "POST", large);
      await expect.poll(async () => (await f.request<WorkerExecution>(`/v1/executions/${large.id}`)).state, { timeout: 10_000 }).toBe("completed");
      const page = workerLogsPageSchema.parse(await f.request(`/v1/executions/${large.id}/logs?after=0&limit=500`));
      expect(page.truncated).toBe(true);
      expect(page.firstSeq).toBeGreaterThan(1);
      expect(page.logs.length).toBeGreaterThan(0);
      await expect(f.request(`/v1/executions/${large.id}/logs?after=1`)).rejects.toMatchObject({ status: 410 });
      const stream = await fetch(`${f.url}/v1/executions/${large.id}/events?after=1`, { headers: { authorization: `Bearer ${f.token}` }, signal: AbortSignal.timeout(10_000) });
      const frames = await stream.text();
      expect(frames.startsWith("event: reset\n")).toBe(true);
      expect(frames).toContain("event: end\n");
      const timeout = { ...command("sleep 60"), timeoutMs: 50 };
      await f.request("/v1/executions", "POST", timeout);
      await expect.poll(async () => (await f.request<WorkerExecution>(`/v1/executions/${timeout.id}`)).state, { timeout: 10_000 }).toBe("failed");
      expect(await f.request(`/v1/executions/${timeout.id}`)).toMatchObject({ errorCode: "WORKER_COMMAND_TIMEOUT", signal: "SIGTERM" });
    });
  }, 90_000);

  it("holds all 32 UID slots until their processes have stopped and then allows a fresh job", async () => {
    await withContainer(async f => {
      const inputs = Array.from({ length: 32 }, () => command("sleep 60"));
      for (const input of inputs) await f.request("/v1/executions", "POST", input);
      await expect(f.request("/v1/executions", "POST", command("sleep 60"))).rejects.toMatchObject({ message: "WORKER_CAPACITY_EXCEEDED", status: 409 });
      await f.request(`/v1/executions/${inputs[0]!.id}/cancel`, "POST");
      const fresh = command("printf 'FRESH_SLOT'\n");
      await f.request("/v1/executions", "POST", fresh);
      await expect.poll(async () => (await f.request<WorkerExecution>(`/v1/executions/${fresh.id}`)).state, { timeout: 10_000 }).toBe("completed");
      await Promise.all(inputs.slice(1).map(input => f.request(`/v1/executions/${input.id}/cancel`, "POST")));
      expect((await f.request<WorkerExecution[]>("/v1/executions")).every(job => job.state !== "running")).toBe(true);
    });
  }, 90_000);

  it("keeps a registered double-fork background server running after its launcher exits and stops all of its UID descendants", async () => {
    await withContainer(async f => {
      const input = command("python3 - <<'PY'\nimport os,http.server\nif os.fork() > 0: os._exit(0)\nos.setsid()\nif os.fork() > 0: os._exit(0)\nhttp.server.HTTPServer(('0.0.0.0',3110),http.server.SimpleHTTPRequestHandler).serve_forever()\nPY", "background");
      const started = await f.request<WorkerExecution>("/v1/processes", "POST", input);
      const port = { id: randomUUID(), processId: input.id, port: 3_110, label: "detached registered service" };
      await expect.poll(async () => { try { return (await f.request<RegisteredPort>("/v1/ports", "POST", port)).state; } catch { return null; } }, { timeout: 10_000 }).toBe("listening");
      await expect.poll(async () => (await f.request<WorkerExecution>(`/v1/processes/${input.id}`)).pid, { timeout: 10_000 }).not.toBe(started.pid);
      expect((await f.request<WorkerExecution>(`/v1/processes/${input.id}`)).state).toBe("running");
      const stopped = await f.request<WorkerExecution>(`/v1/processes/${input.id}/stop`, "POST");
      expect(stopped).toMatchObject({ state: "cancelled", exitCode: null, signal: null });
      expect((await f.request<RegisteredPort[]>("/v1/ports"))[0]!.state).toBe("stopped");
    });
  }, 90_000);

  it("round-trips a full 1 MiB of valid newline/NUL/quoted UTF8 bytes without confusing JSON size with file size", async () => {
    await withContainer(async f => {
      for (const [index, character] of ["\n", "\0", '"', "😀"].entries()) {
        const content = character.repeat(ENV_FILE_MAX_BYTES / Buffer.byteLength(character));
        const path = `full-size-${index}.txt`;
        const write = await f.request<{ size: number; sha256: string }>("/v1/files/content", "PUT", { path, content, encoding: "utf8" });
        const read = await f.request<EnvironmentFileContent>(`/v1/files/content?path=${path}`);
        const bytes = Buffer.from(read.content, read.encoding === "base64" ? "base64" : "utf8");
        expect(bytes.length).toBe(ENV_FILE_MAX_BYTES);
        expect(write.size).toBe(ENV_FILE_MAX_BYTES);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(createHash("sha256").update(content).digest("hex"));
        expect(read.sha256).toBe(write.sha256);
      }
      await expect(f.request("/v1/files/content", "PUT", { path: "oversized.txt", content: "x".repeat(ENV_FILE_MAX_BYTES + 1) })).rejects.toMatchObject({ status: 400 });
      const response = await fetch(`${f.url}/v1/files/content`, { method: "PUT", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
        body: JSON.stringify({ path: "escaped-too-large.txt", content: "\0".repeat(ENV_FILE_MAX_BYTES + 20_000) }), signal: AbortSignal.timeout(10_000) });
      expect(Buffer.byteLength(JSON.stringify({ path: "escaped-too-large.txt", content: "\0".repeat(ENV_FILE_MAX_BYTES + 20_000) }))).toBeGreaterThan(ENV_HTTP_BODY_MAX_BYTES);
      expect(response.status).toBe(413);
    });
  }, 90_000);

  it("seals a cancelled execution session before a late foreground request without stopping its registered background process", async () => {
    await withContainer(async f => {
      const sessionId = randomUUID();
      const background = command("python3 -m http.server 3111 --bind 0.0.0.0", "background", sessionId);
      await f.request("/v1/processes", "POST", background);
      const port = { id: randomUUID(), processId: background.id, port: 3_111, label: "independent registered fixture" };
      await expect.poll(async () => { try { return (await f.request<RegisteredPort>("/v1/ports", "POST", port)).state; } catch { return null; } }, { timeout: 10_000 }).toBe("listening");
      expect(await f.request(`/v1/execution-sessions/${sessionId}/cancel`, "POST")).toEqual([]);
      const late = { ...command("printf 'MUST_NOT_START' > cancelled-side-effect.txt", "foreground", sessionId), runtimeRunId: null };
      await expect(f.request("/v1/executions", "POST", late)).rejects.toMatchObject({ message: "WORKER_SESSION_CANCELLED", status: 409 });
      expect((await f.request<WorkerExecution>(`/v1/processes/${background.id}`)).state).toBe("running");
      expect((await f.request<WorkerExecution[]>("/v1/executions")).map(job => job.id)).toEqual([background.id]);
      const files = await f.request<{ entries: { path: string }[] }>("/v1/files?path=.");
      expect(files.entries.some(file => file.path === "cancelled-side-effect.txt")).toBe(false);
      await f.request(`/v1/processes/${background.id}/stop`, "POST");
    });
  }, 90_000);

  it("acknowledges one early per-id cancellation without stopping siblings in the same execution session", async () => {
    await withContainer(async f => {
      const sessionId = randomUUID();
      const background = command("python3 -m http.server 3112 --bind 0.0.0.0", "background", sessionId);
      const sibling = { ...command("sleep 60", "foreground", sessionId), runtimeRunId: null };
      await f.request("/v1/processes", "POST", background);
      await f.request("/v1/executions", "POST", sibling);
      const late = { ...command("printf 'MUST_NOT_START' > id-cancelled-side-effect.txt", "foreground", sessionId), runtimeRunId: null };
      expect(workerPendingCancelAckSchema.parse(await f.request(`/v1/executions/${late.id}/cancel`, "POST"))).toEqual({ id: late.id, state: "cancelled", pending: true });
      await expect(f.request("/v1/executions", "POST", late)).rejects.toMatchObject({ message: "WORKER_JOB_CANCELLED", status: 409 });
      expect((await f.request<WorkerExecution>(`/v1/executions/${sibling.id}`)).state).toBe("running");
      expect((await f.request<WorkerExecution>(`/v1/processes/${background.id}`)).state).toBe("running");
      expect((await f.request<WorkerExecution[]>("/v1/executions")).map(job => job.id).toSorted()).toEqual([sibling.id, background.id].toSorted());
      const files = await f.request<{ entries: { path: string }[] }>("/v1/files?path=.");
      expect(files.entries.some(file => file.path === "id-cancelled-side-effect.txt")).toBe(false);
      await f.request(`/v1/executions/${sibling.id}/cancel`, "POST");
      await f.request(`/v1/processes/${background.id}/stop`, "POST");
    });
  }, 90_000);
});
