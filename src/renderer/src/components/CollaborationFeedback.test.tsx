import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtifactStatusBar } from "./CollaborationFeedback";

describe("ArtifactStatusBar", () => {
  it("does not render a per-reply Markdown export control when there is no saved artifact", () => {
    const html = renderToStaticMarkup(
      <ArtifactStatusBar writes={[]} onRevealWorkspace={() => undefined} onOpenWorkspaces={() => undefined} />,
    );

    expect(html).toBe("");
    expect(html).not.toContain("保存为 Markdown");
  });
});
