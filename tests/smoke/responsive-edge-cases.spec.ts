import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { AppRepository } from "../../src/main/database";

test("keeps compact header controls visible at 150 and 200 percent zoom", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-responsive-edge-"));
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1" },
  });

  try {
    const page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.getByRole("button", { name: "创建新 Bot" }).click();

    for (const zoomFactor of [1.5, 2]) {
      await application.evaluate(({ BrowserWindow }, factor) => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.webContents.setZoomFactor(factor);
        window?.setSize(390, 640);
      }, zoomFactor);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(Math.ceil(390 / zoomFactor));

      const layout = await page.evaluate(() => {
        const header = document.querySelector<HTMLElement>(".conversation-header");
        const title = document.querySelector<HTMLElement>(".conversation-title");
        const centerCopy = document.querySelector<HTMLElement>(".center-state span");
        const composer = document.querySelector<HTMLElement>(".composer");
        if (!header || !title || !centerCopy || !composer) throw new Error("missing compact chat layout");
        const titleRect = title.getBoundingClientRect();
        const centerRect = centerCopy.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        return {
          headerContained: header.scrollWidth <= header.clientWidth,
          titleWidth: titleRect.width,
          controlsContained: [...header.querySelectorAll("button")].every((button) => {
            const rect = button.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= window.innerWidth;
          }),
          centerCopyContained: centerRect.left >= 0 && centerRect.right <= window.innerWidth,
          composerContained: composerRect.left >= 0 && composerRect.right <= window.innerWidth,
        };
      });
      expect(layout).toEqual({
        headerContained: true,
        titleWidth: expect.any(Number),
        controlsContained: true,
        centerCopyContained: true,
        composerContained: true,
      });
      expect(layout.titleWidth).toBeGreaterThanOrEqual(40);
    }

    await page.screenshot({ path: "/tmp/aevoren-bot-responsive-zoom-200-fixed.png" });
    expect(consoleErrors).toEqual([]);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});

test("keeps inspector and model settings usable at 200 percent zoom", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-responsive-panels-"));
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1" },
  });

  try {
    const page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.getByRole("button", { name: "创建新 Bot" }).click();
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.webContents.setZoomFactor(2);
      window?.setSize(390, 640);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(195);

    await page.getByRole("button", { name: "打开 Bot 设置" }).click();
    await expect(page.locator(".inspector")).toBeVisible();
    await page.waitForTimeout(220);
    const inspectorLayout = await page.evaluate(() => {
      const inspector = document.querySelector<HTMLElement>(".inspector");
      const header = document.querySelector<HTMLElement>(".inspector-header");
      const heading = header?.querySelector<HTMLElement>("h2");
      const firstField = inspector?.querySelector<HTMLElement>("input, textarea");
      if (!inspector || !header || !heading || !firstField) throw new Error("missing compact inspector");
      const inspectorRect = inspector.getBoundingClientRect();
      return {
        inspectorContained: inspectorRect.left >= 0 && inspectorRect.right <= window.innerWidth,
        inspectorWidth: inspectorRect.width,
        headerContained: header.scrollWidth <= header.clientWidth,
        headingHeight: heading.getBoundingClientRect().height,
        fieldWidth: firstField.getBoundingClientRect().width,
        controlsContained: [...header.querySelectorAll("button")].every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= inspectorRect.left && rect.right <= inspectorRect.right;
        }),
        fieldsContained: [...inspector.querySelectorAll("input, textarea")].every((field) => {
          const rect = field.getBoundingClientRect();
          return rect.left >= inspectorRect.left && rect.right <= inspectorRect.right;
        }),
      };
    });
    expect(inspectorLayout).toEqual({
      inspectorContained: true,
      inspectorWidth: expect.any(Number),
      headerContained: true,
      headingHeight: expect.any(Number),
      fieldWidth: expect.any(Number),
      controlsContained: true,
      fieldsContained: true,
    });
    expect(inspectorLayout.inspectorWidth).toBeGreaterThanOrEqual(170);
    expect(inspectorLayout.headingHeight).toBeLessThanOrEqual(30);
    expect(inspectorLayout.fieldWidth).toBeGreaterThanOrEqual(140);
    await page.screenshot({ path: "/tmp/aevoren-bot-responsive-inspector-zoom-200-fixed.png" });
    await page.getByRole("button", { name: "关闭 Bot 设置" }).click();

    await page.getByRole("button", { name: "打开 Bot 列表" }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型与 CLI", exact: true }).click();
    const settingsLayout = await page.locator(".settings-dialog").evaluate((dialog) => {
      const dialogRect = dialog.getBoundingClientRect();
      const panel = dialog.querySelector('.settings-panel:not([hidden])');
      const paragraph = panel?.querySelector("p");
      if (!(dialog instanceof HTMLElement) || !(panel instanceof HTMLElement) || !(paragraph instanceof HTMLElement)) {
        throw new Error("missing compact model settings");
      }
      const paragraphRect = paragraph.getBoundingClientRect();
      const visibleControls = [...dialog.querySelectorAll("button, input, select")].filter(
        (control): control is HTMLElement => control instanceof HTMLElement && control.offsetParent !== null,
      );
      return {
        dialogContained: dialogRect.left >= 0 && dialogRect.right <= window.innerWidth,
        horizontalContentContained: dialog.scrollWidth <= dialog.clientWidth,
        descriptionContained: paragraphRect.left >= dialogRect.left && paragraphRect.right <= dialogRect.right,
        controlsContained: visibleControls.every((control) => {
          const rect = control.getBoundingClientRect();
          return rect.left >= dialogRect.left && rect.right <= dialogRect.right;
        }),
        outOfBounds: visibleControls.filter((control) => {
          const rect = control.getBoundingClientRect();
          return rect.left < dialogRect.left || rect.right > dialogRect.right;
        }).map((control) => ({
          label: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? control.tagName,
          left: control.getBoundingClientRect().left,
          right: control.getBoundingClientRect().right,
        })),
      };
    });
    expect(settingsLayout).toEqual({
      dialogContained: true,
      horizontalContentContained: true,
      descriptionContained: true,
      controlsContained: true,
      outOfBounds: [],
    });
    await page.screenshot({ path: "/tmp/aevoren-bot-responsive-settings-zoom-200-fixed.png" });
    expect(consoleErrors).toEqual([]);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});

