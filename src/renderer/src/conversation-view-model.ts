import type { ToolInvocation } from "@shared/contracts";

export type ToolActivityItem =
  | { kind: "tool"; id: string; invocation: ToolInvocation }
  | { kind: "run"; id: string; invocations: ToolInvocation[] };

export type ConversationArtifact = {
  id: string;
  invocation: ToolInvocation;
  name: string;
  extension: string | null;
  bytes: number | null;
};

function flushSuccessfulRun(target: ToolActivityItem[], run: ToolInvocation[]): void {
  if (run.length === 1) {
    const invocation = run[0]!;
    target.push({ kind: "tool", id: invocation.id, invocation });
  } else if (run.length > 1) {
    target.push({ kind: "run", id: `tool-run:${run[0]!.id}`, invocations: [...run] });
  }
  run.length = 0;
}

/**
 * Finished successful steps can be folded without hiding live, failed or
 * approval-gated work. A non-successful invocation always breaks the run.
 */
export function groupToolActivity(invocations: ToolInvocation[]): ToolActivityItem[] {
  const items: ToolActivityItem[] = [];
  const successfulRun: ToolInvocation[] = [];
  for (const invocation of invocations) {
    if (invocation.state === "succeeded") {
      successfulRun.push(invocation);
      continue;
    }
    flushSuccessfulRun(items, successfulRun);
    items.push({ kind: "tool", id: invocation.id, invocation });
  }
  flushSuccessfulRun(items, successfulRun);
  return items;
}

function artifactName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

export function conversationArtifacts(invocations: ToolInvocation[]): ConversationArtifact[] {
  const seen = new Set<string>();
  return invocations.flatMap((invocation) => {
    if (invocation.toolKind !== "workspace-write" || invocation.state !== "succeeded") return [];
    const identity = `${invocation.workspaceId ?? "unknown"}:${invocation.targetPath}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    const name = artifactName(invocation.targetPath);
    const extensionMatch = /\.([^.]+)$/u.exec(name);
    const bytes = typeof invocation.resultMetadata?.bytes === "number" ? invocation.resultMetadata.bytes : null;
    return [{
      id: invocation.id,
      invocation,
      name,
      extension: extensionMatch?.[1]?.toLocaleUpperCase("en-US") ?? null,
      bytes,
    }];
  });
}
