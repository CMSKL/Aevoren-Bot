import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, PromptManifest } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { removeTestDirectory } from "./test-cleanup";
import { openBotList, openInspector, openWorkspaceTab } from "./navigation";

// Browser plugin not available. Exercise the real isolated Electron/SQLite/IPC
// paths, without a fake provider or any model request. The persisted user inputs
// below are explicitly test data, not Agent-generated answers or tool evidence.
const evidenceRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();

function seed() {
  const data = mkdtempSync(join(tmpdir(), "aevoren-archive-restoration-"));
  const path = join(data, "aevoren-bot.sqlite");
  const repository = new AppRepository(path);
  try {
    // Archive verification needs no model credentials. Real absent paths keep
    // CLI scanning fail-closed without invoking the user's OAuth/Keychain CLI.
    for (const id of ["claude.default", "codex.default"]) {
      const configuration = repository.getProviderInstanceConfig(id);
      repository.updateProviderInstanceConfig(id, configuration.version, { ...configuration.config, cliPath: join(data, `not-installed-${id}`) });
    }
    const current = repository.createBot();
    repository.updateBot(current.bot.id, current.bot.version, { name: "当前对话" });
    const peer = repository.createBot();
    const project = repository.createProject("归档所属项目");
    const folder = join(data, "真实工作区");
    mkdirSync(folder);
    const registration = repository.registerWorkspaceRoot(folder, "真实工作区", project.id);
    const deliveryPath = join(folder, "保留文件.md");
    writeFileSync(deliveryPath, "# 归档验收本地文件\n恢复不得修改本文件或授权范围。\n", "utf8");
    const globalRoom = repository.createRoom({ name: "未关联归档群聊", memberBotIds: [current.bot.id, peer.bot.id] });
    const projectRoom = repository.createRoom({ name: "项目归档群聊", memberBotIds: [current.bot.id, peer.bot.id], projectId: project.id });
    const team = repository.createContentTeamTemplate();
    const rooms = [globalRoom, projectRoom, team.room];
    for (const detail of rooms) {
      const nonce = randomUUID();
      repository.prepareMessage({ sessionId: detail.session.id, clientNonce: nonce, text: `归档数据保留验收输入：${detail.room.name}` });
      repository.acknowledgeUserMessage(nonce);
      repository.setRoomUnread(detail.room.id, true);
      repository.archiveRoom(detail.room.id, true);
    }
    repository.setRoomHidden(globalRoom.room.id, true);
    repository.setSetting("appearance.theme", "light", false);
    const attachmentPath = join(data, "归档验收附件.md");
    writeFileSync(attachmentPath, "# 归档验收输入\n真实本地附件；不是模型生成结果。\n", "utf8");
    return { data, path, current, project, rooms, globalRoom, projectRoom, attachmentPath, deliveryPath, registration };
  } finally {
    repository.close();
  }
}

type Fixture = ReturnType<typeof seed>;

async function launch(fixture: Fixture, expectedHeading: string | null = "当前对话"): Promise<{ application: ElectronApplication; page: Page }> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of Object.keys(inherited)) if (key.startsWith("AEVOREN_BOT_FAKE_")) delete inherited[key];
  const application = await electron.launch({
    args: ["."], cwd: process.cwd(),
    env: { ...inherited, AEVOREN_BOT_USER_DATA_DIR: fixture.data, AEVOREN_BOT_DB_PATH: fixture.path, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_ATTACHMENT_TEST_PATHS: fixture.attachmentPath },
  });
  const page = await application.firstWindow();
  await expect(page).toHaveTitle("Aevoren Bot");
  expect(new URL(page.url()).protocol).toBe("file:");
  expect(decodeURIComponent(new URL(page.url()).pathname)).toContain("/out/renderer/index.html");
  await expect(page.locator(".app-shell")).toBeVisible();
  if (expectedHeading) await expect(page.getByRole("heading", { name: expectedHeading, exact: true })).toBeVisible();
  else await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
  return { application, page };
}

async function closeApplication(application: ElectronApplication): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      application.close(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Isolated Electron cleanup timed out")), 3_000); }),
    ]);
  } catch {
    if (application.process().exitCode === null) application.process().kill("SIGKILL");
  } finally { if (timer) clearTimeout(timer); }
}

function archiveSection(page: Page) { return page.getByRole("region", { name: "归档群聊", exact: true }); }
function archiveRow(page: Page, id: string) { return page.getByTestId(`archive-room-${id}`); }
function archiveFeedback(page: Page, id: string) { return page.getByTestId(`archive-feedback-${id}`); }

async function openArchive(page: Page, count?: number): Promise<void> {
  await openWorkspaceTab(page);
  const section = archiveSection(page);
  await expect(section).toBeVisible();
  const toggle = section.getByRole("button", { name: count === undefined ? /^已归档 \(\d+\)$/u : `已归档 (${count})`, exact: count !== undefined });
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
}

async function assertNoChatArchive(page: Page, excludeArchivedName = true): Promise<void> {
  await page.getByRole("tab", { name: "聊天", exact: true }).click();
  await expect(page.getByRole("button", { name: /^已归档/u })).toHaveCount(0);
  await expect(archiveSection(page)).toHaveCount(0);
  if (excludeArchivedName) await expect(page.locator(".sidebar-list")).not.toContainText("未关联归档群聊");
}

