import { openComposerTools, selectDetailsTab, selectNavigationTab } from "./navigation";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import { resolveCliPath } from "../../src/main/providers/cli-utils";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES } from "../../src/shared/bot-avatar";
import type { AevorenBotApi, Bot, Session } from "../../src/shared/contracts";
import { removeTestDirectory } from "./test-cleanup";

// Browser plugin not available: use the repository's actual hidden Electron,
// IPC and SQLite workflow. No fake provider, generated answer, tool evidence,
// updater event or API response is used. Names and attachments are user inputs.
type Fixture = { directory: string; databasePath: string; attachmentPath: string; workspacePath: string };
type Contact = { bot: Bot; session: Session };

function fixture(codexPath?: string): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-contact-configuration-"));
  const databasePath = join(directory, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  try {
    // Genuine absent-path states prevent any Claude OAuth/Keychain operation.
    // A separate test probes only the real installed Codex, never a fake CLI.
    for (const id of ["claude.default", "codex.default"]) {
      const configuration = repository.getProviderInstanceConfig(id);
      repository.updateProviderInstanceConfig(id, configuration.version, {
        ...configuration.config,
        cliPath: id.startsWith("codex") && codexPath ? codexPath : join(directory, `not-installed-${id}`),
      });
    }
    repository.setSetting("appearance.theme", "light", false);
  } finally { repository.close(); }
  const attachmentPath = join(directory, "联系人验收附件.md");
  writeFileSync(attachmentPath, "# 用户提供的验收附件\n用于检查联系人编辑不会丢失当前聊天附件。\n", "utf8");
  const workspacePath = join(directory, "资料验收文件夹");
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, "真实本地输入.md"), "# 用户的本地文件输入\n目录权限修改不得改变本文件。\n", "utf8");
  return { directory, databasePath, attachmentPath, workspacePath };
}

async function launch(data: Fixture): Promise<{ application: ElectronApplication; page: Page }> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of Object.keys(inherited)) if (key.startsWith("AEVOREN_BOT_FAKE_")) delete inherited[key];
  const application = await electron.launch({
    args: ["."], cwd: process.cwd(),
    env: {
      ...inherited,
      AEVOREN_BOT_USER_DATA_DIR: data.directory,
      AEVOREN_BOT_DB_PATH: data.databasePath,
      AEVOREN_BOT_TEST_HIDDEN: "1",
      AEVOREN_BOT_DISABLE_UPDATES: "1",
      AEVOREN_BOT_ATTACHMENT_TEST_PATHS: data.attachmentPath,
      AEVOREN_BOT_WORKSPACE_TEST_PATH: data.workspacePath,
    },
  });
  const page = await application.firstWindow();
  await expect(page).toHaveTitle("Aevoren Bot");
  expect(new URL(page.url()).protocol).toBe("file:");
  expect(decodeURIComponent(new URL(page.url()).pathname)).toContain("/out/renderer/index.html");
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
  return { application, page };
}

async function close(application: ElectronApplication): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      application.close(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Hidden Electron close timed out")), 3_000); }),
    ]);
  } catch {
    if (application.process().exitCode === null) application.process().kill("SIGKILL");
  } finally { if (timer) clearTimeout(timer); }
}

function watchErrors(page: Page, errors: string[]): void {
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
}

async function createContacts(page: Page): Promise<Contact[]> {
  const contacts = await page.evaluate(async () => {
    const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
    const result: Contact[] = [];
    for (const name of ["当前对话", "研究助手"]) {
      const created = await api.bots.create();
      if (!created.ok) throw new Error(created.error.safeMessage);
      const updated = await api.bots.update({
        id: created.data.bot.id,
        expectedVersion: created.data.bot.version,
        patch: { name, label: name === "研究助手" ? "一手信息研究" : "日常协作", avatarShape: "rounded", avatarColor: name === "研究助手" ? "cyan" : "cobalt" },
      });
      if (!updated.ok) throw new Error(updated.error.safeMessage);
      result.push({ bot: updated.data, session: created.data.session });
    }
    return result;
  });
  await page.reload();
  await expect(page.locator(".sidebar .bot-row")).toHaveCount(2);
  return contacts;
}

