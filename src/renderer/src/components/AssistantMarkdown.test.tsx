import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMarkdown } from "./AssistantMarkdown";

const completeMarkdown = `# 一级标题

## 二级标题

- 无序项目
- 第二项

1. 有序项目
2. 第二项

普通文本包含 **加粗**、*斜体* 和 \`行内代码\`。

> 这是一段引用。

[安全链接](https://example.com/docs)

\`\`\`ts
const value = 1;
console.log(value);
\`\`\`

| 字段 | 内容 |
| --- | --- |
| 名称 | Aevoren Bot |

---

<img src=x onerror="alert('xss')">

[危险链接](javascript:alert('xss'))`;

describe("AssistantMarkdown", () => {
  it("renders CommonMark and GFM structures without changing the source text", () => {
    const source = completeMarkdown;
    const html = renderToStaticMarkup(<AssistantMarkdown body={source} />);

    expect(source).toBe(completeMarkdown);
    expect(html).toContain("<h1>一级标题</h1>");
    expect(html).toContain("<h2>二级标题</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain("<code>行内代码</code>");
    expect(html).toContain("<pre><code class=\"language-ts\"");
    expect(html).toContain("const value = 1;\nconsole.log(value);\n");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<hr/>");
    expect(html).toContain("class=\"markdown-table-wrap\"");
    expect(html).toContain("<table>");
    expect(html).toContain("<a href=\"https://example.com/docs\" target=\"_blank\" rel=\"noreferrer noopener\"");
  });

  it("does not execute embedded HTML or unsafe link protocols", () => {
    const html = renderToStaticMarkup(<AssistantMarkdown body={completeMarkdown} />);

    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("href=\"javascript:");
    expect(html).toContain("<span class=\"markdown-unsafe-link\">危险链接</span>");
  });

  it("renders an incomplete streaming prefix and converges without duplicated content", () => {
    const partial = "## 流式标题\n\n- 第一项\n- 第二";
    const partialHtml = renderToStaticMarkup(<AssistantMarkdown body={partial} />);
    const completedHtml = renderToStaticMarkup(<AssistantMarkdown body={`${partial}项\n\n**完成**`} />);

    expect(partialHtml).toContain("<h2>流式标题</h2>");
    expect(partialHtml).toContain("<li>第二</li>");
    expect(completedHtml).toContain("<li>第二项</li>");
    expect(completedHtml).toContain("<strong>完成</strong>");
    expect(completedHtml.match(/第二项/g)).toHaveLength(1);
  });
});
