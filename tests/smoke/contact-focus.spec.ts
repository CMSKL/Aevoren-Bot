import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";
import { observeTestClose } from "./close-observation";

test("delayed contact autofocus preserves the user's chosen field and persisted profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-contact-focus-"));
  const databasePath = join(directory, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  const created = repository.createBot();
  repository.updateBot(created.bot.id, created.bot.version, { name: "研究员", description: "" });
  for (const id of ["claude.default", "codex.default"]) {
    const provider = repository.getProviderInstanceConfig(id);
    repository.updateProviderInstanceConfig(id, provider.version, { ...provider.config, cliPath: join(directory, `not-installed-${id}`) });
  }
  repository.close();
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("AEVOREN_BOT_FAKE_") && !["AEVOREN_BOT_DB_PATH", "AEVOREN_BOT_USER_DATA_DIR"].includes(key)));
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const application = await electron.launch({
    ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ["."]), "--use-mock-keychain"], cwd: process.cwd(),
    env: { ...environment, AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_DB_PATH: databasePath, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_CLOSE_DIAGNOSTICS: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" },
  });
  const closeProbe = await observeTestClose(application);
  let businessCompleted = false;
  try {
    await application.context().tracing.start({ snapshots: true, screenshots: false });
    if (executablePath) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const rendererUrl = pathToFileURL(join(await application.evaluate(({ app }) => app.getAppPath()), "out", "renderer", "index.html")).href;
    // Readiness is tied to the real document, not the early BrowserWindow event.
    await page.waitForURL(rendererUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".app-shell")).toBeVisible();
    await page.getByRole("tab", { name: "联系人", exact: true }).click();
    await page.locator(".sidebar").getByRole("listitem", { name: "研究员", exact: true }).click();
    const contact = page.getByRole("main", { name: "联系人资料", exact: true });
    await expect(contact).toBeVisible();
    // Hold only the application's delayed name focus. Rendering and every other
    // animation frame continue normally while the user selects another field.
    await page.evaluate(() => {
      const original = window.requestAnimationFrame.bind(window);
      const pending: FrameRequestCallback[] = [];
      Object.assign(window, { contactFocusTest: { pending, release: () => pending.splice(0).forEach(callback => callback(performance.now())) } });
      window.requestAnimationFrame = callback => {
        if (/\.focusName\(/u.test(Function.prototype.toString.call(callback))) {
          pending.push(callback);
          return 0;
        }
        return original(callback);
      };
    });
    const pendingFocus = () => page.evaluate(() => (window as unknown as { contactFocusTest: { pending: unknown[] } }).contactFocusTest.pending.length);
    const releaseFocus = () => page.evaluate(() => (window as unknown as { contactFocusTest: { release(): void } }).contactFocusTest.release());
    const readProfile = () => {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try { return database.prepare("SELECT name, description FROM bots WHERE id = ?").get(created.bot.id); }
      finally { database.close(); }
    };
    await contact.getByRole("button", { name: "编辑资料", exact: true }).click();
    await expect.poll(pendingFocus).toBe(1);
    await releaseFocus();
    await expect(contact.getByLabel("名称", { exact: true })).toBeFocused();
    await contact.getByRole("button", { name: "完成编辑", exact: true }).click();
    await contact.getByRole("button", { name: "编辑资料", exact: true }).click();
    await expect.poll(pendingFocus).toBe(1);
    await expect(contact.getByLabel("描述", { exact: true })).toBeEditable();
    await contact.getByLabel("描述", { exact: true }).focus();
    await releaseFocus();
    const description = "恢复归档 Room 前必须先保存的 Bot 描述";
    await page.keyboard.insertText(description);
    await contact.getByRole("button", { name: "完成编辑", exact: true }).click();
    await expect(contact.getByTestId("profile-save-status")).toContainText("已保存");
    expect(readProfile()).toEqual({ name: "研究员", description });

    await contact.getByRole("button", { name: "编辑资料", exact: true }).click();
    await expect.poll(pendingFocus).toBe(1);
    await contact.getByRole("button", { name: "发消息", exact: true }).click();
    await expect(contact).toBeHidden();
    const message = page.getByLabel("消息", { exact: true });
    await message.focus();
    await releaseFocus();
    await page.keyboard.insertText("保持聊天输入焦点，不发送。");
    await expect(message).toHaveValue("保持聊天输入焦点，不发送。");
    expect(readProfile()).toEqual({ name: "研究员", description });
    expect(errors).toEqual([]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
    businessCompleted = true;
  } catch (error) {
    const page = application.windows()[0];
    const document = await page?.evaluate(() => ({ readyState: window.document.readyState, hasApi: Boolean((window as unknown as { aevorenBot?: unknown }).aevorenBot),
      shell: Boolean(window.document.querySelector(".app-shell")), focusTag: window.document.activeElement?.tagName ?? null,
      selectedTab: window.document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("aria-selected") ?? null,
    })).catch(() => ({ unavailable: true }));
    await test.info().attach("contact-initial-document-state", { body: JSON.stringify(document ?? { unavailable: true }), contentType: "application/json" });
    throw error;
  } finally {
    // The business body retains its 30s deadline. Teardown gets its own bounded
    // allowance after those focus, persistence and hidden-window checks finish.
    test.setTimeout(test.info().timeout + 5_000);
    const owned = application.process();
    let closedNormally = false;
    try {
      closeProbe.record("trace-stop-request");
      await application.context().tracing.stop({ path: test.info().outputPath("contact-renderer-trace.zip") }).catch(() => undefined);
      closeProbe.record("trace-stop-returned");
      closeProbe.record("close-request");
      await closeTestApplication(application);
      closeProbe.record("close-helper-returned");
      expect({ code: owned.exitCode, signal: owned.signalCode }).toEqual({ code: 0, signal: null });
      closedNormally = true;
    } finally {
      try {
        closeProbe.record(closedNormally ? "close-final" : "close-or-exit-failed");
        const phasePath = test.info().outputPath("contact-close-phases.json");
        writeFileSync(phasePath, JSON.stringify({ businessCompleted, closedNormally, phases: closeProbe.phases }));
        await test.info().attach("contact-close-phases", { path: phasePath, contentType: "application/json" });
      } finally { closeProbe.detach(); removeTestDirectory(directory); }
    }
  }
});
