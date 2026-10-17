import { IPC } from "../../src/shared/channels";
import { disposeTestApplication, removeTestDirectory } from "./test-cleanup";
import { openInspector } from "./navigation";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

function environment(userDataDir: string): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...inherited, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" };
}

type CloseProbe = { record(phase: string): void; phases: Record<string, unknown>[]; detach(): void };
const closePhases = new WeakMap<ElectronApplication, CloseProbe>();
const CLOSE_PHASE_PREFIX = "AEVOREN_CLOSE_PHASE ";

async function launch(userDataDir: string): Promise<{ application: ElectronApplication; page: Page }> {
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: environment(userDataDir) });
  if (executablePath) {
    const runtime = await application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, version: app.getVersion() }));
    expect(runtime.isPackaged).toBe(true);
    expect(runtime.version).toBe(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version);
    await test.info().attach("actual-close-package", { body: JSON.stringify(runtime), contentType: "application/json" });
  }
  const page = await application.firstWindow();
  const owned = application.process(), started = performance.now(), phases: Record<string, unknown>[] = [];
  let exitSeen = false, closeSeen = false, buffered = "";
  const record = (phase: string): void => {
    if (phases.length >= 120) return;
    phases.push({ source: "fixture", phase, elapsedMs: Math.round(performance.now() - started), pid: owned.pid ?? null,
      exitCode: owned.exitCode, signalCode: owned.signalCode, killed: owned.killed, exitSeen, closeSeen,
      stdio: owned.stdio.map(stream => stream ? { destroyed: stream.destroyed } : null) });
  };
  const exited = (): void => { exitSeen = true; record("owned-exit"); };
  const closed = (): void => { closeSeen = true; record("owned-close"); };
  const streams = owned.stdio.flatMap((stream, index) => stream ? [{ stream, listener: () => record(`stdio-${index}-close`) }] : []);
  const stderr = (chunk: Buffer): void => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n"); buffered = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith(CLOSE_PHASE_PREFIX) && phases.length < 120) {
      try { phases.push({ source: "main", observedAtMs: Math.round(performance.now() - started), ...JSON.parse(line.slice(CLOSE_PHASE_PREFIX.length)) as Record<string, unknown> }); }
      catch { record("invalid-main-phase"); }
    }
    if (buffered.length > 4_096) buffered = "";
  };
  owned.once("exit", exited); owned.once("close", closed); owned.stderr?.on("data", stderr);
  for (const { stream, listener } of streams) stream.once("close", listener);
  closePhases.set(application, { record, phases, detach() {
    owned.removeListener("exit", exited); owned.removeListener("close", closed); owned.stderr?.removeListener("data", stderr);
    for (const { stream, listener } of streams) stream.removeListener("close", listener);
  } });
  record("probe-installed");
  await application.evaluate(({ app, BrowserWindow, ipcMain }, channels) => {
    const started = performance.now();
    const record = (phase: string, state: Record<string, string | number | boolean> = {}): void => {
      console.error("AEVOREN_CLOSE_PHASE " + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started), ...state }));
    };
    app.on("before-quit", () => record("app-before-quit", { windows: BrowserWindow.getAllWindows().length }));
    app.on("will-quit", () => record("app-will-quit", { windows: BrowserWindow.getAllWindows().length }));
    app.on("quit", (_event, exitCode) => record("app-quit", { exitCode }));
    app.on("window-all-closed", () => record("app-window-all-closed", { windows: BrowserWindow.getAllWindows().length }));
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents;
      const send = contents.send.bind(contents);
      contents.send = (channel, ...args) => {
        if (channel === channels.appBeforeClose || channel === channels.appCloseBlocked) record(channel, { loading: contents.isLoadingMainFrame(), destroyed: contents.isDestroyed() });
        return send(channel, ...args);
      };
      window.on("close", () => record("window-close", { loading: contents.isLoadingMainFrame() }));
      window.on("closed", () => record("window-closed", { windows: BrowserWindow.getAllWindows().length }));
      contents.on("did-navigate", () => record("main-navigation-committed"));
      contents.on("did-stop-loading", () => record("loading-stopped"));
      contents.on("render-process-gone", (_event, details) => record("renderer-gone", { reason: details.reason, exitCode: details.exitCode }));
    }
    ipcMain.on(channels.appRendererReady, event => record("renderer-ready", { mainFrame: event.senderFrame === event.sender.mainFrame }));
    ipcMain.on(channels.appConfirmClose, (event, value: unknown) => record("flush-ack", { mainFrame: event.senderFrame === event.sender.mainFrame, canClose: value === true }));
  }, IPC);
  return { application, page };
}