function execute(path: string, sql: string): void {
  const database = new DatabaseSync(path);
  try { database.exec(sql); } finally { database.close(); }
}

function inspect(path: string, sessionId: string, roomId: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      room: database.prepare("SELECT id, name, project_id, archived_at FROM rooms WHERE id = ?").get(roomId),
      conversation: database.prepare("SELECT session_id, project_id, hidden_at, has_unread, pinned_at, last_activity_at FROM conversation_metadata WHERE session_id = ?").get(sessionId),
      session: database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId),
      entries: database.prepare("SELECT * FROM transcript_entries WHERE session_id = ? ORDER BY seq").all(sessionId),
      grants: database.prepare("SELECT * FROM session_workspace_grants WHERE session_id = ? ORDER BY workspace_id").all(sessionId),
      members: database.prepare("SELECT * FROM room_members WHERE room_id = ? ORDER BY position").all(roomId),
      tools: database.prepare("SELECT * FROM tool_invocations WHERE session_id = ? ORDER BY id").all(sessionId),
      foreignKeys: database.prepare("PRAGMA foreign_key_check").all(),
    };
  } finally { database.close(); }
}

test("P0 exposes every archived Room only in the global Workspace area, independently of project folding and restart", async () => {
  const fixture = seed();
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(fixture);
    application = launched.application;
    let page = launched.page;
    await assertNoChatArchive(page);
    await openArchive(page, fixture.rooms.length);
    for (const detail of fixture.rooms) await expect(archiveRow(page, detail.room.id)).toContainText(detail.room.name);
    await expect(page.getByRole("button", { name: /^已归档/u })).toHaveCount(1);
    for (const project of await page.locator(".sidebar-project-toggle").all()) {
      if (await project.getAttribute("aria-expanded") === "true") await project.click();
    }
    for (const detail of fixture.rooms) await expect(archiveRow(page, detail.room.id)).toBeVisible();
    const projectsToggle = page.getByRole("button", { name: "项目", exact: true });
    if (await projectsToggle.getAttribute("aria-expanded") === "true") await projectsToggle.click();
    for (const detail of fixture.rooms) await expect(archiveRow(page, detail.room.id)).toBeVisible();
    await application.close();
    application = undefined;
    launched = await launch(fixture);
    application = launched.application;
    page = launched.page;
    await assertNoChatArchive(page);
    await openArchive(page, fixture.rooms.length);
    for (const detail of fixture.rooms) await expect(archiveRow(page, detail.room.id)).toBeVisible();
    expect(inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id).conversation).toMatchObject({ project_id: null });
    expect(inspect(fixture.path, fixture.projectRoom.session.id, fixture.projectRoom.room.id).conversation).toMatchObject({ project_id: fixture.project.id });
  } finally {
    if (application) await closeApplication(application);
    removeTestDirectory(fixture.data);
  }
});

