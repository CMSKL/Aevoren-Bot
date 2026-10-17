import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { AppRepository } from "../../src/main/database";
import { removeTestDirectory } from "./test-cleanup";
import { closeInspector, openConversationMenu, openInspector } from "./navigation";

test("keeps chat drafts editable beside the modeless Bot drawer and hides per-reply Markdown export", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-conversation-controls-"));
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AEVOREN_BOT_USER_DATA_DIR: userDataDir,
      AEVOREN_BOT_FAKE_PROVIDER: "1",
      AEVOREN_BOT_FAKE_DELAY_MS: "5",
    },
  });

  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.getByRole("button", { name: "创建新 Bot" }).click();
    await expect(page.getByRole("heading", { name: "新建 Bot" })).toBeVisible();
    await closeInspector(page);
    await page.getByLabel("消息").fill("请用一句话确认消息功能正常。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: /保存为 Markdown/u })).toHaveCount(0);

    await page.getByLabel("消息").fill("联系人编辑期间保留的聊天草稿。");
    await openInspector(page);
    await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeVisible();
    await expect(page.getByLabel("名称", { exact: true })).toHaveValue("新建 Bot");
    await expect(page.locator("#conversation-inspector")).toBeVisible();
    await page.getByLabel("消息", { exact: true }).fill("详情抽屉中仍可编辑的聊天草稿。");
    await page.screenshot({ path: "/tmp/aevoren-contact-profile-config.png" });
    await closeInspector(page);
    await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeHidden();
    await expect(page.getByLabel("消息")).toHaveValue("详情抽屉中仍可编辑的聊天草稿。");
    const menu = await openConversationMenu(page);
    await expect(menu.getByRole("menuitem", { name: "展开详情面板", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Bot 设置", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "模型设置", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: "/tmp/aevoren-pure-chat-without-profile-panel.png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});

// Local UI/IPC fixture: screenshots do not claim real provider or cloud execution.
test("search, modeless details and modal settings preserve the real conversation draft", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-compact-ui-"));
  const evidence = join(tmpdir(), "aevoren-compact-ui-acceptance");
  mkdirSync(evidence, { recursive: true });
  const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
  try {
    for (const [index, name] of ["项目助手", "资料助手", "写作助手", "研究助手", "事实编辑", "内容主笔", "选题策划", "数据复盘", "代码助手"].entries()) {
      const created = repository.createBot();
      const bot = repository.updateBot(created.bot.id, created.bot.version, { name });
      if (index !== 0) continue;
      const nonce = randomUUID();
      repository.prepareMessage({ sessionId: created.session.id, clientNonce: nonce, text: "能在隔离环境中运行我的项目吗？" });
      repository.acknowledgeUserMessage(nonce);
      const entry = repository.createAssistantEntry(created.session.id, { speakerBotId: bot.id, speakerNameSnapshot: name });
      repository.updateTranscriptEntry(entry.id, "可以使用配置好的本机 Docker Linux 环境，安装依赖、运行服务，也可以启动项目预览。\n\n具体能做到哪一步，取决于项目类型和当前授权。例如：\n\n- 在隔离工作区中运行 Node 或 Python 项目，查看实际输出与退出状态。\n- 登记后台服务与端口，再打开对应的真实预览。\n- 浏览器和电脑保持独立授权；未启动环境时，界面会说明实际状态。\n\n请说明项目的技术栈，以及希望先验证的启动命令。工具执行仍需经过相应审批。", "completed");
    }
  } finally { repository.close(); }
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: {
    ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1",
  } });
  try {
    if (executablePath) expect(await application.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))).toEqual({ packaged: true, version: JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version });
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1041, 713));
    await page.getByRole("listitem", { name: "项目助手", exact: true }).click();
    const input = page.getByLabel("消息", { exact: true });
    await input.fill("保留项目讨论草稿");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const search = page.getByRole("dialog", { name: "搜索", exact: true });
    await expect(search.getByRole("option")).toHaveCount(9);
    await page.screenshot({ path: join(evidence, "dark-search-all.png"), scale: "css", animations: "disabled" });
    for (let index = 0; index < 8; index += 1) await page.keyboard.press("ArrowDown");
    await expect(search.getByRole("option").last()).toHaveAttribute("aria-selected", "true");
    await expect(search.getByRole("option").last()).toBeInViewport();
    await search.getByRole("combobox").fill("资料");
    await expect(search.getByRole("option")).toHaveCount(1);
    await page.screenshot({ path: join(evidence, "dark-search.png"), scale: "css", animations: "disabled" });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "资料助手", exact: true })).toBeVisible();
    await expect(input).toHaveValue("");
    await page.getByRole("listitem", { name: "项目助手", exact: true }).click();
    await expect(input).toHaveValue("保留项目讨论草稿");
    await page.getByRole("button", { name: "查看对话详情", exact: true }).click();
    const drawer = page.getByRole("main", { name: "联系人资料", exact: true });
    await expect(drawer).toBeVisible();
    expect((await drawer.boundingBox())?.width).toBe(320);
    await input.fill("第一行\n第二行\n第三行");
    await expect(input).toBeFocused();
    expect(await input.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(28);
    await page.screenshot({ path: join(evidence, "dark-details.png"), scale: "css", animations: "disabled", caret: "hide" });
    await drawer.getByRole("tab", { name: "电脑", exact: true }).click();
    await expect(drawer.getByRole("tabpanel", { name: "电脑", exact: true })).toBeVisible();
    await page.screenshot({ path: join(evidence, "dark-computer.png"), scale: "css", animations: "disabled", caret: "hide" });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(settings).toHaveAttribute("aria-modal", "true");
    await page.screenshot({ path: join(evidence, "dark-settings.png"), scale: "css", animations: "disabled" });
    await settings.getByRole("combobox", { name: "界面主题", exact: true }).selectOption("light");
    await page.screenshot({ path: join(evidence, "light-settings.png"), scale: "css", animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(drawer).toBeVisible();
    await expect(input).toHaveValue("第一行\n第二行\n第三行");
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
    await expect(drawer).toBeHidden();
    await page.screenshot({ path: join(evidence, "light-chat.png"), scale: "css", animations: "disabled", caret: "hide" });
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});
