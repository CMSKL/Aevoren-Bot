import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { removeTestDirectory } from "./test-cleanup";
import { openConversationFiles, openWorkspaceTab } from "./navigation";

// Browser plugin not available. These tests use hidden real Electron, isolated
// SQLite, actual files and unchanged IPC handlers. UI-only permission cases do
// not claim model execution; real model cases below never enable Fake Provider.
const evidenceRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();

async function fixture() {
  const data = mkdtempSync(join(tmpdir(), "aevoren-ux-review-fixes-"));
  const path = join(data, "aevoren-bot.sqlite");
  const aRoot = join(data, "UX文件夹A");
  const bRoot = join(data, "UX文件夹B");
  mkdirSync(aRoot); mkdirSync(bRoot);
  copyFileSync(join(process.cwd(), "LICENSE"), join(aRoot, "LICENSE.md"));
  copyFileSync(join(process.cwd(), "README.zh-CN.md"), join(bRoot, "产品说明.md"));
  const repository = new AppRepository(path);
  try {
    const service = new WorkspaceService(repository);
    const a = await service.registerRoot(aRoot);
    const b = await service.registerRoot(bRoot);
    const bound = repository.createBot(b.project.id);
    repository.updateBot(bound.bot.id, bound.bot.version, { name: "B文件助手" });
    const unbound = repository.createBot();
    repository.updateBot(unbound.bot.id, unbound.bot.version, { name: "未绑定助手" });
    const legacy = repository.createBot();
    repository.updateBot(legacy.bot.id, legacy.bot.version, { name: "历史多授权助手" });
    repository.setSetting("appearance.theme", "light", false);
    repository.setSetting("memory.capture.enabled", "false", false);
    // A valid legacy authorization snapshot can hold multiple explicit folder
    // grants. Seed real FK-bound rows, not a mocked permissions/IPC response.
    const database = new DatabaseSync(path);
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const insert = database.prepare("INSERT INTO session_workspace_grants(session_id, workspace_id) VALUES (?, ?)");
      insert.run(legacy.session.id, a.workspace.id);
      insert.run(legacy.session.id, b.workspace.id);
    } finally { database.close(); }
    return { data, path, aRoot, bRoot, a, b, bound, unbound, legacy };
  } finally { repository.close(); }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function launch(data: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of Object.keys(env)) if (key.startsWith("AEVOREN_BOT_FAKE_")) delete env[key];
  delete env.AEVOREN_BOT_DB_PATH;
  Object.assign(env, { AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE: "1" });
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env });
  const page = await application.firstWindow();
  await expect(page).toHaveTitle("Aevoren Bot");
  expect(new URL(page.url()).protocol).toBe("file:");
  expect(decodeURIComponent(new URL(page.url()).pathname)).toContain("/out/renderer/index.html");
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
  return { application, page };
}

async function close(application: ElectronApplication): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([application.close(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Isolated Electron close timed out")), 3_000); })]);
  } catch { if (application.process().exitCode === null) application.process().kill("SIGKILL"); }
  finally { if (timer) clearTimeout(timer); }
}

function scope(f: Fixture, sessionId: string) {
  const database = new DatabaseSync(f.path, { readOnly: true });
  try {
    return {
      project: database.prepare("SELECT project_id FROM conversation_metadata WHERE session_id = ?").get(sessionId),
      grants: database.prepare("SELECT * FROM session_workspace_grants WHERE session_id = ? ORDER BY workspace_id").all(sessionId),
    };
  } finally { database.close(); }
}

async function closeFiles(page: Page): Promise<void> {
  const close = page.getByRole("button", { name: "关闭会话成果", exact: true });
  if (await page.locator(".task-details-shelf").isVisible()) await close.last().click();
  await expect(page.locator(".task-details-shelf")).toBeHidden();
}

async function checkTarget(page: Page, name: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "工作区权限", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".workspace-row")).toHaveCount(1);
  await expect(dialog.locator(".workspace-row strong")).toHaveText(name);
}