test("restoring preserves the current view, draft, attachment, unread state and saved data; only explicit Open navigates through the save guard", async () => {
  test.setTimeout(60_000);
  const fixture = seed();
  const baselines = fixture.rooms.map(detail => inspect(fixture.path, detail.session.id, detail.room.id));
  const fileBefore = readFileSync(fixture.deliveryPath);
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(fixture);
    application = launched.application;
    const page = launched.page;
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.getByLabel("添加文本附件").click();
    await expect(page.getByRole("button", { name: /移除附件 归档验收附件\.md/u })).toBeVisible();
    const draft = "不要发送：恢复另一个群聊时保留本对话的草稿。";
    const description = "归档管理前必须可靠保存当前联系人编辑内容。";
    await page.getByLabel("消息", { exact: true }).fill(draft);
    const selectionBefore = await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"));
    await openArchive(page, fixture.rooms.length);
    execute(fixture.path, `
      CREATE TABLE archive_restore_audit(kind TEXT, resource_id TEXT);
      CREATE TRIGGER audit_archive_restore AFTER UPDATE OF archived_at ON rooms
      WHEN NEW.id = '${fixture.globalRoom.room.id}' BEGIN
        INSERT INTO archive_restore_audit VALUES ('archive', NEW.id);
      END;
      CREATE TRIGGER audit_archive_show AFTER UPDATE OF hidden_at ON conversation_metadata
      WHEN NEW.session_id = '${fixture.globalRoom.session.id}' BEGIN
        INSERT INTO archive_restore_audit VALUES ('show', NEW.session_id);
      END;
    `);
    for (const [index, detail] of fixture.rooms.entries()) {
      const restore = archiveRow(page, detail.room.id).getByRole("button", { name: "恢复", exact: true });
      if (index === 0) {
        // Two actual DOM events exercise the synchronous pending lock. The real
        // handlers and SQLite writes remain untouched; no response is substituted.
        await restore.evaluate(element => {
          const row = element.closest('[data-testid^="archive-room-"]')!;
          const observer = new MutationObserver(records => {
            if (records.some(record => record.attributeName === "disabled" && record.oldValue === null)) {
              document.documentElement.dataset.archivePendingObserved = "true";
              observer.disconnect();
            }
          });
          observer.observe(row, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["disabled"] });
          (element as HTMLButtonElement).click();
          (element as HTMLButtonElement).click();
        });
      } else {
        await restore.click();
      }
      await expect(archiveFeedback(page, detail.room.id)).toContainText("已恢复到聊天列表");
      await expect(archiveFeedback(page, detail.room.id).getByRole("button", { name: "打开", exact: true })).toBeEnabled();
      await expect(page.getByRole("heading", { name: "当前对话", exact: true })).toBeVisible();
      await expect(page.locator(".sidebar-workspace")).toBeVisible();
      await expect(page.getByLabel("消息", { exact: true })).toHaveValue(draft);
      await expect(page.getByRole("button", { name: /移除附件 归档验收附件\.md/u })).toBeVisible();
      expect(await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"))).toBe(selectionBefore);
      const after = inspect(fixture.path, detail.session.id, detail.room.id);
      const before = baselines[index]!;
      expect(after.room).toEqual({ ...before.room, archived_at: null });
      expect(after.conversation).toEqual({ ...before.conversation, hidden_at: null });
      expect(after.session).toEqual(before.session);
      expect(after.entries).toEqual(before.entries);
      expect(after.grants).toEqual(before.grants);
      expect(after.members).toEqual(before.members);
      expect(after.tools).toEqual(before.tools);
      expect(after.foreignKeys).toEqual([]);
      if (index === 0) {
        const image = join(evidenceRoot, "aevoren-archive-restored-feedback.png");
        await page.screenshot({ path: image });
        await test.info().attach("real-restore-feedback", { path: image, contentType: "image/png" });
      }
    }
    await expect(page.locator("html")).toHaveAttribute("data-archive-pending-observed", "true");
    expect(readFileSync(fixture.deliveryPath)).toEqual(fileBefore);
    const database = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      expect(database.prepare("SELECT kind, COUNT(*) AS count FROM archive_restore_audit GROUP BY kind ORDER BY kind").all()).toEqual([{ kind: "archive", count: 1 }, { kind: "show", count: 1 }]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM rooms WHERE archived_at IS NOT NULL").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()).toEqual({ count: 0 });
    } finally { database.close(); }
    // Success feedback stays reachable even after the last archived item leaves.
    const open = archiveFeedback(page, fixture.globalRoom.room.id).getByRole("button", { name: /^(?:打开|重新打开)$/u });
    await expect(open).toBeVisible();
    // Contact editing is now a separate page: a dirty failed profile cannot
    // physically share the archive controls. Exercise the real guard before
    // returning to archive management instead of clicking detached/hidden UI.
    await openInspector(page);
    execute(fixture.path, `CREATE TRIGGER reject_archive_open_save BEFORE UPDATE ON bots
      WHEN NEW.id = '${fixture.current.bot.id}' BEGIN SELECT RAISE(ABORT, 'archive save guard test'); END;`);
    await page.getByRole("textbox", { name: "描述", exact: true }).fill(description);
    await page.getByRole("button", { name: "发消息", exact: true }).click();
    await expect(page.getByTestId("profile-save-status")).toContainText("保存失败");
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeVisible();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "当前对话", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "描述", exact: true })).toHaveValue(description);
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(draft);
    expect(inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id).conversation).toMatchObject({ has_unread: 1 });
    execute(fixture.path, "DROP TRIGGER reject_archive_open_save;");
    await page.getByRole("button", { name: "发消息", exact: true }).click();
    await openArchive(page, 0);
    await open.click();
    await expect(page.getByRole("heading", { name: "未关联归档群聊", exact: true })).toBeVisible();
    await expect(page.locator("article.message-user")).toContainText("归档数据保留验收输入");
    expect(inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id).conversation).toMatchObject({ project_id: null, has_unread: 0 });
    const saved = new DatabaseSync(fixture.path, { readOnly: true });
    try { expect(saved.prepare("SELECT description FROM bots WHERE id = ?").get(fixture.current.bot.id)).toEqual({ description }); }
    finally { saved.close(); }
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await application.close();
    application = undefined;
    const restarted = await launch(fixture, null);
    application = restarted.application;
    await assertNoChatArchive(restarted.page, false);
    await expect(restarted.page.locator(`.bot-row[aria-label="${fixture.globalRoom.room.name}"]`)).toBeVisible();
  } finally {
    if (application) await closeApplication(application);
    removeTestDirectory(fixture.data);
  }
});

