import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import { closeInspector, openConversationMenu, openInspector } from "./navigation";

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
    await expect(page.locator(".inspector")).toBeVisible();

    await closeInspector(page);
    for (const zoomFactor of [1.5, 2]) {
      await application.evaluate(({ BrowserWindow }, factor) => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.webContents.setZoomFactor(factor);
        window?.setSize(390, 640);
      }, zoomFactor);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(Math.ceil(390 / zoomFactor));
      await expect(page.locator(".conversation-header").getByRole("button", { name: "聊天选项", exact: true })).toBeVisible();
      await expect(page.locator(".conversation-header button")).toHaveCount(1);

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
          headerDragRegion: getComputedStyle(header).getPropertyValue("-webkit-app-region"),
          controlsNoDrag: [...header.querySelectorAll("button")].every((button) => getComputedStyle(button).getPropertyValue("-webkit-app-region") === "no-drag"),
          centerCopyContained: centerRect.left >= 0 && centerRect.right <= window.innerWidth,
          composerContained: composerRect.left >= 0 && composerRect.right <= window.innerWidth,
        };
      });
      expect(layout).toEqual({
        headerContained: true,
        titleWidth: expect.any(Number),
        controlsContained: true,
        headerDragRegion: "drag",
        controlsNoDrag: true,
        centerCopyContained: true,
        composerContained: true,
      });
      expect(layout.titleWidth).toBeGreaterThanOrEqual(40);
      const menu = await openConversationMenu(page);
      await expect(menu.getByRole("menuitem", { name: "Bot 设置", exact: true })).toBeVisible();
      expect(await menu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth;
      })).toBe(true);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
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
    await expect(page.locator(".inspector")).toBeVisible();
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.webContents.setZoomFactor(2);
      window?.setSize(390, 640);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(195);

    await openInspector(page);
    await expect(page.locator(".inspector")).toBeVisible();
    await expect.poll(
      () => page.evaluate(() => {
        const inspector = document.querySelector<HTMLElement>(".inspector");
        if (!inspector) return false;
        const rect = inspector.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth;
      }),
      { timeout: 2_000 },
    ).toBe(true);
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
          if (field.getClientRects().length === 0) return true;
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
    await page.screenshot({ path: "/tmp/aevoren-bot-responsive-inspector-zoom-200-fixed.png" });
    expect(inspectorLayout.inspectorWidth).toBeGreaterThanOrEqual(170);
    expect(inspectorLayout.headingHeight).toBeLessThanOrEqual(54);
    expect(inspectorLayout.fieldWidth).toBeGreaterThanOrEqual(140);
    await page.getByRole("button", { name: "关闭 Bot 设置" }).click();

    await (await openConversationMenu(page)).getByRole("menuitem", { name: "打开 Bot 列表", exact: true }).click();
    await expect(page.locator(".sidebar.mobile-open")).toBeVisible();
    const sidebarHeader = await page.locator(".sidebar-list-header").evaluate((header) => {
      const search = header.querySelector<HTMLInputElement>(".sidebar-search input");
      const controls = [...header.querySelectorAll<HTMLElement>(":scope > .sidebar-search, :scope > button")];
      if (!search) throw new Error("Missing sidebar search input");
      const rectangles = controls.map((control) => control.getBoundingClientRect());
      const overlap = rectangles.some((rect, index) => rectangles.slice(index + 1).some((other) => {
        return Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > 1
          && Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) > 1;
      }));
      return { inputWidth: search.getBoundingClientRect().width, overlap };
    });
    expect(sidebarHeader.inputWidth).toBeGreaterThan(30);
    expect(sidebarHeader.overlap).toBe(false);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const sidebarCapture = await application.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"),
    );
    writeFileSync("/tmp/aevoren-bot-sidebar-zoom-200-native.png", Buffer.from(sidebarCapture, "base64"));
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型与 CLI", exact: true }).click();
    const settingsLayout = await page.locator(".settings-dialog").evaluate((dialog) => {
      const dialogRect = dialog.getBoundingClientRect();
      const panel = dialog.querySelector('.settings-panel:not([hidden])');
      const paragraph = panel?.querySelector("p");
      const navigation = dialog.querySelector<HTMLElement>(".settings-nav nav");
      if (!(dialog instanceof HTMLElement) || !(panel instanceof HTMLElement) || !(paragraph instanceof HTMLElement) || !navigation) {
        throw new Error("missing compact model settings");
      }
      const paragraphRect = paragraph.getBoundingClientRect();
      const navigationRect = navigation.getBoundingClientRect();
      const visibleControls = [...dialog.querySelectorAll("button, input, select")].filter(
        (control): control is HTMLElement => control instanceof HTMLElement && control.offsetParent !== null && !control.closest(".settings-nav"),
      );
      return {
        dialogContained: dialogRect.left >= 0 && dialogRect.right <= window.innerWidth,
        horizontalContentContained: dialog.scrollWidth <= dialog.clientWidth,
        navigationContained: navigationRect.left >= dialogRect.left && navigationRect.right <= dialogRect.right,
        navigationScrollable: navigation.scrollWidth > navigation.clientWidth && getComputedStyle(navigation).overflowX === "auto",
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
      navigationContained: true,
      navigationScrollable: true,
      descriptionContained: true,
      controlsContained: true,
      outOfBounds: [],
    });
    await page.screenshot({ path: "/tmp/aevoren-bot-responsive-settings-zoom-200-fixed.png" });
    const sections = ["通用", "能力与权限", "长期记忆", "模型与 CLI", "MCP", "主动服务", "版本更新"];
    await page.getByRole("button", { name: sections[0], exact: true }).focus();
    for (const [index, name] of sections.entries()) {
      const category = page.getByRole("button", { name, exact: true });
      await expect(category).toBeFocused();
      await expect(category).toBeInViewport();
      await page.keyboard.press("Enter");
      await expect(category).toHaveAttribute("aria-current", "page");
      if (index < sections.length - 1) await page.keyboard.press("Tab");
    }
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
    await openInspector(page);
    await expect(page.locator(".inspector")).toBeVisible();
    await page.getByRole("button", { name: /管理群聊成员/u }).click();
    const memberRow = page.locator(".room-member-row").filter({ hasText: longName });
    const removeButton = memberRow.getByRole("button", { name: "移除" });
    const layout = await memberRow.evaluate((row) => {
      const name = row.querySelector<HTMLElement>(".member-main-link");
      const nameText = name?.querySelector<HTMLElement>(":scope > span");
      const remove = [...row.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "移除");
      if (!name || !nameText || !remove) throw new Error("missing Room member controls");
      const rowRect = row.getBoundingClientRect();
      const nameRect = name.getBoundingClientRect();
      const removeRect = remove.getBoundingClientRect();
      return {
        rowHeight: rowRect.height,
        removeHeight: removeRect.height,
        removeSingleLine: removeRect.height <= 36 && remove.scrollWidth <= remove.clientWidth,
        nameEllipses: getComputedStyle(nameText).textOverflow === "ellipsis" && getComputedStyle(nameText).whiteSpace === "nowrap",
        controlsSeparated: nameRect.right <= removeRect.left,
      };
    });
    await expect(removeButton).toBeVisible();
    await page.screenshot({ path: "/tmp/aevoren-bot-responsive-long-member-fixed.png" });
    expect(layout.rowHeight).toBeLessThanOrEqual(76);
    expect(layout.removeHeight).toBe(36);
    expect(layout.removeSingleLine).toBe(true);
    expect(layout.nameEllipses).toBe(true);
    expect(layout.controlsSeparated).toBe(true);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});

