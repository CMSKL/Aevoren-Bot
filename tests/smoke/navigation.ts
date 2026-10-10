import { expect, type Locator, type Page } from "@playwright/test";

export async function closeInspector(page: Page): Promise<void> {
  await expect(page.locator(".new-bot-chooser")).toBeHidden();
  const close = page.locator(".inspector .drawer-close-button");
  if (await close.isVisible()) await close.click();
  await expect(page.locator(".inspector")).toBeHidden();
}

export async function openConversationMenu(page: Page): Promise<Locator> {
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".new-bot-chooser")).toBeHidden();
  const closeSidebar = page.locator(".sidebar.mobile-open .drawer-close-button");
  if (await closeSidebar.isVisible()) await closeSidebar.click();
  const closeDetails = page.locator(".inspector.mobile-open .drawer-close-button");
  if (await closeDetails.isVisible()) await closeDetails.click();
  const menu = page.getByRole("menu", { name: "聊天选项", exact: true });
  if (!await menu.isVisible()) {
    await page.getByRole("button", { name: "聊天选项", exact: true }).click();
  }
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
  if (!await page.locator(".sidebar").isVisible()) {
    const menu = await openConversationMenu(page);
    await menu.getByRole("menuitem", { name: "打开 Bot 列表", exact: true }).click();
  }
  await expect(page.locator(".sidebar")).toBeVisible();
}

export async function openModelPicker(page: Page): Promise<Locator> {
  const menu = await openConversationMenu(page);
  await menu.locator(".header-model-trigger").click();
  const picker = page.getByRole("dialog", { name: "选择模型", exact: true });
  await expect(picker).toBeVisible();
  return picker;
}

export async function openMessageEvidence(page: Page): Promise<void> {
  for (const toggle of await page.locator(".message-evidence-toggle").all()) {
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}

export async function openInspector(page: Page): Promise<void> {
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".new-bot-chooser")).toBeHidden();
  const closeSidebar = page.locator(".sidebar.mobile-open .drawer-close-button");
  if (await closeSidebar.isVisible()) await closeSidebar.click();
  const inspector = page.locator(".inspector");
  if (!await inspector.isVisible()) {
    const menu = await openConversationMenu(page);
    await menu.getByRole("menuitem", { name: /^(?:Bot 设置|成员详情)$/u }).click();
  }
  await expect(inspector).toBeVisible();
}

export async function openWorkspaceTab(page: Page): Promise<void> {
  await expect(page.locator(".app-shell")).toBeVisible();
  await closeInspector(page);
  const tab = page.getByRole("tab", { name: "工作区", exact: true });
  if (!await tab.isVisible()) await openBotList(page);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