test("real SQLite archive and visibility failures keep a retry path without repeating a successful unarchive", async () => {
  const fixture = seed();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(fixture);
    application = launched.application;
    const page = launched.page;
    await openArchive(page, fixture.rooms.length);
    execute(fixture.path, `
      CREATE TABLE archive_fault_audit(room_id TEXT);
      CREATE TRIGGER audit_archive_fault AFTER UPDATE OF archived_at ON rooms
      WHEN NEW.id = '${fixture.globalRoom.room.id}' BEGIN INSERT INTO archive_fault_audit VALUES (NEW.id); END;
      CREATE TRIGGER reject_archive_restore BEFORE UPDATE OF archived_at ON rooms
      WHEN NEW.id = '${fixture.globalRoom.room.id}' AND NEW.archived_at IS NULL
      BEGIN SELECT RAISE(ABORT, 'archive restore persistence test'); END;
    `);
    await archiveRow(page, fixture.globalRoom.room.id).getByRole("button", { name: "恢复", exact: true }).click();
    const feedback = archiveFeedback(page, fixture.globalRoom.room.id);
    await expect(feedback.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    await expect(feedback).not.toContainText("已恢复到聊天列表");
    expect(inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id).room).toMatchObject({ archived_at: expect.any(String) });
    execute(fixture.path, `
      DROP TRIGGER reject_archive_restore;
      CREATE TRIGGER reject_archive_visibility BEFORE UPDATE OF hidden_at ON conversation_metadata
      WHEN NEW.session_id = '${fixture.globalRoom.session.id}'
      BEGIN SELECT RAISE(ABORT, 'archive visibility persistence test'); END;
    `);
    await feedback.getByRole("button", { name: "重试", exact: true }).click();
    await expect(feedback.getByRole("button", { name: "重试", exact: true })).toBeEnabled();
    await expect(feedback).not.toContainText("已恢复到聊天列表");
    const partial = inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id);
    await expect.poll(() => inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id).room).toMatchObject({ archived_at: null });
    await expect(feedback).toContainText("已取消归档");
    expect(partial.conversation).toMatchObject({ hidden_at: expect.any(String), has_unread: 1, project_id: null });
    execute(fixture.path, "DROP TRIGGER reject_archive_visibility;");
    await feedback.getByRole("button", { name: "重试", exact: true }).click();
    await expect(feedback).toContainText("已恢复到聊天列表");
    expect(inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id).conversation).toMatchObject({ hidden_at: null, has_unread: 1, project_id: null });
    const database = new DatabaseSync(fixture.path, { readOnly: true });
    try { expect(database.prepare("SELECT COUNT(*) AS count FROM archive_fault_audit").get()).toEqual({ count: 1 }); }
    finally { database.close(); }
    await expect(page.getByRole("heading", { name: "当前对话", exact: true })).toBeVisible();
    await expect(archiveSection(page)).not.toContainText("SqliteError");
    await expect(archiveSection(page)).not.toContainText("archive visibility persistence test");

    // A real activation write failure must not report the Room as opened.
    execute(fixture.path, `CREATE TRIGGER reject_archive_open BEFORE UPDATE OF has_unread ON conversation_metadata
      WHEN NEW.session_id = '${fixture.globalRoom.session.id}'
      BEGIN SELECT RAISE(ABORT, 'archive open persistence test'); END;`);
    await feedback.getByRole("button", { name: "打开", exact: true }).click();
    await expect(feedback).toContainText("已恢复，但暂时无法打开");
    await expect(page.getByRole("heading", { name: "当前对话", exact: true })).toBeVisible();
    expect(inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id).conversation).toMatchObject({ has_unread: 1 });
    execute(fixture.path, "DROP TRIGGER reject_archive_open;");
    await feedback.getByRole("button", { name: "重新打开", exact: true }).click();
    await expect(page.getByRole("heading", { name: "未关联归档群聊", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    const row = page.locator(`.bot-row[aria-label="${fixture.globalRoom.room.name}"]`);
    await row.click({ button: "right" });
    await page.getByRole("menu", { name: "群聊操作", exact: true }).getByRole("menuitem", { name: "标为未读", exact: true }).click();
    await row.click({ button: "right" });
    await page.getByRole("menu", { name: "群聊操作", exact: true }).getByRole("menuitem", { name: "归档群聊", exact: true }).click();
    await expect(row).toHaveCount(0);
    await openArchive(page, fixture.rooms.length);
    await expect(archiveFeedback(page, fixture.globalRoom.room.id)).toHaveCount(0);
    await archiveRow(page, fixture.globalRoom.room.id).getByRole("button", { name: "恢复", exact: true }).click();
    await expect(archiveFeedback(page, fixture.globalRoom.room.id)).toContainText("已恢复到聊天列表");
    expect(inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id).conversation).toMatchObject({ has_unread: 1, hidden_at: null });
    const repeated = new DatabaseSync(fixture.path, { readOnly: true });
    try { expect(repeated.prepare("SELECT COUNT(*) AS count FROM archive_fault_audit").get()).toEqual({ count: 3 }); }
    finally { repeated.close(); }
  } finally {
    if (application) await closeApplication(application);
    removeTestDirectory(fixture.data);
  }
});

test("global archive controls remain usable in both themes and 1180/1020/620/390px windows", async () => {
  test.setTimeout(60_000);
  const fixture = seed();
  const screenshots = mkdtempSync(join(evidenceRoot, "aevoren-archive-layout-"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(fixture);
    application = launched.application;
    const page = launched.page;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    for (const theme of ["light", "dark"] as const) {
      const closeSidebar = page.locator(".sidebar.mobile-open .drawer-close-button");
      if (await closeSidebar.isVisible()) await closeSidebar.click();
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 844));
      await openBotList(page);
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "通用", exact: true }).click();
      await page.getByRole("group", { name: "外观主题", exact: true }).getByRole("button", { name: theme === "dark" ? /^暗黑/u : /^白昼/u }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
      for (const width of [1180, 1020, 620, 390]) {
        await application.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0]?.setContentSize(next, 844), width);
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
        await openArchive(page, fixture.rooms.length);
        for (const detail of fixture.rooms) {
          const row = archiveRow(page, detail.room.id);
          await row.scrollIntoViewIfNeeded();
          const button = row.getByRole("button", { name: "恢复", exact: true });
          await expect(button).toBeVisible();
          await button.click({ trial: true });
          expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
          const bounds = await button.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        }
        await page.locator(".sidebar").screenshot({ path: join(screenshots, `${theme}-${width}.png`) });
        const ipc = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.rooms.list({ includeArchived: true }));
        expect(ipc.ok && ipc.data.filter(room => room.archivedAt !== null).length).toBe(fixture.rooms.length);
      }
    }
    expect(errors).toEqual([]);
    await test.info().attach("archive-layout-evidence-directory", { body: Buffer.from(screenshots), contentType: "text/plain" });
  } finally {
    if (application) await closeApplication(application);
    removeTestDirectory(fixture.data);
  }
});

