import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { openBotList, openConversationFiles, openConversationMenu } from "./navigation";
import { removeTestDirectory } from "./test-cleanup";

// Current-run UI verification only: real isolated SQLite, files and production
// IPC. The history replay copies actual CLI evidence; it sends no new requests,
// enables no Fake Provider and makes no fresh business-execution claim.
const widths = [1180, 1020, 620, 390];
const themes = ["dark", "light"] as const;
const evidenceBase = process.platform === "darwin" ? "/private/tmp" : tmpdir();

async function launch(data: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of Object.keys(env)) if (key.startsWith("AEVOREN_BOT_FAKE_")) delete env[key];
  delete env.AEVOREN_BOT_DB_PATH;
  Object.assign(env, { AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE: "1" });
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env });
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await expect(page).toHaveTitle("Aevoren Bot");
  expect(new URL(page.url()).protocol).toBe("file:");
  expect(decodeURIComponent(new URL(page.url()).pathname)).toContain("/out/renderer/index.html");
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
  return { application, page, errors };
}

async function close(application: ElectronApplication): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([application.close(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Hidden Electron close timed out")), 3_000); })]);
  } catch { if (application.process().exitCode === null) application.process().kill("SIGKILL"); }
  finally { if (timer) clearTimeout(timer); }
}

async function configureViewport(application: ElectronApplication, page: Page, width: number, theme: typeof themes[number]): Promise<void> {
  await application.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    if (window.getMinimumSize()[0] !== 390) throw new Error("Application minimum width changed; review this acceptance matrix");
    window.setContentSize(size, size === 390 ? 640 : 800);
  }, width);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  const result = await page.evaluate(async value => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.settings.saveGeneral({ theme: value }), theme);
  expect(result.ok).toBe(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator(".app-shell")).toBeVisible();
}

async function checkSurface(page: Page, surface: Locator): Promise<void> {
  await expect(surface).toBeVisible();
  const bounds = await surface.evaluate(element => {
    const root = element as HTMLElement;
    const rect = root.getBoundingClientRect();
    const outside = [...root.querySelectorAll<HTMLElement>("button,input,select,summary")]
      .filter(control => control.getClientRects().length > 0)
      .filter(control => {
        const r = control.getBoundingClientRect();
        return r.left < rect.left - 1 || r.right > rect.right + 1;
      }).map(control => control.getAttribute("aria-label") || control.textContent?.trim() || control.tagName);
    return { left: rect.left, right: rect.right, viewport: window.innerWidth, overflow: root.scrollWidth - root.clientWidth, outside,
      pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
  expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.viewport + 1);
  expect(bounds.overflow).toBeLessThanOrEqual(1);
  expect(bounds.outside).toEqual([]);
}

async function capture(application: ElectronApplication, page: Page, path: string): Promise<void> {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  const result = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    if (window.isVisible()) throw new Error("Acceptance must never show or focus the application");
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    return { empty: image.isEmpty(), png: image.toPNG().toString("base64") };
  });
  expect(result.empty).toBe(false);
  writeFileSync(path, Buffer.from(result.png, "base64"));
}

async function manageCurrentFolder(page: Page): Promise<Locator> {
  await openConversationFiles(page);
  await page.locator(".task-details-shelf").getByRole("button", { name: "管理文件夹", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "工作区权限", exact: true });
  await expect(manager).toBeVisible();
  return manager;
}

async function selectChat(page: Page, name: string): Promise<void> {
  await openBotList(page);
  await page.locator(`.sidebar .bot-row[aria-label="${name}"]`).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.locator(".sidebar.mobile-open")).toBeHidden();
}

