import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { removeTestDirectory } from "./test-cleanup";

test("uses real Claude native MCP through Aevoren approval and the Tool Journal", async () => {
  test.skip(process.env.AEVOREN_REAL_CLAUDE_TOOLS !== "1", "requires explicit real Claude validation and a verified public document");
  test.setTimeout(300_000);
  const document = process.env.AEVOREN_PUBLIC_CLAUDE_DOC;
  if (!document || !readFileSync(document, "utf8").includes("URL Source: https://code.claude.com/docs/en/mcp")) throw new Error("A verified public document is required; private files must not be uploaded");
  const data = mkdtempSync(join(tmpdir(), "aevoren-claude-tools-real-"));
  const root = join(data, "公开资料");
  mkdirSync(root);
  copyFileSync(document, join(root, "public-mcp-doc.txt"));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const registered = await new WorkspaceService(repository).registerRoot(root);
  const created = repository.createBot(registered.project.id);
  repository.updateBot(created.bot.id, created.bot.version, {
    name: "公开资料研究员",
    instructions: "只读取用户指定的公开资料。请真实使用 Workspace 工具，不能声称未执行的操作。不要联网或写入，不要做字符数估算。工具失败就明确说明。",
  });
  repository.setSetting("appearance.theme", "dark", false);
  repository.close();
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" };
  delete env.AEVOREN_BOT_FAKE_PROVIDER;
  delete env.AEVOREN_BOT_DB_PATH;
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.getByRole("heading", { name: "公开资料研究员", exact: true })).toBeVisible();
    const configured = await page.evaluate(async ({ botId, cliPath }) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const providers = await api.providers.list();
      const provider = providers.ok ? providers.data.find(item => item.id === "claude.default") : null;
      if (!provider) throw new Error("Claude not discovered");
      const saved = await api.providers.saveCli({ instanceId: provider.id, expectedVersion: provider.version, cliPath });
      if (!saved.ok || saved.data.status !== "available" || !saved.data.authenticated) throw new Error("Actual Claude authentication is required");
      const bots = await api.bots.list();
      const bot = bots.ok ? bots.data.find(item => item.id === botId) : null;
      if (!bot) throw new Error("Bot missing");
      const updated = await api.bots.update({ id: bot.id, expectedVersion: bot.version, patch: { modelSelection: { providerInstanceId: provider.id, modelId: "k3" } } });
      if (!updated.ok) throw new Error(updated.error.code);
      return api.capabilities.getSnapshot({ botId });
    }, { botId: created.bot.id, cliPath: process.env.AEVOREN_REAL_CLAUDE_PATH ?? "claude" });
    expect(configured.ok && configured.data.availableTools).toEqual(["workspace_list", "workspace_read", "workspace_search", "web_search", "web_fetch"]);
    await page.reload();
    await page.getByLabel("消息", { exact: true }).fill("请先查看公开资料工作区目录，再读取 public-mcp-doc.txt 的前 6000 字节，然后在该文件中检索 ‘HTTP servers’。仅根据真实工具结果总结 MCP 的作用和公开文档标题。不要联网，不要写文件，不要使用训练知识代替工具。请在同一个请求里完成，不需要我拆分操作。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    let initialApprovalChecked = false;
    let completed = false;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const state = await page.evaluate(async (sessionId) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        return { approvals: await api.approvals.listPending({ sessionId }), snapshot: await api.runtime.getSessionSnapshot(sessionId), tools: await api.tools.list({ sessionId }) };
      }, created.session.id);
      if (state.approvals.ok && state.approvals.data.length) {
        if (!initialApprovalChecked) {
          expect(state.tools.ok && state.tools.data.some(item => item.state === "awaiting-approval" && item.startedAt === null)).toBe(true);
          await expect(page.getByRole("button", { name: "仅允许一次", exact: true }).first()).toBeVisible();
          initialApprovalChecked = true;
        }
        for (const approval of state.approvals.data) {
          const resolved = await page.evaluate(async (input) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.approvals.resolve(input), { sessionId: created.session.id, id: approval.id, expectedVersion: approval.version, resolution: "allow-once" as const });
          expect(resolved.ok).toBe(true);
        }
      }
      if (state.snapshot.ok && state.snapshot.data.runs.some(run => run.state === "failed" || run.state === "interrupted")) throw new Error(`Real Claude failed: ${state.snapshot.data.runs.map(run => run.lastErrorCode).join(",")}`);
      if (state.snapshot.ok && state.snapshot.data.runs.some(run => run.state === "completed")) { completed = true; break; }
      await page.waitForTimeout(300);
    }
    expect(completed).toBe(true);
    expect(initialApprovalChecked).toBe(true);
    const result = await page.evaluate(async (sessionId) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      return { tools: await api.tools.list({ sessionId }), snapshot: await api.runtime.getSessionSnapshot(sessionId) };
    }, created.session.id);
    if (!result.tools.ok || !result.snapshot.ok) throw new Error("Real evidence missing");
    expect(result.snapshot.data.runs.at(-1)?.route).toBe("claude-cli");
    for (const kind of ["workspace-list", "workspace-read", "workspace-search"]) expect(result.tools.data.some(tool => tool.toolKind === kind && tool.state === "succeeded" && tool.resultDigest)).toBe(true);
    expect(result.tools.data.every(tool => tool.executorBotId === created.bot.id)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: join(tmpdir(), "aevoren-real-claude-host-tools.png") });
    const safety: Array<{ action: string; runState: string; toolStates: string[] }> = [];
    for (const action of ["deny", "cancel"] as const) {
      await page.getByLabel("消息", { exact: true }).fill("请真实读取 public-mcp-doc.txt 的前 1000 字节。必须通过 workspace_read；不能用历史文字代替本次读取，不要联网。此次工具调用需要重新批准。");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      let handled = false;
      await expect.poll(async () => {
        const state = await page.evaluate(async (sessionId) => {
          const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
          return { pending: await api.approvals.listPending({ sessionId }), snapshot: await api.runtime.getSessionSnapshot(sessionId), tools: await api.tools.list({ sessionId }) };
        }, created.session.id);
        if (!state.pending.ok || !state.snapshot.ok || !state.tools.ok) throw new Error("Safety evidence missing");
        const run = state.snapshot.data.runs.at(-1)!;
        const tools = state.tools.data.filter(tool => tool.runtimeRunId === run.id);
        if (state.pending.data.length) {
          expect(tools.every(tool => tool.attemptCount === 0 && tool.startedAt === null)).toBe(true);
          handled = true;
          if (action === "cancel") {
            const cancelled = await page.evaluate(async (runId) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.cancel(runId), run.id);
            expect(cancelled.ok).toBe(true);
          } else for (const approval of state.pending.data) {
            const denied = await page.evaluate(async (input) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.approvals.resolve(input), { sessionId: created.session.id, id: approval.id, expectedVersion: approval.version, resolution: "deny" as const });
            expect(denied.ok).toBe(true);
          }
        }
        if (!handled || !["failed", "cancelled"].includes(run.state)) return false;
        expect(run.state).toBe(action === "cancel" ? "cancelled" : "failed");
        expect(tools.length).toBeGreaterThan(0);
        expect(tools.every(tool => tool.attemptCount === 0 && tool.resultDigest === null && tool.state === (action === "cancel" ? "cancelled" : "denied"))).toBe(true);
        safety.push({ action, runState: run.state, toolStates: tools.map(tool => tool.state) });
        return true;
      }, { timeout: 90_000, intervals: [500] }).toBe(true);
    }
    expect(errors).toEqual([]);
    writeFileSync(join(tmpdir(), "aevoren-real-claude-host-tools-result.json"), JSON.stringify({ completed, provider: "claude.default", model: "k3", initialApprovalChecked, safety, tools: result.tools.data.map(({ toolKind, state, resultDigest, toolCallId }) => ({ toolKind, state, resultDigest, toolCallId })) }, null, 2));
  } finally {
    await application.close();
    removeTestDirectory(data);
  }
});