test("UX-01 chat file management targets its granted B folder before and after managing sidebar A, without changing grants", async () => {
  const f = await fixture();
  const initial = scope(f, f.bound.session.id);
  const sourceBytes = readFileSync(join(f.bRoot, "产品说明.md"));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(f.data);
    application = launched.application;
    const page = launched.page;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await expect(page.getByRole("heading", { name: "B文件助手", exact: true })).toBeVisible();
    await openConversationFiles(page);
    await page.locator(".task-details-shelf").getByRole("button", { name: "管理文件夹", exact: true }).click();
    await checkTarget(page, f.b.workspace.name);
    await page.getByRole("dialog", { name: "工作区权限" }).getByRole("button", { name: "完成", exact: true }).click();
    await closeFiles(page);
    await openWorkspaceTab(page);
    await page.getByRole("button", { name: `管理工作区 ${f.a.workspace.name}`, exact: true }).click();
    await checkTarget(page, f.a.workspace.name);
    await page.getByRole("dialog", { name: "工作区权限" }).getByRole("button", { name: "完成", exact: true }).click();
    await page.getByRole("tab", { name: "聊天", exact: true }).click();
    await expect(page.getByRole("heading", { name: "B文件助手", exact: true })).toBeVisible();
    await openConversationFiles(page);
    await page.locator(".task-details-shelf").getByRole("button", { name: "管理文件夹", exact: true }).click();
    await checkTarget(page, f.b.workspace.name);
    const dialog = page.getByRole("dialog", { name: "工作区权限", exact: true });
    await dialog.getByLabel("允许 Bot 新建 Markdown/CSV", { exact: true }).check();
    await expect(dialog.getByLabel("允许 Bot 新建 Markdown/CSV", { exact: true })).toBeChecked();
    await expect.poll(async () => {
      const state = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.workspaces.list());
      return state.ok ? state.data.map(workspace => ({ id: workspace.id, write: workspace.writeEnabled })).sort((left, right) => left.id.localeCompare(right.id)) : null;
    }).toEqual([{ id: f.a.workspace.id, write: false }, { id: f.b.workspace.id, write: true }].sort((left, right) => left.id.localeCompare(right.id)));
    expect(scope(f, f.bound.session.id)).toEqual(initial);
    expect(readFileSync(join(f.bRoot, "产品说明.md"))).toEqual(sourceBytes);
    await page.screenshot({ path: join(evidenceRoot, "aevoren-ux01-correct-b-permission.png") });
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await closeFiles(page);
    await openWorkspaceTab(page);
    await page.getByRole("button", { name: `管理工作区 ${f.a.workspace.name}`, exact: true }).click();
    await checkTarget(page, f.a.workspace.name);
    await expect(page.getByRole("dialog", { name: "工作区权限" }).getByLabel("允许 Bot 新建 Markdown/CSV", { exact: true })).not.toBeChecked();
    expect(errors).toEqual([]);
  } finally {
    if (application) await close(application);
    removeTestDirectory(f.data);
  }
});

test("UX-01 unbound chat names the missing scope and opens the existing binding detail without silently granting a folder", async () => {
  const f = await fixture();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(f.data);
    application = launched.application;
    const page = launched.page;
    await page.locator(`.bot-row[aria-label="未绑定助手"]`).click();
    await expect(page.getByRole("heading", { name: "未绑定助手", exact: true })).toBeVisible();
    await openConversationFiles(page);
    await page.locator(".task-details-shelf").getByRole("button", { name: "管理文件夹", exact: true }).click();
    const manager = page.getByRole("dialog", { name: "工作区权限", exact: true });
    await expect(manager).toContainText("当前聊天未关联工作区");
    await expect(manager.getByLabel("当前聊天工作区", { exact: true })).toHaveValue("");
    await manager.getByLabel("当前聊天工作区", { exact: true }).click({ trial: true });
    expect(scope(f, f.unbound.session.id)).toEqual({ project: { project_id: null }, grants: [] });
    await page.screenshot({ path: join(evidenceRoot, "aevoren-ux01-unbound-chat-settings.png") });
    await manager.getByLabel("当前聊天工作区", { exact: true }).selectOption(f.b.project.id);
    await expect.poll(() => scope(f, f.unbound.session.id).grants.map(row => row.workspace_id)).toEqual([f.b.workspace.id]);
    await manager.getByRole("button", { name: "完成", exact: true }).click();
    await openConversationFiles(page);
    await page.locator(".task-details-shelf").getByRole("button", { name: "管理文件夹", exact: true }).click();
    await checkTarget(page, f.b.workspace.name);
  } finally {
    if (application) await close(application);
    removeTestDirectory(f.data);
  }
});

