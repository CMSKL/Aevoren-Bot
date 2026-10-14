import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest } from "@shared/contracts";
import type { LibraryContent, LibraryResource, ResourceRevisionSummary } from "@shared/library-contracts";
import { AppRepository } from "./database";
import { GeneralSettingsService } from "./settings";
import { LibraryService } from "./library-service";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";
import { RoomCoordinator } from "./room-coordinator";
import { SendWorker } from "./send-worker";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
const cleanup: { repository: AppRepository; root: string }[] = [];
const call = (operation: string, input: unknown): ProductToolRequest => ({ kind: "product-call", action: "execute", operation, input });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aevoren-library-product-"));
  const databasePath = join(root, "app.sqlite");
  const repository = new AppRepository(databasePath);
  cleanup.push({ repository, root });
  const source = join(root, "source");
  mkdirSync(source);
  const workspaceService = new WorkspaceService(repository);
  const registration = await workspaceService.registerRoot(source);
  const actor = repository.createBot(registration.project.id);
  const nonce = crypto.randomUUID();
  repository.prepareMessage({ sessionId: actor.session.id, clientNonce: nonce, text: "管理当前会话资料与 Skill" });
  const runtime = repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: actor.bot.id, profileVersion: 1,
    sessionId: actor.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "library-acceptance" });
  repository.transitionRuntimeRun(runtime.id, "dispatching");
  repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "fixture" });
  const executor = new WorkspaceToolExecutor(repository, workspaceService);
  const coordinator = new WorkspaceToolCoordinator(repository, executor, () => {});
  const worker = new SendWorker(repository, null, { transcript: () => {}, sendState: () => {}, runtime: () => {} }, false, undefined, undefined, coordinator);
  const libraryService = new LibraryService(repository, join(root, "owned"), { workspaceService });
  const dependencies = { repository, workspaceService, libraryService, workspaceToolCoordinator: coordinator, sendWorker: worker,
    roomCoordinator: new RoomCoordinator(repository, worker.executor, { transcript: () => {}, roomRuntime: () => {} }),
    generalSettings: new GeneralSettingsService(repository), providers: { list: async () => [], isSupported: () => true }, updateService: {},
    libraryChanged: vi.fn(), productChanged: vi.fn() } as unknown as ProductDependencies;
  const service = new ProductOperationService(dependencies);
  executor.setProductOperations(service);
  const prepare = (tool: ProductToolRequest) => repository.prepareToolInvocation({ runtimeRunId: runtime.id,
    toolCallId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), tool });
  const execute = async (tool: ProductToolRequest, signal?: AbortSignal) => {
    const prepared = prepare(tool);
    repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
    return executor.execute(prepared.invocation.id, signal);
  };
  return { root, source, repository, databasePath, registration, actor, libraryService, service, runtime, executor, prepare, execute };
}

afterEach(() => {
  for (const item of cleanup.splice(0)) { item.repository.close(); rmSync(item.root, { recursive: true, force: true }); }
});

