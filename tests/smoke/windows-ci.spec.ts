import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "@shared/contracts";
import { removeTestDirectory } from "./test-cleanup";

test.skip(process.platform !== "win32", "Windows CI contract");

test("boots Main, Preload and Renderer and completes Windows core IPC flows", async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-windows-ci-"));
  const attachmentPath = join(userDataDir, "windows-check.txt");
  writeFileSync(attachmentPath, "Windows attachment content", "utf8");
  const environment = {
    ...process.env,
    AEVOREN_BOT_USER_DATA_DIR: userDataDir,
    AEVOREN_BOT_FAKE_PROVIDER: "1",
    AEVOREN_BOT_TEST_HIDDEN: "1",
    AEVOREN_BOT_ATTACHMENT_TEST_PATHS: attachmentPath,
  };
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
  const page = await application.firstWindow();
  let applicationClosed = false;
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  try {
    await page.waitForFunction(() => Boolean(
      (window as unknown as { aevorenBot?: AevorenBotApi }).aevorenBot && document.body.textContent?.includes("Aevoren Bot"),
    ));
    const fixture = await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const first = await api.bots.create();
      const second = await api.bots.create();
      const attachments = await api.attachments.pick();
      if (!first.ok || !second.ok || !attachments.ok) throw new Error("Windows fixture setup failed");
      const direct = await api.messages.send({
        sessionId: first.data.session.id,
        clientNonce: crypto.randomUUID(),
        text: "Windows direct smoke",
        attachments: attachments.data,
      });
      if (!direct.ok) throw new Error(direct.error.safeMessage);
      const room = await api.rooms.create({ memberBotIds: [first.data.bot.id, second.data.bot.id], name: "Windows Room" });
      if (!room.ok) throw new Error(room.error.safeMessage);
      const roomSend = await api.roomRuntime.send({
        roomId: room.data.room.id,
        sessionId: room.data.session.id,
        clientNonce: crypto.randomUUID(),
        text: "Windows room smoke",
        targetBotIds: [first.data.bot.id],
        routingMode: "explicit",
      });
      if (!roomSend.ok) throw new Error(roomSend.error.safeMessage);
      const settings = await api.settings.saveGeneral({ memoryCaptureEnabled: false });
      if (!settings.ok) throw new Error(settings.error.safeMessage);
      return { directSessionId: first.data.session.id, roomSessionId: room.data.session.id };
    });

    await expect.poll(async () => page.evaluate(async ({ directSessionId, roomSessionId }) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const [direct, room] = await Promise.all([api.transcript.list(directSessionId), api.transcript.list(roomSessionId)]);
      return direct.ok && room.ok &&
        direct.data.some((entry) => entry.role === "assistant" && entry.status === "completed") &&
        room.data.some((entry) => entry.role === "assistant" && entry.status === "completed");
    }, fixture)).toBe(true);

    await page.evaluate(() => document.querySelector<HTMLButtonElement>(".sidebar-settings-button")?.click());
    await expect.poll(() => page.locator(".settings-dialog").count()).toBe(1);
    expect(await page.locator(".settings-dialog").textContent()).toContain("模型与 CLI");
    await page.evaluate(() => {
      const theme = document.querySelector<HTMLSelectElement>('select[aria-label="外观主题"]');
      if (!theme) throw new Error("Missing appearance theme control");
      theme.value = "dark";
      theme.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
    expect(consoleErrors).toEqual([]);
    await application.close();
    applicationClosed = true;

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs WHERE state = 'completed'").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM message_attachments").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM rooms WHERE archived_at IS NULL").get()).toEqual({ count: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    if (!applicationClosed) await application.close().catch(() => undefined);
    removeTestDirectory(userDataDir);
  }
});