async function createBot(page: Page): Promise<void> {
  await page.getByRole("button", { name: "新建聊天" }).click();
  await page.getByRole("button", { name: "创建新 Bot" }).click();
  await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeVisible();
  await openInspector(page);
}

async function requestWindowClose(application: ElectronApplication, timeoutMs = 3_000): Promise<boolean> {
  const process = application.process(), probe = closePhases.get(application);
  probe?.record("window-close-request");
  const exited = new Promise<boolean>((resolve) => process.once("exit", () => resolve(true)));
  try {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    probe?.record("window-close-evaluate-resolved");
  } catch {
    probe?.record("window-close-evaluate-interrupted");
    // A successful immediate close can destroy Playwright's main-process context
    // before evaluate resolves. The process exit below remains the authority.
  }
  const didExit = await Promise.race([
    exited,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  probe?.record(didExit ? "window-close-exit-observed" : "window-close-exit-deadline");
  try {
    if (didExit) expect({ code: process.exitCode, signal: process.signalCode }).toEqual({ code: 0, signal: null });
    if (!didExit) {
      await test.info().attach("close-phase-diagnostics", { body: JSON.stringify({ timeoutMs, phases: probe?.phases ?? [] }), contentType: "application/json" });
      probe?.record("window-close-cleanup-start");
      await disposeTestApplication(application);
      await exited;
      probe?.record("window-close-cleanup-resolved");
    }
    return didExit;
  } finally {
    probe?.record("window-close-final");
    await test.info().attach("close-phase-diagnostics-final", { body: JSON.stringify({ timeoutMs, didExit, phases: probe?.phases ?? [] }), contentType: "application/json" });
    probe?.detach();
  }
}

async function requestAppQuit(application: ElectronApplication, timeoutMs = 3_000): Promise<boolean> {
  const process = application.process(), probe = closePhases.get(application);
  probe?.record("app-quit-request");
  const exited = new Promise<boolean>((resolve) => process.once("exit", () => resolve(true)));
  await application.evaluate(({ app }) => app.quit());
  const didExit = await Promise.race([
    exited,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  probe?.record(didExit ? "app-quit-exit-observed" : "app-quit-exit-deadline");
  try {
    if (didExit) expect({ code: process.exitCode, signal: process.signalCode }).toEqual({ code: 0, signal: null });
    if (!didExit) {
      await test.info().attach("close-phase-diagnostics", { body: JSON.stringify({ timeoutMs, phases: probe?.phases ?? [] }), contentType: "application/json" });
      probe?.record("app-quit-cleanup-start");
      await disposeTestApplication(application);
      await exited;
      probe?.record("app-quit-cleanup-resolved");
    }
    return didExit;
  } finally {
    probe?.record("app-quit-final");
    await test.info().attach("close-phase-diagnostics-final", { body: JSON.stringify({ timeoutMs, didExit, phases: probe?.phases ?? [] }), contentType: "application/json" });
    probe?.detach();
  }
}

function databaseHash(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const bots = database.prepare("SELECT * FROM bots ORDER BY id").all();
    const sessions = database.prepare("SELECT * FROM sessions ORDER BY id").all();
    const transcript = database
      .prepare("SELECT * FROM transcript_entries ORDER BY session_id,generation,seq")
      .all();
    return createHash("sha256").update(JSON.stringify({ bots, sessions, transcript })).digest("hex");
  } finally {
    database.close();
  }
}

function execute(databasePath: string, sql: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

test("closes successfully on each of ten immediate startup close requests", async () => {
  test.setTimeout(60_000);
  const failures: number[] = [];
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-close-ready-"));
    const { application } = await launch(userDataDir);
    if (!(await requestWindowClose(application))) failures.push(attempt);
    removeTestDirectory(userDataDir);
  }
  expect(failures).toEqual([]);
});

test("flushes a dirty profile and preserves its database hash across three restarts", async () => {
  test.setTimeout(60_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-close-restart-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(userDataDir);
    application = launched.application;
    let page = launched.page;
    await createBot(page);
    await page.getByLabel("描述").fill("关闭前未移焦也必须保存");
    expect(await requestWindowClose(application)).toBe(true);
    application = undefined;

    const expectedHash = databaseHash(databasePath);
    for (let restart = 0; restart < 3; restart += 1) {
      launched = await launch(userDataDir);
      application = launched.application;
      page = launched.page;
      await openInspector(page);
      await expect(page.getByLabel("描述")).toHaveValue("关闭前未移焦也必须保存");
      expect(databaseHash(databasePath)).toBe(expectedHash);
      expect(await requestWindowClose(application)).toBe(true);
      application = undefined;
    }
  } finally {
    if (application) await disposeTestApplication(application);
    removeTestDirectory(userDataDir);
  }
});

test("keeps the window open when a dirty profile cannot be saved, then closes after retry", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-close-failure-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(userDataDir);
    application = launched.application;
    const page = launched.page;
    await createBot(page);
    execute(
      databasePath,
      "CREATE TRIGGER reject_bot_updates BEFORE UPDATE ON bots BEGIN SELECT RAISE(ABORT, 'close test'); END;",
    );
    await page.getByLabel("描述").fill("保存失败时不能关闭");
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect(page.getByTestId("profile-save-status")).toContainText("保存失败");
    await expect(page.getByRole("button", { name: "重试保存" })).toBeVisible();
    expect(application.process().exitCode).toBeNull();

    execute(databasePath, "DROP TRIGGER reject_bot_updates;");
    await page.getByRole("button", { name: "重试保存" }).click();
    await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
    expect(await requestWindowClose(application)).toBe(true);
    application = undefined;
  } finally {
    if (application) await disposeTestApplication(application);
    removeTestDirectory(userDataDir);
  }
});

test("flushes a dirty profile through the application quit path", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-close-quit-"));
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(userDataDir);
    application = launched.application;
    let page = launched.page;
    await createBot(page);
    await page.getByLabel("描述").fill("Quit 路径也必须保存");
    expect(await requestAppQuit(application)).toBe(true);
    application = undefined;

    launched = await launch(userDataDir);
    application = launched.application;
    page = launched.page;
    await openInspector(page);
    await expect(page.getByLabel("描述")).toHaveValue("Quit 路径也必须保存");
    expect(await requestWindowClose(application)).toBe(true);
    application = undefined;
  } finally {
    if (application) await disposeTestApplication(application);
    removeTestDirectory(userDataDir);
  }
});

