import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LibraryContent } from "@shared/library-contracts";
import { AppRepository } from "./database";
import { LibraryService } from "./library-service";
import { LibraryBlobStore, libraryBytesDigest, MAX_LIBRARY_IMPORT_BYTES, MAX_LIBRARY_TEXT_BYTES } from "./library-blob-store";
import { WorkspaceService } from "./workspace-service";

const roots: string[] = [];
const repositories: AppRepository[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aevoren-library-service-"));
  roots.push(root);
  const databasePath = join(root, "app.sqlite");
  const repository = new AppRepository(databasePath);
  repositories.push(repository);
  const { session, bot } = repository.createBot();
  const blobRoot = join(root, "owned");
  const service = new LibraryService(repository, blobRoot, { workspaceService: new WorkspaceService(repository) });
  return { root, repository, databasePath, service, session, bot, blobRoot };
}

function skillDirectory(root: string, metadata = "name: research-assistant\ndescription: Finds source evidence\nallowed-tools: dangerous-shell") {
  const directory = join(root, "source-skill");
  mkdirSync(join(directory, "references"), { recursive: true });
  mkdirSync(join(directory, "scripts"), { recursive: true });
  mkdirSync(join(directory, "assets"), { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\n${metadata}\n---\nRead references/guide.md before answering.`);
  writeFileSync(join(directory, "references", "guide.md"), "Verified source reference.");
  writeFileSync(join(directory, "scripts", "task.sh"), "#!/bin/sh\ntouch never-executed\n");
  const binary = Buffer.from([0, 255, 137, 80, 78, 71]);
  writeFileSync(join(directory, "assets", "sample.png"), binary);
  return { directory, binary };
}

function resourceInput(sessionId: string, content: LibraryContent, path: string) {
  return { sessionId, id: content.resource.id, revisionId: content.revision.id, path };
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LibraryService real imports and revisions", () => {
  it("owns imported text after source deletion and a real SQLite reopen", async () => {
    const f = fixture();
    const source = join(f.root, "说明.md");
    writeFileSync(source, "持久资料正文\n");
    const result = await f.service.importPaths(f.session.id, [source], "document");
    const content = result.imported[0]!;
    rmSync(source);
    f.repository.close();
    repositories.splice(repositories.indexOf(f.repository), 1);
    const reopened = new AppRepository(f.databasePath);
    repositories.push(reopened);
    const read = reopened.library.read({ sessionId: f.session.id, id: content.resource.id });
    expect(read.revision.body).toBe("持久资料正文\n");
    expect(read.reference).toEqual(content.reference);
    const exported = await new LibraryService(reopened, f.blobRoot).prepareExport({ sessionId: f.session.id, id: content.resource.id });
    expect(exported.files[0]!.bytes.toString("utf8")).toBe("持久资料正文\n");
  });

  it("keeps the whole Skill as one immutable resource and retains actual non-executable binary/script bytes", async () => {
    const f = fixture();
    const source = skillDirectory(f.root);
    const content = (await f.service.importPaths(f.session.id, [source.directory], "skill")).imported[0]!;
    expect(f.repository.library.list({ sessionId: f.session.id })).toHaveLength(1);
    expect(content.resource).toMatchObject({ kind: "skill", name: "research-assistant", description: "Finds source evidence" });
    expect(content.revision.body).toContain("allowed-tools: dangerous-shell");
    expect(content.revision.files.map((file) => file.relativePath)).toEqual(["assets/sample.png", "references/guide.md", "scripts/task.sh"]);
    rmSync(source.directory, { recursive: true });
    expect((await f.service.readResourceFile(resourceInput(f.session.id, content, "references/guide.md"))).data).toBe("Verified source reference.");
    const image = await f.service.readResourceFile(resourceInput(f.session.id, content, "assets/sample.png"));
    expect(image.encoding).toBe("base64");
    expect(Buffer.from(image.data, "base64")).toEqual(source.binary);
    expect((await f.service.readResourceFile(resourceInput(f.session.id, content, "scripts/task.sh"))).data).toContain("touch never-executed");
    expect(existsSync(join(f.root, "never-executed"))).toBe(false);
    const exported = await f.service.prepareExport({ sessionId: f.session.id, id: content.resource.id });
    const restored = join(f.root, "exported");
    for (const file of exported.files) {
      const parts = file.relativePath.split("/");
      parts.pop();
      mkdirSync(join(restored, ...parts), { recursive: true });
      writeFileSync(join(restored, file.relativePath), file.bytes);
    }
    expect(readFileSync(join(restored, "assets/sample.png"))).toEqual(source.binary);
    const reimport = (await f.service.importPaths(f.session.id, [restored], "skill")).imported[0]!;
    expect(reimport.revision.digest).toBe(content.revision.digest);
  });

  it("exports a user-created text Skill in a reimportable SKILL.md format", async () => {
    const f = fixture();
    const content = f.service.create({ sessionId: f.session.id, kind: "skill", name: "中文写作助手", description: "明确写作要求", body: "使用自然中文。" });
    const exported = await f.service.prepareExport({ sessionId: f.session.id, id: content.resource.id });
    const folder = join(f.root, "exported");
    mkdirSync(folder);
    writeFileSync(join(folder, "SKILL.md"), exported.files[0]!.bytes);
    const reimport = (await f.service.importPaths(f.session.id, [folder], "skill")).imported[0]!;
    expect(reimport.revision.body).toContain("使用自然中文。");
    expect(reimport.resource.name).toBe("中文写作助手");
    expect(reimport.resource.description).toBe("明确写作要求");
  });

  it("preserves a long user description in export while keeping Agent Skills YAML compatible", async () => {
    const f = fixture();
    const description = "详".repeat(2_000);
    const content = f.service.create({ sessionId: f.session.id, kind: "skill", name: "writing-assistant", description, body: "Write a short draft." });
    const exported = await f.service.prepareExport({ sessionId: f.session.id, id: content.resource.id });
    const folder = join(f.root, "exported");
    mkdirSync(folder);
    writeFileSync(join(folder, "SKILL.md"), exported.files[0]!.bytes);
    const reimport = (await f.service.importPaths(f.session.id, [folder], "skill")).imported[0]!;
    expect(reimport.resource.name).toBe("writing-assistant");
    expect(reimport.resource.description).toBe(description);
  });

  it("exports current display metadata after editing an imported Skill and retains unknown declarations", async () => {
    const f = fixture();
    const source = skillDirectory(f.root);
    const original = (await f.service.importPaths(f.session.id, [source.directory], "skill")).imported[0]!;
    const current = f.service.update({ sessionId: f.session.id, id: original.resource.id, expectedVersion: original.resource.version, name: "新显示名", description: "新说明" });
    const exported = await f.service.prepareExport({ sessionId: f.session.id, id: current.resource.id });
    const folder = join(f.root, "exported");
    for (const file of exported.files) {
      const parts = file.relativePath.split("/");
      parts.pop();
      mkdirSync(join(folder, ...parts), { recursive: true });
      writeFileSync(join(folder, file.relativePath), file.bytes);
    }
    const reimport = (await f.service.importPaths(f.session.id, [folder], "skill")).imported[0]!;
    expect(reimport.resource).toMatchObject({ name: "新显示名", description: "新说明" });
    expect(reimport.revision.body).toContain("allowed-tools: dangerous-shell");
    expect(reimport.revision.files).toEqual(current.revision.files);
  });

  it("pins the old body after updates and refuses stale expectedVersion without losing the current content", () => {
    const f = fixture();
    const content = f.service.create({ sessionId: f.session.id, kind: "document", name: "brief", body: "first" });
    const next = f.service.update({ sessionId: f.session.id, id: content.resource.id, expectedVersion: 1, body: "second" });
    expect(next.resource.version).toBe(2);
    expect(() => f.service.update({ sessionId: f.session.id, id: content.resource.id, expectedVersion: 1, body: "unsaved draft" })).toThrow();
    expect(f.repository.library.resolveReferences(f.session.id, [content.reference])[0]!.revision.body).toBe("first");
    expect(f.repository.library.read({ sessionId: f.session.id, id: content.resource.id }).revision.body).toBe("second");
  });

  it("keeps private resource files outside another private session until explicit binding and blocks revocation", async () => {
    const f = fixture();
    const source = skillDirectory(f.root);
    const content = (await f.service.importPaths(f.session.id, [source.directory], "skill")).imported[0]!;
    const other = f.repository.createBot();
    await expect(f.service.readResourceFile(resourceInput(other.session.id, content, "references/guide.md"))).rejects.toThrow();
    f.repository.library.bind({ sessionId: other.session.id, id: content.resource.id });
    expect((await f.service.readResourceFile(resourceInput(other.session.id, content, "references/guide.md"))).data).toContain("Verified");
    f.repository.library.unbind({ sessionId: other.session.id, id: content.resource.id });
    await expect(f.service.readResourceFile(resourceInput(other.session.id, content, "references/guide.md"))).rejects.toThrow();
    f.repository.library.setEnabled({ sessionId: f.session.id, id: content.resource.id, expectedVersion: content.resource.version, enabled: false });
    await expect(f.service.readResourceFile(resourceInput(f.session.id, content, "references/guide.md"), undefined, f.bot.id)).rejects.toThrow();
  });

  it("does not publish prepared bytes until commit, rejects cancellation, and ignores tampered preparation fields", async () => {
    const f = fixture();
    const source = skillDirectory(f.root);
    const prepared = await f.service.prepareImportPaths(f.session.id, [source.directory], "skill");
    expect(f.repository.library.list({ sessionId: f.session.id })).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    expect(() => f.service.commitImport(prepared, controller.signal)).toThrow();
    expect(f.repository.library.list({ sessionId: f.session.id })).toEqual([]);
    prepared.resources[0]!.name = "tampered";
    const content = f.service.commitImport(prepared).imported[0]!;
    expect(content.resource.name).toBe("research-assistant");
    expect(() => f.service.commitImport(prepared)).toThrow();
    expect(() => f.service.commitImport({ sessionId: f.session.id, resources: [], skipped: [] })).toThrow();
  });

  it("does not publish earlier folder files when later input is invalid or the batch is too large", async () => {
    const f = fixture();
    const good = join(f.root, "good.txt");
    const bad = join(f.root, "bad.txt");
    writeFileSync(good, "valid");
    writeFileSync(bad, Buffer.from([0xc3, 0x28]));
    await expect(f.service.importPaths(f.session.id, [good, bad], "document")).rejects.toThrow();
    expect(f.repository.library.list({ sessionId: f.session.id })).toEqual([]);
    const large = join(f.root, "large.txt");
    writeFileSync(large, Buffer.alloc(MAX_LIBRARY_TEXT_BYTES + 1, 97));
    await expect(f.service.importPaths(f.session.id, [large], "document")).rejects.toThrow();
    const batch = Array.from({ length: 5 }, (_, index) => {
      const path = join(f.root, `size-${index}.txt`);
      writeFileSync(path, Buffer.alloc(MAX_LIBRARY_IMPORT_BYTES / 4, 97));
      return path;
    });
    await expect(f.service.importPaths(f.session.id, batch, "document")).rejects.toThrow();
    expect(f.repository.library.list({ sessionId: f.session.id })).toEqual([]);
  });

  it("shows unsupported and dependency skips, and bounds a directory to 250 resources", async () => {
    const f = fixture();
    const folder = join(f.root, "docs");
    mkdirSync(join(folder, "node_modules"), { recursive: true });
    writeFileSync(join(folder, "good.md"), "visible text");
    writeFileSync(join(folder, "sample.png"), Buffer.from([0, 1, 2]));
    const result = await f.service.importPaths(f.session.id, [folder], "document");
    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toEqual([{ name: "node_modules", reason: "dependency-directory" }, { name: "sample.png", reason: "unsupported-document-format" }]);
    const excess = join(f.root, "too-many");
    mkdirSync(excess);
    for (let index = 0; index < 251; index += 1) writeFileSync(join(excess, `${index}.md`), "x");
    await expect(f.service.importPaths(f.session.id, [excess], "document")).rejects.toThrow();
    expect(f.repository.library.list({ sessionId: f.session.id })).toHaveLength(1);
  });

  it("imports 250 small documents atomically at the supported file-count boundary", async () => {
    const f = fixture();
    const folder = join(f.root, "at-limit");
    mkdirSync(folder);
    for (let index = 0; index < 250; index += 1) writeFileSync(join(folder, `${index}.md`), `source ${index}`);
    const prepared = await f.service.prepareImportPaths(f.session.id, [folder], "document");
    expect(f.repository.library.list({ sessionId: f.session.id })).toEqual([]);
    expect(f.service.commitImport(prepared).imported).toHaveLength(250);
    expect(f.repository.library.list({ sessionId: f.session.id })).toHaveLength(250);
  });

  it.each([
    "name: &alias research-assistant\ndescription: *alias",
    "name: research-assistant\nname: duplicated\ndescription: desc",
    "name: !!js/function 'function () {}'\ndescription: desc",
    "name: Wrong Name\ndescription: desc",
    "name: research-assistant\ndescription: ''",
  ])("rejects malformed or executable YAML metadata without publishing (%s)", async (metadata) => {
    const f = fixture();
    const source = skillDirectory(f.root, metadata);
    await expect(f.service.importPaths(f.session.id, [source.directory], "skill")).rejects.toThrow();
    expect(f.repository.library.list({ sessionId: f.session.id })).toEqual([]);
  });

  it("imports only an authorized Workspace relative path and rechecks the grant before commit", async () => {
    const f = fixture();
    const source = join(f.root, "workspace");
    mkdirSync(source);
    writeFileSync(join(source, "brief.md"), "workspace original");
    const registration = await new WorkspaceService(f.repository).registerRoot(source);
    const owner = f.repository.createBot(registration.project.id);
    const input = { sessionId: owner.session.id, workspaceId: registration.workspace.id, path: "brief.md", kind: "document" as const };
    const prepared = await f.service.prepareImportPath(input, undefined, owner.bot.id);
    f.repository.setConversationProject(owner.session.id, null, f.repository.getConversation(owner.session.id).version);
    expect(() => f.service.commitImport(prepared, undefined, owner.bot.id)).toThrow();
    expect(f.repository.library.list({ sessionId: owner.session.id })).toEqual([]);
    await expect(f.service.importPath({ ...input, sessionId: f.session.id })).rejects.toThrow();
    await expect(f.service.importPath({ ...input, path: "../brief.md" }, undefined, owner.bot.id)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects source symlinks, skips referenced symlinks and refuses file traversal", async () => {
    const f = fixture();
    const source = skillDirectory(f.root);
    const outside = join(f.root, "outside.txt");
    writeFileSync(outside, "private outside");
    symlinkSync(outside, join(source.directory, "references", "link.txt"));
    const result = await f.service.importPaths(f.session.id, [source.directory], "skill");
    expect(result.skipped).toEqual([{ name: "references/link.txt", reason: "symbolic-link" }]);
    const content = result.imported[0]!;
    await expect(f.service.readResourceFile(resourceInput(f.session.id, content, "../outside.txt"))).rejects.toThrow();
    const sourceLink = join(f.root, "linked.md");
    symlinkSync(outside, sourceLink);
    await expect(f.service.importPaths(f.session.id, [sourceLink], "document")).rejects.toThrow();
  });
});

describe("LibraryBlobStore integrity", () => {
  it("deduplicates application-owned bytes, verifies hashes and leaves no staging files", async () => {
    const f = fixture();
    const store = new LibraryBlobStore(f.blobRoot);
    const bytes = Buffer.from([0, 1, 2, 3]);
    const digest = await store.put(bytes);
    expect(await store.put(bytes)).toBe(digest);
    expect(await store.read(digest, bytes.length)).toEqual(bytes);
    expect(readdirSync(join(f.blobRoot, digest.slice(0, 2)))).toEqual([digest]);
    writeFileSync(join(f.blobRoot, digest.slice(0, 2), digest), Buffer.from([4, 3, 2, 1]));
    await expect(store.read(digest, bytes.length)).rejects.toThrow();
    await expect(store.put(bytes)).rejects.toThrow();
  });

  it("rejects fake hash paths and pre-aborted imports without writing", async () => {
    const f = fixture();
    const store = new LibraryBlobStore(f.blobRoot);
    await expect(store.read("../private", 4)).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(store.put(Buffer.from("x"), controller.signal)).rejects.toThrow();
    expect(existsSync(f.blobRoot)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses symlink shards and symlink bytes instead of accessing their targets", async () => {
    const f = fixture();
    const store = new LibraryBlobStore(f.blobRoot);
    const bytes = Buffer.from("some bytes");
    const digest = libraryBytesDigest(bytes);
    mkdirSync(f.blobRoot);
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(f.blobRoot, digest.slice(0, 2)));
    await expect(store.put(bytes)).rejects.toThrow();
    expect(readdirSync(outside)).toEqual([]);
    rmSync(join(f.blobRoot, digest.slice(0, 2)));
    mkdirSync(join(f.blobRoot, digest.slice(0, 2)));
    const secret = join(outside, "secret");
    writeFileSync(secret, bytes);
    symlinkSync(secret, join(f.blobRoot, digest.slice(0, 2), digest));
    await expect(store.read(digest, bytes.length)).rejects.toThrow();
  });
});