async function sidebar(page: Page): Promise<void> {
  if (await page.locator(".sidebar").isVisible()) return;
  const toggle = page.getByRole("button", { name: "打开 Bot 列表", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  else {
    await page.getByRole("button", { name: "聊天选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "打开 Bot 列表", exact: true }).click();
  }
  await expect(page.locator(".sidebar")).toBeVisible();
}

async function openContact(page: Page, name: string): Promise<void> {
  await sidebar(page);
  await selectNavigationTab(page, "联系人");
  await page.locator(".sidebar").getByRole("listitem", { name, exact: true }).click();
  await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeVisible();
}

async function settings(page: Page): Promise<void> {
  await sidebar(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
}

function sql(data: Fixture, statement: string): void {
  const database = new DatabaseSync(data.databasePath);
  try { database.exec(statement); } finally { database.close(); }
}

function storedBot(data: Fixture, id: string) {
  const database = new DatabaseSync(data.databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT id,name,label,description,instructions,provider_instance_id,model_id,version FROM bots WHERE id = ?").get(id);
  } finally { database.close(); }
}

function unread(data: Fixture, sessionId: string): number {
  const database = new DatabaseSync(data.databasePath, { readOnly: true });
  try {
    return (database.prepare("SELECT has_unread FROM conversation_metadata WHERE session_id = ?").get(sessionId) as { has_unread: number }).has_unread;
  } finally { database.close(); }
}

async function resize(application: ElectronApplication, page: Page, width: number): Promise<void> {
  await application.evaluate(({ BrowserWindow }, requestedWidth) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setSize(requestedWidth, 850);
    const frame = window.getSize()[0]! - window.getContentSize()[0]!;
    if (frame) window.setSize(requestedWidth + frame, 850);
  }, width);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
}

async function layout(page: Page, selector: string): Promise<void> {
  const geometry = await page.locator(selector).evaluate(element => {
    const root = element as HTMLElement;
    const rect = root.getBoundingClientRect();
    const overflow = [...root.querySelectorAll<HTMLElement>("button,input,select,textarea")]
      .filter(control => control.getClientRects().length > 0 && getComputedStyle(control).visibility !== "hidden")
      .filter(control => {
        const bounds = control.getBoundingClientRect();
        const navigation = control.closest<HTMLElement>(".settings-nav nav");
        if (navigation && getComputedStyle(navigation).overflowX === "auto" && navigation.scrollWidth > navigation.clientWidth) return false;
        return bounds.left < -1 || bounds.right > window.innerWidth + 1;
      })
      .map(control => control.getAttribute("aria-label") || control.textContent?.trim() || control.tagName);
    const selectedNavigation = root.querySelector<HTMLElement>('.settings-nav button[aria-current="page"]')?.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: window.innerWidth, documentWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth), overflow, selectedNavigation: selectedNavigation ? { left: selectedNavigation.left, right: selectedNavigation.right } : null };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.overflow).toEqual([]);
  if (geometry.selectedNavigation) {
    expect(geometry.selectedNavigation.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.selectedNavigation.right).toBeLessThanOrEqual(geometry.width + 1);
  }
}

test("contact editing and model configuration remain local, preserve a real chat draft/attachment and survive restart", async () => {
  test.setTimeout(90_000);
  const data = fixture();
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(data);
    application = launched.application;
    let page = launched.page;
    const errors: string[] = [];
    watchErrors(page, errors);
    const [current, contact] = await createContacts(page);
    await page.locator('.sidebar [role="listitem"]').filter({ hasText: current!.bot.name }).click();
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    await page.getByLabel("消息", { exact: true }).fill("保留当前对话草稿，不发送。");
    await openComposerTools(page); await page.getByRole("button", { name: "添加文本附件", exact: true }).click();
    await expect(page.getByRole("button", { name: "移除附件 联系人验收附件.md", exact: true })).toBeVisible();
    const selection = await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"));
    await page.evaluate(async id => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.bots.setUnread({ id, unread: true });
      if (!result.ok) throw new Error(result.error.safeMessage);
    }, contact!.bot.id);
    await openContact(page, contact!.bot.name);
    expect(unread(data, contact!.session.id)).toBe(1);
    expect(await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"))).toBe(selection);
    await page.getByRole("button", { name: "编辑资料", exact: true }).click();
    const profile = page.getByRole("main", { name: "联系人资料", exact: true });
    await profile.getByLabel("名称", { exact: true }).fill("资料已更新的研究助手");
    await profile.getByLabel("标签（可选）", { exact: true }).fill("用户中心研究");
    await profile.getByLabel("描述", { exact: true }).fill("真实资料配置：只基于来源证据整理研究结果。");
    await selectDetailsTab(profile, "模型与能力");
    await expect(profile.getByTestId("profile-save-status")).toContainText("已保存");
    expect(storedBot(data, contact!.bot.id)).toMatchObject({ name: "资料已更新的研究助手", label: "用户中心研究", description: "真实资料配置：只基于来源证据整理研究结果。" });
    await expect(profile.getByLabel("模型供应商", { exact: true })).toBeVisible();
    await expect(profile.getByLabel("模型供应商", { exact: true }).locator("option")).toHaveCount(3);
    const providers = await page.evaluate(async () => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.providers.scan();
      if (!result.ok) throw new Error(result.error.safeMessage);
      return result.data.map(provider => ({ id: provider.id, status: provider.status, cliPath: provider.cliPath, apiKeyConfigured: provider.apiKeyConfigured }));
    });
    expect(providers).toHaveLength(3);
    expect(providers.every(provider => provider.status === "unavailable")).toBe(true);
    expect(providers.find(provider => provider.id === "openai-compatible.default")?.apiKeyConfigured).toBe(false);
    await profile.getByLabel("模型供应商", { exact: true }).selectOption("claude.default");
    await expect(profile.getByTestId("profile-save-status")).toContainText("已保存");
    expect(storedBot(data, contact!.bot.id)).toMatchObject({ provider_instance_id: "claude.default", model_id: "" });
    await profile.getByText("本机连接设置", { exact: true }).click();
    await expect(profile.getByRole("button", { name: "重新扫描", exact: true })).toBeVisible();
    await profile.getByRole("button", { name: "重新扫描", exact: true }).click();
    await expect(profile.getByRole("button", { name: "重新扫描", exact: true })).toBeEnabled();
    await expect(profile.getByLabel("名称", { exact: true })).toBeHidden();
    await selectDetailsTab(profile, "记忆");
    await profile.getByLabel("新增 Memory", { exact: true }).fill("用户明确要求研究结论保留来源链接。");
    await selectDetailsTab(profile, "资料");
    const memory = await page.evaluate(async id => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.memories.list({ botId: id });
      if (!result.ok) throw new Error(result.error.safeMessage);
      return result.data;
    }, contact!.bot.id);
    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatchObject({ content: "用户明确要求研究结论保留来源链接。", source: "manual-user" });

    await sidebar(page);
    await selectNavigationTab(page, "聊天");
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue("保留当前对话草稿，不发送。");
    await expect(page.getByRole("button", { name: "移除附件 联系人验收附件.md", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"))).toBe(selection);
    await expect(page.locator('.inspector[aria-label="Bot 设置"]')).toHaveCount(0);
    await page.getByRole("button", { name: "聊天选项", exact: true }).click();
    const menu = page.getByRole("menu", { name: "聊天选项", exact: true });
    await expect(menu.getByText("Bot 设置", { exact: true })).toHaveCount(0);
    await expect(menu.getByText("编辑资料", { exact: true })).toHaveCount(0);
    await expect(menu.locator(".header-model-trigger")).toHaveCount(0);
    await expect(menu.getByText("会话文件", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: test.info().outputPath("chat-draft-preserved.png") });
    expect(readFileSync(data.attachmentPath, "utf8")).toContain("联系人编辑不会丢失当前聊天附件");
    await close(application);
    application = undefined;
    launched = await launch(data);
    application = launched.application;
    page = launched.page;
    watchErrors(page, errors);
    await openContact(page, "资料已更新的研究助手");
    await expect(page.getByLabel("名称", { exact: true })).toHaveValue("资料已更新的研究助手");
    await selectDetailsTab(page, "模型与能力");
    await expect(page.getByLabel("模型供应商", { exact: true })).toHaveValue("claude.default");
    await selectDetailsTab(page, "记忆");
    await expect(page.getByLabel("Memory 1", { exact: true })).toHaveValue("用户明确要求研究结论保留来源链接。");
    expect(unread(data, contact!.session.id)).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    if (application) await close(application);
    removeTestDirectory(data.directory);
  }
});

test("a real SQLite write failure retains the contact draft and blocks navigation until a successful retry", async () => {
  const data = fixture();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(data);
    application = launched.application;
    const page = launched.page;
    const [current, contact] = await createContacts(page);
    await openContact(page, contact!.bot.name);
    sql(data, `CREATE TRIGGER reject_contact_profile_update BEFORE UPDATE ON bots WHEN NEW.id = '${contact!.bot.id}' BEGIN SELECT RAISE(ABORT, 'contact-real-write-failure'); END;`);
    await page.getByRole("button", { name: "编辑资料", exact: true }).click();
    await page.getByLabel("描述", { exact: true }).fill("写入故障时必须保留的资料草稿。");
    await selectDetailsTab(page, "模型与能力");
    await expect(page.getByRole("tab", { name: "详情", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("profile-save-status")).toContainText("保存失败");
    await expect(page.getByRole("textbox", { name: "描述", exact: true })).toHaveValue("写入故障时必须保留的资料草稿。");
    await page.locator('.sidebar [role="listitem"]').filter({ hasText: current!.bot.name }).click();
    await expect(page.getByLabel("名称", { exact: true })).toHaveValue(contact!.bot.name);
    await selectNavigationTab(page, "聊天");
    await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeVisible();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("alert").first()).not.toContainText(/contact-real-write-failure|SQLITE|stack|Error:/u);
    expect(storedBot(data, contact!.bot.id)).toMatchObject({ description: "" });
    await page.screenshot({ path: test.info().outputPath("real-write-failure-retained-draft.png") });
    sql(data, "DROP TRIGGER reject_contact_profile_update;");
    await selectDetailsTab(page, "模型与能力");
    await expect(page.getByRole("tab", { name: "模型与能力", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(storedBot(data, contact!.bot.id)).toMatchObject({ description: "写入故障时必须保留的资料草稿。" });
  } finally {
    if (application) await close(application);
    removeTestDirectory(data.directory);
  }
});

test("contacts, pure chat and all six settings pages work in both themes at desktop, narrow and minimum widths", async () => {
  test.setTimeout(150_000);
  const data = fixture();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(data);
    application = launched.application;
    const page = launched.page;
    const errors: string[] = [];
    watchErrors(page, errors);
    const [current, contact] = await createContacts(page);
    for (const theme of ["白昼", "暗黑"]) {
      await settings(page);
      await page.getByRole("button", { name: "通用", exact: true }).click();
      const themeSelect = page.getByRole("combobox", { name: "界面主题", exact: true });
      await themeSelect.selectOption(theme === "暗黑" ? "dark" : "light");
      await expect(themeSelect).toHaveValue(theme === "暗黑" ? "dark" : "light");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "暗黑" ? "dark" : "light");
      for (const width of [1180, 1020, 620, 390]) {
        await resize(application, page, width);
        await openContact(page, contact!.bot.name);
        for (const tab of ["详情", "模型与能力", "记忆"]) {
          await selectDetailsTab(page, tab);
          await expect(page.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true");
          await layout(page, ".contact-detail");
          await page.screenshot({ path: test.info().outputPath(`${theme}-${width}-contacts-${tab}.png`), scale: "css" });
        }
        await settings(page);
        for (const category of ["通用", "能力与权限", "长期记忆", "MCP", "主动服务", "版本更新"]) {
          await page.locator(".settings-nav").getByRole("button", { name: category, exact: true }).click();
          await layout(page, ".settings-page");
          await page.screenshot({ path: test.info().outputPath(`${theme}-${width}-settings-${category}.png`), scale: "css" });
        }
        await expect(page.locator(".settings-nav").getByRole("button", { name: "模型与 CLI", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "检查更新", exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "关闭更新提示", exact: true })).toHaveCount(0);
        await sidebar(page);
        await selectNavigationTab(page, "聊天");
        await sidebar(page);
        await page.locator('.sidebar [role="listitem"]').filter({ hasText: current!.bot.name }).click();
        await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
        await layout(page, ".conversation:not(.contact-detail)");
        await page.screenshot({ path: test.info().outputPath(`${theme}-${width}-pure-chat.png`), scale: "css" });
      }
    }
    expect(errors).toEqual([]);
    await settings(page);
    await page.locator(".settings-nav").getByRole("button", { name: "版本更新", exact: true }).click();
    await page.getByLabel("自动检查更新频率", { exact: true }).selectOption("720");
    await expect(page.getByLabel("自动检查更新频率", { exact: true })).toHaveValue("720");
    const configuration = await page.evaluate(async () => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.settings.getGeneral();
      if (!result.ok) throw new Error(result.error.safeMessage);
      return result.data;
    });
    expect(configuration).toMatchObject({ theme: "dark", updateCheckIntervalMinutes: 720 });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1487, 1058));
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 1487, height: 1058 });
    await page.locator(".settings-nav").getByRole("button", { name: "通用", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("approved-size-dark-settings-1487x1058.png"), scale: "css" });
    await page.getByRole("combobox", { name: "界面主题", exact: true }).selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await openContact(page, contact!.bot.name);
    await selectDetailsTab(page, "资料");
    await page.getByRole("button", { name: "编辑资料", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("approved-size-profile-editing-1487x1058.png"), scale: "css" });
    await selectDetailsTab(page, "模型与能力");
    await page.screenshot({ path: test.info().outputPath("approved-size-models-1487x1058.png"), scale: "css" });
  } finally {
    if (application) await close(application);
    removeTestDirectory(data.directory);
  }
});