test("UX-01 legacy multiple grants require an explicit allowed target and never borrow the last sidebar target", async () => {
  const f = await fixture();
  const initial = scope(f, f.legacy.session.id);
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(f.data);
    application = launched.application;
    const page = launched.page;
    await page.locator(`.bot-row[aria-label="历史多授权助手"]`).click();
    await openConversationFiles(page);
    const shelf = page.locator(".task-details-shelf");
    await shelf.getByRole("button", { name: "管理文件夹", exact: true }).click();
    const manager = page.getByRole("dialog", { name: "工作区权限", exact: true });
    const target = manager.getByLabel("选择要管理的工作区", { exact: true });
    await expect(target).toBeVisible();
    await expect(target).toHaveValue("");
    await expect(manager.locator(".workspace-row")).toHaveCount(0);
    const allowed = await target.locator("option").evaluateAll(options => options.map(option => ({ value: (option as HTMLOptionElement).value, disabled: (option as HTMLOptionElement).disabled })).filter(option => option.value));
    expect(allowed.map(option => option.value).sort()).toEqual([f.a.workspace.id, f.b.workspace.id].sort());
    await target.selectOption(f.a.workspace.id);
    await checkTarget(page, f.a.workspace.name);
    await target.selectOption(f.b.workspace.id);
    await checkTarget(page, f.b.workspace.name);
    expect(scope(f, f.legacy.session.id)).toEqual(initial);
    await page.screenshot({ path: join(evidenceRoot, "aevoren-ux01-legacy-selected-b.png") });
  } finally {
    if (application) await close(application);
    removeTestDirectory(f.data);
  }
});

async function configureCodex(page: Page, botIds: string[]): Promise<void> {
  await page.evaluate(async ids => {
    const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
    const scanned = await api.providers.scan();
    if (!scanned.ok) throw new Error(scanned.error.safeMessage);
    const provider = scanned.data.find(item => item.id === "codex.default");
    if (!provider || provider.status !== "available" || !provider.authenticated || !provider.models.default || !provider.capabilities.workspaceTools) throw new Error("Real authenticated tool-capable Codex CLI is required; this flow is unverified");
    const bots = await api.bots.list();
    if (!bots.ok) throw new Error(bots.error.safeMessage);
    for (const id of ids) {
      const bot = bots.data.find(item => item.id === id);
      if (!bot) throw new Error("Missing real test Bot");
      const saved = await api.bots.update({ id, expectedVersion: bot.version, patch: { modelSelection: { providerInstanceId: provider.id, modelId: provider.models.default } } });
      if (!saved.ok) throw new Error(saved.error.safeMessage);
    }
  }, botIds);
  await page.reload();
}

async function directState(page: Page, sessionId: string) {
  return page.evaluate(async id => {
    const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
    return { snapshot: await api.runtime.getSessionSnapshot(id), tools: await api.tools.list({ sessionId: id }), approvals: await api.approvals.listPending({ sessionId: id }) };
  }, sessionId);
}

async function waitDirect(page: Page, sessionId: string, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await directState(page, sessionId);
    if (!state.snapshot.ok || !state.tools.ok || !state.approvals.ok) throw new Error("Real execution evidence could not be loaded");
    if (state.approvals.data.length > 0) {
      const allow = page.getByRole("button", { name: "仅允许一次", exact: true });
      await expect(allow).toBeVisible();
      await allow.click();
    }
    const latest = state.snapshot.data.runs.at(-1);
    if (latest && ["completed", "failed", "cancelled", "interrupted"].includes(latest.state)) return state;
    await page.waitForTimeout(300);
  }
  throw new Error("The real CLI did not settle before the acceptance deadline; unverified");
}

