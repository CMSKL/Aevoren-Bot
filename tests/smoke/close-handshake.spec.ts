import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

function environment(userDataDir: string): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...inherited, MS_BOT_USER_DATA_DIR: userDataDir, MS_BOT_FAKE_PROVIDER: "1" };
}

async function launch(userDataDir: string): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment(userDataDir) });
  return { application, page: await application.firstWindow() };
}

async function createBot(page: Page): Promise<void> {
  await page.getByRole("button", { name: "新建聊天" }).click();
  await page.getByRole("button", { name: "创建新 Bot" }).click();
}

async function requestWindowClose(application: ElectronApplication, timeoutMs = 3_000): Promise<boolean> {
  const process = application.process();
  const exited = new Promise<boolean>((resolve) => process.once("exit", () => resolve(true)));
  try {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  } catch {
    // A successful immediate close can destroy Playwright's main-process context
    // before evaluate resolves. The process exit below remains the authority.
  }
  const didExit = await Promise.race([
    exited,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!didExit) {
    process.kill("SIGKILL");
    await exited;
  }
  return didExit;
}

async function requestAppQuit(application: ElectronApplication, timeoutMs = 3_000): Promise<boolean> {
  const process = application.process();
  const exited = new Promise<boolean>((resolve) => process.once("exit", () => resolve(true)));
  await application.evaluate(({ app }) => app.quit());
  const didExit = await Promise.race([
    exited,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!didExit) {
    process.kill("SIGKILL");
    await exited;
  }
  return didExit;
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
    const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-close-ready-"));
    const { application } = await launch(userDataDir);
    if (!(await requestWindowClose(application, 1_500))) failures.push(attempt);
    rmSync(userDataDir, { recursive: true, force: true });
  }
  expect(failures).toEqual([]);
});

test("flushes a dirty profile and preserves its database hash across three restarts", async () => {
  test.setTimeout(60_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-close-restart-"));
  const databasePath = join(userDataDir, "ms-bot.sqlite");
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
      await expect(page.getByLabel("描述")).toHaveValue("关闭前未移焦也必须保存");
      expect(databaseHash(databasePath)).toBe(expectedHash);
      expect(await requestWindowClose(application)).toBe(true);
      application = undefined;
    }
  } finally {
    if (application) application.process().kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("keeps the window open when a dirty profile cannot be saved, then closes after retry", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-close-failure-"));
  const databasePath = join(userDataDir, "ms-bot.sqlite");
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
    if (application) application.process().kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("flushes a dirty profile through the application quit path", async () => {
  test.setTimeout(30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "ms-bot-close-quit-"));
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
    await expect(page.getByLabel("描述")).toHaveValue("Quit 路径也必须保存");
    expect(await requestWindowClose(application)).toBe(true);
    application = undefined;
  } finally {
    if (application) application.process().kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