test("keeps Room member actions on one line beside a long Bot name", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-responsive-members-"));
  const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
  const longName = "执行员 · 负责验证窄窗口候选和提及标签不会撑破布局的超长名称";
  const roomName = "长名称成员验收群聊";
  try {
    const bots = ["研究员", longName, "评审员"].map((name) => {
      const created = repository.createBot();
      return repository.updateBot(created.bot.id, created.bot.version, { name });
    });
    repository.createRoom({ name: roomName, memberBotIds: bots.map((bot) => bot.id) });
  } finally {
    repository.close();
  }

  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1" },
  });

  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 800));
    await page.locator(".bot-row").filter({ hasText: roomName }).click();
    await page.getByRole("button", { name: "打开 Bot 设置" }).click();
    await expect(page.locator(".inspector")).toBeVisible();
    const memberRow = page.locator(".room-member-row").filter({ hasText: longName });
    const removeButton = memberRow.getByRole("button", { name: "移除" });
    const layout = await memberRow.evaluate((row) => {
      const name = row.querySelector<HTMLElement>(".member-main-link");
      const remove = [...row.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "移除");
      if (!name || !remove) throw new Error("missing Room member controls");
      const rowRect = row.getBoundingClientRect();
      const nameRect = name.getBoundingClientRect();
      const removeRect = remove.getBoundingClientRect();
      return {
        rowHeight: rowRect.height,
        removeHeight: removeRect.height,
        removeWhiteSpace: getComputedStyle(remove).whiteSpace,
        nameEllipses: getComputedStyle(name).textOverflow === "ellipsis",
        controlsSeparated: nameRect.right <= removeRect.left,
      };
    });
    await expect(removeButton).toBeVisible();
    expect(layout.rowHeight).toBeLessThanOrEqual(40);
    expect(layout.removeHeight).toBeLessThanOrEqual(24);
    expect(layout.removeWhiteSpace).toBe("nowrap");
    expect(layout.nameEllipses).toBe(true);
    expect(layout.controlsSeparated).toBe(true);
    await page.screenshot({ path: "/tmp/aevoren-bot-responsive-long-member-fixed.png" });
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});

test("uses a two-stage compact layout around the desktop breakpoint", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-responsive-breakpoint-"));
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1" },
  });

  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.getByRole("button", { name: "创建新 Bot" }).click();
    const expected = [
      { width: 1181, sidebar: true, inspector: true, minConversationWidth: 580 },
      { width: 1180, sidebar: true, inspector: false, minConversationWidth: 850 },
      { width: 1021, sidebar: true, inspector: false, minConversationWidth: 700 },
      { width: 1020, sidebar: false, inspector: false, minConversationWidth: 950 },
    ];

    for (const item of expected) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setSize(width, 700), item.width);
      await page.waitForTimeout(220);
      const layout = await page.evaluate(() => {
        const sidebar = document.querySelector<HTMLElement>(".sidebar");
        const inspector = document.querySelector<HTMLElement>(".inspector");
        const conversation = document.querySelector<HTMLElement>(".conversation");
        if (!sidebar || !inspector || !conversation) throw new Error("missing responsive columns");
        const isVisible = (element: HTMLElement): boolean => {
          const rect = element.getBoundingClientRect();
          return getComputedStyle(element).visibility !== "hidden" && rect.right > 0 && rect.left < window.innerWidth;
        };
        return {
          sidebar: isVisible(sidebar),
          inspector: isVisible(inspector),
          conversationWidth: conversation.getBoundingClientRect().width,
          rootContained: document.documentElement.scrollWidth <= window.innerWidth,
        };
      });
      expect(layout.sidebar).toBe(item.sidebar);
      expect(layout.inspector).toBe(item.inspector);
      expect(layout.conversationWidth).toBeGreaterThanOrEqual(item.minConversationWidth);
      expect(layout.rootContained).toBe(true);
      if (item.width === 1180) await page.screenshot({ path: "/tmp/aevoren-bot-responsive-two-pane-1180-fixed.png" });
      if (item.width === 1020) await page.screenshot({ path: "/tmp/aevoren-bot-responsive-single-pane-1020-fixed.png" });
    }

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 700));
    await page.waitForTimeout(220);
    await page.getByRole("button", { name: "打开 Bot 设置" }).click();
    await expect(page.locator(".inspector")).toBeVisible();
    await page.getByRole("button", { name: "关闭 Bot 设置" }).click();
    await expect(page.locator(".inspector")).not.toBeVisible();
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});

