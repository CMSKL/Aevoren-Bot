import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AppRepository } from "./database";
import { WorkspaceService } from "./workspace-service";
import { AevorenBotError } from "./errors";

/** Read only a journalled artifact, inside its still-authorized root, with a pinned digest. */
export async function readVerifiedArtifact(repository: AppRepository, artifact: {
  workspaceId: string;
  path: string;
  sha256: string | null;
}): Promise<string> {
  if (!artifact.sha256 || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
  const target = await new WorkspaceService(repository).resolveExistingTarget(artifact.workspaceId, artifact.path, "file");
  const handle = await open(target.canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 262_144) throw new AevorenBotError("HANDOFF_CONTEXT_INVALID");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new AevorenBotError("WORKSPACE_TARGET_CHANGED");
    }
    const bytes = buffer.subarray(0, bytesRead);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new AevorenBotError("WORKSPACE_TARGET_CHANGED");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}
