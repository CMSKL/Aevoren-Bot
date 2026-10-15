import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotionDraftEditor } from "./NotionDraftEditor";

describe("Notion draft operation controls", () => {
  it("keeps a saved title operation fixed and exposes no body replacement field", () => {
    const html = renderToStaticMarkup(<NotionDraftEditor content={{ kind: "notion-page-title", pageId: "fixed-page", title: "New title" }} saved busy={false} onChange={() => undefined} onKindChange={() => undefined} />);
    expect(html).toMatch(/<select aria-label="Notion 草稿操作"[^>]*disabled=""/);
    expect(html).toContain('aria-label="Notion 草稿新标题"');
    expect(html).toContain('value="fixed-page"');
    expect(html).toContain("不修改正文");
    expect(html).not.toContain("<textarea");
  });
  it("offers append for a new draft with only a page and end-append text", () => {
    const html = renderToStaticMarkup(<NotionDraftEditor content={{ kind: "notion-page-append", pageId: "append-page", text: "Append & keep" }} saved={false} busy={false} onChange={() => undefined} onKindChange={() => undefined} />);
    expect(html).toMatch(/<select aria-label="Notion 草稿操作"[^>]*>/);
    expect(html).not.toMatch(/<select[^>]*disabled/);
    expect(html).toContain('aria-label="Notion 草稿追加正文"');
    expect(html).toContain("Append &amp; keep");
    expect(html).toContain("不会覆盖页面内容");
    expect(html).not.toContain('aria-label="文件草稿标题"');
    expect(html).not.toContain('aria-label="Notion 草稿父页面"');
  });
  it("retains existing create page fields", () => {
    const html = renderToStaticMarkup(<NotionDraftEditor content={{ kind: "notion-page", parentPageId: "parent", title: "Child title", text: "Child body" }} saved={false} busy={false} onChange={() => undefined} onKindChange={() => undefined} />);
    expect(html).toContain('aria-label="Notion 草稿父页面"');
    expect(html).toContain('aria-label="文件草稿标题"');
    expect(html).toContain('aria-label="文件草稿正文"');
  });
});
