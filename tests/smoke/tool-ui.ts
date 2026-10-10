import { expect, type Locator, type Page } from "@playwright/test";
import { openConversationMenu } from "./navigation";

export async function openToolRecords(page: Page): Promise<Locator> {
  const shelf = page.getByRole("complementary", { name: "会话成果", exact: true });
  if (!await shelf.isVisible()) {
    const menu = await openConversationMenu(page);
    await menu.getByRole("menuitem", { name: /^执行记录/u }).click();
  }
  await expect(shelf).toBeVisible();
  await shelf.getByRole("tab", { name: /^执行记录/u }).click();
  return shelf;
}