test("UX-02 renders a new isolated copy of genuine failed/completed audit attempts as recovered without rewriting its evidence", async () => {
  const sourcePath = process.env.AEVOREN_UX_REAL_HISTORY_DB;
  test.skip(!sourcePath || !existsSync(sourcePath), "requires AEVOREN_UX_REAL_HISTORY_DB with genuine CLI history; replay remains unverified");
  if (!sourcePath) return;
  const data = mkdtempSync(join(tmpdir(), "aevoren-ux02-replay-"));
  const path = join(data, "aevoren-bot.sqlite");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let application: ElectronApplication | undefined;
  try {
    expect(source.prepare("SELECT COUNT(*) AS count FROM routines WHERE enabled = 1").get()?.count).toBe(0);
    expect(source.prepare("SELECT COUNT(*) AS count FROM runtime_runs WHERE state IN ('created','dispatching','running','streaming','cancel-requested')").get()?.count).toBe(0);
    await backup(source, path);
    const before = source.prepare("SELECT * FROM runtime_runs WHERE execution_key IN (SELECT execution_key FROM runtime_runs GROUP BY execution_key HAVING SUM(state = 'failed') > 0 AND SUM(state = 'completed') > 0) ORDER BY execution_key, attempt_no").all();
    expect(before.length).toBeGreaterThanOrEqual(2);
    const completed = before.find(row => row.state === "completed" && row.route === "codex-cli" && row.provider_request_id);
    if (!completed) throw new Error("No genuine failed/completed Codex retry evidence; acceptance is unverified");
    const completedId = String(completed.id);
    const executionKey = String(completed.execution_key);
    const sessionId = String(completed.session_id);
    const destination = new DatabaseSync(path, { readOnly: true });
    let name: string;
    try {
      const owner = destination.prepare("SELECT bots.name FROM sessions JOIN bots ON bots.id = sessions.bot_id WHERE sessions.id = ?").get(sessionId);
      if (!owner || typeof owner.name !== "string") throw new Error("Missing original direct conversation owner");
      name = owner.name;
      const succeeded = destination.prepare("SELECT t.result_metadata_json, w.canonical_root FROM tool_invocations t JOIN workspaces w ON w.id = t.workspace_id WHERE t.runtime_run_id = ? AND t.tool_kind = 'workspace-write' AND t.state = 'succeeded'").all(completedId);
      expect(succeeded.length).toBeGreaterThan(0);
      for (const proof of succeeded) {
        const metadata = JSON.parse(String(proof.result_metadata_json));
        if (typeof proof.canonical_root !== "string") throw new Error("Missing verified output root");
        const bytes = readFileSync(join(proof.canonical_root, metadata.path));
        expect(bytes.byteLength).toBe(metadata.bytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(metadata.sha256);
      }
    } finally { destination.close(); }
    const launched = await launch(data);
    application = launched.application;
    const page = launched.page;
    await page.locator(`.bot-row[aria-label="${name}"]`).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.locator(".run-status-card.status-error:visible")).toHaveCount(0);
    await expect(page.locator(".composer-error:visible")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "重试此步骤", exact: true })).toHaveCount(0);
    const history = page.getByTestId("direct-attempt-history");
    await expect(history).toHaveCount(1);
    await expect(history).not.toHaveAttribute("open", "");
    await history.locator("summary").first().click();
    await expect(history.locator(".run-status-card.status-error")).toBeVisible();
    await expect(history).toContainText("TASK_REQUIREMENTS_UNMET");
    await page.screenshot({ path: join(evidenceRoot, "aevoren-ux02-real-history-replay.png") });
    const observed = new DatabaseSync(path, { readOnly: true });
    try { expect(observed.prepare("SELECT * FROM runtime_runs WHERE execution_key = ? ORDER BY attempt_no").all(executionKey)).toEqual(before.filter(row => row.execution_key === completed.execution_key)); }
    finally { observed.close(); }
    expect(source.prepare("SELECT * FROM runtime_runs WHERE execution_key = ? ORDER BY attempt_no").all(executionKey)).toEqual(before.filter(row => row.execution_key === completed.execution_key));
  } finally {
    source.close();
    if (application) await close(application);
    removeTestDirectory(data);
  }
});

