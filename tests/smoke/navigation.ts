import { expect, type Locator, type Page } from "@playwright/test";

export async function closeInspector(page: Page): Promise<void> {
  await expect(page.locator(".new-bot-chooser")).toBeHidden();
  const room = page.getByRole("dialog", { name: "群聊设置", exact: true });
  if (await room.isVisible()) {
    await room.getByRole("button", { name: "关闭群聊设置", exact: true }).click();
    await expect(room).toBeHidden();
  }
  const detailClose = page.getByRole("button", { name: "关闭详情", exact: true });
  if (await detailClose.isVisible()) { await detailClose.click(); await expect(detailClose).toBeHidden(); }
  const contact = page.getByRole("main", { name: "联系人资料", exact: true });
  if (await contact.isVisible()) {
    // Completing the old edit flow now explicitly enters this contact's chat.
    // Do not bypass the production save/navigation guards through IPC.
    const send = contact.getByRole("button", { name: "发消息", exact: true });
    if (await send.isVisible()) {
      await send.click();
      await expect(contact).toBeHidden();
    } else {
      await openBotList(page);
      await selectNavigationTab(page, "聊天");
    }
  }
}

export async function openConversationMenu(page: Page): Promise<Locator> {
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".new-bot-chooser")).toBeHidden();
  const settingsClose = page.getByRole("button", { name: "关闭设置", exact: true });
  if (await settingsClose.isVisible()) await settingsClose.click();
  await closeInspector(page);
  const closeSidebar = page.locator(".sidebar.mobile-open .drawer-close-button");
  if (await closeSidebar.isVisible()) await closeSidebar.click();
  const menu = page.getByRole("menu", { name: "聊天选项", exact: true });
  if (!await menu.isVisible()) await page.getByRole("button", { name: "聊天选项", exact: true }).click();
  await expect(menu).toBeVisible();
  return menu;
}

export async function openConversationFiles(page: Page): Promise<void> {
  const shelf = page.locator(".task-details-shelf");
  if (!await shelf.isVisible()) {
    const menu = await openConversationMenu(page);
    await menu.getByRole("menuitem", { name: /^(?:打开任务详情|打开会话成果，共 \d+ 个)$/u }).click();
  }
  await expect(shelf).toBeVisible();
}

export async function openBotList(page: Page): Promise<void> {
  await expect(page.locator(".app-shell")).toBeVisible();
  const settingsClose = page.getByRole("button", { name: "关闭设置", exact: true });
  if (await settingsClose.isVisible()) await settingsClose.click();
  if (!await page.locator(".sidebar").isVisible()) {
    const contactToggle = page.getByRole("main", { name: "联系人资料", exact: true }).getByRole("button", { name: "打开 Bot 列表", exact: true });
    if (await contactToggle.isVisible()) await contactToggle.click();
    else {
      const menu = await openConversationMenu(page);
      await menu.getByRole("menuitem", { name: "打开 Bot 列表", exact: true }).click();
    }
  }
  await expect(page.locator(".sidebar")).toBeVisible();
}

export async function openModelPicker(page: Page): Promise<Locator> {
  await openInspector(page, "models");
  const panel = page.getByRole("main", { name: "联系人资料", exact: true }).getByRole("tabpanel", { name: "模型与能力", exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

export async function openMessageEvidence(page: Page): Promise<void> {
  for (const toggle of await page.locator(".message-evidence-toggle").all()) {
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}

export async function openInspector(page: Page, tab: "profile" | "models" | "memory" = "profile"): Promise<void> {
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".new-bot-chooser")).toBeHidden();
  const openGroup = page.getByRole("dialog", { name: "群聊设置", exact: true });
  if (await openGroup.isVisible()) { await selectDetailsTab(openGroup, "详情"); return; }
  const contact = page.getByRole("main", { name: "联系人资料", exact: true });
  if (!await contact.isVisible()) {
    await page.getByRole("button", { name: "查看对话详情", exact: true }).click();
    const group = page.getByRole("dialog", { name: "群聊设置", exact: true });
    if (await group.isVisible()) return;
  }
  await expect(contact).toBeVisible();
  const label = { profile: "详情", models: "模型与能力", memory: "记忆" }[tab];
  if (!await contact.getByRole("tab", { name: label, exact: true }).isVisible()) {
    await contact.getByRole("button", { name: "更多详情功能", exact: true }).click();
    await contact.getByRole("menuitem", { name: label, exact: true }).click();
  }
  const target = contact.getByRole("tab", { name: label, exact: true });
  if (await target.getAttribute("aria-selected") !== "true") await target.click();
  await expect(target).toHaveAttribute("aria-selected", "true");
  if (tab === "profile") {
    const edit = contact.getByRole("button", { name: "编辑资料", exact: true });
    if (await edit.isVisible()) await edit.click();
    await expect(contact.getByLabel("名称", { exact: true })).not.toHaveAttribute("readonly", "");
  }
}

export async function openWorkspaceTab(page: Page): Promise<void> {
  await closeInspector(page);
  await selectNavigationTab(page, "工作区");
  await expect(page.locator(".sidebar-workspace")).toBeVisible();
}

export async function selectNavigationTab(page: Page, name: "聊天" | "联系人" | "工作区"): Promise<void> {
  await openBotList(page);
  const tab = page.getByRole("tab", { name, exact: true });
  if (!await tab.isVisible()) await page.getByRole("button", { name: "打开账户菜单", exact: true }).click();
  await tab.click();
}

export async function selectDetailsTab(scope: Page | Locator, name: string): Promise<void> {
  const label = name === "资料" ? "详情" : name === "浏览器" ? "电脑工具" : name === "执行环境" ? "高级工具" : name;
  const tab = scope.getByRole("tab", { name: label, exact: true });
  if (!await tab.isVisible()) {
    await scope.getByRole("button", { name: "更多详情功能", exact: true }).click();
    await scope.getByRole("menuitem", { name: label, exact: true }).click();
  } else await tab.click();
}

export async function openListFilter(page: Page): Promise<void> {
  await openBotList(page);
  await page.getByRole("button", { name: "打开账户菜单", exact: true }).click();
  await page.getByRole("button", { name: "筛选聊天", exact: true }).click();
  await expect(page.getByRole("search", { name: "筛选列表", exact: true })).toBeVisible();
}

export async function openComposerTools(page: Page): Promise<void> {
  const disclosure = page.locator(".composer-tools-disclosure");
  if (await disclosure.getAttribute("open") === null) await disclosure.locator("summary").click();
  await expect(disclosure).toHaveAttribute("open", "");
}
