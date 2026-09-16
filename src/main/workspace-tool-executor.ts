import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { posix } from "node:path";
import type { Stats } from "node:fs";
import type { ToolInvocation, WorkspaceToolRequest } from "@shared/contracts";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import type { WorkspaceService } from "./workspace-service";

const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_BYTES = 20 * 1_048_576;
const MAX_SEARCH_FILE_BYTES = 1_048_576;
const MAX_SEARCH_DURATION_MS = 5_000;
const MAX_PREVIEW_CHARACTERS = 240;

type ResultMetadata = Record<string, string | number | boolean | null>;

export type WorkspaceToolExecutionResult = {
  invocation: ToolInvocation;
  content: string;
};

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

function cancelled(): AevorenBotError {
  return new AevorenBotError("TOOL_EXECUTION_CANCELLED");
}

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}

function stableError(error: unknown): AevorenBotError {
  return error instanceof AevorenBotError ? error : new AevorenBotError("TOOL_EXECUTION_FAILED");
}

function digestResult(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decodeUtf8(buffer: Buffer): string {
  if (buffer.includes(0)) throw new AevorenBotError("WORKSPACE_BINARY_UNSUPPORTED");
  const firstPossibleBoundary = Math.max(0, buffer.length - 3);
  for (let end = buffer.length; end >= firstPossibleBoundary; end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
    } catch {
      // A bounded read can stop inside one UTF-8 code point. Only trim that suffix.
    }
  }
  throw new AevorenBotError("WORKSPACE_BINARY_UNSUPPORTED");
}

async function stableDirectoryEntries(path: string, signal: AbortSignal) {
  try {
    checkCancellation(signal);
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new AevorenBotError("WORKSPACE_TARGET_CHANGED");
    }
    const entries = await readdir(path, { withFileTypes: true });
    checkCancellation(signal);
    const after = await lstat(path);
    if (!sameIdentity(before, after) || !after.isDirectory() || after.isSymbolicLink()) {
      throw new AevorenBotError("WORKSPACE_TARGET_CHANGED");
    }
    return {
      entries: entries.toSorted((left, right) => compareNames(left.name, right.name)),
      identity: after,
    };
  } catch (error) {
    if (error instanceof AevorenBotError) throw error;
    throw new AevorenBotError("WORKSPACE_TARGET_CHANGED");
  }
}

export class WorkspaceToolExecutor {
  constructor(
    private readonly repository: AppRepository,
    private readonly workspaceService: WorkspaceService,
  ) {}

  async execute(id: string, signal: AbortSignal = new AbortController().signal): Promise<WorkspaceToolExecutionResult> {
    const initial = this.repository.getToolInvocation(id);
    if (initial.state !== "approved") {
      throw new AevorenBotError("TOOL_STATE_INVALID", undefined, undefined, { currentState: initial.state });
    }
    if (signal.aborted) {
      this.repository.cancelToolInvocation(id);
      throw cancelled();
    }

    this.repository.transitionToolInvocation(id, "dispatching");
    try {
      const targetType = initial.toolKind === "workspace-read" ? "file" : "directory";
      await this.workspaceService.resolveExistingTarget(initial.workspaceId, initial.targetPath, targetType);
      checkCancellation(signal);
      this.repository.transitionToolInvocation(id, "running");

      const result = await this.run(initial.arguments, signal);
      checkCancellation(signal);
      const invocation = this.repository.completeToolInvocation(id, digestResult(result.content), result.metadata);
      return { invocation, content: result.content };
    } catch (error) {
      const normalized = signal.aborted ? cancelled() : stableError(error);
      const current = this.repository.getToolInvocation(id);
      if (normalized.code === "TOOL_EXECUTION_CANCELLED") {
        if (["awaiting-approval", "approved", "dispatching", "running"].includes(current.state)) {
          this.repository.cancelToolInvocation(id);
        }
      } else if (current.state === "dispatching" || current.state === "running") {
        this.repository.failToolInvocation(id, normalized.code);
      }
      throw normalized;
    }
  }

  private async run(
    tool: WorkspaceToolRequest,
    signal: AbortSignal,
  ): Promise<{ content: string; metadata: ResultMetadata }> {
    switch (tool.kind) {
      case "workspace-list":
        return this.list(tool, signal);
      case "workspace-read":
        return this.read(tool, signal);
      case "workspace-search":
        return this.search(tool, signal);
    }
  }

  private async list(
    tool: Extract<WorkspaceToolRequest, { kind: "workspace-list" }>,
    signal: AbortSignal,
  ): Promise<{ content: string; metadata: ResultMetadata }> {
    const target = await this.workspaceService.resolveExistingTarget(tool.workspaceId, tool.path, "directory");
    const directory = await stableDirectoryEntries(target.canonicalPath, signal);
    const entries = directory.entries;
    const visible = entries.slice(0, tool.maxEntries).map((entry) => ({
      name: entry.name,
      type: entry.isFile()
        ? "file"
        : entry.isDirectory()
          ? "directory"
          : entry.isSymbolicLink()
            ? "symlink"
            : "other",
    }));
    await this.verifyTargetUnchanged(tool.workspaceId, tool.path, "directory", target.canonicalPath, directory.identity);
    const truncated = entries.length > visible.length;
    return {
      content: JSON.stringify({ entries: visible, truncated }),
      metadata: { kind: tool.kind, entries: visible.length, truncated },
    };
  }

