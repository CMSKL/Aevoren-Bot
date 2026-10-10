import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { BOT_AVATAR_COLORS, type BotAvatarColor } from "../../src/shared/bot-avatar";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { removeTestDirectory } from "./test-cleanup";

// Browser plugin not available. Use the repository's Playwright/Electron workflow.
// The fake provider isolates UI fixtures; these tests make no model-response claims.
async function launch(userDataDir: string): Promise<{ application: ElectronApplication; page: Page }> {
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const application = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : ["."],
    cwd: process.cwd(),
    env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1" },
  });
  return { application, page: await application.firstWindow() };
}

function watchErrors(page: Page, errors: string[]): void {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
}

async function checkPage(page: Page): Promise<void> {
  await expect(page).toHaveTitle("Aevoren Bot");
  await expect(page).toHaveURL(/^file:.*\/index\.html$/u);
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建聊天", exact: true })).toBeEnabled();
}

async function resize(application: ElectronApplication, page: Page, width: number): Promise<{ width: number; height: number }> {
  await application.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Missing application window");
    window.setSize(size, 800);
    // Windows window borders consume content width; retain the intended CSS viewport.
    const frameWidth = window.getSize()[0]! - window.getContentSize()[0]!;
    if (frameWidth) window.setSize(size + frameWidth, 800);
  }, width);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

async function seedBots(page: Page, colors: readonly BotAvatarColor[]): Promise<void> {
  await page.evaluate(async (avatarColors) => {
    const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
    for (const [index, color] of avatarColors.entries()) {
      const created = await api.bots.create();
      if (!created.ok) throw new Error(created.error.safeMessage);
      const updated = await api.bots.update({
        id: created.data.bot.id,
        expectedVersion: created.data.bot.version,
        patch: { name: `界面验收 Bot ${index + 1}`, avatarShape: "rounded", avatarColor: color },
      });
      if (!updated.ok) throw new Error(updated.error.safeMessage);
    }
  }, [...colors]);
  await page.reload();
  await expect(page.locator(".sidebar .bot-row")).toHaveCount(colors.length);
}

