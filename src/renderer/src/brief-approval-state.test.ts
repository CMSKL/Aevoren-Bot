import { describe, expect, it } from "vitest";
import type { ToolInvocation, TranscriptEntry } from "@shared/contracts";
import { briefCandidateOptions, shouldShowBriefApproval } from "./brief-approval-state";

function write(path: string, createdAt = "2026-09-22T00:00:00.000Z"): ToolInvocation {
  return { toolKind: "workspace-write", state: "succeeded", targetPath: path, createdAt } as ToolInvocation;
}

function user(body: string, createdAt = "2026-09-22T00:00:01.000Z"): TranscriptEntry {
  return { role: "user", body, createdAt } as TranscriptEntry;
}

describe("contextual Brief approval", () => {
  it("shows only when a real Brief exists and no decision has been made", () => {
    expect(shouldShowBriefApproval([write("02-briefs/options.md")], [user("请生成 Brief", "2026-09-21T23:59:00.000Z")])).toBe(true);
    expect(shouldShowBriefApproval([write("02-briefs/options.md")], [user("APPROVED：批准候选 A")])).toBe(false);
    expect(shouldShowBriefApproval([write("02-briefs/options.md")], [user("RETURN：退回补证")])).toBe(false);
  });

  it("stays hidden after a downstream artifact is written", () => {
    expect(shouldShowBriefApproval([
      write("02-briefs/options.md"),
      write("03-drafts/draft.md", "2026-09-22T00:01:00.000Z"),
    ], [])).toBe(false);
  });

  it("extracts concise candidate labels without inventing missing content", () => {
    expect(briefCandidateOptions(`## 候选 A\n《单线状态机》\n\n候选 B：三个门禁\n\n### 方案 C 证据链设计`)).toEqual([
      { id: "A", label: "单线状态机" },
      { id: "B", label: "三个门禁" },
      { id: "C", label: "证据链设计" },
    ]);
    expect(briefCandidateOptions("只有一段普通 Brief")).toEqual([
      { id: "A", label: "候选 A" },
      { id: "B", label: "候选 B" },
      { id: "C", label: "候选 C" },
    ]);
  });
});
