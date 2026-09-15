import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";

const completeMarkdown = `# Markdown 验收

## 列表

- 无序项目
- 第二项

1. 有序项目
2. 第二项

普通文本包含 **加粗**、*斜体* 和 \`行内代码\`。

> 引用内容需要有清晰层级。

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

test("renders Markdown during streaming and keeps the same semantic structure when completed", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-markdown-"));
  const environment = {
    ...process.env,
    AEVOREN_BOT_USER_DATA_DIR: userDataDir,
    AEVOREN_BOT_FAKE_PROVIDER: "1",
    AEVOREN_BOT_FAKE_DELAY_MS: "180",
  };

  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.getByRole("button", { name: "创建新 Bot" }).click();
    await page.getByRole("button", { name: "模型设置" }).click();
    await page.getByLabel("Model ID").fill("markdown-smoke-model");
    await page.getByLabel("API Key").fill("markdown-smoke-key-not-a-real-secret");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: "关闭" }).click();

    await page.getByLabel("消息").fill("请使用 Markdown 回复。");
    await page.getByRole("button", { name: "发送" }).click();

    const assistant = page.locator("article.message-assistant");
    await expect(assistant).toHaveAttribute("data-status", "streaming");
    await expect(assistant.locator("h2", { hasText: "背景" })).toBeVisible();
    await expect(assistant).toHaveAttribute("data-status", "streaming");
    await expect(assistant).not.toContainText("## 背景");

    await expect(assistant).toHaveAttribute("data-status", "completed");
    await expect(assistant.locator("h2")).toHaveCount(10);
    await expect(assistant.locator("ol > li")).toHaveCount(2);
    await expect(assistant.locator("h2", { hasText: "背景" })).toHaveCount(1);

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"));
    try {
      database
        .prepare(
          `UPDATE transcript_entries
           SET body = ?, updated_seq = updated_seq + 1, updated_at = ?
           WHERE id = (
             SELECT id FROM transcript_entries WHERE role = 'assistant' ORDER BY seq DESC LIMIT 1
           )`,
        )
        .run(completeMarkdown, new Date().toISOString());
    } finally {
      database.close();
    }

    await page.reload();
    const markdown = page.locator("article.message-assistant .assistant-markdown");
    await expect(markdown.locator("h1", { hasText: "Markdown 验收" })).toBeVisible();
    await expect(markdown.locator("ul > li")).toHaveCount(2);
    await expect(markdown.locator("ol > li")).toHaveCount(2);
    await expect(markdown.locator("strong", { hasText: "加粗" })).toBeVisible();
    await expect(markdown.locator("em", { hasText: "斜体" })).toBeVisible();
    await expect(markdown.locator("p > code", { hasText: "行内代码" })).toBeVisible();
    await expect(markdown.locator("pre > code.language-ts")).toContainText("console.log(value);");
    await expect(markdown.locator("blockquote")).toContainText("引用内容");
    await expect(markdown.locator("a", { hasText: "安全链接" })).toHaveAttribute("href", "https://example.com/docs");
    await expect(markdown.locator("table th")).toHaveCount(2);
    await expect(markdown.locator("table td")).toHaveCount(2);
    await expect(markdown.locator("hr")).toHaveCount(1);
    await expect(markdown.locator("img, script")).toHaveCount(0);
    await expect(markdown.locator("a", { hasText: "危险链接" })).toHaveCount(0);
    await expect(markdown).toContainText("危险链接");

    const tableLayout = await markdown.locator(".markdown-table-wrap").evaluate((element) => {
      const container = element as HTMLElement;
      const parent = container.parentElement as HTMLElement;
      return {
        overflowX: getComputedStyle(container).overflowX,
        contained: container.getBoundingClientRect().width <= parent.getBoundingClientRect().width,
      };
    });
    expect(tableLayout).toEqual({ overflowX: "auto", contained: true });
    await expect(markdown.locator("pre")).toHaveCSS("overflow-x", "auto");
    await expect(markdown.locator("pre > code")).toHaveCSS("white-space", "pre");
    await page.screenshot({ path: "/tmp/aevoren-bot-markdown-rendered.png", fullPage: true });
  } finally {
    await application.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
