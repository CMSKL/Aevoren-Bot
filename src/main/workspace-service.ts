import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { WorkspaceRegistrationResult } from "@shared/contracts";
import { workspaceRelativePathSchema } from "@shared/schemas";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";

export type ResolvedWorkspaceTarget = {
  workspaceId: string;
  relativePath: string;
  canonicalPath: string;
};

export type ResolvedWorkspaceWriteTarget = ResolvedWorkspaceTarget & {
  canonicalParent: string;
};

function isContained(rootPath: string, targetPath: string): boolean {
  const offset = relative(rootPath, targetPath);
  return offset === "" || !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
}

function invalidRoot(): never {
  throw new AevorenBotError("WORKSPACE_INVALID_ROOT");
}

export class WorkspaceService {
  constructor(private readonly repository: AppRepository) {}

  async registerRoot(rootPath: string): Promise<WorkspaceRegistrationResult> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(rootPath);
      if (!(await stat(canonicalRoot)).isDirectory()) invalidRoot();
    } catch (error) {
      if (error instanceof AevorenBotError) throw error;
      invalidRoot();
    }
    if (parse(canonicalRoot).root === canonicalRoot) {
      throw new AevorenBotError("WORKSPACE_SCOPE_TOO_BROAD");
    }
    return this.repository.registerWorkspaceRoot(canonicalRoot, basename(canonicalRoot));
  }

  async resolveExistingTarget(
    workspaceId: string,
    relativePath: string,
    expectedType: "file" | "directory",
  ): Promise<ResolvedWorkspaceTarget> {
    const normalized = workspaceRelativePathSchema.parse(relativePath);
    const { rootPath } = this.repository.getWorkspaceRoot(workspaceId);
    const candidate = resolve(rootPath, normalized || ".");
    if (!isContained(rootPath, candidate)) throw new AevorenBotError("WORKSPACE_PATH_OUTSIDE_ROOT");
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(candidate);
    } catch {
      throw new AevorenBotError("WORKSPACE_TARGET_NOT_FOUND");
    }
    if (!isContained(rootPath, canonicalPath)) throw new AevorenBotError("WORKSPACE_PATH_OUTSIDE_ROOT");
    let targetStat;
    try {
      targetStat = await stat(canonicalPath);
    } catch {
      throw new AevorenBotError("WORKSPACE_TARGET_NOT_FOUND");
    }
    if (expectedType === "file" ? !targetStat.isFile() : !targetStat.isDirectory()) {
      throw new AevorenBotError("WORKSPACE_TARGET_TYPE_INVALID");
    }
    return { workspaceId, relativePath: normalized, canonicalPath };
  }

  async resolveNewTextTarget(workspaceId: string, relativePath: string): Promise<ResolvedWorkspaceWriteTarget> {
    const normalized = workspaceRelativePathSchema.parse(relativePath);
    if (!normalized || !/\.(?:md|csv)$/iu.test(normalized)) {
      throw new AevorenBotError("WORKSPACE_TARGET_TYPE_INVALID");
    }
    const { workspace, rootPath } = this.repository.getWorkspaceRoot(workspaceId);
    if (!workspace.writeEnabled) throw new AevorenBotError("WORKSPACE_WRITE_NOT_ENABLED");
    const candidate = resolve(rootPath, normalized);
    if (!isContained(rootPath, candidate)) throw new AevorenBotError("WORKSPACE_PATH_OUTSIDE_ROOT");
    const parent = dirname(candidate);
    let canonicalParent: string;
    try {
      canonicalParent = await realpath(parent);
      const parentStat = await lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || canonicalParent !== parent) {
        throw new AevorenBotError("WORKSPACE_TARGET_CHANGED");
      }
    } catch (error) {
      if (error instanceof AevorenBotError) throw error;
      throw new AevorenBotError("WORKSPACE_TARGET_NOT_FOUND");
    }
    if (!isContained(rootPath, canonicalParent) || !isContained(rootPath, candidate)) {
      throw new AevorenBotError("WORKSPACE_PATH_OUTSIDE_ROOT");
    }
    try {
      await lstat(candidate);
      throw new AevorenBotError("WORKSPACE_WRITE_CONFLICT");
    } catch (error) {
      if (error instanceof AevorenBotError) throw error;
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
        throw new AevorenBotError("WORKSPACE_WRITE_FAILED");
      }
    }
    return { workspaceId, relativePath: normalized, canonicalPath: candidate, canonicalParent };
  }
}