test("the installed Codex is detected and scanned through real IPC without changing the active contact or calling a model", async () => {
  test.setTimeout(90_000);
  const codexPath = resolveCliPath("codex");
  test.skip(!codexPath, "Actual Codex executable is not installed in this environment; no fake CLI is substituted.");
  const data = fixture(codexPath ?? undefined);
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(data);
    application = launched.application;
    const page = launched.page;
    const [, contact] = await createContacts(page);
    await openContact(page, contact!.bot.name);
    await selectDetailsTab(page, "模型与能力");
    const before = await page.getByLabel("模型供应商", { exact: true }).inputValue();
    const scan = await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const start = performance.now();
      const result = await api.providers.scan();
      if (!result.ok) throw new Error(result.error.safeMessage);
      const codex = result.data.find(provider => provider.driverKind === "codex-cli");
      if (!codex) throw new Error("Actual scan omitted Codex");
      return { duration: performance.now() - start, path: codex.cliPath, version: codex.runtimeVersion, status: codex.status, models: codex.models.options.length, defaultModel: codex.models.default, authenticated: codex.authenticated };
    });
    expect(scan.path).toBe(codexPath);
    expect(scan.version).toBeTruthy();
    expect(scan.duration).toBeLessThan(30_000);
    await expect(page.getByLabel("模型供应商", { exact: true })).toHaveValue(before);
    await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeVisible();
    if (scan.defaultModel) {
      await page.getByLabel("模型供应商", { exact: true }).selectOption("openai-compatible.default");
      await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
      await page.getByLabel("模型供应商", { exact: true }).selectOption("codex.default");
      await expect(page.getByLabel("Bot 模型", { exact: true })).toHaveValue(scan.defaultModel);
      await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
      expect(storedBot(data, contact!.bot.id)).toMatchObject({ provider_instance_id: "codex.default", model_id: scan.defaultModel });
    }
    await test.info().attach("actual-codex-scan.json", { body: JSON.stringify(scan, null, 2), contentType: "application/json" });
    writeFileSync(test.info().outputPath("actual-codex-scan.json"), `${JSON.stringify(scan, null, 2)}\n`, "utf8");
    await page.screenshot({ path: test.info().outputPath("actual-codex-contact.png") });
  } finally {
    if (application) await close(application);
    removeTestDirectory(data.directory);
  }
});

