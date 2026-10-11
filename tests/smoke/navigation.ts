import { expect, type Locator, type Page } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { buildBotIdentityMap } from "../../src/renderer/src/bot-identity";

export async function closeInspector(page: Page): Promise<void> {
  await expect(page.locator(".new-bot-chooser")).toBeHidden();
  const room = page.getByRole("dialog", { name: "群聊设置", exact: true });
  if (await room.isVisible()) {
    await room.getByRole("button", { name: "关闭群聊设置", exact: true }).click();
    await expect(room).toBeHidden();
  }
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
      await page.getByRole("tab", { name: "聊天", exact: true }).click();
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
  if (await page.getByRole("dialog", { name: "群聊设置", exact: true }).isVisible()) return;
  const contact = page.getByRole("main", { name: "联系人资料", exact: true });
  if (!await contact.isVisible()) {
    const selected = await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"));
    const menu = await openConversationMenu(page);
    const group = menu.getByRole("menuitem", { name: "群聊管理", exact: true });
    if (await group.isVisible()) {
      await group.click();
      await expect(page.getByRole("dialog", { name: "群聊设置", exact: true })).toBeVisible();
      return;
    }
    await page.keyboard.press("Escape");
    const bots = await page.evaluate(async () => {
      const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.bots.list();
      if (!result.ok) throw new Error(result.error.safeMessage);
      return result.data;
    });
    const selectedBot = bots.find(bot => selected === `bot:${bot.id}`);
    if (!selectedBot) throw new Error("A Bot must be selected before opening its contact profile.");
    const identity = buildBotIdentityMap(bots).get(selectedBot.id);
    if (!identity) throw new Error("Selected Bot identity is unavailable.");
    await openBotList(page);
    await page.getByRole("tab", { name: "联系人", exact: true }).click();
    await page.locator(".sidebar").getByRole("listitem", { name: identity.inline, exact: true }).click();
    await expect(page.locator(".sidebar.mobile-open")).toHaveCount(0);
  }
  await expect(contact).toBeVisible();
  const label = { profile: "资料", models: "模型与能力", memory: "记忆" }[tab];
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
  await expect(page.locator(".app-shell")).toBeVisible();
  if (await page.locator(".sidebar-workspace").isVisible()) return;
  const room = page.getByRole("dialog", { name: "群聊设置", exact: true });
  if (await room.isVisible()) {
    await room.getByRole("button", { name: "关闭群聊设置", exact: true }).click();
    await expect(room).toBeHidden();
  }
  const settings = page.getByRole("region", { name: "设置", exact: true });
  if (!await settings.isVisible()) {
    await openBotList(page);
    await page.getByRole("button", { name: "设置", exact: true }).click();
  }
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "能力与权限", exact: true }).click();
  await settings.getByRole("button", { name: "打开管理", exact: true }).click();
  await expect(settings).toBeHidden();
  await openBotList(page);
  await expect(page.locator(".sidebar-workspace")).toBeVisible();
}