test("UX-02 real Codex read-only failure then corrected permission retries the same task and saves a verified file", async () => {
  test.skip(process.env.AEVOREN_BOT_REAL_UX_CLI !== "1", "requires explicit local real CLI verification; business execution remains unverified");
  test.setTimeout(420_000);
  const f = await fixture();
  const instructions = new AppRepository(f.path);
  const current = instructions.getBot(f.bound.bot.id);
  instructions.updateBot(current.id, current.version, { instructions: "只通过真实工作区工具处理用户文件任务。必须读取指定来源；即便写入未获授权，也应实际读取后明确说明缺失权限。没有成功写入和回读工具记录，不得声称已保存。写入权限开放后完成用户原任务，只新建指定的一份文件，不创建副本、不覆盖、不联网。" });
  instructions.close();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(f.data);
    application = launched.application;
    const page = launched.page;
    await configureCodex(page, [f.bound.bot.id]);
    await page.getByLabel("消息", { exact: true }).fill("请实际读取当前工作区的产品说明.md，提炼三项核心能力，并新建权限修正结果.md，最后真实回读这份文件核对保存成功。即便写入暂时不可用，也必须先完成真实读取，明确说明为什么尚未保存；不要虚构执行，不要覆盖文件，不联网。修复授权后重试必须继续同一任务，只生成这一个文件。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const first = await waitDirect(page, f.bound.session.id);
    if (!first.snapshot.ok || !first.tools.ok) throw new Error("Missing real initial evidence");
    const failed = first.snapshot.data.runs.at(-1)!;
    expect(failed).toMatchObject({ route: "codex-cli", state: "failed", lastErrorCode: "TASK_REQUIREMENTS_UNMET" });
    expect(first.tools.data.some(tool => tool.runtimeRunId === failed.id && tool.toolKind === "workspace-read" && tool.state === "succeeded")).toBe(true);
    expect(existsSync(join(f.bRoot, "权限修正结果.md"))).toBe(false);
    await expect(page.getByRole("button", { name: "重试此步骤", exact: true })).toBeVisible();
    await openConversationFiles(page);
    await page.locator(".task-details-shelf").getByRole("button", { name: "管理文件夹", exact: true }).click();
    await checkTarget(page, f.b.workspace.name);
    await page.getByRole("dialog", { name: "工作区权限" }).getByLabel("允许 Bot 新建 Markdown/CSV", { exact: true }).check();
    await page.getByRole("dialog", { name: "工作区权限" }).getByRole("button", { name: "完成", exact: true }).click();
    await page.getByRole("button", { name: "重试此步骤", exact: true }).click();
    await expect(page.locator(".run-status-card.status-error:visible")).toHaveCount(0);
    await expect.poll(async () => {
      const state = await directState(page, f.bound.session.id);
      return state.snapshot.ok ? state.snapshot.data.runs.at(-1)?.attemptNo : null;
    }, { timeout: 10_000 }).toBe(2);
    const final = await waitDirect(page, f.bound.session.id);
    if (!final.snapshot.ok || !final.tools.ok) throw new Error("Missing real retried evidence");
    const completed = final.snapshot.data.runs.at(-1)!;
    expect(completed).toMatchObject({ executionKey: failed.executionKey, attemptNo: 2, route: "codex-cli", state: "completed" });
    const writes = final.tools.data.filter(tool => tool.runtimeRunId === completed.id && tool.toolKind === "workspace-write" && tool.state === "succeeded");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.targetPath).toBe("权限修正结果.md");
    const bytes = readFileSync(join(f.bRoot, "权限修正结果.md"));
    expect(writes[0]!.resultMetadata).toMatchObject({ bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), created: true });
    expect(final.tools.data.some(tool => tool.runtimeRunId === completed.id && tool.toolKind === "workspace-read" && tool.targetPath === "权限修正结果.md" && tool.state === "succeeded")).toBe(true);
    await expect(page.locator(".run-status-card.status-error:visible")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "重试此步骤", exact: true })).toHaveCount(0);
    await expect(page.locator(".composer-error:visible")).toHaveCount(0);
    await expect(page.getByTestId("direct-attempt-history")).toHaveCount(1);
    await page.screenshot({ path: join(evidenceRoot, "aevoren-ux02-real-retry-saved.png") });
    await openConversationFiles(page);
    await expect(page.locator(".task-details-shelf")).toContainText("权限修正结果.md");
    await test.info().attach("real-cli-retry-evidence", { body: Buffer.from(JSON.stringify({ first, final }, null, 2)), contentType: "application/json" });
  } finally {
    if (application) await close(application);
    removeTestDirectory(f.data);
  }
});