test("flushes a dirty profile after an embedded frame loads and is removed", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-close-frame-"));
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(userDataDir);
    application = launched.application;
    let page = launched.page;
    await createBot(page);
    await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
    await page.evaluate(async () => {
      const frame = document.createElement("iframe");
      frame.title = "Close handshake fixture";
      frame.sandbox.add("allow-scripts");
      const loaded = new Promise<void>(resolve => frame.addEventListener("load", () => resolve(), { once: true }));
      frame.srcdoc = "<!doctype html><title>Close frame fixture</title><p>Real embedded content</p>";
      document.body.append(frame);
      await loaded;
    });
    const frame = page.frameLocator('iframe[title="Close handshake fixture"]');
    await expect(frame.getByText("Real embedded content", { exact: true })).toBeVisible();
    expect(await frame.locator("body").evaluate(() => typeof (window as unknown as { aevorenBot?: unknown }).aevorenBot)).toBe("undefined");
    await page.locator('iframe[title="Close handshake fixture"]').evaluate(element => element.remove());
    expect(await page.locator('iframe[title="Close handshake fixture"]').count()).toBe(0);
    await page.getByLabel("描述").fill("嵌入内容关闭后仍需保存未移焦的修改");
    expect(await requestAppQuit(application)).toBe(true);
    application = undefined;

    launched = await launch(userDataDir);
    application = launched.application;
    page = launched.page;
    await openInspector(page);
    await expect(page.getByLabel("描述")).toHaveValue("嵌入内容关闭后仍需保存未移焦的修改");
    expect(await requestWindowClose(application)).toBe(true);
    application = undefined;
  } finally {
    if (application) await disposeTestApplication(application);
    removeTestDirectory(userDataDir);
  }
});

