import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest, PromptManifest, RuntimeRun } from "@shared/contracts";
import type { EnvironmentScope, Execution } from "@shared/environment-contracts";
import type { SkillExecutionGrant, SkillScriptExecution } from "@shared/skill-execution-contracts";
import { AppRepository } from "./database";
import { LibraryService } from "./library-service";
import { EnvironmentService } from "./environment-service";
import { SkillExecutionService } from "./skill-execution-service";
import { DockerDriver } from "./docker-driver";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
const dockerCommand = promisify(execFile), selected = (run: RuntimeRun): EnvironmentScope => ({ sessionId: run.sessionId, executorBotId: run.executorBotId });
type Receipt<T> = { ok: boolean; status: string; result: T; reused?: boolean };

// Actual imports, SQLite, approval gateway and Linux processes. No model inference or user's app/profile is involved.
describe.skipIf(process.env.AEVOREN_SKILL_DOCKER_TEST !== "1")("script host and AI approvals with real isolated Docker", () => {
  let root: string, repository: AppRepository, library: LibraryService, environments: EnvironmentService, skills: SkillExecutionService;
  let product: ProductOperationService, executor: WorkspaceToolExecutor;
  const driver = new DockerDriver();
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "aevoren-script-host-docker-")); repository = new AppRepository(join(root, "app.sqlite"));
    library = new LibraryService(repository, join(root, "owned"));
    environments = new EnvironmentService(repository.environments, { isAvailable: () => true,
      encrypt: value => Buffer.from(value).toString("base64"), decrypt: value => Buffer.from(value, "base64").toString() },
    join(process.cwd(), "out", "worker"), () => undefined, driver);
    await environments.initialize(); skills = new SkillExecutionService(repository, library, environments);
    executor = new WorkspaceToolExecutor(repository, new WorkspaceService(repository));
    product = new ProductOperationService({ repository, skillExecutionService: skills, environmentService: environments, libraryService: library } as unknown as ProductDependencies);
    executor.setProductOperations(product);
  }, 900_000);
  afterEach(async () => {
    if (!repository) return;
    for (const record of repository.environments.listInternal()) {
      await environments.stop({ sessionId: record.sessionId, executorBotId: record.executorBotId }).catch(() => undefined);
      await driver.remove(record.id).catch(() => undefined);
      await dockerCommand("docker", ["volume", "rm", `aevoren-work-${record.id}`, `aevoren-state-${record.id}`]).catch(() => undefined);
      expect(await driver.inspect(record.id)).toBeNull();
    }
  }, 120_000);
  afterAll(async () => {
    if (!repository) return;
    await environments.shutdown(); repository.close(); rmSync(root, { recursive: true, force: true });
  });
  function runtime(): RuntimeRun {
    const actor = repository.createBot(), nonce = randomUUID(); repository.prepareMessage({ sessionId: actor.session.id, clientNonce: nonce, text: "明确执行固定版本的隔离脚本" });
    const run = repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: actor.bot.id, profileVersion: 1, sessionId: actor.session.id,
      generation: 1, inputSeq: 1, blocks: [], digest: "actual-script-gateway" });
    repository.transitionRuntimeRun(run.id, "dispatching"); return repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "fixture-no-inference" });
  }
  async function imported(scope: EnvironmentScope, scripts: Record<string, string | Buffer>) {
    const directory = join(root, `source-${randomUUID()}`); mkdirSync(join(directory, "scripts"), { recursive: true }); mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "SKILL.md"), "---\nname: host-script-fixture\ndescription: Actual isolated script acceptance\n---\nOriginal owned body.\n");
    for (const [path, bytes] of Object.entries(scripts)) writeFileSync(join(directory, "scripts", path), bytes);
    writeFileSync(join(directory, "assets", "payload.png"), Buffer.from([0, 255, 128, 1]));
    const content = (await library.importPaths(scope.sessionId, [directory], "skill", undefined, scope.executorBotId)).imported[0]!;
    rmSync(directory, { recursive: true }); return content;
  }
  async function grant(scope: EnvironmentScope, content: Awaited<ReturnType<typeof imported>>, entryPath: string, interpreter: SkillExecutionGrant["interpreter"]) {
    const environment = repository.environments.get(scope)!;
    return skills.grantExecution({ ...scope, environmentId: environment.id, expectedImageDigest: environment.imageDigest, expectedWorkerVersion: environment.workerVersion,
      reference: content.reference, entryPath, interpreter });
  }
  async function approved<T>(run: RuntimeRun, operation: string, input?: unknown): Promise<Receipt<T>> {
    const tool: ProductToolRequest = { kind: "product-call", action: "execute", operation, ...(input === undefined ? {} : { input }) };
    const review = operation === "skills.runScript" ? skills.approvalReview(input, selected(run)) : undefined;
    const prepared = repository.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool }, undefined, product.preview(tool), review);
    await expect(executor.execute(prepared.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    if (review) expect(repository.getApprovalReview({ ...selected(run), id: prepared.approval.id, expectedVersion: 1 })).toEqual({ snapshot: review, executable: true });
    repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
    const result = await executor.execute(prepared.invocation.id); expect(result.invocation.state).toBe("succeeded"); return JSON.parse(result.content) as Receipt<T>;
  }
  async function completed(scope: EnvironmentScope, id: string): Promise<Execution> {
    await expect.poll(async () => (await environments.getExecution({ ...scope, id })).state, { timeout: 20_000 }).toBe("completed");
    return environments.getExecution({ ...scope, id });
  }
  async function output(scope: EnvironmentScope, id: string): Promise<string> {
    return (await environments.logs({ ...scope, id })).logs.filter(log => log.stream === "stdout").map(log => log.text).join("");
  }
  const longScript = 'console.log("SCRIPT_STARTED");setInterval(()=>console.log("SCRIPT_TICK"),1000);\n';

  it("executes real Node, Python and Bash argv from owned bytes with a read-only package through genuine approvals", async () => {
    const run = runtime(), scope = selected(run); await approved(run, "environments.start");
    const node = '\uFEFFimport fs from "node:fs";import path from "node:path";import{fileURLToPath}from"node:url";const file=fileURLToPath(import.meta.url);let denied=false;try{fs.writeFileSync(file,"MUST_NOT_WRITE")}catch(e){denied=e.code==="EACCES"}const asset=fs.readFileSync(path.join(path.dirname(file),"../assets/payload.png")).toString("hex");fs.writeFileSync("once.txt",String(Number(fs.existsSync("once.txt")?fs.readFileSync("once.txt","utf8"):0)+1));console.log(JSON.stringify({args:process.argv.slice(2),denied,asset}));\n';
    const python = 'import sys,json,pathlib\np=pathlib.Path(__file__)\ndenied=False\ntry:\n p.write_text("MUST_NOT_WRITE")\nexcept PermissionError:\n denied=True\nprint(json.dumps({"args":sys.argv[1:],"denied":denied,"asset":(p.parent.parent/"assets/payload.png").read_bytes().hex()},ensure_ascii=False))\n';
    const bash = '#!/bin/bash\nset -eu\nprintf "BASH_ARG=%s\\n" "$@"\nif printf MUST_NOT_WRITE > "$0";then exit 91;else printf "BASH_READ_ONLY\\n";fi\n';
    const content = await imported(scope, { "node.mjs": node, "python.py": python, "bash.sh": bash });
    const args = ["你好 🌈", "literal $(touch SHOULD_NOT_EXIST)", "a b"];
    const entries = [["scripts/node.mjs", "node"], ["scripts/python.py", "python"], ["scripts/bash.sh", "bash"]] as const;
    for (const [entryPath, interpreter] of entries) {
      const permission = await grant(scope, content, entryPath, interpreter);
      const input = { grantId: permission.id, expectedGrantVersion: permission.version, args };
      const receipt = await approved<SkillScriptExecution>(run, "skills.runScript", input);
      expect((await completed(scope, receipt.result.execution.id)).exitCode).toBe(0);
      const stdout = await output(scope, receipt.result.execution.id);
      if (interpreter === "bash") { expect(stdout).toContain("BASH_READ_ONLY"); args.forEach(value => expect(stdout).toContain(`BASH_ARG=${value}`)); }
      else expect(JSON.parse(stdout.trim())).toEqual({ args, denied: true, asset: "00ff8001" });
      const replay = await approved<SkillScriptExecution>(run, "skills.runScript", { ...input, cwd: ".", timeoutMs: 120_000 });
      expect(replay.reused).toBe(true); expect(replay.result.execution.id).toBe(receipt.result.execution.id);
    }
    expect((await environments.readFile({ ...scope, path: "once.txt" })).content).toBe("1");
    expect((await environments.listFiles(scope)).entries.some(file => file.path === "SHOULD_NOT_EXIST")).toBe(false);
    repository.transitionRuntimeRun(run.id, "completed");
  }, 180_000);

  it("preserves a running fixed revision on edits and cancels only revoked scripts while a sibling and background remain alive", async () => {
    const run = runtime(), scope = selected(run); await environments.start(scope);
    const first = await imported(scope, { "long.mjs": longScript }), other = await imported(scope, { "long.mjs": longScript });
    const permission = await grant(scope, first, "scripts/long.mjs", "node"), siblingGrant = await grant(scope, other, "scripts/long.mjs", "node");
    const launched = await skills.runScript({ ...scope, clientNonce: randomUUID(), grantId: permission.id, expectedGrantVersion: 1 });
    const sibling = await skills.runScript({ ...scope, clientNonce: randomUUID(), grantId: siblingGrant.id, expectedGrantVersion: 1 });
    const background = await environments.run({ ...scope, clientNonce: randomUUID(), command: 'node -e \'console.log("BACKGROUND_STARTED");setInterval(()=>console.log("BACKGROUND_TICK"),1000)\'' }, null, true);
    await expect.poll(() => output(scope, launched.execution.id), { timeout: 10_000 }).toContain("SCRIPT_STARTED");
    const edited = repository.library.update({ sessionId: scope.sessionId, id: first.resource.id, expectedVersion: 1, body: "NEW_REVISION_BODY" });
    await skills.libraryChanged({ sessionId: scope.sessionId, resourceId: first.resource.id, action: "updated" });
    expect((await environments.getExecution({ ...scope, id: launched.execution.id })).state).toBe("running");
    expect((await skills.scriptExecution({ ...scope, id: launched.execution.id })).reference).toEqual(first.reference);
    await skills.revokeExecution({ ...scope, id: permission.id, expectedVersion: 1 });
    expect((await environments.getExecution({ ...scope, id: launched.execution.id })).state).toBe("cancelled");
    expect((await environments.getExecution({ ...scope, id: sibling.execution.id })).state).toBe("running");
    expect((await environments.getExecution({ ...scope, id: background.id })).state).toBe("running");
    const restored = await skills.grantExecution({ ...scope, environmentId: permission.environmentId, expectedImageDigest: permission.imageDigest,
      expectedWorkerVersion: permission.workerVersion, reference: first.reference, entryPath: permission.entryPath, interpreter: permission.interpreter, expectedVersion: 2 });
    const next = await skills.runScript({ ...scope, clientNonce: randomUUID(), grantId: restored.id, expectedGrantVersion: restored.version });
    repository.library.unbind({ sessionId: scope.sessionId, id: edited.resource.id });
    await skills.libraryChanged({ sessionId: scope.sessionId, resourceId: first.resource.id, action: "unbound" });
    expect((await environments.getExecution({ ...scope, id: next.execution.id })).state).toBe("cancelled");
    expect((await environments.getExecution({ ...scope, id: sibling.execution.id })).state).toBe("running");
    expect((await environments.getExecution({ ...scope, id: background.id })).state).toBe("running");
    await expect(skills.runScript({ ...scope, clientNonce: randomUUID(), grantId: restored.id, expectedGrantVersion: restored.version })).rejects.toMatchObject({ code: "LIBRARY_NOT_BOUND" });
    await environments.cancel({ ...scope, id: sibling.execution.id }); await environments.cancel({ ...scope, id: background.id });
    repository.transitionRuntimeRun(run.id, "completed");
  }, 180_000);

  it("queries a genuinely accepted but unconfirmed script after a dropped response without dispatching its nonce again", async () => {
    const run = runtime(), scope = selected(run); await environments.start(scope);
    const content = await imported(scope, { "once.mjs": 'import fs from"node:fs";fs.writeFileSync("unknown-count.txt",String(Number(fs.existsSync("unknown-count.txt")?fs.readFileSync("unknown-count.txt","utf8"):0)+1));await new Promise(r=>setTimeout(r,1200));console.log("ACTUAL_UNKNOWN_ONCE");\n' });
    const permission = await grant(scope, content, "scripts/once.mjs", "node"), original = repository.environments.getInternal(scope)!;
    const token = Buffer.from(original.encryptedToken!, "base64").toString(), upstreamPort = original.workerPort!;
    let posts = 0, dropped = false, acceptanceStatus: number | undefined, accepted: { id: string; environmentId: string } | undefined;
    const proxy = createServer(async (request, response) => {
      try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const upstream = await fetch(`http://127.0.0.1:${upstreamPort}${request.url}`, { method: request.method, redirect: "error",
        headers: { authorization: `Bearer ${token}`, ...(chunks.length ? { "content-type": "application/json" } : {}) },
        ...(chunks.length ? { body: Buffer.concat(chunks).toString("utf8") } : {}) });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (request.url === "/v1/skill-runs") {
        posts++; acceptanceStatus = upstream.status;
        if (upstream.ok && !dropped) { accepted = JSON.parse(bytes.toString("utf8")); dropped = true; response.destroy(); return; }
      }
      response.statusCode = upstream.status; response.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json"); response.end(bytes);
      } catch { response.destroy(); }
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    repository.environments.update(scope, original.version, { workerPort: (proxy.address() as { port: number }).port });
    const input = { ...scope, clientNonce: randomUUID(), grantId: permission.id, expectedGrantVersion: 1 };
    try {
      await expect(skills.runScript(input)).rejects.toMatchObject({ code: "ENVIRONMENT_UNAVAILABLE" });
      const unconfirmed = repository.environments.findExecutionByNonce(scope, input.clientNonce)!;
      expect(unconfirmed.state).toBe("unknown"); expect(posts).toBe(1); expect(dropped).toBe(true);
      expect(acceptanceStatus).toBe(202); expect(accepted).toMatchObject({ id: unconfirmed.id, environmentId: original.id });
      const queried = await skills.runScript(input); expect(queried.execution.id).toBe(unconfirmed.id);
      await completed(scope, unconfirmed.id);
      expect((await environments.readFile({ ...scope, path: "unknown-count.txt" })).content).toBe("1"); expect(posts).toBe(1);
    } finally {
      const current = repository.environments.getInternal(scope)!; repository.environments.update(scope, current.version, { workerPort: upstreamPort });
      proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
    repository.transitionRuntimeRun(run.id, "completed");
  }, 180_000);

  it("starts all six explicitly scoped Room scripts through approvals before any completes, without private grants or shared results", async () => {
    const bots = Array.from({ length: 6 }, () => repository.createBot().bot), detail = repository.createRoom({ memberBotIds: bots.map(bot => bot.id), leadBotId: null });
    const prepared = repository.createRoomRunWithInitialTurns({ roomId: detail.room.id, sessionId: detail.session.id, clientNonce: randomUUID(), text: "@所有人 各自执行脚本",
      membershipVersion: detail.room.membershipVersion, maxTurns: 8, maxHops: 6, maxTargetsPerTurn: 2, deadlineAt: new Date(Date.now() + 300_000).toISOString(),
      initialTurns: bots.map(bot => ({ agentId: bot.id, nonce: randomUUID() })), routingMode: "everyone", orchestrationEnabled: false });
    repository.transitionRoomBatch(prepared.run.id, "running");
    const runs = prepared.turns.map(original => {
      const turn = repository.transitionRoomTurn(original.id, "running", { promptCutoffSeq: original.inputSeq });
      const manifest: PromptManifest = { schemaVersion: 2, botId: turn.memberBotId, profileVersion: 1, sessionId: detail.session.id, generation: turn.inputGeneration,
        inputSeq: turn.inputSeq, promptCutoffSeq: turn.inputSeq, roomId: detail.room.id, roomMembershipVersion: prepared.run.membershipVersion,
        executorBotId: turn.memberBotId, sourceTurnId: turn.id, blocks: [], digest: "real-script-room" };
      const run = repository.createRuntimeRun(prepared.run.clientNonce, "fake", manifest, { executorBotId: turn.memberBotId,
        executionKey: `${prepared.run.id}:${turn.logicalTurnId}`, inputSeq: turn.inputSeq, promptCutoffSeq: turn.inputSeq });
      repository.attachRoomTurnRuntime(turn.id, run.id); repository.transitionRuntimeRun(run.id, "dispatching");
      return repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "fixture-no-inference" });
    });
    const content = await imported(selected(runs[0]!), { "wait.mjs": 'import fs from"node:fs";console.log("SCOPED_SCRIPT_STARTED");while(!fs.existsSync("finish.flag")){await new Promise(r=>setTimeout(r,20))}console.log("SCOPED_SCRIPT_DONE");\n' });
    await Promise.all(runs.map(run => approved(run, "environments.start")));
    const permissions = await Promise.all(runs.map(run => grant(selected(run), content, "scripts/wait.mjs", "node")));
    const receipts = await Promise.all(runs.map((run, index) => approved<SkillScriptExecution>(run, "skills.runScript", { grantId: permissions[index]!.id, expectedGrantVersion: 1 })));
    expect(new Set(receipts.map(receipt => receipt.result.execution.id)).size).toBe(6);
    expect(new Set(receipts.map(receipt => receipt.result.environmentId)).size).toBe(6);
    for (const [index, run] of runs.entries()) {
      await expect.poll(() => output(selected(run), receipts[index]!.result.execution.id), { timeout: 15_000 }).toContain("SCOPED_SCRIPT_STARTED");
      expect((await environments.getExecution({ ...selected(run), id: receipts[index]!.result.execution.id })).state).toBe("running");
      expect(repository.library.list({ sessionId: repository.getMainSession(run.executorBotId).id })).toEqual([]);
    }
    expect(() => skills.approvalReview({ grantId: permissions[1]!.id, expectedGrantVersion: 1 }, selected(runs[0]!))).toThrowError(expect.objectContaining({ code: "SKILL_GRANT_NOT_FOUND" }));
    await expect(skills.scriptExecution({ ...selected(runs[1]!), id: receipts[0]!.result.execution.id })).rejects.toMatchObject({ code: "ENVIRONMENT_EXECUTION_NOT_FOUND" });
    await Promise.all(runs.map(run => environments.writeFile({ ...selected(run), path: "finish.flag", content: "go" })));
    await Promise.all(runs.map((run, index) => completed(selected(run), receipts[index]!.result.execution.id)));
    const repeated = await Promise.all(runs.map((run, index) => approved<SkillScriptExecution>(run, "skills.runScript", { grantId: permissions[index]!.id, expectedGrantVersion: 1, args: [], cwd: ".", timeoutMs: 120_000 })));
    expect(repeated.map(receipt => receipt.result.execution.id)).toEqual(receipts.map(receipt => receipt.result.execution.id));
    expect(repeated.every(receipt => receipt.reused === true)).toBe(true);
  }, 240_000);
});