test("a real list-sync schema failure retries only synchronization after unarchive and show have committed", async () => {
  const fixture = seed();
  let altered = false;
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(fixture);
    application = launched.application;
    const page = launched.page;
    await openArchive(page, fixture.rooms.length);
    execute(fixture.path, `
      CREATE TABLE archive_sync_audit(kind TEXT);
      CREATE TRIGGER audit_archive_sync AFTER UPDATE OF archived_at ON rooms
      WHEN NEW.id = '${fixture.globalRoom.room.id}' BEGIN INSERT INTO archive_sync_audit VALUES ('archive'); END;
      CREATE TRIGGER audit_archive_sync_show AFTER UPDATE OF hidden_at ON conversation_metadata
      WHEN NEW.session_id = '${fixture.globalRoom.session.id}' BEGIN INSERT INTO archive_sync_audit VALUES ('show'); END;
      ALTER TABLE conversation_metadata RENAME COLUMN last_activity_at TO archive_test_activity_at;
    `);
    altered = true;
    await archiveRow(page, fixture.globalRoom.room.id).getByRole("button", { name: "恢复", exact: true }).click();
    const feedback = archiveFeedback(page, fixture.globalRoom.room.id);
    await expect(feedback).toContainText("列表同步未完成");
    await expect(feedback.getByRole("button", { name: "重试", exact: true })).toBeEnabled();
    await expect(feedback).not.toContainText("已恢复到聊天列表");
    // The renamed column deliberately makes a full summary query fail. Inspect
    // the committed visibility and unread columns directly, without a substitute
    // IPC response or fabricated success state.
    const database = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      expect(database.prepare("SELECT archived_at FROM rooms WHERE id = ?").get(fixture.globalRoom.room.id)).toEqual({ archived_at: null });
      expect(database.prepare("SELECT hidden_at, has_unread FROM conversation_metadata WHERE session_id = ?").get(fixture.globalRoom.session.id)).toEqual({ hidden_at: null, has_unread: 1 });
    }
    finally { database.close(); }
    execute(fixture.path, "ALTER TABLE conversation_metadata RENAME COLUMN archive_test_activity_at TO last_activity_at;");
    altered = false;
    await feedback.getByRole("button", { name: "重试", exact: true }).click();
    await expect(feedback).toContainText("已恢复到聊天列表");
    const audited = new DatabaseSync(fixture.path, { readOnly: true });
    try { expect(audited.prepare("SELECT kind, COUNT(*) AS count FROM archive_sync_audit GROUP BY kind ORDER BY kind").all()).toEqual([{ kind: "archive", count: 1 }, { kind: "show", count: 1 }]); }
    finally { audited.close(); }
    await expect(page.getByRole("heading", { name: "当前对话", exact: true })).toBeVisible();
    expect(inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id).conversation).toMatchObject({ project_id: null, has_unread: 1, hidden_at: null });
  } finally {
    if (altered) execute(fixture.path, "ALTER TABLE conversation_metadata RENAME COLUMN archive_test_activity_at TO last_activity_at;");
    if (application) await closeApplication(application);
    removeTestDirectory(fixture.data);
  }
});

test("a real SQLite writer lock does not discard editing or change the user's view and remains retryable", async () => {
  const fixture = seed();
  let application: ElectronApplication | undefined;
  let locker: DatabaseSync | undefined;
  let locked = false;
  try {
    const launched = await launch(fixture);
    application = launched.application;
    const page = launched.page;
    await openArchive(page, fixture.rooms.length);
    execute(fixture.path, `
      CREATE TABLE archive_lock_audit(kind TEXT);
      CREATE TRIGGER audit_archive_lock AFTER UPDATE OF archived_at ON rooms
      WHEN NEW.id = '${fixture.globalRoom.room.id}' BEGIN INSERT INTO archive_lock_audit VALUES ('archive'); END;
      CREATE TRIGGER audit_archive_lock_show AFTER UPDATE OF hidden_at ON conversation_metadata
      WHEN NEW.session_id = '${fixture.globalRoom.session.id}' BEGIN INSERT INTO archive_lock_audit VALUES ('show'); END;
    `);
    locker = new DatabaseSync(fixture.path);
    locker.exec("BEGIN IMMEDIATE");
    locked = true;
    await archiveRow(page, fixture.globalRoom.room.id).getByRole("button", { name: "恢复", exact: true }).click();
    const draft = "数据库暂忙期间仍可编辑，不得被后台恢复清掉。";
    await page.getByLabel("消息", { exact: true }).fill(draft);
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    await expect(page.getByRole("tab", { name: "聊天", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "当前对话", exact: true })).toBeVisible();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(draft);
    locker.exec("COMMIT");
    locked = false;
    locker.close();
    locker = undefined;
    await openArchive(page);
    const feedback = archiveFeedback(page, fixture.globalRoom.room.id);
    // With SQLite's default zero busy timeout the real request may fail before
    // navigation; environments with a longer timeout can instead finish after
    // COMMIT. Neither outcome is a simulated delay or fabricated success.
    await expect(feedback).not.toContainText("正在恢复");
    const retry = feedback.getByRole("button", { name: "重试", exact: true });
    if (await retry.isVisible()) await retry.click();
    await expect(feedback).toContainText("已恢复到聊天列表");
    await expect(page.getByRole("heading", { name: "当前对话", exact: true })).toBeVisible();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(draft);
    const database = new DatabaseSync(fixture.path, { readOnly: true });
    try { expect(database.prepare("SELECT kind, COUNT(*) AS count FROM archive_lock_audit GROUP BY kind ORDER BY kind").all()).toEqual([{ kind: "archive", count: 1 }, { kind: "show", count: 1 }]); }
    finally { database.close(); }
    expect(inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id).conversation).toMatchObject({ hidden_at: null, has_unread: 1 });
  } finally {
    if (locker) {
      if (locked) locker.exec("ROLLBACK");
      locker.close();
    }
    if (application) await closeApplication(application);
    removeTestDirectory(fixture.data);
  }
});