test("keeps the sidebar through tablet widths and uses overlay drawers at the mobile breakpoint", async () => {
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
    await expect(page.locator(".inspector")).toBeVisible();
    await closeInspector(page);
    const expected = [
      { width: 1181, sidebarWidth: 404 },
      { width: 1180, sidebarWidth: 342 },
      { width: 1021, sidebarWidth: 342 },
      { width: 1020, sidebarWidth: 308 },
      { width: 621, sidebarWidth: 308 },
      { width: 620, sidebarWidth: 0 },
      { width: 390, sidebarWidth: 0 },
    ];

    for (const item of expected) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setContentSize(width, 700), item.width);
      await expect.poll(
        () => page.evaluate((expectedWidth) => {
          const sidebar = document.querySelector<HTMLElement>(".sidebar");
          const inspector = document.querySelector<HTMLElement>(".inspector");
          if (!sidebar || !inspector) return false;
          const isVisible = (element: HTMLElement): boolean => {
            const rect = element.getBoundingClientRect();
            return getComputedStyle(element).visibility !== "hidden" && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth;
          };
          return window.innerWidth === expectedWidth
            && isVisible(sidebar) === (window.innerWidth > 620)
            && !isVisible(inspector);
        }, item.width),
        { timeout: 2_000 },
      ).toBe(true);
      const layout = await page.evaluate(() => {
        const sidebar = document.querySelector<HTMLElement>(".sidebar");
        const inspector = document.querySelector<HTMLElement>(".inspector");
        const conversation = document.querySelector<HTMLElement>(".conversation");
        const header = document.querySelector<HTMLElement>(".conversation-header");
        if (!sidebar || !inspector || !conversation || !header) throw new Error("missing responsive columns");
        const isVisible = (element: HTMLElement): boolean => {
          const rect = element.getBoundingClientRect();
          return getComputedStyle(element).visibility !== "hidden" && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth;
        };
        return {
          viewportWidth: window.innerWidth,
          sidebar: isVisible(sidebar),
          sidebarWidth: isVisible(sidebar) ? sidebar.getBoundingClientRect().width : 0,
          inspector: isVisible(inspector),
          conversationWidth: conversation.getBoundingClientRect().width,
          conversationLeft: conversation.getBoundingClientRect().left,
          headerHeight: header.getBoundingClientRect().height,
          rootContained: document.documentElement.scrollWidth <= window.innerWidth,
        };
      });
      expect(layout.viewportWidth).toBeGreaterThanOrEqual(item.width - 2);
      expect(layout.viewportWidth).toBeLessThanOrEqual(item.width + 2);
      expect(layout.sidebar).toBe(item.sidebarWidth > 0);
      expect(layout.sidebarWidth).toBe(item.sidebarWidth);
      expect(layout.inspector).toBe(false);
      expect(layout.conversationLeft).toBe(item.sidebarWidth);
      expect(layout.conversationWidth).toBe(item.width - item.sidebarWidth);
      expect(layout.headerHeight).toBe(item.width <= 620 ? 64 : 88);
      expect(layout.rootContained).toBe(true);
      if ([1180, 621, 620].includes(item.width)) await page.screenshot({ path: `/tmp/aevoren-bot-responsive-sidebar-${item.width}-fixed.png` });

      await openInspector(page);
      await expect(page.locator(".inspector.mobile-open")).toBeVisible();
      await expect(page.locator(".inspector")).toHaveCSS("position", "fixed");
      const drawerLayout = await page.evaluate(() => {
        const inspector = document.querySelector<HTMLElement>(".inspector");
        const conversation = document.querySelector<HTMLElement>(".conversation");
        if (!inspector || !conversation) throw new Error("missing inspector drawer");
        const rect = inspector.getBoundingClientRect();
        return {
          width: rect.width,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          viewportHeight: window.innerHeight,
          conversationWidth: conversation.getBoundingClientRect().width,
          rootContained: document.documentElement.scrollWidth <= window.innerWidth,
        };
      });
      expect(drawerLayout.width).toBe(Math.min(440, item.width));
      expect(drawerLayout.right).toBe(item.width);
      expect(drawerLayout.top).toBe(0);
      expect(drawerLayout.bottom).toBe(drawerLayout.viewportHeight);
      expect(drawerLayout.conversationWidth).toBe(layout.conversationWidth);
      expect(drawerLayout.rootContained).toBe(true);
      await page.getByRole("button", { name: "关闭 Bot 设置", exact: true }).click();
      await expect(page.locator(".inspector")).toBeHidden();
    }
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
    await expect(page.locator(".inspector")).toBeVisible();
    await closeInspector(page);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 640));
    await (await openConversationMenu(page)).getByRole("menuitem", { name: "打开 Bot 列表", exact: true }).click();
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
      const lastRow = [...list.querySelectorAll<HTMLElement>(".bot-row")].at(-1);
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
