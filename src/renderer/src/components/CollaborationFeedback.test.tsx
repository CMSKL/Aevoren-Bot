import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtifactStatusBar, RunFailureCard } from "./CollaborationFeedback";

describe("ArtifactStatusBar", () => {
  it("does not render a per-reply Markdown export control when there is no saved artifact", () => {
    const html = renderToStaticMarkup(
      <ArtifactStatusBar writes={[]} onRevealWorkspace={() => undefined} onOpenWorkspaces={() => undefined} />,
    );

    expect(html).toBe("");
    expect(html).not.toContain("保存为 Markdown");
  });
});

describe("MCP host task failure", () => {
  it("keeps the original operation record visible without suggesting model retry", () => {
    const html = renderToStaticMarkup(<RunFailureCard step="MCP 成员" errorCode="TOOL_EXECUTION_CANCELLED" invocations={[]} hostMcp canRetry={false} onRetry={() => undefined} />);
    expect(html).toContain("固定 MCP 参数审批或派发阶段");
    expect(html).toContain("固定参数与原 MCP 操作记录");
    expect(html).toContain("不会自动重新调用");
    expect(html).not.toContain("模型文字阶段");
    expect(html).not.toContain("重试此步骤");
  });
});
