import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync, readFileSync } from "node:fs";
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
    await expect(page.getByLabel("登录时启动")).toBeDisabled();
    await expect(page.getByText(/(?:仅打包版 macOS \/ Windows 支持；开发测试不会注册系统启动项|当前仅 macOS 打包版支持；Windows 启动任务适配尚未启用)/u)).toBeVisible();
    await page.screenshot({ path: "/tmp/aevoren-settings-general-1182x804.png" });
    await page.locator(".settings-dialog").screenshot({ path: "/tmp/aevoren-settings-general-modal.png" });

    await page.getByRole("button", { name: "能力与权限", exact: true }).click();
    await expect(page.getByRole("heading", { name: "能力与权限", exact: true })).toBeVisible();
    await expect(page.locator('[data-capability="conversation.text"]')).toContainText("可用");
    await expect(page.locator('[data-capability="workspace.read"]')).toContainText("需要授权");
    await expect(page.locator('[data-capability="network.search"]')).toContainText("可用");
    await expect(page.getByText("仅前台运行", { exact: false })).toBeVisible();
    await page.locator(".settings-dialog").screenshot({ path: "/tmp/aevoren-settings-capabilities-modal.png" });

    await page.getByRole("button", { name: "模型与 CLI", exact: true }).click();
    await expect(page.getByRole("heading", { name: "需要设置", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "重新扫描", exact: true })).toBeVisible();
    await expect(page.getByText("Codex CLI", { exact: true })).toBeVisible();
    await expect(page.getByText("Claude Code", { exact: true })).toBeVisible();
    await expect(page.locator(".provider-settings-card").filter({ hasText: "API" })).toBeVisible();
    await expect(page.locator(".provider-engine-card")).toHaveCount(3);
    await expect(page.getByText("Ollama", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Gemini CLI", { exact: true })).toHaveCount(0);
    await expect(page.locator('.provider-engine-card[data-provider-state="unconfigured"]')).toHaveCount(1);
    await expect(page.locator(".provider-engine-card .provider-status-pill").filter({ hasText: /未安装|未登录|不可用/u }).first()).toBeVisible();
    await expect(page.getByLabel("Codex CLI 手动 CLI 路径")).toBeHidden();
    await page.screenshot({ path: "/tmp/aevoren-settings-model-1182x804.png" });
    await page.locator(".settings-dialog").screenshot({ path: "/tmp/aevoren-settings-model-modal.png" });
    await page.getByLabel("管理 API").click();
    await page.getByLabel("Base URL").fill("https://example.com/v1/");
    await page.getByLabel("API Key").fill("settings-smoke-secret");
    await page.getByRole("button", { name: "保存 API 配置", exact: true }).click();
    await expect(page.getByText("API 配置已保存。")).toBeVisible();
    await expect(page.getByRole("heading", { name: "已就绪", exact: true })).toBeVisible();
    await expect(page.locator('.provider-engine-card[data-provider-state="ready"]').filter({ hasText: "API" })).toBeVisible();
    const codexCard = page.locator(".provider-settings-card").filter({ hasText: "Codex CLI" });
    await codexCard.getByLabel("管理 Codex CLI").click();
    await codexCard.getByText("高级：手动指定 CLI 路径", { exact: true }).click();
    await expect(page.getByLabel("Codex CLI 手动 CLI 路径")).toHaveValue("codex");

    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await expect(page.getByText("尚未配置 MCP Server。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "添加网页搜索", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "添加网页搜索", exact: true }).click();
    const searchCard = page.locator('[data-mcp-server="exa-search"]');
    await expect(searchCard).toContainText("https://mcp.exa.ai/mcp");
    await expect(searchCard).toContainText("OAuth 未授权");
    await expect(searchCard.getByRole("button", { name: "OAuth 授权" })).toBeVisible();
    await page.getByRole("button", { name: "添加 Server", exact: true }).click();
    await page.getByLabel("MCP 名称").fill("settings-fixture");
    await page.getByLabel("MCP URL").fill("https://example.com/mcp");
    await page.getByLabel("MCP Headers").fill("Authorization: Bearer mcp-settings-secret");
    await page.getByRole("button", { name: "保存（默认关闭）", exact: true }).click();
    const mcpCard = page.locator('[data-mcp-server="settings-fixture"]');
    await expect(mcpCard).toContainText("未启用");
    await expect(mcpCard).toContainText("1 个 Secret");
    await expect(page.getByText("mcp-settings-secret", { exact: false })).toHaveCount(0);

    await page.getByRole("button", { name: "长期记忆", exact: true }).click();
    await expect(page.getByLabel("Memory 范围")).toHaveValue("user");
    await expect(page.getByLabel("后台生成 Memory 候选")).toBeChecked();
    await page.getByLabel("后台生成 Memory 候选").uncheck();
    await page.getByLabel("新增范围 Memory").fill("所有 Bot 都使用简洁中文回答");
    await page.getByRole("button", { name: "添加 Memory", exact: true }).click();
    await expect(page.locator('textarea[aria-label^="Memory "]').first()).toHaveValue("所有 Bot 都使用简洁中文回答");

    await page.getByRole("button", { name: "版本更新", exact: true }).click();
    await page.screenshot({ path: "/tmp/aevoren-settings-update-1182x804.png" });
    await page.locator(".settings-dialog").screenshot({ path: "/tmp/aevoren-settings-update-modal.png" });
    await expect(page.locator('[aria-labelledby="settings-update-title"]').getByText(`v${appVersion}`, { exact: true })).toBeVisible();
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
    const storedMcpSecret = database.prepare("SELECT value, encrypted FROM app_settings WHERE key LIKE 'mcp.server.%.secrets'").get() as { value: string; encrypted: number };
    expect(storedMcpSecret.encrypted).toBe(1);
    expect(storedMcpSecret.value).not.toContain("mcp-settings-secret");
    expect(database.prepare("SELECT scope,scope_key,bot_id,workspace_id,content FROM memory_items WHERE scope = 'user'").get()).toEqual({
      scope: "user",
      scope_key: "user",
      bot_id: null,
      workspace_id: null,
      content: "所有 Bot 都使用简洁中文回答",
    });
    database.close();

    application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    page = await application.firstWindow();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByLabel("外观主题")).toHaveValue("dark");
    await page.getByRole("button", { name: "模型与 CLI", exact: true }).click();
    await page.getByLabel("管理 API").click();
    await expect(page.getByLabel("Base URL")).toHaveValue("https://example.com/v1");
    await expect(page.getByText("已安全保存；留空表示不替换")).toBeVisible();
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await expect(page.locator('[data-mcp-server="exa-search"]')).toContainText("OAuth 未授权");
    await expect(page.locator('[data-mcp-server="settings-fixture"]')).toContainText("未启用");
    await page.locator('[data-mcp-server="settings-fixture"]').getByRole("button", { name: "编辑" }).click();
    await expect(page.getByLabel("MCP Headers")).toHaveValue("Authorization: ");
    await page.getByRole("button", { name: "长期记忆", exact: true }).click();
    await expect(page.getByLabel("后台生成 Memory 候选")).not.toBeChecked();
    await expect(page.locator('textarea[aria-label^="Memory "]').first()).toHaveValue("所有 Bot 都使用简洁中文回答");
    expect(consoleErrors).toEqual([]);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});