test("UX-01 current folder, missing grant and keyboard controls remain reachable in both themes at all supported widths", async () => {
  test.setTimeout(180_000);
  const data = mkdtempSync(join(tmpdir(), "aevoren-ux-responsive-folders-"));
  const evidence = mkdtempSync(join(evidenceBase, "aevoren-ux-responsive-folders-evidence-"));
  const path = join(data, "aevoren-bot.sqlite");
  const root = join(data, "实际验收工作区");
  mkdirSync(root);
  copyFileSync(join(process.cwd(), "LICENSE"), join(root, "LICENSE.md"));
  const repository = new AppRepository(path);
  const registered = await new WorkspaceService(repository).registerRoot(root);
  const bound = repository.createBot(registered.project.id);
  repository.updateBot(bound.bot.id, bound.bot.version, { name: "已绑定文件助手" });
  const unbound = repository.createBot();
  repository.updateBot(unbound.bot.id, unbound.bot.version, { name: "未绑定文件助手" });
  repository.setSetting("memory.capture.enabled", "false", false);
  repository.close();
  const modeMetrics: Array<{ theme: string; width: number; label: string; actualWidth: number; requiredWidth: number }> = [];
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(data); application = launched.application;
    const { page, errors } = launched;
    for (const theme of themes) for (const width of widths) {
      await configureViewport(application, page, width, theme);
      await selectChat(page, "已绑定文件助手");
      const manager = await manageCurrentFolder(page);
      await expect(manager.locator(".workspace-row strong")).toHaveText(registered.workspace.name);
      await checkSurface(page, manager);
      const write = manager.getByLabel("允许 Bot 新建 Markdown/CSV", { exact: true });
      await write.focus(); await page.keyboard.press("Space");
      await expect(write).toBeChecked();
      await expect.poll(() => {
        const db = new DatabaseSync(path, { readOnly: true });
        try { return db.prepare("SELECT write_enabled FROM workspaces WHERE id = ?").get(registered.workspace.id)?.write_enabled; }
        finally { db.close(); }
      }).toBe(1);
      await capture(application, page, join(evidence, `${theme}-${width}-bound.png`));
      await expect(write).toBeEnabled();
      await write.focus(); await page.keyboard.press("Space"); await expect(write).not.toBeChecked();
      await expect(manager.getByRole("button", { name: "完成", exact: true })).toBeEnabled();
      await manager.getByRole("button", { name: "完成", exact: true }).focus(); await page.keyboard.press("Enter");
      await expect(manager).toBeHidden();
      await selectChat(page, "未绑定文件助手");
      const missing = await manageCurrentFolder(page);
      await expect(missing).toContainText("当前聊天未关联工作区");
      await checkSurface(page, missing);
      await capture(application, page, join(evidence, `${theme}-${width}-unbound.png`));
      await missing.getByRole("button", { name: "打开聊天设置", exact: true }).click();
      await expect(page.locator(".inspector")).toBeVisible();
      await expect(page.getByLabel("当前聊天工作区", { exact: true })).toHaveValue("");
      await checkSurface(page, page.locator(".inspector"));
      await page.keyboard.press("Escape"); await expect(page.locator(".inspector")).toBeHidden();
      await openBotList(page);
      await page.getByRole("button", { name: "新建聊天", exact: true }).click();
      const chooser = page.getByRole("dialog", { name: "新建聊天", exact: true });
      await chooser.getByRole("button", { name: /创建群聊/u }).click();
      await chooser.getByRole("button", { name: "已绑定文件助手", exact: true }).click();
      await chooser.getByRole("button", { name: "未绑定文件助手", exact: true }).click();
      const lead = chooser.getByLabel("新群协调者", { exact: true });
      await expect(lead).toBeEnabled(); await expect(lead).toHaveValue("none");
      await expect(lead.locator("option[value=default]")).toHaveAttribute("disabled", "");
      await expect(chooser).toContainText("当前成员没有可用的自动接力能力");
      await checkSurface(page, chooser);
      await capture(application, page, join(evidence, `${theme}-${width}-group-choice.png`));
      const before = await page.evaluate(async () => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.rooms.list({ includeArchived: true }));
      if (!before.ok) throw new Error(before.error.safeMessage);
      await chooser.getByRole("button", { name: "创建群聊", exact: true }).click();
      await expect(chooser).toBeHidden(); await expect(page.locator(".sidebar.mobile-open")).toBeHidden();
      const after = await page.evaluate(async () => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.rooms.list({ includeArchived: true }));
      if (!after.ok) throw new Error(after.error.safeMessage);
      const created = after.data.filter(room => !before.data.some(previous => previous.id === room.id));
      expect(created).toHaveLength(1); expect(created[0]!.leadBotId).toBeNull();
      await expect(page.getByRole("heading", { name: created[0]!.name, exact: true })).toBeVisible();
      const mode = page.getByLabel("群聊默认响应方式", { exact: true });
      await expect(mode.locator("option[value=automatic]")).toHaveText("自动 · 单人");
      const metrics = await mode.evaluate(element => {
        const select = element as HTMLSelectElement;
        const label = select.selectedOptions[0]!.text;
        const style = getComputedStyle(select);
        const context = document.createElement("canvas").getContext("2d");
        if (!context) throw new Error("Text measurement canvas is unavailable");
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const textWidth = context.measureText(label).width + (Number.parseFloat(style.letterSpacing) || 0) * (label.length - 1);
        const requiredWidth = textWidth + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight) + 16 + 4; // Native arrow plus text clearance; the previous 76px compact limit fails this check.
        const rect = select.getBoundingClientRect();
        const mention = select.closest(".composer-toolbar")?.querySelector(".composer-mention-button")?.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { label, actualWidth: rect.width, requiredWidth, mentionRight: mention?.right, left: rect.left, hit: hit === select || select.contains(hit) };
      });
      expect(metrics.label).toBe("自动 · 单人");
      expect(metrics.actualWidth).toBeGreaterThanOrEqual(metrics.requiredWidth);
      if (metrics.mentionRight !== undefined) expect(metrics.left).toBeGreaterThanOrEqual(metrics.mentionRight);
      expect(metrics.hit).toBe(true);
      modeMetrics.push({ theme, width, label: metrics.label, actualWidth: metrics.actualWidth, requiredWidth: metrics.requiredWidth });
      await checkSurface(page, page.locator(".composer"));
      await capture(application, page, join(evidence, `${theme}-${width}-group-empty.png`));
    }
    expect(errors).toEqual([]);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM session_workspace_grants WHERE session_id = ?").get(unbound.session.id)?.count).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_runs").get()?.count).toBe(0);
    } finally { db.close(); }
    writeFileSync(join(evidence, "observations.json"), JSON.stringify({ widths, themes, screenshots: 32, modeMetrics, consoleErrors: errors, noModelRequests: true }, null, 2));
    console.log(`UX-01 responsive evidence: ${evidence}`);
  } finally {
    if (application) await close(application);
    removeTestDirectory(data);
  }
});