describe("library product receipts and scope acceptance", () => {
  it.each(["documents", "skills"] as const)("runs the complete approved %s mutation lifecycle with real revisions and receipts", async namespace => {
    const f = await fixture();
    const approved = async <T>(operation: string, input: unknown): Promise<T> => {
      const prepared = f.prepare(call(operation, input));
      await expect(f.executor.execute(prepared.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
      expect(f.repository.getToolInvocation(prepared.invocation.id).state).not.toBe("succeeded");
      f.repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
      const completed = await f.executor.execute(prepared.invocation.id);
      const receipt = JSON.parse(completed.content);
      expect(receipt.status).toBe("completed");
      expect(completed.invocation.effectClass).toBe("write-reversible");
      expect(f.repository.getToolInvocation(prepared.invocation.id)).toMatchObject({ state: "succeeded", resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(f.repository.getApprovalRequest(prepared.approval.id).state).toBe("allowed");
      return receipt.result as T;
    };
    const created = await approved<LibraryContent>(`${namespace}.create`, { name: `${namespace} lifecycle`, description: "v1 description", body: "LIFECYCLE_ORIGINAL" });
    const scope = { sessionId: f.actor.session.id, id: created.resource.id };
    expect(created.resource.kind).toBe(namespace === "documents" ? "document" : "skill");
    const updated = await approved<LibraryContent>(`${namespace}.update`, { id: created.resource.id, expectedVersion: created.resource.version,
      name: `${namespace} updated`, description: "v2 description", body: "LIFECYCLE_UPDATED" });
    expect(updated.resource.version).toBe(2);
    expect(f.repository.library.read(scope).revision).toMatchObject({ name: `${namespace} updated`, description: "v2 description", body: "LIFECYCLE_UPDATED" });
    const listed = JSON.parse((await f.execute(call(namespace === "skills" ? "library.versions" : "documents.versions", { id: created.resource.id }))).content).result as ResourceRevisionSummary[];
    expect(listed).toHaveLength(2);
    expect(listed.map(revision => revision.id)).toEqual(expect.arrayContaining([created.revision.id, updated.revision.id]));
    const restoreOperation = namespace === "documents" ? "documents.restoreVersion" : "library.restoreVersion";
    const restored = await approved<LibraryContent>(restoreOperation, { id: created.resource.id, expectedVersion: updated.resource.version, revisionId: created.revision.id });
    expect(restored.resource.version).toBe(3);
    expect(restored.revision.body).toBe("LIFECYCLE_ORIGINAL");
    expect(restored.revision.id).not.toBe(created.revision.id);
    expect(f.repository.library.read({ ...scope, revisionId: updated.revision.id }).revision.body).toBe("LIFECYCLE_UPDATED");
    const enabledOperation = namespace === "skills" ? "skills.setEnabled" : "library.setEnabled";
    const disabled = await approved<LibraryResource>(enabledOperation, { id: created.resource.id, expectedVersion: restored.resource.version, enabled: false });
    expect(disabled).toMatchObject({ enabled: false, version: 4 });
    expect(() => f.repository.library.read(scope)).toThrowError(expect.objectContaining({ code: "LIBRARY_DISABLED" }));
    const enabled = await approved<LibraryResource>(enabledOperation, { id: created.resource.id, expectedVersion: disabled.version, enabled: true });
    expect(enabled).toMatchObject({ enabled: true, version: 5 });
    expect(f.repository.library.read(scope).revision.body).toBe("LIFECYCLE_ORIGINAL");
    const deleted = await approved<LibraryResource>(`${namespace}.delete`, { id: created.resource.id, expectedVersion: enabled.version });
    expect(deleted.version).toBe(6);
    expect(deleted.deletedAt).not.toBeNull();
    expect(() => f.repository.library.read(scope)).toThrowError(expect.objectContaining({ code: "LIBRARY_NOT_FOUND" }));
    const recovered = await approved<LibraryResource>(`${namespace}.restore`, { id: created.resource.id, expectedVersion: deleted.version });
    expect(recovered).toMatchObject({ version: 7, deletedAt: null, enabled: true });
    expect(f.repository.library.read(scope).revision).toMatchObject({ body: "LIFECYCLE_ORIGINAL", name: `${namespace} lifecycle`, description: "v1 description" });
    expect(f.repository.library.versions(scope)).toHaveLength(3);
  });

  it("refuses wrong-kind alias reads and writes without changing either approved resource", async () => {
    const f = await fixture();
    const document = JSON.parse((await f.execute(call("documents.create", { name: "document", body: "UNCHANGED_DOCUMENT_BODY" }))).content).result as LibraryContent;
    const skill = JSON.parse((await f.execute(call("skills.create", { name: "skill", body: "UNCHANGED_SKILL_BODY" }))).content).result as LibraryContent;
    for (const [namespace, content] of [["documents", skill], ["skills", document]] as const) {
      await expect(f.execute(call(`${namespace}.read`, { id: content.resource.id }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(f.execute(call(`${namespace}.update`, { id: content.resource.id, expectedVersion: content.resource.version, body: "WRONG_KIND_WRITE" }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(f.execute(call(`${namespace}.delete`, { id: content.resource.id, expectedVersion: content.resource.version }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(f.execute(call(`${namespace}.restore`, { id: content.resource.id, expectedVersion: content.resource.version }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    await expect(f.execute(call("skills.load", { id: document.resource.id }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(f.execute(call("skills.setEnabled", { id: document.resource.id, expectedVersion: 1, enabled: false }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(f.execute(call("documents.versions", { id: skill.resource.id }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(f.execute(call("documents.restoreVersion", { id: skill.resource.id, expectedVersion: 1, revisionId: skill.revision.id }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const scope = { sessionId: f.actor.session.id };
    expect(f.repository.library.read({ ...scope, id: document.resource.id })).toMatchObject({ resource: { version: 1, deletedAt: null }, revision: { body: "UNCHANGED_DOCUMENT_BODY" } });
    expect(f.repository.library.read({ ...scope, id: skill.resource.id })).toMatchObject({ resource: { version: 1, deletedAt: null }, revision: { body: "UNCHANGED_SKILL_BODY" } });
    expect(f.repository.listToolInvocations(f.actor.session.id).filter(invocation => invocation.state === "succeeded")).toHaveLength(2);
  });

  it.each(["documents", "skills"] as const)("keeps illegal %s import paths rejected without publishing any bytes", async namespace => {
    const f = await fixture();
    writeFileSync(join(f.root, "outside.md"), "UNAUTHORIZED_OUTSIDE_FIXTURE");
    for (const path of ["../outside.md", join(f.root, "outside.md"), "..\\outside.md", "C:/outside.md"]) {
      await expect(f.execute(call(`${namespace}.import`, { workspaceId: f.registration.workspace.id, path }))).rejects.toThrow();
    }
    expect(f.repository.library.available()).toEqual([]);
    expect(f.repository.library.list({ sessionId: f.actor.session.id })).toEqual([]);
    expect(f.repository.listToolInvocations(f.actor.session.id).every(invocation => invocation.state !== "succeeded")).toBe(true);
  });

  it("publishes an actual created Skill only with the approved product receipt", async () => {
    const f = await fixture();
    const pending = f.prepare(call("skills.create", { name: "写作 Skill", body: "真实文本指令" }));
    await expect(f.executor.execute(pending.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    expect(f.repository.library.list({ sessionId: f.actor.session.id })).toEqual([]);
    f.repository.resolveToolApproval(pending.approval.id, pending.approval.version, "allow-once");
    const executed = await f.executor.execute(pending.invocation.id);
    const result = JSON.parse(executed.content);
    expect(result.status).toBe("completed");
    expect(result.result.resource.kind).toBe("skill");
    expect(f.repository.library.read({ sessionId: f.actor.session.id, id: result.result.resource.id }).revision.body).toBe("真实文本指令");
    expect(f.repository.getToolInvocation(pending.invocation.id).state).toBe("succeeded");
  });

  it("rolls back all imported rows and bindings if recording the success receipt fails", async () => {
    const f = await fixture();
    const batch = join(f.source, "batch");
    mkdirSync(batch);
    writeFileSync(join(batch, "first.md"), "first source");
    writeFileSync(join(batch, "second.md"), "second source");
    const commitImport = vi.spyOn(f.libraryService, "commitImport");
    const originalReceipt = f.repository.completeProductToolInvocation.bind(f.repository);
    let rowsBeforeReceipt = 0;
    let receiptFailure = "";
    const completeReceipt = vi.spyOn(f.repository, "completeProductToolInvocation").mockImplementation((...input) => {
      rowsBeforeReceipt = f.repository.library.list({ sessionId: f.actor.session.id }).length;
      try { return originalReceipt(...input); }
      catch (error) {
        receiptFailure = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
    const raw = new DatabaseSync(f.databasePath);
    raw.exec("CREATE TRIGGER reject_library_receipt BEFORE UPDATE OF state ON tool_invocations WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END;");
    raw.close();
    await expect(f.execute(call("documents.import", { workspaceId: f.registration.workspace.id, path: "batch" }))).rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
    expect(commitImport).toHaveBeenCalledOnce();
    expect(commitImport.mock.results[0]!.type).toBe("return");
    expect(commitImport.mock.results[0]!.value.imported).toHaveLength(2);
    expect(completeReceipt).toHaveBeenCalledOnce();
    expect(rowsBeforeReceipt).toBe(2);
    expect(receiptFailure).toContain("receipt rejected");
    expect(f.repository.library.list({ sessionId: f.actor.session.id })).toEqual([]);
    expect(f.repository.library.available()).toEqual([]);
    const inspected = new DatabaseSync(f.databasePath, { readOnly: true });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM library_revisions").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM session_resource_bindings").get()).toEqual({ count: 0 });
    inspected.close();
  });

  it("cancels after source staging without publishing resources or a successful receipt", async () => {
    const f = await fixture();
    writeFileSync(join(f.source, "original.md"), "real staged source");
    const controller = new AbortController();
    const original = f.libraryService.prepareImportPath.bind(f.libraryService);
    vi.spyOn(f.libraryService, "prepareImportPath").mockImplementation(async (...input) => {
      const staged = await original(...input);
      controller.abort();
      return staged;
    });
    await expect(f.execute(call("documents.import", { workspaceId: f.registration.workspace.id, path: "original.md" }), controller.signal)).rejects.toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
    expect(f.repository.library.list({ sessionId: f.actor.session.id })).toEqual([]);
    expect(f.repository.listToolInvocations(f.actor.session.id).every(invocation => invocation.state !== "succeeded")).toBe(true);
  });

  it("reuses an identical import receipt after the original source is removed instead of importing twice", async () => {
    const f = await fixture();
    const path = join(f.source, "original.md");
    writeFileSync(path, "original import bytes");
    const command = call("documents.import", { workspaceId: f.registration.workspace.id, path: "original.md" });
    const first = await f.execute(command);
    rmSync(path);
    const reused = JSON.parse((await f.execute(command)).content);
    expect(reused.result).toEqual(JSON.parse(first.content).result);
    expect(reused.reused).toBe(true);
    expect(f.repository.library.list({ sessionId: f.actor.session.id })).toHaveLength(1);
  });

  it("rejects a model-supplied different session and refuses disabled bodies even with visibility flags", async () => {
    const f = await fixture();
    const other = f.repository.createBot();
    const content = f.libraryService.create({ sessionId: f.actor.session.id, kind: "skill", name: "local skill", body: "PRIVATE_DISABLED_BODY" });
    expect(() => f.service.validate(call("skills.load", { sessionId: other.session.id, id: content.resource.id }), f.runtime.id)).toThrow();
    f.repository.library.setEnabled({ sessionId: f.actor.session.id, id: content.resource.id, expectedVersion: 1, enabled: false });
    await expect(f.execute(call("library.read", { id: content.resource.id, includeDisabled: true, includeDeleted: true }))).rejects.toMatchObject({ code: "LIBRARY_DISABLED" });
  });

  it("returns auxiliary binary metadata and real text through the AI gateway without executing scripts", async () => {
    const f = await fixture();
    const source = join(f.source, "skill-package");
    mkdirSync(join(source, "assets"), { recursive: true });
    mkdirSync(join(source, "scripts"), { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: gateway-test\ndescription: Resource bytes\n---\nUse references.");
    writeFileSync(join(source, "assets", "sample.png"), Buffer.from([0, 255, 137, 80]));
    writeFileSync(join(source, "scripts", "run.sh"), "#!/bin/sh\necho NEVER_EXECUTE\n");
    const imported = (await f.libraryService.importPath({ sessionId: f.actor.session.id, kind: "skill", workspaceId: f.registration.workspace.id, path: "skill-package" })).imported[0]!;
    const fileInput = { id: imported.resource.id, revisionId: imported.revision.id };
    const binary = JSON.parse((await f.execute(call("skills.readFile", { ...fileInput, path: "assets/sample.png" }))).content).result;
    expect(binary).toMatchObject({ encoding: "binary", contentAvailable: false, scriptsExecutable: false, size: 4 });
    expect(binary).not.toHaveProperty("data");
    expect(binary.sha256).toBe(imported.revision.files.find(file => file.relativePath === "assets/sample.png")!.sha256);
    const script = JSON.parse((await f.execute(call("skills.readFile", { ...fileInput, path: "scripts/run.sh" }))).content).result;
    expect(script).toMatchObject({ encoding: "utf8", scriptsExecutable: false, data: "#!/bin/sh\necho NEVER_EXECUTE\n" });
  });
});
