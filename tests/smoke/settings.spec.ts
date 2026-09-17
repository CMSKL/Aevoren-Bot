import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";

const appVersion = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

test("uses one sidebar settings entry and preserves general and model configuration", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-settings-"));
  const environment = {
    ...process.env,
    AEVOREN_BOT_USER_DATA_DIR: userDataDir,
    AEVOREN_BOT_FAKE_PROVIDER: "1",
  };

  let application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  try {
    let page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1182, 804));
    await expect(page.getByRole("button", { name: "设置", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "模型设置" })).toHaveCount(0);

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
    await page.getByLabel("外观主题").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "/tmp/aevoren-settings-general-1182x804.png" });
    await page.locator(".settings-dialog").screenshot({ path: "/tmp/aevoren-settings-general-modal.png" });

    await page.getByRole("button", { name: "模型与 CLI", exact: true }).click();
    await expect(page.getByText("自动发现", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "重新扫描", exact: true })).toBeVisible();
    await expect(page.getByText("Codex CLI", { exact: true })).toBeVisible();
    await expect(page.getByText("Claude Code", { exact: true })).toBeVisible();
    await expect(page.getByText("Ollama", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Codex CLI 手动 CLI 路径")).toBeHidden();
    await page.screenshot({ path: "/tmp/aevoren-settings-model-1182x804.png" });
    await page.locator(".settings-dialog").screenshot({ path: "/tmp/aevoren-settings-model-modal.png" });
    await page.getByLabel("Base URL").fill("https://example.com/v1/");
    await page.getByLabel("API Key").fill("settings-smoke-secret");
    await page.getByRole("button", { name: "保存兜底配置", exact: true }).click();
    await expect(page.getByText("OpenAI-compatible 兜底配置已保存。")).toBeVisible();
    const codexCard = page.locator(".provider-settings-card").filter({ hasText: "Codex CLI" });
    await codexCard.getByText("高级：手动指定 CLI 路径", { exact: true }).click();
    await expect(page.getByLabel("Codex CLI 手动 CLI 路径")).toHaveValue("codex");

    await page.getByRole("button", { name: "版本更新", exact: true }).click();
    await page.screenshot({ path: "/tmp/aevoren-settings-update-1182x804.png" });
    await page.locator(".settings-dialog").screenshot({ path: "/tmp/aevoren-settings-update-modal.png" });
    await expect(page.getByText(`v${appVersion}`, { exact: true })).toBeVisible();
    await expect(page.getByText("开发环境未启用", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "检查更新" })).toBeDisabled();
    await page.getByRole("button", { name: "关闭设置" }).click();

    await application.close();
    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT value, encrypted FROM app_settings WHERE key = 'appearance.theme'").get()).toEqual({
      value: "dark",
      encrypted: 0,
    });
    const storedKey = database.prepare("SELECT value, encrypted FROM app_settings WHERE key = 'provider.openai-compatible.default.apiKey'").get() as { value: string; encrypted: number };
    expect(storedKey.encrypted).toBe(1);
    expect(storedKey.value).not.toContain("settings-smoke-secret");
    database.close();

    application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    page = await application.firstWindow();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByLabel("外观主题")).toHaveValue("dark");
    await page.getByRole("button", { name: "模型与 CLI", exact: true }).click();
    await expect(page.getByLabel("Base URL")).toHaveValue("https://example.com/v1");
    await expect(page.getByText("已安全保存；留空表示不替换")).toBeVisible();
    expect(consoleErrors).toEqual([]);
  } finally {
    await application.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