test("local folder management remains reachable and real session permissions work without a Bot details drawer", async () => {
  const data = fixture();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(data);
    application = launched.application;
    const page = launched.page;
    const [current, peer] = await createContacts(page);
    const registration = await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const result = await api.workspaces.add();
      if (!result.ok) throw new Error(result.error.safeMessage);
      if (!result.data) throw new Error("Actual test folder registration was cancelled");
      return result.data;
    });
    expect(registration.workspace.name).toBe("资料验收文件夹");
    expect(registration.workspace.writeEnabled).toBe(false);
    await page.reload();
    await expect(page.locator(".app-shell")).toBeVisible();
    await settings(page);
    await page.locator(".settings-nav").getByRole("button", { name: "能力与权限", exact: true }).click();
    await page.getByRole("button", { name: "打开管理", exact: true }).click();
    await expect(page.locator(".sidebar-workspace")).toBeVisible();
    await expect(page.locator(".sidebar-project-toggle").filter({ hasText: registration.project.name })).toBeVisible();
    await expect(page.getByRole("tab", { name: "工作区", exact: true })).toHaveCount(0);
    await selectNavigationTab(page, "聊天");
    await page.locator('.sidebar [role="listitem"]').filter({ hasText: current!.bot.name }).click();
    await page.getByRole("button", { name: "聊天选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "打开任务详情", exact: true }).click();
    await page.getByRole("button", { name: "管理文件夹", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "工作区权限", exact: true });
    await expect(dialog.getByLabel("当前聊天工作区", { exact: true })).toBeVisible();
    await dialog.getByLabel("当前聊天工作区", { exact: true }).selectOption(registration.project.id);
    await expect(dialog.getByLabel("当前聊天工作区", { exact: true })).toHaveValue(registration.project.id);
    await expect(dialog.getByLabel("允许 Bot 新建 Markdown/CSV", { exact: true })).not.toBeChecked();
    await dialog.getByLabel("允许 Bot 新建 Markdown/CSV", { exact: true }).check();
    await expect(dialog.getByLabel("允许 Bot 新建 Markdown/CSV", { exact: true })).toBeChecked();
    const actualPermissions = await page.evaluate(async () => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.workspaces.list();
      if (!result.ok) throw new Error(result.error.safeMessage);
      return result.data;
    });
    expect(actualPermissions.find(workspace => workspace.id === registration.workspace.id)?.writeEnabled).toBe(true);
    const database = new DatabaseSync(data.databasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT workspace_id FROM session_workspace_grants WHERE session_id = ?").all(current!.session.id)).toEqual([{ workspace_id: registration.workspace.id }]);
      expect(database.prepare("SELECT workspace_id FROM session_workspace_grants WHERE session_id = ?").all(peer!.session.id)).toEqual([]);
    } finally { database.close(); }
    expect(readFileSync(join(data.workspacePath, "真实本地输入.md"), "utf8")).toBe("# 用户的本地文件输入\n目录权限修改不得改变本文件。\n");
    await page.screenshot({ path: test.info().outputPath("real-session-folder-permissions.png"), scale: "css" });
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await expect(page.locator('.inspector[aria-label="Bot 设置"]')).toHaveCount(0);
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
  } finally {
    if (application) await close(application);
    removeTestDirectory(data.directory);
  }
});