async function waitRoom(page: Page, roomId: string, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await page.evaluate(id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.getSnapshot(id), roomId);
    if (!result.ok) throw new Error(result.error.safeMessage);
    const batch = result.data.batches.at(-1);
    if (batch && ["completed", "partial", "cancelled", "interrupted"].includes(batch.state)) return result.data;
    await page.waitForTimeout(300);
  }
  throw new Error("The actual group CLI request did not finish; unverified");
}

test("UX-03 real Codex members without coordination capability default to single-owner mode and Everyone produces two actual replies", async () => {
  test.skip(process.env.AEVOREN_BOT_REAL_UX_CLI !== "1", "requires explicit local real CLI verification; business execution remains unverified");
  test.setTimeout(360_000);
  const f = await fixture();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(f.data);
    application = launched.application;
    const page = launched.page;
    await configureCodex(page, [f.bound.bot.id, f.unbound.bot.id]);
    const actual = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.providers.list());
    if (!actual.ok) throw new Error(actual.error.safeMessage);
    const codex = actual.data.find(provider => provider.id === "codex.default")!;
    expect(codex).toMatchObject({ status: "available", authenticated: true, capabilities: { handoff: false, roomOwnerSelection: false } });
    await page.getByRole("button", { name: "新建聊天", exact: true }).click();
    const chooser = page.getByRole("dialog", { name: "新建聊天", exact: true });
    await chooser.locator(".recipient-option").filter({ hasText: "创建群聊" }).click();
    await chooser.getByRole("button", { name: "B文件助手", exact: true }).click();
    await chooser.getByRole("button", { name: "未绑定助手", exact: true }).click();
    await expect(chooser.getByLabel("新群协调者", { exact: true })).toHaveValue("none");
    await expect(chooser).toContainText("单人");
    await page.screenshot({ path: join(evidenceRoot, "aevoren-ux03-no-eligible-default.png") });
    await chooser.locator(".recipient-footer").getByRole("button", { name: "创建群聊", exact: true }).click();
    await expect(chooser).toBeHidden();
    const rooms = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.rooms.list());
    if (!rooms.ok || rooms.data.length !== 1) throw new Error("The real group was not created exactly once");
    const room = rooms.data[0]!;
    expect(room.leadBotId).toBeNull();
    const mode = page.getByLabel("群聊默认响应方式", { exact: true });
    await expect(mode).toHaveValue("automatic");
    await expect(mode.locator('option[value="automatic"]')).toContainText("单人");
    await page.getByLabel("消息", { exact: true }).fill("请本轮负责人只用一行确认已收到，不调用任何工具、不读取文件、不委派任务、不执行外部动作。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const automatic = await waitRoom(page, room.id);
    const first = automatic.batches.at(-1)!;
    await test.info().attach("actual-automatic-room", { body: Buffer.from(JSON.stringify(automatic, null, 2)), contentType: "application/json" });
    await page.screenshot({ path: join(evidenceRoot, "aevoren-ux03-real-automatic-outcome.png") });
    expect(first).toMatchObject({ state: "completed", routingMode: "automatic", leadBotId: null });
    expect(automatic.turns.filter(turn => turn.batchId === first.id)).toHaveLength(1);
    expect(automatic.handoffs).toHaveLength(0);
    const firstRuns = automatic.runs.filter(run => automatic.turns.some(turn => turn.batchId === first.id && turn.runtimeRunId === run.id));
    expect(firstRuns).toHaveLength(1);
    expect(firstRuns[0]).toMatchObject({ state: "completed", route: "codex-cli" });
    expect(firstRuns[0]!.providerRequestId).toBeTruthy();
    await mode.selectOption("everyone");
    await page.getByLabel("消息", { exact: true }).fill("请所有成员各用一行确认收到这条消息；不调用工具、不读取文件、不委派、不执行任何外部动作。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const everyone = await waitRoom(page, room.id);
    const final = everyone.batches.at(-1)!;
    await test.info().attach("actual-everyone-room", { body: Buffer.from(JSON.stringify(everyone, null, 2)), contentType: "application/json" });
    expect(final).toMatchObject({ state: "completed", routingMode: "everyone", leadBotId: null });
    const turns = everyone.turns.filter(turn => turn.batchId === final.id);
    expect(turns).toHaveLength(2);
    expect(turns.every(turn => turn.state === "completed")).toBe(true);
    expect(turns.map(turn => turn.memberBotId).sort()).toEqual([f.bound.bot.id, f.unbound.bot.id].sort());
    const runs = everyone.runs.filter(run => turns.some(turn => turn.runtimeRunId === run.id));
    expect(runs).toHaveLength(2);
    expect(runs.every(run => run.route === "codex-cli" && run.state === "completed" && Boolean(run.providerRequestId))).toBe(true);
    expect(everyone.handoffs).toHaveLength(0);
    await page.screenshot({ path: join(evidenceRoot, "aevoren-ux03-real-everyone-completed.png") });
    await test.info().attach("real-group-reply-evidence", { body: Buffer.from(JSON.stringify({ automatic, everyone }, null, 2)), contentType: "application/json" });
  } finally {
    if (application) await close(application);
    removeTestDirectory(f.data);
  }
});

