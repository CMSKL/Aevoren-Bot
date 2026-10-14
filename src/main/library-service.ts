import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { parseDocument, stringify } from "yaml";
import type { LibraryContent, LibraryCreateInput, LibraryImportResult, LibraryReadInput, LibraryResourceKind, LibraryUpdateInput, ResourceFileRef } from "@shared/library-contracts";
import { libraryCreateSchema, libraryUpdateSchema, resourceFileRefSchema } from "@shared/library-schemas";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import { assertLibraryNotCancelled, LibraryBlobStore, libraryBytesDigest, MAX_LIBRARY_FILES, MAX_LIBRARY_IMPORT_BYTES, MAX_LIBRARY_TEXT_BYTES } from "./library-blob-store";
import type { WorkspaceService } from "./workspace-service";

const TEXT_TYPES: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".yaml": "application/yaml", ".yml": "application/yaml",
  ".xml": "application/xml", ".html": "text/html", ".htm": "text/html", ".js": "text/javascript",
  ".mjs": "text/javascript", ".cjs": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
  ".jsx": "text/javascript", ".css": "text/css", ".scss": "text/x-scss", ".sql": "application/sql",
  ".py": "text/x-python", ".sh": "application/x-sh", ".go": "text/x-go", ".rs": "text/x-rust",
  ".java": "text/x-java", ".toml": "text/plain", ".ini": "text/plain", ".log": "text/plain", ".diff": "text/plain",
};
const BINARY_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".zip": "application/zip",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4",
};
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "__pycache__"]);
const SKILL_FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
type PreparedResource = LibraryCreateInput & { files: ResourceFileRef[] };
type WorkspaceImportInput = { sessionId: string; kind: LibraryResourceKind; workspaceId: string; path: string };
export type PreparedLibraryImport = {
  sessionId: string;
  resources: PreparedResource[];
  skipped: LibraryImportResult["skipped"];
  workspace?: WorkspaceImportInput;
};
export type LibraryServiceOptions = {
  workspaceService?: WorkspaceService;
  /** Resolves only an already-granted workspace path and rechecks its session scope. */
  authorizeWorkspacePath?: (input: WorkspaceImportInput, executorBotId?: string) => Promise<string>;
};
export type LibraryResourceFileResult = ResourceFileRef & { encoding: "utf8" | "base64"; data: string };
export type PreparedLibraryExport = {
  name: string;
  kind: LibraryResourceKind;
  resourceId: string;
  revisionId: string;
  files: { relativePath: string; bytes: Buffer }[];
};

function stableIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function decodeText(bytes: Buffer): string {
  if (bytes.includes(0)) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new AevorenBotError("LIBRARY_IMPORT_INVALID"); }
}

function skillMetadata(body: string, required: boolean): { name: string; description: string } | null {
  const frontmatter = SKILL_FRONTMATTER.exec(body);
  if (!frontmatter) {
    if (required) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
    return null;
  }
  try {
    const parsed = parseDocument(frontmatter[1]!, { schema: "core", uniqueKeys: true, prettyErrors: false });
    if (parsed.errors.length || parsed.warnings.length) throw new Error("Invalid Skill metadata");
    const metadata: unknown = parsed.toJS({ maxAliasCount: 0 });
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Invalid Skill metadata");
    const values = metadata as Record<string, unknown>;
    if (typeof values.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(values.name) || values.name.length > 64 ||
      typeof values.description !== "string" || !values.description.trim() || values.description.length > 1_024) throw new Error("Invalid Skill metadata");
    if (values.metadata !== undefined && (!values.metadata || typeof values.metadata !== "object" || Array.isArray(values.metadata))) throw new Error("Invalid Skill metadata map");
    const fields = (values.metadata ?? {}) as Record<string, unknown>;
    if (fields.aevorenDisplayName !== undefined || fields.aevorenDescription !== undefined) {
      if (typeof fields.aevorenDisplayName !== "string" || !fields.aevorenDisplayName.trim() || fields.aevorenDisplayName.length > 120 ||
        typeof fields.aevorenDescription !== "string" || fields.aevorenDescription.length > 2_000) throw new Error("Invalid Skill display metadata");
      return { name: fields.aevorenDisplayName, description: fields.aevorenDescription };
    }
    return { name: values.name, description: values.description };
  } catch { throw new AevorenBotError("LIBRARY_IMPORT_INVALID"); }
}

function pathIsContained(root: string, target: string): boolean {
  const offset = relative(root, target);
  return offset === "" || !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
}

export class LibraryService {
  private readonly blobs: LibraryBlobStore;
  private readonly preparedImports = new WeakMap<PreparedLibraryImport, PreparedLibraryImport>();