for (const navigation of ["same-document", "main-document"] as const) {
  test(`flushes a dirty profile after ${navigation} navigation`, async () => {
    // Windows took 22.58s through the first close; restart navigation exhausted 30s.
    if (process.platform === "win32" && navigation === "main-document") test.setTimeout(60_000);
    const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-close-navigation-"));
    let application: ElectronApplication | undefined;
    const description = `关闭前保存 ${navigation} 后的修改`;
    try {
      let launched = await launch(userDataDir);
      application = launched.application;
      let page = launched.page;
      await createBot(page);
      await expect(page.getByTestId("profile-save-status")).toContainText("已保存");
      if (navigation === "same-document") {
        await page.evaluate(() => { window.location.hash = "close-navigation-fixture"; });
        await expect(page).toHaveURL(/#close-navigation-fixture$/u);
      } else {
        await page.reload();
        await openInspector(page);
      }
      await page.getByLabel("描述").fill(description);
      expect(await requestWindowClose(application)).toBe(true);
      application = undefined;

      launched = await launch(userDataDir);
      application = launched.application;
      page = launched.page;
      await openInspector(page);
      await expect(page.getByLabel("描述")).toHaveValue(description);
      expect(await requestWindowClose(application)).toBe(true);
      application = undefined;
    } finally {
      if (application) await disposeTestApplication(application);
      removeTestDirectory(userDataDir);
    }
  });
}

test("flushes a dirty profile after a main-frame navigation is blocked", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-close-blocked-navigation-"));
  let application: ElectronApplication | undefined;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("Blocked main-frame fixture");
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing blocked-navigation fixture port");
    let launched = await launch(userDataDir);
    application = launched.application;
    let page = launched.page;
    await createBot(page);
    await page.getByLabel("描述").fill("被阻止的导航不能阻止关闭保存");
    const originalUrl = page.url();
    await application.evaluate(({ BrowserWindow }) => {
      (globalThis as typeof globalThis & { blockedCloseNavigation?: Promise<boolean> }).blockedCloseNavigation = new Promise(resolve => {
        BrowserWindow.getAllWindows()[0]!.webContents.once("will-navigate", details => resolve(details.defaultPrevented));
      });
    });
    await page.evaluate(url => {
      const link = document.createElement("a");
      link.href = url;
      document.body.append(link);
      link.click();
      link.remove();
    }, `http://127.0.0.1:${address.port}/blocked`);
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { blockedCloseNavigation?: Promise<boolean> }).blockedCloseNavigation)).toBe(true);
    expect(page.url()).toBe(originalUrl);
    expect(requests).toBe(0);
    expect(await requestWindowClose(application)).toBe(true);
    application = undefined;

    launched = await launch(userDataDir);
    application = launched.application;
    page = launched.page;
    await openInspector(page);
    await expect(page.getByLabel("描述")).toHaveValue("被阻止的导航不能阻止关闭保存");
    expect(await requestWindowClose(application)).toBe(true);
    application = undefined;
  } finally {
    if (application) await disposeTestApplication(application);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    removeTestDirectory(userDataDir);
  }
});
