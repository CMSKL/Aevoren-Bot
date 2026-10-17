import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { removeTestDirectory } from "./test-cleanup";
import { openToolRecords } from "./tool-ui";

test("real Claude public queries run after one explicit consent while files still require approval", async () => {
  test.skip(process.env.AEVOREN_REAL_TOOL_CONSENT !== "1", "requires explicit real Claude/public-web verification");
  test.setTimeout(420_000);
  const publicDocument = process.env.AEVOREN_PUBLIC_CLAUDE_DOC;
  if (!publicDocument || !readFileSync(publicDocument, "utf8").includes("URL Source: https://code.claude.com/docs/en/mcp")) throw new Error("A verified public document is required");
  const data = mkdtempSync(join(tmpdir(), "aevoren-consent-real-"));
  const root = join(data, "公开资料");
  mkdirSync(root);
  copyFileSync(publicDocument, join(root, "public-mcp-doc.txt"));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const registered = await new WorkspaceService(repository).registerRoot(root);
  const created = repository.createBot(registered.project.id);
  repository.updateBot(created.bot.id, created.bot.version, {
    name: "公开资料研究员", instructions: "仅处理用户指定的公开文档。调研必须真实搜索并抓取网页，来源和时间使用工具结果。需要授权时通过工具调用请求宿主审批，不用文字询问代替。只使用提供的宿主工具，不发布、不登录、不读私有数据。",
  });
  repository.setSetting("appearance.theme", "dark", false);
  repository.close();
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" };
  delete env.AEVOREN_BOT_FAKE_PROVIDER;
  delete env.AEVOREN_BOT_DB_PATH;
  const app = await electron.launch({ args: ["."], cwd: process.cwd(), env });
  let retain = false;
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.getByRole("heading", { name: "公开资料研究员", exact: true })).toBeVisible();
    await page.evaluate(async ({ botId, cliPath }) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const list = await api.providers.list();
      const provider = list.ok ? list.data.find(item => item.id === "claude.default") : null;
      if (!provider) throw new Error("Actual Claude CLI required");
      const saved = await api.providers.saveCli({ instanceId: provider.id, expectedVersion: provider.version, cliPath });
      if (!saved.ok || saved.data.status !== "available") throw new Error("Actual CLI authentication required");
      const bots = await api.bots.list();
      const bot = bots.ok ? bots.data.find(item => item.id === botId) : null;
      if (!bot) throw new Error("Bot missing");
      const selected = await api.bots.update({ id: bot.id, expectedVersion: bot.version, patch: { modelSelection: { providerInstanceId: "claude.default", modelId: "k3" } } });
      if (!selected.ok) throw new Error(selected.error.code);
    }, { botId: created.bot.id, cliPath: process.env.AEVOREN_REAL_CLAUDE_PATH ?? "claude" });
    await page.reload();
    const snapshot = async (sessionId = created.session.id) => page.evaluate(async (sessionId) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      return { runtime: await api.runtime.getSessionSnapshot(sessionId), tools: await api.tools.list({ sessionId }), settings: await api.settings.getGeneral() };
    }, sessionId);
    const initial = await snapshot();
    expect(initial.settings.ok && initial.settings.data.autoApprovePublicReadTools).toBe(false);
    await send(page, "请调研 Claude Code 官方 MCP 文档的主要用途。真实联网搜索官方资料，并抓取 https://code.claude.com/docs/en/mcp 的原文，简短总结并列出来源与抓取时间。不读写本地文件，不发布或登录。");
    const permission = page.getByTestId("tool-permission-dialog");
    await expect(permission).toBeVisible({ timeout: 90_000 });
    const before = await snapshot();
    expect(before.tools.ok && before.tools.data.some(tool => tool.state === "awaiting-approval" && tool.startedAt === null && tool.attemptCount === 0)).toBe(true);
    await expect(page.locator(".transcript .message-tools")).toHaveCount(0);
    for (const width of [1180, 1020, 620, 390]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size, 820), width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      const bounds = await permission.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: join(tmpdir(), `aevoren-tool-consent-real-${width}.png`) });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 820));
    await permission.getByRole("button", { name: "允许公开查询并记住", exact: true }).click();
    await expect.poll(async () => {
      const state = await snapshot();
      if (!state.runtime.ok) throw new Error("Actual runtime unavailable");
      const run = state.runtime.data.runs.at(-1)!;
      if (["failed", "interrupted"].includes(run.state)) throw new Error(`Real research failed ${run.lastErrorCode}; evidence ${data}`);
      return run.state;
    }, { timeout: 180_000, intervals: [500] }).toBe("completed");
    const first = await snapshot();
    expect(first.settings.ok && first.settings.data.autoApprovePublicReadTools).toBe(true);
    if (!first.tools.ok) throw new Error("Real evidence missing");
    for (const kind of ["web-search", "web-fetch"]) expect(first.tools.data.some(tool => tool.toolKind === kind && tool.state === "succeeded" && tool.resultDigest && tool.resultMetadata?.retrievedAt)).toBe(true);
    await expect(permission).toBeHidden();
    await expect(page.locator(".transcript .message-tools")).toHaveCount(0);
    await page.screenshot({ path: join(tmpdir(), "aevoren-tool-consent-real-chat.png") });
    await openToolRecords(page);
    await page.screenshot({ path: join(tmpdir(), "aevoren-tool-consent-real-records.png") });
    await page.getByRole("button", { name: "关闭会话成果", exact: true }).last().click();
    await send(page, "请重新访问 https://code.claude.com/docs/en/mcp ，只根据本次真实网页抓取结果简短说明 HTTP MCP 的用途，附抓取时间。不读写本地文件。");
    await expect.poll(async () => {
      await expect(permission).toBeHidden();
      const state = await snapshot();
      if (!state.runtime.ok) throw new Error("Actual runtime unavailable");
      const run = state.runtime.data.runs.at(-1)!;
      if (["failed", "interrupted"].includes(run.state)) throw new Error(`Real repeat query failed ${run.lastErrorCode}; evidence ${data}`);
      return state.runtime.data.runs.filter(item => item.state === "completed").length;
    }, { timeout: 120_000, intervals: [500] }).toBe(2);
    // A separate file task avoids mixing earlier network-only instructions
    // into the permission-boundary proof; the persisted public consent remains.
    const fileSessionId = await page.evaluate(async (projectId) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const next = await api.bots.create({ projectId });
      if (!next.ok) throw new Error(next.error.code);
      const updated = await api.bots.update({ id: next.data.bot.id, expectedVersion: next.data.bot.version, patch: {
        name: "文件权限验证员", instructions: "只读取用户指定的公开文件。必须通过实际 Workspace 工具请求宿主审批并拿到结果；不能用文字伪造调用或返回。不联网，不写文件。",
        modelSelection: { providerInstanceId: "claude.default", modelId: "k3" },
      } });
      if (!updated.ok) throw new Error(updated.error.code);
      return next.data.session.id;
    }, registered.project.id);
    await page.reload();
    await page.getByText("文件权限验证员", { exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "文件权限验证员", exact: true })).toBeVisible();
    await send(page, "请发起 workspace_read，读取公开资料工作区 public-mcp-doc.txt 的前 1000 字节。通过实际工具调用请求宿主审批，成功拿到结果后概述文档内容。");
    await expect(permission).toBeVisible({ timeout: 90_000 });
    await expect(permission).toContainText("读取文件");
    await expect(permission.getByRole("button", { name: "允许公开查询并记住" })).toHaveCount(0);
    await page.screenshot({ path: join(tmpdir(), "aevoren-tool-consent-real-file.png") });
    await permission.getByRole("button", { name: "停止任务", exact: true }).click();
    await expect(permission).toBeHidden();
    const final = await snapshot(fileSessionId);
    if (!final.tools.ok || !final.runtime.ok) throw new Error("Final evidence missing");
    expect(final.runtime.data.runs.at(-1)?.state).toBe("cancelled");
    const reads = final.tools.data.filter(tool => tool.toolKind === "workspace-read");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(tool => tool.state === "cancelled" && tool.attemptCount === 0 && tool.startedAt === null)).toBe(true);
    expect(errors).toEqual([]);
    const publicResult = await snapshot();
    if (!publicResult.tools.ok || !publicResult.runtime.ok) throw new Error("Public evidence missing");
    writeFileSync(join(tmpdir(), "aevoren-tool-consent-real-result.json"), JSON.stringify({ verified: true, provider: "claude.default", model: "k3", publicTools: publicResult.tools.data.map(({ toolKind, state, attemptCount, resultDigest, resultMetadata }) => ({ toolKind, state, attemptCount, resultDigest, resultMetadata })), protectedTools: final.tools.data.map(({ toolKind, state, attemptCount, resultDigest }) => ({ toolKind, state, attemptCount, resultDigest })), publicRuns: publicResult.runtime.data.runs.map(({ state, lastErrorCode }) => ({ state, lastErrorCode })), protectedRuns: final.runtime.data.runs.map(({ state, lastErrorCode }) => ({ state, lastErrorCode })), errors }, null, 2));
  } catch (error) { retain = true; throw error; }
  finally { await app.close(); if (!retain) removeTestDirectory(data); }
});

async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel("消息", { exact: true }).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}
