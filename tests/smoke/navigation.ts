import { expect, type Page } from "@playwright/test";

export async function openInspector(page: Page): Promise<void> {
  await expect(page.locator(".app-shell")).toBeVisible();
  const closeSidebar = page.locator(".sidebar.mobile-open .drawer-close-button");
  if (await closeSidebar.isVisible()) await closeSidebar.click();
  const inspector = page.locator(".inspector");
  if (!await inspector.isVisible()) {
    const desktopToggle = page.getByRole("button", { name: "展开详情面板", exact: true });
    if (await desktopToggle.isVisible()) {
      await desktopToggle.click();
    } else {
      await page.getByRole("button", { name: "打开 Bot 设置", exact: true }).click();
    }
  }
  await expect(inspector).toBeVisible();
}

export async function openWorkspaceTab(page: Page): Promise<void> {
  await expect(page.locator(".app-shell")).toBeVisible();
  const closeInspector = page.locator(".inspector.mobile-open .drawer-close-button");
  if (await closeInspector.isVisible()) await closeInspector.click();
  const tab = page.getByRole("tab", { name: "工作区", exact: true });
  if (!await tab.isVisible()) {
    await page.getByRole("button", { name: "打开 Bot 列表", exact: true }).click();
  }
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
