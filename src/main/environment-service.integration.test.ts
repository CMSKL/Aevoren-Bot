import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppRepository } from "./database";
import { DockerDriver } from "./docker-driver";
import { EnvironmentService } from "./environment-service";
import type { EnvironmentScope } from "@shared/environment-contracts";

// Explicit opt-in: this builds a local worker and creates only fixture-owned containers/volumes.
describe.skipIf(process.env.AEVOREN_DOCKER_INTEGRATION !== "1")("host service with actual local Linux Docker", () => {
  let data: string;
  let repository: AppRepository;
  const docker = new DockerDriver();
  const scopes: EnvironmentScope[] = [];
  let service: EnvironmentService;
  beforeAll(async () => {
    data = mkdtempSync(join(tmpdir(), "aevoren-env-service-"));
    repository = new AppRepository(join(data, "app.sqlite"));
    service = new EnvironmentService(repository.environments, { isAvailable: () => true,
      encrypt: value => Buffer.from(value).toString("base64"), decrypt: value => Buffer.from(value, "base64").toString() }, join(process.cwd(), "out", "worker"), () => undefined, docker);
    expect((await service.probe()).daemonReachable).toBe(true); await service.initialize();
  }, 600_000);
  afterAll(async () => {
    await service.shutdown();
    for (const environment of repository.environments.listInternal()) { await docker.stop(environment.id).catch(() => undefined); await docker.remove(environment.id).catch(() => undefined); }
    repository.close(); rmSync(data, { recursive: true, force: true });
  });
  function scope(): EnvironmentScope {
    const value = repository.createBot();
    const result = { sessionId: value.session.id, executorBotId: value.bot.id }; scopes.push(result); return result;
  }

  it("runs Node/Python, transfers actual bytes, observes exit/logs and preserves files across sleep", async () => {
    const owner = scope();
    const started = await service.start(owner);
    expect(started.state).toBe("running");
    expect(JSON.stringify(started)).not.toMatch(/encryptedToken|workerPort|containerId/);
    const file = await service.writeFile({ ...owner, path: "hello.py", content: 'print("PYTHON_ACTUAL_RESULT")\n' });
    const read = await service.readFile({ ...owner, path: "hello.py" });
    expect(read.sha256).toBe(file.sha256);
    const execution = await service.run({ ...owner, clientNonce: randomUUID(), command: 'node -e "console.log(6 * 7)"; python3 hello.py' });
    await expect.poll(async () => (await service.getExecution({ ...owner, id: execution.id })).state).toBe("completed");
    const result = await service.getExecution({ ...owner, id: execution.id });
    expect(result.exitCode).toBe(0);
    expect((await service.getExecution({ ...owner, id: execution.id })).version).toBe(result.version);
    const logs = await service.logs({ ...owner, id: execution.id });
    expect(logs.logs.map(log => log.text).join("")).toContain("PYTHON_ACTUAL_RESULT");
    expect(logs.logs.map(log => log.text).join("")).toContain("42");
    const bytes = Buffer.from([0, 255, 137, 80]);
    await service.writeFile({ ...owner, path: "bytes.bin", content: bytes.toString("base64"), encoding: "base64" });
    const binary = await service.readFile({ ...owner, path: "bytes.bin" });
    expect(Buffer.from(binary.content, binary.encoding === "base64" ? "base64" : "utf8")).toEqual(bytes);
    const stopped = await service.stop(owner);
    expect(stopped.state).toBe("stopped");
    await service.start({ ...owner, expectedVersion: stopped.version });
    expect((await service.readFile({ ...owner, path: "hello.py" })).content).toBe(read.content);
  }, 120_000);

  it("starts six independent jobs before any completion and cancellation does not kill siblings", async () => {
    const members = Array.from({ length: 6 }, scope);
    const environments = await Promise.all(members.map(member => service.start(member)));
    expect(new Set(environments.map(environment => environment.id)).size).toBe(6);
    const jobs = await Promise.all(members.map((member, index) => service.run({ ...member, clientNonce: randomUUID(), command: `printf 'STARTED_${index}\\n'; sleep 10; printf 'DONE_${index}\\n'` })));
    expect(jobs.every(job => job.state === "running")).toBe(true);
    const cancelled = await service.cancel({ ...members[0]!, id: jobs[0]!.id });
    expect(cancelled.state).toBe("cancelled");
    const other = await Promise.all(members.slice(1).map((member, index) => service.getExecution({ ...member, id: jobs[index + 1]!.id })));
    expect(other.every(job => job.state === "running")).toBe(true);
    for (const [index, member] of members.slice(1).entries()) await service.cancel({ ...member, id: jobs[index + 1]!.id });
    await expect(service.getExecution({ ...members[1]!, id: jobs[0]!.id })).rejects.toMatchObject({ code: "ENVIRONMENT_EXECUTION_NOT_FOUND" });
  }, 120_000);

  it("retains an independent background service, checks real ports and never replays one nonce", async () => {
    const owner = scope(); await service.start(owner);
    const nonce = randomUUID();
    const background = await service.run({ ...owner, clientNonce: nonce, command: "python3 -m http.server 8127" }, null, true);
    expect(background.kind).toBe("background");
    let port: Awaited<ReturnType<EnvironmentService["registerPort"]>> | undefined;
    await expect.poll(async () => {
      try { port = await service.registerPort({ ...owner, processId: background.id, port: 8127, label: "actual-python-service" }); return port.state; }
      catch { return "not-ready"; }
    }).toBe("listening");
    expect((await service.listPorts(owner))[0]?.id).toBe(port!.id);
    const repeated = await service.run({ ...owner, clientNonce: nonce, command: "python3 -m http.server 8127" }, null, true);
    expect(repeated.id).toBe(background.id);
    expect((await service.listExecutions(owner, "background"))).toHaveLength(1);
    await expect(service.run({ ...owner, clientNonce: nonce, command: "echo DIFFERENT" }, null, true)).rejects.toMatchObject({ code: "ENVIRONMENT_EXECUTION_CONFLICT" });
    expect((await service.cancel({ ...owner, id: background.id })).state).toBe("cancelled");
  }, 120_000);

  it("retires only the deleted Bot while another background service keeps running", async () => {
    const owner = scope(), peer = scope();
    await Promise.all([service.start(owner), service.start(peer)]);
    const [first, other] = await Promise.all([owner, peer].map(member => service.run({ ...member, clientNonce: randomUUID(), command: "sleep 120" }, null, true)));
    const retired = repository.environments.get(owner)!;
    await service.retire([], [owner.executorBotId], () => repository.assertBotDeletable(owner.executorBotId), () => repository.deleteBot(owner.executorBotId));
    expect(await docker.inspect(retired.id)).toBeNull();
    expect(repository.environments.listInternal().some(environment => environment.id === first!.environmentId)).toBe(false);
    expect((await service.getExecution({ ...peer, id: other!.id })).state).toBe("running");
    await expect(service.start(owner)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await service.cancel({ ...peer, id: other!.id });
  }, 120_000);

  it("recovers existing foreground tasks without replaying them or stopping independent services", async () => {
    const owner = scope(); await service.start(owner);
    const foreground = await service.run({ ...owner, clientNonce: randomUUID(), command: "sleep 120" });
    const background = await service.run({ ...owner, clientNonce: randomUUID(), command: "sleep 120" }, null, true);
    const recovery = service.recover();
    const fresh = await service.run({ ...owner, clientNonce: randomUUID(), command: "sleep 120" });
    await recovery;
    expect((await service.getExecution({ ...owner, id: foreground.id })).state).toBe("cancelled");
    expect((await service.getExecution({ ...owner, id: background.id })).state).toBe("running");
    expect((await service.getExecution({ ...owner, id: fresh.id })).state).toBe("running");
    expect(await service.listExecutions(owner)).toHaveLength(3);
    await Promise.all([background, fresh].map(job => service.cancel({ ...owner, id: job.id })));
  }, 120_000);
});