test("UX-02 genuine recovered CLI results and preserved failure history remain accessible without new model calls", async () => {
  test.setTimeout(180_000);
  const sourcePath = process.env.AEVOREN_UX_REAL_HISTORY_DB;
  test.skip(!sourcePath || !existsSync(sourcePath), "requires AEVOREN_UX_REAL_HISTORY_DB with genuine CLI history; history UI remains unverified");
  if (!sourcePath) return;
  const data = mkdtempSync(join(tmpdir(), "aevoren-ux-responsive-history-"));
  const evidence = mkdtempSync(join(evidenceBase, "aevoren-ux-responsive-history-evidence-"));
  const path = join(data, "aevoren-bot.sqlite");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let application: ElectronApplication | undefined;
  try {
    const runs = source.prepare("SELECT * FROM runtime_runs WHERE execution_key IN (SELECT execution_key FROM runtime_runs GROUP BY execution_key HAVING SUM(state = 'failed') > 0 AND SUM(state = 'completed') > 0) ORDER BY execution_key, attempt_no").all();
    expect(source.prepare("SELECT COUNT(*) AS count FROM routines WHERE enabled = 1").get()?.count).toBe(0);
    expect(source.prepare("SELECT COUNT(*) AS count FROM runtime_runs WHERE state IN ('created','dispatching','running','streaming','cancel-requested')").get()?.count).toBe(0);
    const completed = runs.find(run => run.state === "completed" && run.route === "codex-cli" && run.provider_request_id);
    if (!completed) throw new Error("No genuine failed/completed Codex retry evidence; acceptance is unverified");
    const sessionId = String(completed.session_id);
    const name = source.prepare("SELECT bots.name FROM sessions JOIN bots ON bots.id = sessions.bot_id WHERE sessions.id = ?").get(sessionId)?.name;
    if (typeof name !== "string") throw new Error("Missing original conversation owner");
    const proof = source.prepare("SELECT result_metadata_json FROM tool_invocations WHERE runtime_run_id = ? AND tool_kind = 'workspace-write' AND state = 'succeeded'").get(String(completed.id));
    if (!proof) throw new Error("No real saved-file journal evidence");
    const metadata = JSON.parse(String(proof.result_metadata_json));
    const sourceRoot = source.prepare("SELECT w.canonical_root FROM workspaces w JOIN tool_invocations t ON t.workspace_id = w.id WHERE t.runtime_run_id = ? AND t.tool_kind = 'workspace-write' AND t.state = 'succeeded'").get(String(completed.id))?.canonical_root;
    if (typeof sourceRoot !== "string") throw new Error("Missing verified output root");
    const bytes = readFileSync(join(sourceRoot, metadata.path));
    expect(bytes.byteLength).toBe(metadata.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(metadata.sha256);
    await backup(source, path);
    const isolated = new AppRepository(path);
    isolated.setSetting("memory.capture.enabled", "false", false); isolated.close();
    const launched = await launch(data); application = launched.application;
    const { page, errors } = launched;
    for (const theme of themes) for (const width of widths) {
      await configureViewport(application, page, width, theme);
      await selectChat(page, name);
      await expect(page.locator(".run-status-card.status-error:visible")).toHaveCount(0);
      await expect(page.locator(".composer-error:visible")).toHaveCount(0);
      const result = page.locator(`article[data-runtime-run-id="${String(completed.id)}"]`);
      await result.scrollIntoViewIfNeeded(); await checkSurface(page, result);
      await expect(result.locator(".artifact-card")).toHaveCount(1);
      await capture(application, page, join(evidence, `${theme}-${width}-recovered.png`));
      const menu = await openConversationMenu(page);
      await expect(menu.getByRole("menuitem", { name: "重新生成回复", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape"); await expect(menu).toBeHidden();
      const history = page.getByTestId("direct-attempt-history");
      await expect(history).toHaveCount(1);
      const summary = history.locator("summary").first();
      await summary.scrollIntoViewIfNeeded(); await summary.focus(); await page.keyboard.press("Enter");
      await expect(history).toHaveAttribute("open", "");
      await checkSurface(page, history); await expect(history.getByRole("button", { name: "重试此步骤", exact: true })).toHaveCount(0);
      await capture(application, page, join(evidence, `${theme}-${width}-history.png`));
      await summary.focus(); await page.keyboard.press("Enter"); await expect(history).not.toHaveAttribute("open", "");
    }
    const observed = new DatabaseSync(path, { readOnly: true });
    try { expect(observed.prepare("SELECT * FROM runtime_runs WHERE execution_key = ? ORDER BY attempt_no").all(String(completed.execution_key))).toEqual(runs.filter(run => run.execution_key === completed.execution_key)); }
    finally { observed.close(); }
    expect(source.prepare("SELECT * FROM runtime_runs WHERE execution_key = ? ORDER BY attempt_no").all(String(completed.execution_key))).toEqual(runs.filter(run => run.execution_key === completed.execution_key));
    expect(errors).toEqual([]);
    writeFileSync(join(evidence, "observations.json"), JSON.stringify({ widths, themes, screenshots: 16, sourceExecutionKey: completed.execution_key, sha256: metadata.sha256, bytes: metadata.bytes, consoleErrors: errors, noNewModelRequests: true }, null, 2));
    console.log(`UX-02 responsive evidence: ${evidence}`);
  } finally {
    source.close();
    if (application) await close(application);
    removeTestDirectory(data);
  }
});
