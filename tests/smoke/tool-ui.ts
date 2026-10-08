import { expect, type Locator, type Page } from "@playwright/test";

export async function openToolRecords(page: Page): Promise<Locator> {
  const shelf = page.getByRole("complementary", { name: "会话成果", exact: true });
  if (!await shelf.isVisible()) await page.getByRole("button", { name: /^(?:打开任务详情|打开会话成果，共 \d+ 个)$/u }).click();
  await expect(shelf).toBeVisible();
  await shelf.getByRole("tab", { name: /^执行记录/u }).click();
  return shelf;
}