test("unsaved shared connection input is retained when leaving a contact and discarded only explicitly", async () => {
  const data = fixture();
  const beforeDatabase = new DatabaseSync(data.databasePath, { readOnly: true });
  const beforeProvider = beforeDatabase.prepare("SELECT config_json FROM provider_instances WHERE id = 'openai-compatible.default'").get() as { config_json: string };
  beforeDatabase.close();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(data);
    application = launched.application;
    const page = launched.page;
    const [current, contact] = await createContacts(page);
    await openContact(page, contact!.bot.name);
    await selectDetailsTab(page, "模型与能力");
    await page.getByText("本机连接设置", { exact: true }).click();
    await page.getByLabel("管理 API", { exact: true }).click();
    const baseUrl = page.getByLabel("Base URL", { exact: true });
    const original = await baseUrl.inputValue();
    const draft = `${original.replace(/\/+$/u, "")}/`;
    await baseUrl.fill(draft);
    await expect(page.getByTestId("profile-save-status")).toContainText("未保存");
    await page.getByLabel("模型供应商", { exact: true }).selectOption("claude.default");
    await expect.poll(() => storedBot(data, contact!.bot.id)).toMatchObject({ provider_instance_id: "claude.default" });
    await expect(page.getByTestId("profile-save-status")).toContainText("未保存");
    await expect(baseUrl).toHaveValue(draft);
    await page.locator('.sidebar [role="listitem"]').filter({ hasText: current!.bot.name }).click();
    await expect(page.getByRole("heading", { name: contact!.bot.name, exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "模型与能力", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(baseUrl).toHaveValue(draft);
    await selectDetailsTab(page, "资料");
    await expect(page.getByRole("tab", { name: "模型与能力", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("alert").first()).toBeVisible();
    const database = new DatabaseSync(data.databasePath, { readOnly: true });
    try {
      const provider = database.prepare("SELECT config_json FROM provider_instances WHERE id = 'openai-compatible.default'").get() as { config_json: string };
      expect(provider.config_json).toBe(beforeProvider.config_json);
      expect(database.prepare("SELECT value FROM app_settings WHERE key = 'provider.openai-compatible.default.apiKey'").get()).toBeUndefined();
    } finally { database.close(); }
    await page.screenshot({ path: test.info().outputPath("shared-connection-real-unsaved-input.png"), scale: "css" });
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await page.locator('.sidebar [role="listitem"]').filter({ hasText: current!.bot.name }).click();
    await expect(page.getByRole("heading", { name: current!.bot.name, exact: true })).toBeVisible();
  } finally {
    if (application) await close(application);
    removeTestDirectory(data.directory);
  }
});

test("creating a contact stays in Contacts and group management keeps the modeless chat usable", async () => {
  test.setTimeout(60_000);
  const data = fixture();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(data);
    application = launched.application;
    const page = launched.page;
    const [current, contact] = await createContacts(page);
    await page.locator('.sidebar [role="listitem"]').filter({ hasText: current!.bot.name }).click();
    const selection = await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"));
    await page.getByLabel("消息", { exact: true }).fill("新建联系人不得丢失此聊天草稿。");
    await openContact(page, contact!.bot.name);
    await page.getByRole("button", { name: "添加联系人", exact: true }).click();
    await page.getByRole("button", { name: "创建新 Bot", exact: true }).click();
    await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeVisible();
    await expect(page.locator("#navigation-contacts")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("名称", { exact: true })).toBeEditable();
    await page.getByLabel("名称", { exact: true }).fill("事实编辑");
    await selectDetailsTab(page, "模型与能力");
    await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
    expect(await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"))).toBe(selection);
    await selectNavigationTab(page, "聊天");
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue("新建联系人不得丢失此聊天草稿。");
    const group = await page.evaluate(async input => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const contacts = await api.bots.list();
      if (!contacts.ok) throw new Error(contacts.error.safeMessage);
      const editor = contacts.data.find(bot => bot.name === "事实编辑");
      if (!editor) throw new Error("Actually created contact was not persisted");
      const result = await api.rooms.create({ name: "业务群聊UI验收", memberBotIds: input });
      if (!result.ok) throw new Error(result.error.safeMessage);
      return { detail: result.data, editorId: editor.id };
    }, [current!.bot.id, contact!.bot.id]);
    await page.reload();
    await page.locator('.sidebar [role="listitem"]').filter({ hasText: group.detail.room.name }).click();
    await expect(page.getByRole("dialog", { name: "群聊设置", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "聊天选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "群聊管理", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "群聊设置", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "false");
    await dialog.getByLabel("名称", { exact: true }).fill("已配置的业务群聊");
    await dialog.getByRole("button", { name: "管理群聊成员 2/6", exact: true }).click();
    await dialog.getByLabel("选择要添加的 Bot", { exact: true }).selectOption(group.editorId);
    await dialog.getByRole("button", { name: "添加", exact: true }).click();
    await expect(dialog.getByRole("tab", { name: "成员", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.locator(".room-member-row")).toHaveCount(3);
    await expect(dialog.getByTestId("room-save-status")).toContainText("已保存");
    await page.getByLabel("消息", { exact: true }).fill("抽屉打开时仍可输入群聊草稿。");
    await expect(page.getByLabel("消息", { exact: true })).toBeFocused();
    const actual = await page.evaluate(async id => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.rooms.get(id);
      if (!result.ok) throw new Error(result.error.safeMessage);
      return result.data;
    }, group.detail.room.id);
    expect(actual.room.name).toBe("已配置的业务群聊");
    expect(actual.members.map(member => member.botId)).toEqual([current!.bot.id, contact!.bot.id, group.editorId]);
    await page.screenshot({ path: test.info().outputPath("real-group-management-dialog.png"), scale: "css" });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
  } finally {
    if (application) await close(application);
    removeTestDirectory(data.directory);
  }
});

test("real Codex contact selection produces an actual completed UI reply on the selected runtime and model", async () => {
  test.skip(process.env.AEVOREN_CONTACT_REAL_CODEX_CHAT !== "1", "Requires explicit opt-in for a real authenticated Codex model request; no fake result is substituted.");
  test.setTimeout(180_000);
  const codexPath = resolveCliPath("codex");
  if (!codexPath) throw new Error("Actual Codex executable is unavailable; real chat cannot be verified.");
  const data = fixture(codexPath);
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let sessionId: string | undefined;
  try {
    const launched = await launch(data);
    application = launched.application;
    page = launched.page;
    const errors: string[] = [];
    watchErrors(page, errors);
    const [current, contact] = await createContacts(page);
    sessionId = contact!.session.id;
    const scanned = await page.evaluate(async botId => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      // Only the isolated test's setting changes; avoid a second model request
      // for automatic Memory extraction after this deliberately tiny reply.
      const preferences = await api.settings.saveGeneral({ memoryCaptureEnabled: false });
      if (!preferences.ok) throw new Error(preferences.error.safeMessage);
      const scanned = await api.providers.scan();
      if (!scanned.ok) throw new Error(scanned.error.safeMessage);
      const provider = scanned.data.find(provider => provider.id === "codex.default");
      if (!provider || provider.status !== "available" || !provider.authenticated || !provider.models.default) throw new Error("Actual Codex is not authenticated and available; real chat is unverified.");
      const bots = await api.bots.list();
      if (!bots.ok) throw new Error(bots.error.safeMessage);
      const bot = bots.data.find(bot => bot.id === botId)!;
      const updated = await api.bots.update({ id: bot.id, expectedVersion: bot.version, patch: { instructions: "这是一次真实界面验收。仅按最新用户要求回复一句中文。不要调用任何工具，不读取或写入文件，不联网，不发起外部操作。", mcpServerIds: [] } });
      if (!updated.ok) throw new Error(updated.error.safeMessage);
      return { model: provider.models.default, version: provider.runtimeVersion };
    }, contact!.bot.id);
    await page.reload();
    await openContact(page, contact!.bot.name);
    await selectDetailsTab(page, "模型与能力");
    await page.getByLabel("模型供应商", { exact: true }).selectOption("codex.default");
    await page.getByLabel("Bot 模型", { exact: true }).fill(scanned.model);
    await page.getByLabel("Bot 模型", { exact: true }).blur();
    await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
    expect(storedBot(data, contact!.bot.id)).toMatchObject({ provider_instance_id: "codex.default", model_id: scanned.model });
    await page.getByRole("button", { name: "发消息", exact: true }).click();
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    await expect(page.locator('.inspector[aria-label="Bot 设置"]')).toHaveCount(0);
    await page.evaluate(sessionId => {
      const context = window as unknown as { aevorenBot: AevorenBotApi; contactRealRuntimeStates: string[]; contactRealTranscriptStatuses: string[] };
      context.contactRealRuntimeStates = [];
      context.contactRealTranscriptStatuses = [];
      context.aevorenBot.events.subscribeRuntime(event => {
        if (event.sessionId === sessionId) context.contactRealRuntimeStates.push(event.run.state);
      });
      context.aevorenBot.events.subscribeTranscript(event => {
        if (event.sessionId === sessionId && event.entry.role === "assistant") context.contactRealTranscriptStatuses.push(event.entry.status);
      });
    }, sessionId);
    const input = "请只回复：你好，界面已正常响应。不要调用任何工具。";
    const started = Date.now();
    await page.getByLabel("消息", { exact: true }).fill(input);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(async () => page!.evaluate(async id => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot(id);
      if (!result.ok) throw new Error(result.error.safeMessage);
      const run = result.data.runs.at(-1);
      if (run && ["failed", "cancelled", "interrupted", "completed"].includes(run.state)) throw new Error(`The real request is not active: ${run.lastErrorCode ?? run.state}. No active task is fabricated.`);
      return Boolean(run?.acceptedAt && ["running", "streaming"].includes(run.state));
    }, sessionId!), { timeout: 60_000, intervals: [100] }).toBe(true);
    await page.locator(".sidebar").getByRole("listitem", { name: current!.bot.name, exact: true }).click();
    await expect(page.getByRole("heading", { name: current!.bot.name, exact: true })).toBeVisible();
    const updateWhileActive = await page.evaluate(async ({ idleSession, activeSession }) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const idle = await api.runtime.getSessionSnapshot(idleSession);
      const active = await api.runtime.getSessionSnapshot(activeSession);
      const updater = await api.updates.getState();
      if (!idle.ok || !active.ok || !updater.ok) throw new Error("Actual runtime/update state could not be read");
      const update = await api.updates.installAndRestart();
      return { idleState: idle.data.liveState.state, activeState: active.data.runs.at(-1)?.state, updaterState: updater.data.status, result: update };
    }, { idleSession: current!.session.id, activeSession: sessionId });
    expect(updateWhileActive).toMatchObject({ idleState: "idle", updaterState: "disabled", result: { ok: false, error: { code: "UPDATE_TASKS_RUNNING" } } });
    expect(["running", "streaming"]).toContain(updateWhileActive.activeState);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1 && BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
    await page.locator(".sidebar").getByRole("listitem", { name: contact!.bot.name, exact: true }).click();
    await expect.poll(async () => {
      const snapshot = await page!.evaluate(async id => {
        const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot(id);
        if (!result.ok) throw new Error(result.error.safeMessage);
        const run = result.data.runs.at(-1);
        if (run && ["failed", "cancelled", "interrupted"].includes(run.state)) throw new Error(`Actual Codex request failed: ${run.lastErrorCode ?? run.state}. No generated success is substituted.`);
        return run?.state;
      }, sessionId!);
      return snapshot;
    }, { timeout: 120_000, intervals: [200, 500] }).toBe("completed");
    const assistant = page.locator('article.message-assistant[data-status="completed"]');
    await expect(assistant).toHaveCount(1);
    await expect(assistant.locator(".assistant-markdown")).toHaveText("你好，界面已正常响应。");
    const response = await assistant.locator(".assistant-markdown").innerText();
    const states = await page.evaluate(() => {
      const context = window as unknown as { contactRealRuntimeStates: string[]; contactRealTranscriptStatuses: string[] };
      return { runtime: [...new Set(context.contactRealRuntimeStates)], transcript: [...new Set(context.contactRealTranscriptStatuses)] };
    });
    expect(states.runtime).toContain("completed");
    expect(states.runtime.includes("streaming") || states.transcript.includes("streaming")).toBe(true);
    const updateAfterCompletion = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.updates.installAndRestart());
    expect(updateAfterCompletion).toMatchObject({ ok: false, error: { code: "UPDATE_NOT_READY" } });
    const database = new DatabaseSync(data.databasePath, { readOnly: true });
    try {
      const run = database.prepare("SELECT id,state,route,provider_instance_id,provider_model_id,provider_request_id,accepted_at,finished_at FROM runtime_runs WHERE session_id = ?").get(sessionId);
      expect(run).toMatchObject({ state: "completed", route: "codex-cli", provider_instance_id: "codex.default", provider_model_id: scanned.model, provider_request_id: expect.any(String), accepted_at: expect.any(String), finished_at: expect.any(String) });
      const entries = database.prepare("SELECT role,body,status FROM transcript_entries WHERE session_id = ? ORDER BY seq").all(sessionId);
      expect(entries).toEqual([{ role: "user", body: input, status: "completed" }, { role: "assistant", body: response, status: "completed" }]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM tool_invocations WHERE session_id = ?").get(sessionId)).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()).toEqual({ count: 1 });
      const evidence = { durationMs: Date.now() - started, cliVersion: scanned.version, selectedModel: scanned.model, actualReply: response, states, runtime: run, tools: 0, updateWhileActive, updateAfterCompletion };
      writeFileSync(test.info().outputPath("actual-codex-ui-chat.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      await backup(database, test.info().outputPath("actual-codex-ui-chat.sqlite"));
    } finally { database.close(); }
    await page.screenshot({ path: test.info().outputPath("actual-codex-ui-chat.png"), scale: "css" });
    expect(errors).toEqual([]);
  } finally {
    if (page && sessionId) {
      await page.evaluate(async id => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        const snapshot = await api.runtime.getSessionSnapshot(id);
        if (!snapshot.ok) return;
        for (const run of snapshot.data.runs.filter(run => ["created", "dispatching", "running", "streaming", "cancel-requested"].includes(run.state))) await api.runtime.cancel(run.id);
      }, sessionId).catch(() => {});
    }
    if (application) await close(application);
    removeTestDirectory(data.directory);
  }
});

test("duplicating a contact preserves the original chat, role and model and cannot bypass an unsaved shared connection", async () => {
  const data = fixture();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(data);
    application = launched.application;
    const page = launched.page;
    const [current, source] = await createContacts(page);
    await page.locator(".sidebar").getByRole("listitem", { name: current!.bot.name, exact: true }).click();
    const draft = "创建联系人副本也必须保留此原聊天草稿。";
    await page.getByLabel("消息", { exact: true }).fill(draft);
    await openComposerTools(page); await page.getByRole("button", { name: "添加文本附件", exact: true }).click();
    await expect(page.getByRole("button", { name: "移除附件 联系人验收附件.md", exact: true })).toBeVisible();
    const selected = await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"));
    await openContact(page, source!.bot.name);
    await page.getByRole("button", { name: "编辑资料", exact: true }).click();
    await page.getByRole("textbox", { name: "描述", exact: true }).fill("使用真实来源开展研究并清楚说明不确定性。");
    await page.getByText("职责与规则", { exact: true }).click();
    await page.getByLabel("Instructions", { exact: true }).fill("保留来源和风险说明，不声称执行尚未成功的工具。");
    await selectDetailsTab(page, "模型与能力");
    await page.getByLabel("模型供应商", { exact: true }).selectOption("claude.default");
    await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
    const sourceConfiguration = await page.evaluate(async id => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.bots.list();
      if (!result.ok) throw new Error(result.error.safeMessage);
      return result.data.find(bot => bot.id === id)!;
    }, source!.bot.id);
    await page.locator(".sidebar").getByRole("listitem", { name: source!.bot.name, exact: true }).click({ button: "right" });
    await page.getByRole("menu", { name: "Bot 操作", exact: true }).getByRole("menuitem", { name: "创建副本", exact: true }).click();
    await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: `${source!.bot.name} 副本`, exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"))).toBe(selected);
    const afterCopy = await page.evaluate(async () => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.bots.list();
      if (!result.ok) throw new Error(result.error.safeMessage);
      return result.data;
    });
    expect(afterCopy).toHaveLength(3);
    expect(afterCopy.find(bot => bot.id === source!.bot.id)?.name).toBe(source!.bot.name);
    const copy = afterCopy.find(bot => bot.name === `${source!.bot.name} 副本`)!;
    expect(copy.id).not.toBe(source!.bot.id);
    expect(copy).toMatchObject({ label: sourceConfiguration.label, description: sourceConfiguration.description, instructions: sourceConfiguration.instructions, modelSelection: sourceConfiguration.modelSelection });
    // Existing product policy assigns a random avatar to every new Bot/copy.
    expect(BOT_AVATAR_SHAPES).toContain(copy.avatarShape);
    expect(BOT_AVATAR_COLORS).toContain(copy.avatarColor);
    await selectNavigationTab(page, "聊天");
    expect(await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"))).toBe(selected);
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(draft);
    await expect(page.getByRole("button", { name: "移除附件 联系人验收附件.md", exact: true })).toBeVisible();

    await openContact(page, source!.bot.name);
    await selectDetailsTab(page, "模型与能力");
    await page.getByText("本机连接设置", { exact: true }).click();
    await page.getByLabel("管理 API", { exact: true }).click();
    const baseUrl = page.getByLabel("Base URL", { exact: true });
    const originalUrl = await baseUrl.inputValue();
    await baseUrl.fill(`${originalUrl.replace(/\/+$/u, "")}/`);
    await page.locator(".sidebar").getByRole("listitem", { name: source!.bot.name, exact: true }).click({ button: "right" });
    await page.getByRole("menu", { name: "Bot 操作", exact: true }).getByRole("menuitem", { name: "创建副本", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "本机连接配置尚未保存" })).toBeVisible();
    await expect(page.getByRole("heading", { name: source!.bot.name, exact: true })).toBeVisible();
    const database = new DatabaseSync(data.databasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM bots WHERE deleted_at IS NULL").get()).toEqual({ count: 3 });
      expect(database.prepare("SELECT name,provider_instance_id,model_id FROM bots WHERE id = ?").get(copy.id)).toEqual({ name: `${source!.bot.name} 副本`, provider_instance_id: sourceConfiguration.modelSelection.providerInstanceId, model_id: sourceConfiguration.modelSelection.modelId });
    } finally { database.close(); }
    await page.screenshot({ path: test.info().outputPath("real-contact-duplicate-shared-guard.png"), scale: "css" });
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await selectNavigationTab(page, "聊天");
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(draft);
    await expect(page.getByRole("button", { name: "移除附件 联系人验收附件.md", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"))).toBe(selected);
  } finally {
    if (application) await close(application);
    removeTestDirectory(data.directory);
  }
});

test("a real target snapshot failure stays local to Contacts and preserves unread state, the original draft and attachment", async () => {
  const data = fixture();
  let application: ElectronApplication | undefined;
  let schemaFault = false;
  try {
    const launched = await launch(data);
    application = launched.application;
    const page = launched.page;
    const [current, target] = await createContacts(page);
    await page.evaluate(async id => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.bots.setUnread({ id, unread: true });
      if (!result.ok) throw new Error(result.error.safeMessage);
    }, target!.bot.id);
    await page.reload();
    await page.locator(".sidebar").getByRole("listitem", { name: current!.bot.name, exact: true }).click();
    const draft = "打开另一联系人失败时，不得影响此原聊天草稿。";
    await page.getByLabel("消息", { exact: true }).fill(draft);
    await openComposerTools(page); await page.getByRole("button", { name: "添加文本附件", exact: true }).click();
    await expect(page.getByRole("button", { name: "移除附件 联系人验收附件.md", exact: true })).toBeVisible();
    const originalSelection = await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"));
    await openContact(page, target!.bot.name);
    sql(data, "ALTER TABLE runtime_runs RENAME TO runtime_runs_contact_open_fault;");
    schemaFault = true;
    const actualSnapshotFailure = await page.evaluate(id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot(id), target!.session.id);
    expect(actualSnapshotFailure).toMatchObject({ ok: false });
    await page.getByRole("button", { name: "发消息", exact: true }).click();
    const contact = page.getByRole("main", { name: "联系人资料", exact: true });
    await expect(contact).toBeVisible();
    await expect(contact.getByRole("alert")).toBeVisible();
    await expect(contact.getByRole("alert")).not.toContainText(/SQLITE|runtime_runs|no such table|Error:/u);
    expect(unread(data, target!.session.id)).toBe(1);
    expect(await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"))).toBe(originalSelection);
    await page.screenshot({ path: test.info().outputPath("real-contact-open-failure-local.png"), scale: "css" });
    sql(data, "ALTER TABLE runtime_runs_contact_open_fault RENAME TO runtime_runs;");
    schemaFault = false;
    await selectNavigationTab(page, "聊天");
    await expect(page.getByRole("heading", { name: current!.bot.name, exact: true })).toBeVisible();
    await expect(page.locator(".conversation").getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(draft);
    await expect(page.getByRole("button", { name: "移除附件 联系人验收附件.md", exact: true })).toBeVisible();
    expect(unread(data, target!.session.id)).toBe(1);
    await openContact(page, target!.bot.name);
    await page.getByRole("button", { name: "发消息", exact: true }).click();
    await expect(contact).toBeHidden();
    await expect(page.getByRole("heading", { name: target!.bot.name, exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"))).toBe(`bot:${target!.bot.id}`);
    expect(unread(data, target!.session.id)).toBe(0);
    const database = new DatabaseSync(data.databasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM bots WHERE deleted_at IS NULL").get()).toEqual({ count: 2 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { database.close(); }
  } finally {
    if (schemaFault) sql(data, "ALTER TABLE runtime_runs_contact_open_fault RENAME TO runtime_runs;");
    if (application) await close(application);
    removeTestDirectory(data.directory);
  }
});
