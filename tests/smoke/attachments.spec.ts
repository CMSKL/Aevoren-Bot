import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { removeTestDirectory } from "./test-cleanup";

test("attaches a bounded text file to a direct message and restores its metadata", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-attachments-"));
  const sourcePath = join(userDataDir, "requirements.md");
  const artifactPath = join(userDataDir, "saved-result.md");
  writeFileSync(sourcePath, "# Requirements\n\nKeep this source.", "utf8");
  const environment = {
    ...process.env,
    AEVOREN_BOT_USER_DATA_DIR: userDataDir,
    AEVOREN_BOT_FAKE_PROVIDER: "1",
    AEVOREN_BOT_TEST_HIDDEN: "1",
    AEVOREN_BOT_ATTACHMENT_TEST_PATHS: sourcePath,
    AEVOREN_BOT_ARTIFACT_TEST_PATH: artifactPath,
  };

  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  const page = await application.firstWindow();
  let applicationClosed = false;
  try {
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.getByRole("button", { name: "创建新 Bot" }).click();
    await expect(page.getByRole("heading", { name: "新建 Bot" })).toBeVisible();
    await page.getByLabel("添加文本附件").click();
    await expect(page.getByRole("button", { name: /移除附件 requirements\.md/ })).toBeVisible();
    await page.getByLabel("消息").fill("请阅读这个需求文件。");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.locator("article.message-user")).toContainText("requirements.md");
    await expect(page.locator("article.message-user .message-attachment")).toContainText("1 KB");
    await expect(page.locator("article.message-assistant")).toHaveAttribute("data-status", "completed");
    const saveButton = page.locator(".entry-note.success .text-button");
    await saveButton.evaluate((button) => (button as HTMLButtonElement).click());
    expect(readFileSync(artifactPath, "utf8")).toContain("## 背景");

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM message_attachments").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT name, mime_type, kind FROM message_attachments").get()).toEqual({
      name: "requirements.md",
      mime_type: "text/markdown",
      kind: "text",
    });
    database.close();

    await application.close();
    applicationClosed = true;
    const reopened = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    const reopenedPage = await reopened.firstWindow();
    await expect(reopenedPage.locator("article.message-user .message-attachment")).toContainText("requirements.md");
    await reopened.close();
  } finally {
    if (!applicationClosed) await application.close().catch(() => undefined);
    removeTestDirectory(userDataDir);
  }
});