test("completes real public research, saves one report and reads it back through Claude native MCP", async () => {
  test.skip(process.env.AEVOREN_REAL_CLAUDE_RESEARCH !== "1", "requires explicit public-network real Claude research validation");
  test.setTimeout(360_000);
  const data = mkdtempSync(join(tmpdir(), "aevoren-claude-research-real-"));
  const root = join(data, "公开调研成果");
  mkdirSync(join(root, "01-inbox"), { recursive: true });
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const registered = await new WorkspaceService(repository).registerRoot(root);
  repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: false });
  const created = repository.createBot(registered.project.id);
  repository.updateBot(created.bot.id, created.bot.version, {
    name: "情报侦察员",
    instructions: "你负责公开资料调研与证据化交付。先真实检索，再抓取实际来源原文；搜索条目只是线索，不能冒充原文核验。只使用 Aevoren 宿主工具。每次任务只创建一个正式报告；已有文件不得覆盖。依据抓取结果列出来源 URL、抓取时间、不确定项，再用 Workspace 工具保存并回读。不要发布、登录、支付或读取私有文件。",
  });
  repository.setSetting("appearance.theme", "dark", false);
  repository.close();
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" };
  delete env.AEVOREN_BOT_FAKE_PROVIDER;
  delete env.AEVOREN_BOT_DB_PATH;
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env });
  let retainEvidence = false;
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.getByRole("heading", { name: "情报侦察员", exact: true })).toBeVisible();
    const configured = await page.evaluate(async ({ botId, cliPath }) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const providers = await api.providers.list();
      const provider = providers.ok ? providers.data.find(item => item.id === "claude.default") : null;
      if (!provider) throw new Error("Claude not discovered");
      const saved = await api.providers.saveCli({ instanceId: provider.id, expectedVersion: provider.version, cliPath });
      if (!saved.ok || saved.data.status !== "available" || !saved.data.authenticated) throw new Error("Real CLI unavailable");
      const bots = await api.bots.list();
      const bot = bots.ok ? bots.data.find(item => item.id === botId) : null;
      if (!bot) throw new Error("Bot missing");
      const updated = await api.bots.update({ id: bot.id, expectedVersion: bot.version, patch: { modelSelection: { providerInstanceId: provider.id, modelId: "k3" } } });
      if (!updated.ok) throw new Error(updated.error.code);
      return api.capabilities.getSnapshot({ botId });
    }, { botId: created.bot.id, cliPath: process.env.AEVOREN_REAL_CLAUDE_PATH ?? "claude" });
    expect(configured.ok && configured.data.availableTools).toEqual(["workspace_list", "workspace_read", "workspace_search", "workspace_write", "web_search", "web_fetch"]);
    await page.reload();
    const reportPath = join(root, "01-inbox", "个人网站调研.md");
    expect(existsSync(reportPath)).toBe(false);
    // One ordinary business request, not manually split into tool-specific turns.
    await page.getByLabel("消息", { exact: true }).fill("请调研个人网站如何做。依据当前实际可访问的公开官方资料，比较适合普通用户的建站方式，给出实施建议、来源 URL、抓取时间和未确认事项。把结果自动保存为当前公开调研成果工作区的 01-inbox/个人网站调研.md，保存后读取该真实文件确认完整，再告诉我文件位置。不发布网站，不做登录、支付或其他外部操作；没有成功抓取的原文不要当作已核验依据。不要让我手动保存或拆分工具调用。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    let completed = false;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const state = await page.evaluate(async (sessionId) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        return { approvals: await api.approvals.listPending({ sessionId }), snapshot: await api.runtime.getSessionSnapshot(sessionId) };
      }, created.session.id);
      if (state.approvals.ok) for (const approval of state.approvals.data) {
        const allowed = await page.evaluate(async (input) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.approvals.resolve(input), { sessionId: created.session.id, id: approval.id, expectedVersion: approval.version, resolution: "allow-once" as const });
        expect(allowed.ok).toBe(true);
      }
      if (state.snapshot.ok && state.snapshot.data.runs.some(run => run.state === "failed" || run.state === "interrupted")) {
        retainEvidence = true;
        throw new Error(`Real research failed: ${state.snapshot.data.runs.map(run => run.lastErrorCode).join(",")}; evidence directory ${data}`);
      }
      if (state.snapshot.ok && state.snapshot.data.runs.some(run => run.state === "completed")) { completed = true; break; }
      await page.waitForTimeout(500);
    }
    expect(completed).toBe(true);
    const result = await page.evaluate(async (sessionId) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      return { tools: await api.tools.list({ sessionId }), snapshot: await api.runtime.getSessionSnapshot(sessionId) };
    }, created.session.id);
    if (!result.tools.ok || !result.snapshot.ok) throw new Error("Real evidence missing");
    const succeeded = result.tools.data.filter(tool => tool.state === "succeeded");
    for (const kind of ["web-search", "web-fetch", "workspace-write", "workspace-read"]) expect(succeeded.some(tool => tool.toolKind === kind && tool.resultDigest)).toBe(true);
    const writes = succeeded.filter(tool => tool.toolKind === "workspace-write");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.targetPath).toBe("01-inbox/个人网站调研.md");
    expect(existsSync(reportPath)).toBe(true);
    const report = readFileSync(reportPath, "utf8");
    const sha256 = createHash("sha256").update(report).digest("hex");
    expect(writes[0]?.resultMetadata?.sha256).toBe(sha256);
    expect(succeeded.some(tool => tool.toolKind === "workspace-read" && tool.targetPath === "01-inbox/个人网站调研.md" && tool.resultMetadata?.sha256 === sha256)).toBe(true);
    const fetched = succeeded.filter(tool => tool.toolKind === "web-fetch");
    expect(fetched.some(tool => typeof tool.resultMetadata?.url === "string" && report.includes(tool.resultMetadata.url))).toBe(true);
    expect(fetched.every(tool => typeof tool.resultMetadata?.retrievedAt === "string")).toBe(true);
    expect(readdirSync(join(root, "01-inbox"))).toEqual(["个人网站调研.md"]);
    expect(errors).toEqual([]);
    await expect(page.getByRole("region", { name: "交付物状态" })).toContainText("个人网站调研.md");
    await page.screenshot({ path: join(tmpdir(), "aevoren-real-claude-research.png") });
    writeFileSync(join(tmpdir(), "aevoren-real-claude-research-result.json"), JSON.stringify({ completed, provider: "claude.default", model: "k3", reportPath, sha256, tools: result.tools.data.map(({ toolKind, state, resultDigest, targetPath, resultMetadata }) => ({ toolKind, state, resultDigest, targetPath, resultMetadata })) }, null, 2));
    retainEvidence = true;
  } catch (error) {
    retainEvidence = true;
    throw error;
  } finally {
    await application.close();
    if (!retainEvidence) removeTestDirectory(data);
  }
});