test("real detached and legacy Rooms remain recoverable, and a corrupt historical snapshot does not mark unread or replace the current conversation", async () => {
  test.setTimeout(60_000);
  const fixture = seed();
  const repository = new AppRepository(fixture.path);
  const legacy = repository.createRoom({ name: "旧版无会话元数据群聊", memberBotIds: fixture.globalRoom.members.map(member => member.botId) });
  repository.archiveRoom(legacy.room.id, true);
  repository.close();
  const database = new DatabaseSync(fixture.path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.prepare("DELETE FROM sessions WHERE id = ?").run(legacy.session.id);
    expect(database.prepare("SELECT COUNT(*) AS count FROM conversation_metadata WHERE session_id = ?").get(legacy.session.id)).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM rooms WHERE id = ? AND archived_at IS NOT NULL").get(legacy.room.id)).toEqual({ count: 1 });
  } finally { database.close(); }
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(fixture);
    application = launched.application;
    const page = launched.page;
    const detached = await page.evaluate(async sessionId => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const summaries = await api.conversations.list();
      if (!summaries.ok) throw new Error(summaries.error.safeMessage);
      const summary = summaries.data.find(item => item.sessionId === sessionId);
      if (!summary) throw new Error("The real Room conversation was not loaded");
      return api.conversations.setProject({ sessionId, projectId: null, expectedVersion: summary.version });
    }, fixture.projectRoom.session.id);
    expect(detached).toMatchObject({ ok: true, data: { projectId: null, workspaceIds: [] } });
    const scopeBefore = inspect(fixture.path, fixture.projectRoom.session.id, fixture.projectRoom.room.id);
    expect(scopeBefore.grants).toEqual([]);
    await page.reload();
    await openArchive(page, fixture.rooms.length + 1);
    await expect(archiveRow(page, legacy.room.id)).toBeVisible();
    await expect(archiveRow(page, fixture.projectRoom.room.id)).toBeVisible();
    await archiveRow(page, legacy.room.id).getByRole("button", { name: "恢复", exact: true }).click();
    await expect(archiveFeedback(page, legacy.room.id)).toContainText("已恢复到聊天列表");
    const restoredLegacy = await page.evaluate(id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.rooms.get(id), legacy.room.id);
    expect(restoredLegacy.ok).toBe(true);
    if (!restoredLegacy.ok) throw new Error(restoredLegacy.error.safeMessage);
    expect(restoredLegacy.data.room.id).toBe(legacy.room.id);
    expect(restoredLegacy.data.members.map(member => member.botId)).toEqual(legacy.members.map(member => member.botId));
    expect(inspect(fixture.path, restoredLegacy.data.session.id, legacy.room.id).conversation).toMatchObject({ project_id: null, hidden_at: null });
    await archiveRow(page, fixture.projectRoom.room.id).getByRole("button", { name: "恢复", exact: true }).click();
    await expect(archiveFeedback(page, fixture.projectRoom.room.id)).toContainText("已恢复到聊天列表");
    const scopeAfter = inspect(fixture.path, fixture.projectRoom.session.id, fixture.projectRoom.room.id);
    expect(scopeAfter.grants).toEqual([]);
    expect(scopeAfter.conversation).toEqual({ ...scopeBefore.conversation, hidden_at: null });
    expect(scopeAfter.session).toEqual(scopeBefore.session);
    expect(scopeAfter.entries).toEqual(scopeBefore.entries);

    // Create and cancel a real repository record without invoking any model.
    // This is loading/fault test data, not a successful Agent execution receipt.
    const history = new AppRepository(fixture.path);
    let runtimeId: string;
    let originalManifest: string;
    try {
      const input = history.getLatestUserMessage(fixture.projectRoom.session.id)!;
      if (!input.clientNonce) throw new Error("Missing persisted user input nonce");
      const executor = history.getBot(fixture.current.bot.id);
      const manifest: PromptManifest = {
        schemaVersion: 4, botId: executor.id, profileVersion: executor.version,
        sessionId: fixture.projectRoom.session.id, generation: input.generation,
        inputSeq: input.seq, promptCutoffSeq: input.seq, roomId: fixture.projectRoom.room.id,
        executorBotId: executor.id, blocks: [], digest: "archive-loader-test-no-model-invocation",
      };
      const run = history.createRuntimeRun(input.clientNonce, "openai-compatible", manifest, { executorBotId: executor.id });
      history.transitionRuntimeRun(run.id, "cancel-requested");
      history.transitionRuntimeRun(run.id, "cancelled");
      runtimeId = run.id;
      originalManifest = JSON.stringify(manifest);
    } finally { history.close(); }
    const damaged = new DatabaseSync(fixture.path);
    try { damaged.prepare("UPDATE runtime_runs SET prompt_manifest_json = ? WHERE id = ?").run("not-valid-json", runtimeId); }
    finally { damaged.close(); }
    const snapshotFailure = await page.evaluate(id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.getSnapshot(id), fixture.projectRoom.room.id);
    expect(snapshotFailure).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    const draft = "快照加载失败时不得替换当前对话或清掉草稿。";
    await page.getByLabel("消息", { exact: true }).fill(draft);
    const selection = await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"));
    const feedback = archiveFeedback(page, fixture.projectRoom.room.id);
    await feedback.getByRole("button", { name: "打开", exact: true }).click();
    await expect(feedback).toContainText("已恢复，但暂时无法打开");
    await expect(page.getByRole("heading", { name: "当前对话", exact: true })).toBeVisible();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(draft);
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("aevoren-bot:selected"))).toBe(selection);
    expect(inspect(fixture.path, fixture.projectRoom.session.id, fixture.projectRoom.room.id).conversation).toMatchObject({ has_unread: 1 });
    const repaired = new DatabaseSync(fixture.path);
    try { repaired.prepare("UPDATE runtime_runs SET prompt_manifest_json = ? WHERE id = ?").run(originalManifest, runtimeId); }
    finally { repaired.close(); }
    await feedback.getByRole("button", { name: "重新打开", exact: true }).click();
    await expect(page.getByRole("heading", { name: fixture.projectRoom.room.name, exact: true })).toBeVisible();
    expect(inspect(fixture.path, fixture.projectRoom.session.id, fixture.projectRoom.room.id).conversation).toMatchObject({ has_unread: 0, project_id: null });
    expect(inspect(fixture.path, fixture.projectRoom.session.id, fixture.projectRoom.room.id).grants).toEqual([]);
  } finally {
    if (application) await closeApplication(application);
    removeTestDirectory(fixture.data);
  }
});

