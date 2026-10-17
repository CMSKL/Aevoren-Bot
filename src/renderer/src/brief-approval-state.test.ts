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
  it("shows when a real Brief exists and does not mistake ordinary approval text for an authoritative decision", () => {
    expect(shouldShowBriefApproval([write("02-briefs/options.md")], [user("请生成 Brief", "2026-09-21T23:59:00.000Z")])).toBe(true);
    expect(shouldShowBriefApproval([write("02-briefs/options.md")], [user("APPROVED：批准候选 A")])).toBe(true);
    expect(shouldShowBriefApproval([write("02-briefs/options.md")], [user("我已批准候选 B")])).toBe(true);
    expect(shouldShowBriefApproval([write("02-briefs/options.md")], [user("RETURN：退回补证")])).toBe(false);
  });

  it("stays hidden after a downstream artifact is written", () => {
    expect(shouldShowBriefApproval([
      write("02-briefs/options.md"),
      write("03-drafts/draft.md", "2026-09-22T00:01:00.000Z"),
    ], [])).toBe(false);
  });

  it("extracts concise candidate labels without inventing missing content", () => {
    expect(briefCandidateOptions(`## 候选 A\n标题：《单线状态机》\n核心角度：单线调度\n证据来源：线索 1\n风险：术语偏工程\n推荐理由：证据最完整\n\n候选 B：三个门禁\n\n### 方案 C 证据链设计`)).toEqual([
      { id: "A", title: "单线状态机", angle: "单线调度", evidence: "线索 1", risk: "术语偏工程", recommendation: "证据最完整" },
      { id: "B", title: "三个门禁", angle: null, evidence: null, risk: null, recommendation: null },
      { id: "C", title: "证据链设计", angle: null, evidence: null, risk: null, recommendation: null },
    ]);
    expect(briefCandidateOptions("只有一段普通 Brief")).toEqual([]);
    expect(briefCandidateOptions("# 候选 A\n# 候选 B\n# 候选 C")).toEqual([]);
  });

  it("reads emphasized fields and multiline evidence without turning absent candidates into choices", () => {
    expect(briefCandidateOptions(`## **候选 A：真实产物如何跨阶段传递**
- **核心角度：** 交接凭证
- **证据来源：**
  - [真实读取记录](https://example.org/source)
  - 01-research/scout.md
- **风险：** 样本有限
- **推荐理由：** 可追溯

## 汇总
推荐：不要把这句当成候选 A 的推荐字段
`)).toEqual([{
      id: "A",
      title: "真实产物如何跨阶段传递",
      angle: "交接凭证",
      evidence: "[真实读取记录](https://example.org/source)\n01-research/scout.md",
      risk: "样本有限",
      recommendation: "可追溯",
    }]);
  });

  it("keeps full decision content and prefers an explicit title over a heading qualifier", () => {
    const title = "真实文件交接".repeat(30);
    const risk = "必须检查授权目录与文件摘要。".repeat(30);
    const [option] = briefCandidateOptions(`## Candidate B: recommended\nTitle: ${title}\nAngle: scoped handoff\nRisk: ${risk}`);
    expect(option?.id).toBe("B");
    expect(option?.title).toBe(title);
    expect(option?.risk).toBe(risk);
  });

  it("accepts a recommendation annotation in a real saved Brief heading", () => {
    expect(briefCandidateOptions(`## 候选 A（推荐）：「Aevoren Bot 已发布」— 极简事实通知

- 核心角度：只陈述可核验发布事实
- 证据来源：官方 Release API
- 风险：不得虚构功能
- 推荐理由：与现有证据强度最匹配

## 候选 B：「可校验分发」— 技术信任角度

- 核心角度：校验材料
`)).toEqual([
      {
        id: "A",
        title: "Aevoren Bot 已发布」— 极简事实通知",
        angle: "只陈述可核验发布事实",
        evidence: "官方 Release API",
        risk: "不得虚构功能",
        recommendation: "与现有证据强度最匹配",
      },
      {
        id: "B",
        title: "可校验分发」— 技术信任角度",
        angle: "校验材料",
        evidence: null,
        risk: null,
        recommendation: null,
      },
    ]);
  });

  it("accepts a vertical separator and annotated title field from a real Provider Brief", () => {
    expect(briefCandidateOptions(`## 候选 A｜「可核验的协作」：把每个声明都对上工具记录

- **标题（备选即用）**：\`Aevoren Bot v0.3.0-beta.5：让每一次“已完成”都能对上工具记录\`
- **核心角度**：区分模型文字和真实执行
- **证据来源**：官方 CHANGELOG
- **风险**：避免绝对化表述
- **推荐理由**：证据最扎实

## 候选 B｜「内容团队模板」：五阶段协作流程开箱可用

- **标题（备选即用）**：一键搭起内容团队
`)).toEqual([
      {
        id: "A",
        title: "Aevoren Bot v0.3.0-beta.5：让每一次“已完成”都能对上工具记录",
        angle: "区分模型文字和真实执行",
        evidence: "官方 CHANGELOG",
        risk: "避免绝对化表述",
        recommendation: "证据最扎实",
      },
      {
        id: "B",
        title: "一键搭起内容团队",
        angle: null,
        evidence: null,
        risk: null,
        recommendation: null,
      },
    ]);
  });
});
