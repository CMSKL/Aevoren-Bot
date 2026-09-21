import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExpandableTrace, type ExpandableTraceKind } from "./ExpandableTrace";

const kinds: ExpandableTraceKind[] = ["steps", "reasoning", "search", "coding"];

describe("ExpandableTrace", () => {
  it.each(kinds)("uses the shared expandable structure for %s traces", (kind) => {
    const html = renderToStaticMarkup(
      <ExpandableTrace
        active={false}
        activeLabel="正在处理"
        autoExpanded={true}
        kind={kind}
        rows={[{ id: "row-1", primary: "处理任务", secondary: "detail.txt", trailing: "已完成" }]}
        settledLabel="处理完成"
        tone="success"
      >
        <span>附加状态</span>
      </ExpandableTrace>,
    );

    expect(html).toContain(`data-trace-kind="${kind}"`);
    expect(html).toContain("expandable-trace-header");
    expect(html).toContain("expandable-trace-collapse is-expanded");
    expect(html).toContain("expandable-trace-line");
    expect(html).toContain("expandable-trace-row");
    expect(html).toContain("处理完成");
    expect(html).toContain("附加状态");
    expect(html).toContain("aria-expanded=\"true\"");
  });

  it("renders the shared loading treatment and starts collapsed when requested", () => {
    const html = renderToStaticMarkup(
      <ExpandableTrace
        active
        activeLabel="正在搜索"
        autoExpanded={false}
        kind="search"
        rows={[{ id: "row-1", primary: "查询资料" }]}
        settledLabel="已完成搜索"
        tone="working"
      />,
    );

    expect(html).toContain("expandable-trace-label is-active");
    expect(html).toContain("expandable-trace-spinner");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("aria-hidden=\"true\"");
  });
});