test("UX-02 actual missing CLI path fails before acceptance and a repaired provider safely retries without a stale global error", async () => {
  test.skip(process.env.AEVOREN_BOT_REAL_UX_CLI !== "1", "requires explicit local real CLI verification; business execution remains unverified");
  test.setTimeout(240_000);
  const f = await fixture();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(f.data);
    application = launched.application;
    const page = launched.page;
    await configureCodex(page, [f.bound.bot.id]);
    const broken = await page.evaluate(async path => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const providers = await api.providers.list();
      if (!providers.ok) throw new Error(providers.error.safeMessage);
      const codex = providers.data.find(provider => provider.id === "codex.default")!;
      return api.providers.saveCli({ instanceId: codex.id, expectedVersion: codex.version, cliPath: path });
    }, join(f.data, "actually-not-installed-codex"));
    expect(broken).toMatchObject({ ok: true, data: { status: "unavailable" } });
    await page.getByLabel("消息", { exact: true }).fill("请只用一句话确认收到；不要调用工具、读写文件、联网或委派。本请求用于真实连接恢复验收。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(async () => {
      const state = await directState(page, f.bound.session.id);
      return state.snapshot.ok ? state.snapshot.data.entries.find(entry => entry.role === "user")?.sendState : null;
    }, { timeout: 15_000 }).toBe("failed-before-acceptance");
    const first = await directState(page, f.bound.session.id);
    if (!first.snapshot.ok) throw new Error("Missing genuine failed-before-acceptance record");
    const user = first.snapshot.data.entries.find(entry => entry.role === "user")!;
    const firstRunId = first.snapshot.data.runs.at(-1)?.id;
    await expect(page.locator(".composer-error:visible")).toHaveCount(1);
    const repaired = await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const providers = await api.providers.list();
      if (!providers.ok) throw new Error(providers.error.safeMessage);
      const codex = providers.data.find(provider => provider.id === "codex.default")!;
      return api.providers.saveCli({ instanceId: codex.id, expectedVersion: codex.version, cliPath: codex.cliDefault || "codex" });
    });
    expect(repaired).toMatchObject({ ok: true, data: { status: "available", authenticated: true } });
    await page.locator("article.message-user").getByRole("button", { name: "安全重试发送", exact: true }).click();
    await expect.poll(async () => {
      const state = await directState(page, f.bound.session.id);
      const latest = state.snapshot.ok ? state.snapshot.data.runs.at(-1) : null;
      return Boolean(latest && latest.id !== firstRunId);
    }, { timeout: 15_000 }).toBe(true);
    const final = await waitDirect(page, f.bound.session.id);
    if (!final.snapshot.ok) throw new Error("Missing actual repaired CLI response");
    const completed = final.snapshot.data.runs.at(-1)!;
    expect(completed).toMatchObject({ route: "codex-cli", state: "completed", clientNonce: user.clientNonce });
    expect(completed.providerRequestId).toBeTruthy();
    expect(final.snapshot.data.entries.filter(entry => entry.role === "user")).toHaveLength(1);
    await expect(page.locator(".composer-error:visible")).toHaveCount(0);
    await expect(page.locator(".run-status-card.status-error:visible")).toHaveCount(0);
    await expect(page.locator("article.message-user").getByRole("button", { name: "安全重试发送", exact: true })).toHaveCount(0);
    await page.screenshot({ path: join(evidenceRoot, "aevoren-ux02-real-preaccept-recovered.png") });
    await test.info().attach("real-preaccept-retry-evidence", { body: Buffer.from(JSON.stringify({ first, final }, null, 2)), contentType: "application/json" });
  } finally {
    if (application) await close(application);
    removeTestDirectory(f.data);
  }
});

