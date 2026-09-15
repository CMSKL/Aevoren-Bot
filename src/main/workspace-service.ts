import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { WorkspaceRegistrationResult } from "@shared/contracts";
import { workspaceRelativePathSchema } from "@shared/schemas";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";

export type ResolvedWorkspaceTarget = {
  workspaceId: string;
  relativePath: string;
  canonicalPath: string;
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
}