  constructor(private readonly repository: AppRepository, blobRoot: string, private readonly options: LibraryServiceOptions = {}) {
    this.blobs = new LibraryBlobStore(blobRoot);
  }

  private assertScope(sessionId: string, executorBotId?: string, signal?: AbortSignal): void {
    assertLibraryNotCancelled(signal);
    const session = this.repository.getSession(sessionId);
    if (session.roomId && this.repository.getRoom(session.roomId).archivedAt) throw new AevorenBotError("ROOM_ARCHIVED");
    if (executorBotId) this.repository.assertSessionExecutor(sessionId, executorBotId);
  }

  create(input: LibraryCreateInput, signal?: AbortSignal, executorBotId?: string): LibraryContent {
    const parsed = libraryCreateSchema.parse(input);
    if (parsed.kind === "skill") skillMetadata(parsed.body, false);
    this.assertScope(parsed.sessionId, executorBotId, signal);
    return this.repository.library.create(parsed, executorBotId);
  }

  update(input: LibraryUpdateInput, signal?: AbortSignal, executorBotId?: string): LibraryContent {
    const parsed = libraryUpdateSchema.parse(input);
    this.assertScope(parsed.sessionId, executorBotId, signal);
    const current = this.repository.library.read({ sessionId: parsed.sessionId, id: parsed.id, includeDisabled: !executorBotId }, executorBotId);
    if (current.resource.kind === "skill" && parsed.body !== undefined) skillMetadata(parsed.body, false);
    return this.repository.library.update(parsed, executorBotId);
  }