test("different Rooms restore concurrently without false sync failures and later hide/delete clear stale Open feedback", async () => {
  const fixture = seed();
  const fileBefore = readFileSync(fixture.deliveryPath);
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(fixture);
    application = launched.application;
    const page = launched.page;
    await page.getByLabel("消息", { exact: true }).fill("两个后台恢复不得切换当前会话。");
    await openArchive(page, fixture.rooms.length);
    const ids = [fixture.globalRoom.room.id, fixture.projectRoom.room.id];
    execute(fixture.path, `
      CREATE TABLE archive_parallel_audit(kind TEXT, resource_id TEXT);
      CREATE TRIGGER audit_archive_parallel AFTER UPDATE OF archived_at ON rooms
      WHEN NEW.id IN ('${ids[0]}', '${ids[1]}') BEGIN INSERT INTO archive_parallel_audit VALUES ('archive', NEW.id); END;
      CREATE TRIGGER audit_archive_parallel_show AFTER UPDATE OF hidden_at ON conversation_metadata
      WHEN NEW.session_id IN ('${fixture.globalRoom.session.id}', '${fixture.projectRoom.session.id}')
      BEGIN INSERT INTO archive_parallel_audit VALUES ('show', NEW.session_id); END;
    `);
    await page.evaluate(roomIds => {
      const buttons = roomIds.map(id => document.querySelector<HTMLButtonElement>(`[data-testid="archive-room-${id}"] button`));
      if (buttons.some(button => !button)) throw new Error("Missing real restoration button");
      buttons.forEach(button => button!.click());
    }, ids);
    for (const id of ids) {
      await expect(archiveFeedback(page, id)).toContainText("已恢复到聊天列表");
      await expect(archiveFeedback(page, id).getByRole("button", { name: "打开", exact: true })).toBeEnabled();
    }
    await expect(archiveSection(page)).not.toContainText("列表同步未完成");
    await expect(page.getByRole("heading", { name: "当前对话", exact: true })).toBeVisible();
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue("两个后台恢复不得切换当前会话。");
    const audit = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      const writes = audit.prepare("SELECT kind, resource_id, COUNT(*) AS count FROM archive_parallel_audit GROUP BY kind, resource_id").all();
      expect(writes).toHaveLength(4);
      expect(writes.every(row => row.count === 1)).toBe(true);
    } finally { audit.close(); }
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    const globalRow = page.locator(`.bot-row[aria-label="${fixture.globalRoom.room.name}"]`);
    await globalRow.click({ button: "right" });
    await page.getByRole("menu", { name: "群聊操作", exact: true }).getByRole("menuitem", { name: "移除聊天", exact: true }).click();
    await expect(globalRow).toHaveCount(0);
    await openArchive(page, 1);
    await expect(archiveFeedback(page, fixture.globalRoom.room.id)).toHaveCount(0);
    await expect(archiveFeedback(page, fixture.projectRoom.room.id)).toBeVisible();
    const projectRow = page.locator(`.bot-row[aria-label="${fixture.projectRoom.room.name}"]`);
    await projectRow.click({ button: "right" });
    await page.getByRole("menu", { name: "群聊操作", exact: true }).getByRole("menuitem", { name: "删除群聊", exact: true }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText("群聊中的 Bot 不会被删除");
    await confirmation.getByRole("button", { name: "删除", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(archiveFeedback(page, fixture.projectRoom.room.id)).toHaveCount(0);
    const checked = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      expect(checked.prepare("SELECT COUNT(*) AS count FROM rooms WHERE id = ?").get(fixture.projectRoom.room.id)).toEqual({ count: 0 });
      expect(checked.prepare("SELECT COUNT(*) AS count FROM bots WHERE deleted_at IS NULL AND id IN (?, ?)").get(fixture.current.bot.id, fixture.globalRoom.members[1]!.botId)).toEqual({ count: 2 });
      expect(checked.prepare("SELECT hidden_at FROM conversation_metadata WHERE session_id = ?").get(fixture.globalRoom.session.id)).toMatchObject({ hidden_at: expect.any(String) });
      expect(checked.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { checked.close(); }
    expect(readFileSync(fixture.deliveryPath)).toEqual(fileBefore);
  } finally {
    if (application) await closeApplication(application);
    removeTestDirectory(fixture.data);
  }
});

test("actual member deletion between unarchive and show rearchives the Room without resurrecting completion feedback", async () => {
  const fixture = seed();
  const before = inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id);
  const fileBefore = readFileSync(fixture.deliveryPath);
  const peerId = fixture.globalRoom.members.find(member => member.botId !== fixture.current.bot.id)!.botId;
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(fixture);
    application = launched.application;
    const page = launched.page;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await openArchive(page, fixture.rooms.length);
    execute(fixture.path, `
      CREATE TABLE archive_member_race_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, member_count INTEGER, archived_at TEXT);
      CREATE TRIGGER audit_archive_member_race AFTER UPDATE OF archived_at ON rooms
      WHEN NEW.id = '${fixture.globalRoom.room.id}' BEGIN
        INSERT INTO archive_member_race_audit(kind, member_count, archived_at)
        VALUES (CASE WHEN NEW.archived_at IS NULL THEN 'unarchive' ELSE 'automatic-archive' END,
                (SELECT COUNT(*) FROM room_members WHERE room_id = NEW.id), NEW.archived_at);
      END;
      CREATE TRIGGER audit_archive_member_race_show AFTER UPDATE OF hidden_at ON conversation_metadata
      WHEN NEW.session_id = '${fixture.globalRoom.session.id}' BEGIN
        INSERT INTO archive_member_race_audit(kind, member_count, archived_at)
        SELECT 'show', (SELECT COUNT(*) FROM room_members WHERE room_id = '${fixture.globalRoom.room.id}'), archived_at
        FROM rooms WHERE id = '${fixture.globalRoom.room.id}';
      END;
    `);
    const restore = archiveRow(page, fixture.globalRoom.room.id).getByRole("button", { name: "恢复", exact: true });
    // Send both real operations from one renderer task: the button's real
    // unarchive request is queued first, then a real member deletion. No IPC
    // handler, response, scheduling delay or database result is substituted.
    const deletion = await restore.evaluate(async (element, id) => {
      (element as HTMLButtonElement).click();
      return (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.bots.delete(id);
    }, peerId);
    expect(deletion).toMatchObject({ ok: true, data: { id: peerId, archivedRoomIds: expect.arrayContaining([fixture.globalRoom.room.id]) } });
    await expect.poll(() => {
      const database = new DatabaseSync(fixture.path, { readOnly: true });
      try { return database.prepare("SELECT COUNT(*) AS count FROM archive_member_race_audit").get()!.count; }
      finally { database.close(); }
    }).toBe(3);
    const database = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      expect(database.prepare("SELECT kind, member_count, archived_at FROM archive_member_race_audit ORDER BY seq").all()).toEqual([
        { kind: "unarchive", member_count: 2, archived_at: null },
        { kind: "automatic-archive", member_count: 1, archived_at: expect.any(String) },
        { kind: "show", member_count: 1, archived_at: expect.any(String) },
      ]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM bots WHERE id = ? AND deleted_at IS NULL").get(peerId)).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_members WHERE room_id = ?").get(fixture.globalRoom.room.id)).toEqual({ count: 1 });
    } finally { database.close(); }
    await expect(archiveRow(page, fixture.globalRoom.room.id)).toBeVisible();
    await expect(archiveFeedback(page, fixture.globalRoom.room.id)).toHaveCount(0);
    await expect(archiveSection(page)).not.toContainText("已恢复到聊天列表");
    await expect(page.getByRole("heading", { name: "当前对话", exact: true })).toBeVisible();
    const after = inspect(fixture.path, fixture.globalRoom.session.id, fixture.globalRoom.room.id);
    expect(after.room).toMatchObject({ id: fixture.globalRoom.room.id, archived_at: expect.any(String) });
    expect(after.session).toEqual(before.session);
    expect(after.entries).toEqual(before.entries);
    expect(after.grants).toEqual(before.grants);
    expect(after.tools).toEqual(before.tools);
    expect(after.foreignKeys).toEqual([]);
    expect(readFileSync(fixture.deliveryPath)).toEqual(fileBefore);
    expect(errors).toEqual([]);
  } finally {
    if (application) await closeApplication(application);
    removeTestDirectory(fixture.data);
  }
});