test("does not stack the new-chat chooser over an open narrow sidebar", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-responsive-chooser-"));
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1" },
  });

  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "新建聊天" }).click();
    await page.getByRole("button", { name: "创建新 Bot" }).click();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 640));
    await page.getByRole("button", { name: "打开 Bot 列表" }).click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.getByRole("button", { name: "新建聊天" }).click();
    await expect(page.locator(".new-bot-chooser")).toBeVisible();

    const layout = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>(".sidebar");
      const chooser = document.querySelector<HTMLElement>(".new-bot-chooser");
      if (!sidebar || !chooser) throw new Error("missing narrow chooser layout");
      const sidebarRect = sidebar.getBoundingClientRect();
      const chooserRect = chooser.getBoundingClientRect();
      return {
        sidebarVisible: getComputedStyle(sidebar).visibility !== "hidden" && sidebarRect.right > 0,
        chooserContained: chooserRect.left >= 0
          && chooserRect.right <= window.innerWidth
          && chooserRect.top >= 0
          && chooserRect.bottom <= window.innerHeight,
      };
    });
    expect(layout).toEqual({ sidebarVisible: false, chooserContained: true });
    await page.screenshot({ path: "/tmp/aevoren-bot-responsive-narrow-chooser-fixed.png" });
    await page.getByRole("button", { name: "关闭新聊天" }).click();
    await expect(page.locator(".sidebar")).not.toBeVisible();
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});

test("keeps a long sidebar scrollable without pushing the conversation below the viewport", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-responsive-sidebar-height-"));
  const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
  try {
    const botIds = Array.from({ length: 12 }, (_, index) => {
      const created = repository.createBot();
      return repository.updateBot(created.bot.id, created.bot.version, { name: `滚动验收 Bot ${index + 1}` }).id;
    });
    repository.createRoom({ name: "滚动验收群聊 1", memberBotIds: botIds.slice(0, 2) });
    repository.createRoom({ name: "滚动验收群聊 2", memberBotIds: botIds.slice(2, 4) });
    repository.createRoom({ name: "滚动验收群聊 3", memberBotIds: botIds.slice(4, 6) });
  } finally {
    repository.close();
  }

  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1" },
  });

  try {
    const page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1338, 808));
    await expect(page.locator(".conversation")).toBeVisible();
    await expect(page.locator(".bot-list")).toBeVisible();

    const layout = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".app-shell");
      const sidebar = document.querySelector<HTMLElement>(".sidebar");
      const list = document.querySelector<HTMLElement>(".bot-list");
      const conversation = document.querySelector<HTMLElement>(".conversation");
      const composer = document.querySelector<HTMLElement>(".composer-wrap");
      if (!shell || !sidebar || !list || !conversation || !composer) throw new Error("missing primary layout");
      const sidebarRect = sidebar.getBoundingClientRect();
      const conversationRect = conversation.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      return {
        shellContained: shell.scrollHeight <= shell.clientHeight,
        sidebarContained: sidebarRect.top >= 0 && sidebarRect.bottom <= window.innerHeight,
        conversationContained: conversationRect.top >= 0 && conversationRect.bottom <= window.innerHeight,
        composerVisible: composerRect.top >= 0 && composerRect.bottom <= window.innerHeight,
        listCanScroll: list.scrollHeight > list.clientHeight,
      };
    });
    expect(layout).toEqual({
      shellContained: true,
      sidebarContained: true,
      conversationContained: true,
      composerVisible: true,
      listCanScroll: true,
    });

    const scrollResult = await page.locator(".bot-list").evaluate((list) => {
      list.scrollTop = list.scrollHeight;
      const lastRow = list.querySelector<HTMLElement>('.bot-row[aria-label="滚动验收 Bot 12"]');
      if (!lastRow) throw new Error("missing final sidebar row");
      const listRect = list.getBoundingClientRect();
      const rowRect = lastRow.getBoundingClientRect();
      return {
        scrollTop: list.scrollTop,
        lastRowVisible: rowRect.top >= listRect.top
          && rowRect.bottom <= listRect.bottom
          && rowRect.bottom <= window.innerHeight,
      };
    });
    expect(scrollResult.scrollTop).toBeGreaterThan(0);
    expect(scrollResult.lastRowVisible).toBe(true);
    await page.screenshot({ path: "/tmp/aevoren-bot-layout-height-regression-fixed.png" });
    expect(consoleErrors).toEqual([]);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});