test("UX-03 actual unavailable CLI configurations do not invent eligible coordinators and observed Claude capability metadata is preserved", async () => {
  test.skip(process.env.AEVOREN_BOT_REAL_UX_CLI !== "1", "requires explicit local CLI capability verification; installed CLI metadata remains unverified");
  const f = await fixture();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(f.data);
    application = launched.application;
    const page = launched.page;
    const observed = await page.evaluate(async directory => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const scanned = await api.providers.scan();
      if (!scanned.ok) throw new Error(scanned.error.safeMessage);
      const claude = scanned.data.find(provider => provider.id === "claude.default");
      for (const id of ["codex.default", "claude.default"]) {
        const provider = scanned.data.find(item => item.id === id)!;
        const changed = await api.providers.saveCli({ instanceId: id, expectedVersion: provider.version, cliPath: `${directory}/${id}-actually-absent` });
        if (!changed.ok) throw new Error(changed.error.safeMessage);
      }
      const actual = await api.providers.list();
      if (!actual.ok) throw new Error(actual.error.safeMessage);
      return {
        claude: claude ? { status: claude.status, authenticated: claude.authenticated, capabilities: claude.capabilities } : null,
        sources: actual.data.map(provider => ({ id: provider.id, status: provider.status, authenticated: provider.authenticated, capabilities: provider.capabilities })),
      };
    }, f.data);
    expect(observed.sources.every(provider => provider.status !== "available")).toBe(true);
    if (observed.claude) expect(observed.claude.capabilities.handoff).toBe(false);
    await page.getByRole("button", { name: "新建聊天", exact: true }).click();
    const chooser = page.getByRole("dialog", { name: "新建聊天", exact: true });
    await chooser.locator(".recipient-option").filter({ hasText: "创建群聊" }).click();
    await chooser.getByRole("button", { name: "B文件助手", exact: true }).click();
    await chooser.getByRole("button", { name: "未绑定助手", exact: true }).click();
    await expect(chooser.getByLabel("新群协调者", { exact: true })).toHaveValue("none");
    await expect(chooser).toContainText("单人");
    const unavailableLead = chooser.getByLabel("新群协调者", { exact: true }).locator('option[value="default"]');
    await expect(unavailableLead).toHaveAttribute("disabled", "");
    expect(await unavailableLead.evaluate(option => (option as HTMLOptionElement).disabled)).toBe(true);
    await page.screenshot({ path: join(evidenceRoot, "aevoren-ux03-unavailable-no-false-coordinator.png") });
    await test.info().attach("real-cli-capability-observation", { body: Buffer.from(JSON.stringify(observed, null, 2)), contentType: "application/json" });
  } finally {
    if (application) await close(application);
    removeTestDirectory(f.data);
  }
});
