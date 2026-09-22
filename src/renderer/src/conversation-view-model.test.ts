import { describe, expect, it } from "vitest";
import type { ToolInvocation } from "@shared/contracts";
import { conversationArtifacts, groupToolActivity } from "./conversation-view-model";

function tool(id: string, state: ToolInvocation["state"], kind: ToolInvocation["toolKind"] = "workspace-read", path = `${id}.md`): ToolInvocation {
  return {
    id,
    state,
    toolKind: kind,
    targetPath: path,
    workspaceId: "workspace",
    resultMetadata: kind === "workspace-write" && state === "succeeded" ? { bytes: 42 } : null,
  } as ToolInvocation;
}

describe("conversation view model", () => {
  it("folds only consecutive successful steps and leaves failures visible", () => {
    const result = groupToolActivity([
      tool("read", "succeeded"),
      tool("search", "succeeded", "web-search"),
      tool("failed", "failed", "web-fetch"),
      tool("write", "succeeded", "workspace-write"),
    ]);
    expect(result.map((item) => item.kind)).toEqual(["run", "tool", "tool"]);
    expect(result[0]?.kind === "run" ? result[0].invocations.map((item) => item.id) : []).toEqual(["read", "search"]);
    expect(result[1]?.id).toBe("failed");
  });

  it("derives unique artifacts only from successful real workspace writes", () => {
    const result = conversationArtifacts([
      tool("draft", "succeeded", "workspace-write", "03-drafts/draft.md"),
      tool("duplicate", "succeeded", "workspace-write", "03-drafts/draft.md"),
      tool("failed", "failed", "workspace-write", "04-review/review.md"),
    ]);
    expect(result).toEqual([expect.objectContaining({ id: "draft", name: "draft.md", extension: "MD", bytes: 42 })]);
  });
});