  private async read(
    tool: Extract<WorkspaceToolRequest, { kind: "workspace-read" }>,
    signal: AbortSignal,
  ): Promise<{ content: string; metadata: ResultMetadata }> {
    const value = await this.readText(tool.workspaceId, tool.path, tool.maxBytes, signal);
    return {
      content: JSON.stringify({ text: value.text, truncated: value.truncated }),
      metadata: { kind: tool.kind, bytes: value.bytes, truncated: value.truncated },
    };
  }

  private async search(
    tool: Extract<WorkspaceToolRequest, { kind: "workspace-search" }>,
    signal: AbortSignal,
  ): Promise<{ content: string; metadata: ResultMetadata }> {
    const root = await this.workspaceService.resolveExistingTarget(tool.workspaceId, tool.path, "directory");
    const rootIdentity = await lstat(root.canonicalPath);
    const deadline = Date.now() + MAX_SEARCH_DURATION_MS;
    const matches: Array<{ path: string; line: number; preview: string }> = [];
    let files = 0;
    let bytes = 0;
    let truncated = false;

    const limitReached = (): boolean => {
      checkCancellation(signal);
      if (matches.length >= tool.maxMatches || files >= MAX_SEARCH_FILES || bytes >= MAX_SEARCH_BYTES || Date.now() >= deadline) {
        truncated = true;
        return true;
      }
      return false;
    };

    const visit = async (relativeDirectory: string, canonicalDirectory: string): Promise<void> => {
      if (limitReached()) return;
      const directory = await stableDirectoryEntries(canonicalDirectory, signal);
      for (const entry of directory.entries) {
        if (limitReached()) return;
        const childRelative = relativeDirectory ? posix.join(relativeDirectory, entry.name) : entry.name;
        const childCanonical = posix.join(canonicalDirectory, entry.name);
        const before = await lstat(childCanonical);
        if (before.isSymbolicLink()) continue;
        if (before.isDirectory()) {
          await visit(childRelative, childCanonical);
          continue;
        }
        if (!before.isFile()) continue;

        try {
          const remainingBytes = MAX_SEARCH_BYTES - bytes;
          if (remainingBytes <= 0) {
            truncated = true;
            return;
          }
          const maxBytes = Math.min(MAX_SEARCH_FILE_BYTES, remainingBytes);
          const result = await this.readText(tool.workspaceId, childRelative, maxBytes, signal);
          if (Date.now() >= deadline) {
            truncated = true;
            return;
          }
          const after = await lstat(childCanonical);
          if (!sameIdentity(before, after) || after.isSymbolicLink()) {
            throw new AevorenBotError("WORKSPACE_TARGET_CHANGED");
          }
          files += 1;
          bytes += result.bytes;
          if (result.truncated) truncated = true;
          const lines = result.text.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? "";
            if (!line.includes(tool.query)) continue;
            matches.push({
              path: childRelative,
              line: index + 1,
              preview: line.trim().slice(0, MAX_PREVIEW_CHARACTERS),
            });
            if (matches.length >= tool.maxMatches) {
              truncated = true;
              return;
            }
          }
        } catch (error) {
          if (error instanceof AevorenBotError && error.code === "WORKSPACE_BINARY_UNSUPPORTED") continue;
          throw error;
        }
      }
    };

    await visit(tool.path, root.canonicalPath);
    await this.verifyTargetUnchanged(tool.workspaceId, tool.path, "directory", root.canonicalPath, rootIdentity);
    return {
      content: JSON.stringify({ matches, truncated }),
      metadata: { kind: tool.kind, files, matches: matches.length, truncated },
    };
  }

  private async readText(
    workspaceId: string,
    relativePath: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ text: string; bytes: number; truncated: boolean }> {
    checkCancellation(signal);
    const target = await this.workspaceService.resolveExistingTarget(workspaceId, relativePath, "file");
    const handle = await open(target.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new AevorenBotError("WORKSPACE_TARGET_CHANGED");
      const buffer = Buffer.allocUnsafe(maxBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        checkCancellation(signal);
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      checkCancellation(signal);
      const after = await handle.stat();
      if (!sameIdentity(before, after)) throw new AevorenBotError("WORKSPACE_TARGET_CHANGED");
      await this.verifyTargetUnchanged(workspaceId, relativePath, "file", target.canonicalPath, after);

      const bounded = buffer.subarray(0, Math.min(offset, maxBytes));
      const text = decodeUtf8(bounded);
      const decodedBytes = Buffer.byteLength(text, "utf8");
      return {
        text,
        bytes: decodedBytes,
        truncated: offset > decodedBytes || after.size > decodedBytes,
      };
    } finally {
      await handle.close();
    }
  }

  private async verifyTargetUnchanged(
    workspaceId: string,
    relativePath: string,
    expectedType: "file" | "directory",
    canonicalPath: string,
    identity?: Stats,
  ): Promise<void> {
    const latest = await this.workspaceService.resolveExistingTarget(workspaceId, relativePath, expectedType);
    if (latest.canonicalPath !== canonicalPath) throw new AevorenBotError("WORKSPACE_TARGET_CHANGED");
    if (identity) {
      const latestStat = await lstat(latest.canonicalPath);
      if (!sameIdentity(identity, latestStat)) throw new AevorenBotError("WORKSPACE_TARGET_CHANGED");
    }
  }
}