  private async sourceBytes(path: string, check: () => void): Promise<Buffer> {
    check();
    let handle;
    try {
      const before = await lstat(path);
      check();
      if (!before.isFile() || before.isSymbolicLink()) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
      if (await realpath(dirname(path)) !== dirname(path)) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
      check();
      if (before.size > MAX_LIBRARY_TEXT_BYTES) throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      check();
      if (!stableIdentity(before, opened)) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
      const bytes = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < bytes.length) {
        check();
        const read = await handle.read(bytes, length, bytes.length - length, length);
        length += read.bytesRead;
        if (!read.bytesRead) break;
      }
      const after = await handle.stat();
      const pathAfter = await lstat(path);
      if (await realpath(dirname(path)) !== dirname(path)) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
      check();
      if (length !== before.size || !stableIdentity(opened, after) || !stableIdentity(after, pathAfter)) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
      return bytes.subarray(0, length);
    } catch (error) {
      check();
      if (error instanceof AevorenBotError) throw error;
      throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
    } finally { await handle?.close(); }
  }

  private async directoryFiles(root: string, check: () => void, skipped: LibraryImportResult["skipped"]): Promise<{ path: string; relativePath: string }[]> {
    const files: { path: string; relativePath: string }[] = [];
    let visited = 0;
    const walk = async (directory: string): Promise<void> => {
      check();
      const before = await lstat(directory);
      if (!before.isDirectory() || before.isSymbolicLink() || await realpath(directory) !== directory) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
      check();
      const entries = (await readdir(directory, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name, "en"));
      check();
      for (const entry of entries) {
        if (++visited > 5_000) throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
        check();
        const path = join(directory, entry.name);
        const relativePath = relative(root, path).split(sep).join("/");
        if (entry.isSymbolicLink()) { skipped.push({ name: relativePath, reason: "symbolic-link" }); continue; }
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) { skipped.push({ name: relativePath, reason: "dependency-directory" }); continue; }
          await walk(path);
        } else if (entry.isFile()) {
          if (files.length === MAX_LIBRARY_FILES) throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
          files.push({ path, relativePath });
        } else skipped.push({ name: relativePath, reason: "unsupported-file-type" });
      }
      check();
      if (!stableIdentity(before, await lstat(directory))) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
    };
    await walk(root);
    return files;
  }

  /** Host-only: paths must come from a file picker or an authorized Workspace resolver. */
  async prepareImportPaths(sessionId: string, paths: readonly string[], kind: LibraryResourceKind, signal?: AbortSignal, executorBotId?: string, assertAccess?: () => void): Promise<PreparedLibraryImport> {
    const check = (): void => { this.assertScope(sessionId, executorBotId, signal); assertAccess?.(); };
    check();
    if (paths.length > MAX_LIBRARY_FILES) throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
    const prepared: PreparedLibraryImport = { sessionId, resources: [], skipped: [] };
    let total = 0;
    const load = async (path: string): Promise<Buffer> => {
      const bytes = await this.sourceBytes(path, check);
      total += bytes.length;
      if (total > MAX_LIBRARY_IMPORT_BYTES) throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
      return bytes;
    };
    for (const supplied of paths) {
      check();
      const source = resolve(supplied);
      const identity = await lstat(source);
      check();
      if (identity.isSymbolicLink()) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
      if (identity.isDirectory()) {
        const root = await realpath(source);
        const files = await this.directoryFiles(root, check, prepared.skipped);
        if (kind === "skill") {
          const main = files.find((file) => file.relativePath === "SKILL.md");
          if (!main) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
          const body = decodeText(await load(main.path));
          const metadata = skillMetadata(body, true)!;
          const references: ResourceFileRef[] = [];
          for (const file of files.filter((file) => file !== main)) {
            const bytes = await load(file.path);
            const mimeType = TEXT_TYPES[extname(file.path).toLowerCase()] ?? BINARY_TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream";
            if (TEXT_TYPES[extname(file.path).toLowerCase()]) decodeText(bytes);
            check();
            const sha256 = await this.blobs.put(bytes, signal);
            check();
            references.push(resourceFileRefSchema.parse({ relativePath: file.relativePath, size: bytes.length, mimeType, sha256 }));
          }
          prepared.resources.push({ sessionId, kind, ...metadata, body, files: references });
        } else {
          for (const file of files) {
            if (!TEXT_TYPES[extname(file.path).toLowerCase()]) { prepared.skipped.push({ name: file.relativePath, reason: "unsupported-document-format" }); continue; }
            prepared.resources.push({ sessionId, kind, name: file.relativePath.slice(0, 120), body: decodeText(await load(file.path)), files: [] });
          }
        }
      } else if (identity.isFile()) {
        if (!TEXT_TYPES[extname(source).toLowerCase()]) { prepared.skipped.push({ name: basename(source), reason: "unsupported-document-format" }); continue; }
        const canonicalParent = await realpath(dirname(source));
        check();
        const body = decodeText(await load(join(canonicalParent, basename(source))));
        const metadata = kind === "skill" ? skillMetadata(body, true)! : { name: basename(source).slice(0, 120), description: "" };
        prepared.resources.push({ sessionId, kind, ...metadata, body, files: [] });
      } else prepared.skipped.push({ name: basename(source), reason: "unsupported-file-type" });
    }
    check();
    this.preparedImports.set(prepared, structuredClone(prepared));
    return prepared;
  }

  private workspaceExecutor(sessionId: string, executorBotId?: string): string {
    if (executorBotId) return executorBotId;
    const session = this.repository.getSession(sessionId);
    const id = session.botId ?? (session.roomId ? this.repository.getRoomDetail(session.roomId).members[0]?.botId : undefined);
    if (!id) throw new AevorenBotError("INVALID_REQUEST");
    return id;
  }

  async prepareImportPath(input: WorkspaceImportInput, signal?: AbortSignal, executorBotId?: string): Promise<PreparedLibraryImport> {
    this.assertScope(input.sessionId, executorBotId, signal);
    const actor = this.workspaceExecutor(input.sessionId, executorBotId);
    this.repository.assertSessionWorkspaceAccess(input.sessionId, actor, input.workspaceId);
    let path: string;
    if (this.options.authorizeWorkspacePath) path = await this.options.authorizeWorkspacePath(input, actor);
    else {
      if (!this.options.workspaceService) throw new AevorenBotError("WORKSPACE_NOT_FOUND");
      const { rootPath } = this.repository.getWorkspaceRoot(input.workspaceId);
      const candidate = resolve(rootPath, input.path);
      if (!pathIsContained(rootPath, candidate)) throw new AevorenBotError("WORKSPACE_PATH_OUTSIDE_ROOT");
      const target = await lstat(candidate);
      if (target.isSymbolicLink()) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
      path = (await this.options.workspaceService.resolveExistingTarget(input.workspaceId, input.path, target.isDirectory() ? "directory" : "file")).canonicalPath;
    }
    this.assertScope(input.sessionId, actor, signal);
    this.repository.assertSessionWorkspaceAccess(input.sessionId, actor, input.workspaceId);
    const prepared = await this.prepareImportPaths(input.sessionId, [path], input.kind, signal, actor,
      () => this.repository.assertSessionWorkspaceAccess(input.sessionId, actor, input.workspaceId));
    prepared.workspace = { ...input };
    this.preparedImports.set(prepared, structuredClone(prepared));
    return prepared;
  }

  commitImport(prepared: PreparedLibraryImport, signal?: AbortSignal, executorBotId?: string): LibraryImportResult {
    const snapshot = this.preparedImports.get(prepared);
    if (!snapshot) throw new AevorenBotError("LIBRARY_IMPORT_INVALID");
    this.assertScope(snapshot.sessionId, executorBotId, signal);
    if (snapshot.workspace) this.repository.assertSessionWorkspaceAccess(snapshot.sessionId, this.workspaceExecutor(snapshot.sessionId, executorBotId), snapshot.workspace.workspaceId);
    const imported = snapshot.resources.length ? this.repository.library.createMany(snapshot.resources, executorBotId) : [];
    this.preparedImports.delete(prepared);
    return { imported, skipped: snapshot.skipped };
  }

  async importPaths(sessionId: string, paths: readonly string[], kind: LibraryResourceKind, signal?: AbortSignal, executorBotId?: string): Promise<LibraryImportResult> {
    return this.commitImport(await this.prepareImportPaths(sessionId, paths, kind, signal, executorBotId), signal, executorBotId);
  }

  async importPath(input: WorkspaceImportInput, signal?: AbortSignal, executorBotId?: string): Promise<LibraryImportResult> {
    return this.commitImport(await this.prepareImportPath(input, signal, executorBotId), signal, executorBotId);
  }

  async readResourceFile(input: { sessionId: string; id: string; revisionId: string; path: string }, signal?: AbortSignal, executorBotId?: string): Promise<LibraryResourceFileResult> {
    this.assertScope(input.sessionId, executorBotId, signal);
    const content = this.repository.library.read({ sessionId: input.sessionId, id: input.id, revisionId: input.revisionId }, executorBotId);
    let file: ResourceFileRef;
    let bytes: Buffer;
    if (content.resource.kind === "skill" && input.path === "SKILL.md") {
      bytes = Buffer.from(content.revision.body, "utf8");
      file = { relativePath: "SKILL.md", size: bytes.length, sha256: libraryBytesDigest(bytes), mimeType: "text/markdown" };
    } else {
      const match = content.revision.files.find((file) => file.relativePath === input.path);
      if (!match || posix.normalize(input.path) !== input.path) throw new AevorenBotError("LIBRARY_FILE_NOT_FOUND");
      file = match;
      bytes = await this.blobs.read(file.sha256, file.size, signal);
    }
    this.assertScope(input.sessionId, executorBotId, signal);
    this.repository.library.read({ sessionId: input.sessionId, id: input.id, revisionId: input.revisionId }, executorBotId);
    const text = TEXT_TYPES[extname(file.relativePath).toLowerCase()] ? decodeText(bytes) : null;
    return { ...file, encoding: text === null ? "base64" : "utf8", data: text ?? bytes.toString("base64") };
  }

  async prepareExport(input: LibraryReadInput, signal?: AbortSignal, executorBotId?: string): Promise<PreparedLibraryExport> {
    this.assertScope(input.sessionId, executorBotId, signal);
    const content = this.repository.library.read(input, executorBotId);
    let body = content.revision.body;
    if (content.resource.kind === "skill") {
      const metadata = skillMetadata(body, false);
      const display = { aevorenDisplayName: content.revision.name, aevorenDescription: content.revision.description };
      if (!metadata) {
        const name = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(content.revision.name) && content.revision.name.length <= 64
          ? content.revision.name : `skill-${content.resource.id}`;
        body = `---\n${stringify({ name, description: (content.revision.description || content.revision.name).slice(0, 1_024), metadata: display }).trimEnd()}\n---\n${body}`;
      } else if (metadata.name !== content.revision.name || metadata.description !== content.revision.description) {
        const frontmatter = SKILL_FRONTMATTER.exec(body)!;
        const parsed = parseDocument(frontmatter[1]!, { schema: "core", uniqueKeys: true });
        parsed.setIn(["metadata", "aevorenDisplayName"], display.aevorenDisplayName);
        parsed.setIn(["metadata", "aevorenDescription"], display.aevorenDescription);
        body = `---\n${parsed.toString().trimEnd()}\n---\n${body.slice(frontmatter[0].length)}`;
      }
    }
    if (Buffer.byteLength(body, "utf8") > MAX_LIBRARY_TEXT_BYTES) throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
    const files: PreparedLibraryExport["files"] = [{ relativePath: content.resource.kind === "skill" ? "SKILL.md" : "document.md", bytes: Buffer.from(body, "utf8") }];
    for (const file of content.revision.files) {
      const bytes = await this.blobs.read(file.sha256, file.size, signal);
      this.assertScope(input.sessionId, executorBotId, signal);
      this.repository.library.read(input, executorBotId);
      files.push({ relativePath: file.relativePath, bytes });
    }
    this.assertScope(input.sessionId, executorBotId, signal);
    if (files.reduce((size, file) => size + file.bytes.length, 0) > MAX_LIBRARY_IMPORT_BYTES) throw new AevorenBotError("LIBRARY_IMPORT_TOO_LARGE");
    return { name: content.revision.name, kind: content.resource.kind, resourceId: content.resource.id, revisionId: content.revision.id, files };
  }
}