async function openSidebar(page: Page): Promise<void> {
  if (await page.locator(".sidebar").isVisible()) return;
  const contactToggle = page.getByRole("button", { name: "打开 Bot 列表", exact: true });
  if (await contactToggle.isVisible()) await contactToggle.click();
  else {
    await page.getByRole("button", { name: "聊天选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "打开 Bot 列表", exact: true }).click();
  }
  await expect(page.locator(".sidebar.mobile-open")).toBeVisible();
}

async function openSettings(page: Page): Promise<void> {
  await openSidebar(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
}

async function checkHorizontalLayout(page: Page): Promise<void> {
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  expect(viewport.documentWidth).toBeLessThanOrEqual(viewport.width + 1);
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  if (!await dialog.isVisible()) return;
  const layout = await dialog.evaluate((element) => {
    const dialog = element as HTMLElement;
    const rect = dialog.getBoundingClientRect();
    const content = dialog.querySelector<HTMLElement>(".settings-content");
    const outside = [...dialog.querySelectorAll<HTMLElement>("button,input,select,textarea")]
      .filter((control) => control.getClientRects().length > 0 && !control.closest(".settings-nav"))
      .filter((control) => {
        const controlRect = control.getBoundingClientRect();
        return controlRect.left < rect.left - 1 || controlRect.right > rect.right + 1;
      })
      .map((control) => control.getAttribute("aria-label") || control.textContent?.trim() || control.tagName);
    return {
      left: rect.left,
      right: rect.right,
      viewport: window.innerWidth,
      dialogOverflow: dialog.scrollWidth - dialog.clientWidth,
      contentOverflow: content ? content.scrollWidth - content.clientWidth : 0,
      outside,
    };
  });
  expect(layout.left).toBeGreaterThanOrEqual(-1);
  expect(layout.right).toBeLessThanOrEqual(layout.viewport + 1);
  expect(layout.dialogOverflow).toBeLessThanOrEqual(1);
  expect(layout.contentOverflow).toBeLessThanOrEqual(1);
  expect(layout.outside).toEqual([]);
}

test("loads every avatar asset and persists the actual uploaded, centered avatar after restart", async () => {
  const testInfo = test.info();
  test.setTimeout(60_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-ui-profile-"));
  let application: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    let launched = await launch(userDataDir);
    application = launched.application;
    let page = launched.page;
    watchErrors(page, errors);
    await checkPage(page);
    await resize(application, page, 1180);
    await seedBots(page, BOT_AVATAR_COLORS.slice(0, 7));
    await expect.poll(() => page.locator(".sidebar img.bot-avatar-icon, .nav-rail-profile img.user-avatar").evaluateAll((images) => {
      return images.length === 8 && images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 512 && image.naturalHeight === 512);
    })).toBe(true);
    const assetUrls = await page.locator(".sidebar img.bot-avatar-icon, .nav-rail-profile img.user-avatar").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).currentSrc));
    expect(new Set(assetUrls).size).toBe(8);
    await page.screenshot({ path: testInfo.outputPath("all-avatar-assets.png") });

    await page.getByRole("button", { name: "打开个人资料", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "个人资料", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("昵称", { exact: true }).fill("头像验收用户");
    const fileInput = dialog.getByLabel("选择个人头像", { exact: true });
    await expect(fileInput).toBeHidden();
    await fileInput.setInputFiles(join(process.cwd(), "src/renderer/src/assets/avatars/user-default.png"));
    const preview = dialog.locator(".user-profile-avatar img");
    await expect(preview).toHaveAttribute("src", /^data:image\/png;base64,/u);
    await expect.poll(() => preview.evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 256 && image.naturalHeight === 256)).toBe(true);

    const rectangularPng = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 400;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Fixture canvas unavailable");
      context.fillStyle = "rgb(220, 30, 30)";
      context.fillRect(0, 0, 800, 400);
      context.fillStyle = "rgb(0, 176, 96)";
      context.fillRect(200, 0, 400, 400);
      return canvas.toDataURL("image/png").split(",")[1]!;
    });
    const firstUpload = await preview.getAttribute("src");
    await fileInput.setInputFiles({ name: "center-crop.png", mimeType: "image/png", buffer: Buffer.from(rectangularPng, "base64") });
    await expect.poll(() => preview.getAttribute("src")).not.toBe(firstUpload);
    const centerCrop = await preview.evaluate(async (element) => {
      const image = element as HTMLImageElement;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Preview canvas unavailable");
      context.drawImage(image, 0, 0);
      return { width: image.naturalWidth, height: image.naturalHeight, pixels: [0, 128, 255].map((x) => [...context.getImageData(x, 128, 1, 1).data]) };
    });
    expect(centerCrop).toEqual({ width: 256, height: 256, pixels: Array.from({ length: 3 }, () => [0, 176, 96, 255]) });
    const uploadedAvatar = await preview.getAttribute("src");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".nav-rail-profile img")).toHaveAttribute("src", uploadedAvatar!);
    await application.close();
    application = undefined;

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    try {
      const stored = database.prepare("SELECT value,encrypted FROM app_settings WHERE key='ui.userProfile'").get() as { value: string; encrypted: number };
      expect(stored.encrypted).toBe(0);
      expect(JSON.parse(stored.value)).toEqual({ name: "头像验收用户", avatarUrl: uploadedAvatar });
    } finally {
      database.close();
    }
    launched = await launch(userDataDir);
    application = launched.application;
    page = launched.page;
    watchErrors(page, errors);
    await checkPage(page);
    await expect(page.locator(".nav-rail-profile img")).toHaveAttribute("src", uploadedAvatar!);
    await page.getByRole("button", { name: "打开个人资料", exact: true }).click();
    await expect(page.getByLabel("昵称", { exact: true })).toHaveValue("头像验收用户");
    await expect(page.locator(".user-profile-avatar img")).toHaveAttribute("src", uploadedAvatar!);
    await page.screenshot({ path: testInfo.outputPath("profile-after-restart.png") });
    expect(errors).toEqual([]);
  } catch (error) {
    if (application) {
      const failurePage = await application.firstWindow().catch(() => null);
      await failurePage?.screenshot({ path: testInfo.outputPath("failure.png") }).catch(() => {});
    }
    throw error;
  } finally {
    if (application) await application.close();
    removeTestDirectory(userDataDir);
  }
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1180, 1020, 620, 390]) {
    test(`keeps seven settings pages, navigation, and drawers usable: ${theme}, ${width}px`, async () => {
      const testInfo = test.info();
      test.setTimeout(60_000);
      const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-ui-responsive-"));
      let application: ElectronApplication | undefined;
      const errors: string[] = [];
      try {
        const launched = await test.step("launch isolated Electron application", () => launch(userDataDir));
        application = launched.application;
        const page = launched.page;
        page.setDefaultTimeout(10_000);
        page.setDefaultNavigationTimeout(15_000);
        watchErrors(page, errors);
        await test.step("verify application identity and create persisted UI resources", async () => {
          await checkPage(page);
          await seedBots(page, ["cobalt"]);
          await page.evaluate(async () => {
            const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
            for (let index = 0; index < 18; index += 1) {
              const memory = await api.memories.create({ scope: "user", scopeKey: "user", content: `布局验收记忆 ${index + 1}：长列表中每一条记忆都能滚动到达并编辑。` });
              if (!memory.ok) throw new Error(memory.error.safeMessage);
            }
          });
        });
        await test.step(`set ${width}px viewport and ${theme} theme`, async () => {
          const viewport = await resize(launched.application, page, width);
          testInfo.annotations.push({ type: "viewport", description: `${theme}: ${viewport.width} × ${viewport.height}` });
          await openSettings(page);
          const dialog = page.getByRole("dialog", { name: "设置", exact: true });
          await dialog.getByLabel("外观主题").selectOption(theme);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        });
        const dialog = page.getByRole("dialog", { name: "设置", exact: true });
        const navigation = dialog.locator(".settings-nav nav");
        if (width <= 620) {
          await test.step("verify horizontal settings navigation scroll", async () => {
            expect(await navigation.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
            await navigation.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
            await expect.poll(() => navigation.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
          });
        }
        for (const section of ["通用", "能力与权限", "长期记忆", "模型与 CLI", "MCP", "主动服务", "版本更新"]) {
          await test.step(`open and verify settings page: ${section}`, async () => {
            const tab = navigation.getByRole("button", { name: section, exact: true });
            await tab.click();
            await expect(tab).toHaveAttribute("aria-current", "page");
            await expect(dialog.getByRole("heading", { name: section, exact: true })).toBeVisible();
            await checkHorizontalLayout(page);
            if (section === "长期记忆") {
              await expect(dialog.locator(".scoped-memory-item")).toHaveCount(18);
              const content = dialog.locator(".settings-content");
              expect(await content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
              await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
              await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
              await expect(dialog.locator(".scoped-memory-item textarea").last()).toBeInViewport();
              const geometry = await dialog.evaluate((element) => {
                const content = element.querySelector<HTMLElement>(".settings-content");
                const toolbar = element.querySelector<HTMLElement>(".settings-toolbar");
                const close = element.querySelector<HTMLElement>(".settings-close-button");
                const editor = [...element.querySelectorAll<HTMLTextAreaElement>(".scoped-memory-item textarea")].at(-1);
                if (!content || !toolbar || !close || !editor) throw new Error("Missing settings scroll or toolbar controls");
                const contentRect = content.getBoundingClientRect();
                const toolbarRect = toolbar.getBoundingClientRect();
                const closeRect = close.getBoundingClientRect();
                const editorRect = editor.getBoundingClientRect();
                return {
                  scrollRemaining: content.scrollHeight - content.scrollTop - content.clientHeight,
                  closeInsideContent: content.contains(close),
                  closeInsideToolbar: toolbar.contains(close),
                  closeWidth: closeRect.width,
                  closeHeight: closeRect.height,
                  toolbarBottom: toolbarRect.bottom,
                  contentTop: contentRect.top,
                  closeBottom: closeRect.bottom,
                  editorTop: editorRect.top,
                  editorBottom: editorRect.bottom,
                  contentBottom: contentRect.bottom,
                  editorOverlapsClose: editorRect.left < closeRect.right && editorRect.right > closeRect.left
                    && editorRect.top < closeRect.bottom && editorRect.bottom > closeRect.top,
                };
              });
              expect(geometry.scrollRemaining).toBeLessThanOrEqual(1);
              expect(geometry.closeInsideContent).toBe(false);
              expect(geometry.closeInsideToolbar).toBe(true);
              expect(geometry.closeWidth).toBeGreaterThanOrEqual(40);
              expect(geometry.closeHeight).toBeGreaterThanOrEqual(40);
              expect(geometry.contentTop).toBeGreaterThanOrEqual(geometry.toolbarBottom - 1);
              expect(geometry.closeBottom).toBeLessThanOrEqual(geometry.contentTop + 1);
              expect(geometry.editorTop).toBeGreaterThanOrEqual(geometry.contentTop - 1);
              expect(geometry.editorBottom).toBeLessThanOrEqual(geometry.contentBottom + 1);
              expect(geometry.editorOverlapsClose).toBe(false);
              await page.screenshot({ path: testInfo.outputPath(`memory-${theme}-${width}.png`) });
            }
          });
        }
        await test.step("verify closing settings, contact search, and workspace/chat navigation", async () => {
          await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
          await expect(dialog).toBeHidden();
          await checkHorizontalLayout(page);
          await openSidebar(page);
          await page.getByRole("tab", { name: "联系人", exact: true }).click();
          await expect(page.getByRole("tab", { name: "联系人", exact: true })).toHaveAttribute("aria-selected", "true");
          await openSidebar(page);
          await page.getByLabel("搜索联系人", { exact: true }).fill("没有这个联系人");
          await expect(page.locator(".sidebar .bot-row")).toHaveCount(0);
          await page.getByLabel("搜索联系人", { exact: true }).fill("界面验收");
          await expect(page.locator(".sidebar .bot-row")).toHaveCount(1);
          await openSidebar(page);
          await page.getByRole("tab", { name: "工作区", exact: true }).click();
          await expect(page.getByRole("tab", { name: "工作区", exact: true })).toHaveAttribute("aria-selected", "true");
          await openSidebar(page);
          await page.getByRole("tab", { name: "聊天", exact: true }).click();
          await openSidebar(page);
          await expect(page.getByLabel("搜索聊天", { exact: true })).toHaveValue("");
          await checkHorizontalLayout(page);
        });
        if (width <= 620) {
          await test.step("verify sidebar dismissal and Bot inspector drawer", async () => {
            await page.getByRole("button", { name: "关闭 Bot 列表", exact: true }).click();
            await expect(page.locator(".sidebar")).toBeHidden();
            await page.getByRole("button", { name: "聊天选项", exact: true }).click();
            await page.getByRole("menuitem", { name: "Bot 设置", exact: true }).click();
            await expect(page.locator(".inspector.mobile-open")).toBeVisible();
            await expect(page.locator(".inspector").getByLabel("名称", { exact: true })).toHaveValue("界面验收 Bot 1");
            await checkHorizontalLayout(page);
            await page.screenshot({ path: testInfo.outputPath(`inspector-${theme}-${width}.png`) });
            await page.getByRole("button", { name: "关闭 Bot 设置", exact: true }).click();
            await expect(page.locator(".inspector")).toBeHidden();
          });
        }
        await test.step("verify renderer has no console or page errors", async () => { expect(errors).toEqual([]); });
      } catch (error) {
        if (application) {
          const failurePage = await application.firstWindow().catch(() => null);
          await failurePage?.screenshot({ path: testInfo.outputPath("failure.png"), timeout: 5_000 }).catch(() => {});
        }
        throw error;
      } finally {
        if (application) await application.close();
        removeTestDirectory(userDataDir);
      }
    });
  }
}
