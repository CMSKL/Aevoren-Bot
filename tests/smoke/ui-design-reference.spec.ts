import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, Bot, PromptManifest } from "@shared/contracts";
import { BOT_AVATAR_COLORS, DEFAULT_BOT_AVATAR_SHAPE } from "@shared/bot-avatar";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { WorkspaceToolExecutor } from "../../src/main/workspace-tool-executor";
import { removeTestDirectory } from "./test-cleanup";

// This is a UI-only reference fixture. Names, messages, timestamps and completed
// room/runtime states are seeded to reproduce the approved design, not to prove
// that an Agent generated a website plan or completed a collaboration workflow.
// File cards are stricter: the normal approved WorkspaceToolExecutor really
// creates both files and supplies the journal metadata used by the renderer.
const FIRST_MESSAGE = "整理个人网站方案，并保存建议书和上线清单。";
const ASSISTANT_MESSAGE = "已整理成两份文件。建议先上线作品集，再按需要补充博客。  \n下面是本次交付。";
const FOLLOWUP_MESSAGE = "先把作品集这一部分展开。";
const DEFAULT_OUTPUT_DIR = "/private/tmp/aevoren-ui-redesign-reference";

function referenceTime(minute: number, second = 0): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((value) => value.type === type)!.value;
  return new Date(`${part("year")}-${part("month")}-${part("day")}T09:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}+08:00`).toISOString();
}

function sizedFixtureMarkdown(title: string, bytes: number): string {
  const prefix = `# ${title}\n\nUI-only visual fixture. This local file verifies the saved-file card, not Agent execution.\n\n`;
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix, "utf8"));
}

async function seedReference(databasePath: string, workspaceRoot: string) {
  const repository = new AppRepository(databasePath);
  const displayEntries: Array<{ id: string; at: string; omitRoutingBadge?: boolean }> = [];
  const displayConversations: Array<{ sessionId: string; at: string }> = [];
  const displayToolOrder: Array<{ id: string; at: string }> = [];
  const journalProof: Array<{ invocationId: string; runtimeRunId: string; assistantEntryId: string; workspaceId: string; path: string; state: string; attemptCount: number; bytes: number; sha256: string; approvalResolution: string | null }> = [];
  try {
    const workspaceService = new WorkspaceService(repository);
    const registered = await workspaceService.registerRoot(workspaceRoot);
    repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: false });
    const profiles = [
      { name: "项目协调员", label: "协调", minute: 40, preview: "个人网站方案" },
      { name: "研究助手", label: "研究", minute: 47, preview: "我整理了一些相关资料…" },
      { name: "写作助手", label: "写作", minute: 45, preview: "这段文字可以再精简一些…" },
      { name: "数据助手", label: "数据", minute: 43, preview: "数据已整理完成。" },
      { name: "代码助手", label: "代码", minute: 42, second: 30, preview: "已生成示例代码，供参考。" },
      { name: "资料整理", label: "整理", minute: 42, preview: "文档已归档，共 12 个文件。" },
      { name: "发布准备", label: "发布", minute: 41, preview: "上线清单已更新。" },
    ];
    const bots: Bot[] = [];
    for (const [index, profile] of profiles.entries()) {
      const created = repository.createBot(registered.project.id);
      const bot = repository.updateBot(created.bot.id, created.bot.version, {
        name: profile.name,
        label: profile.label,
        description: "UI-only approved design reference contact.",
        avatarShape: DEFAULT_BOT_AVATAR_SHAPE,
        // avatar-catalog maps shape index 0 / color indices 0..6 to the seven
        // real coordinator, research, writer, data, coding, organizer, publisher PNGs.
        avatarColor: BOT_AVATAR_COLORS[index]!,
      });
      bots.push(bot);
      const preview = repository.createAssistantEntry(created.session.id, { speakerBotId: bot.id, speakerNameSnapshot: bot.name });
      repository.updateTranscriptEntry(preview.id, profile.preview, "completed");
      const at = referenceTime(profile.minute, profile.second ?? 0);
      displayEntries.push({ id: preview.id, at });
      displayConversations.push({ sessionId: created.session.id, at });
    }
    const coordinator = bots[0]!;
    repository.setBotHidden(coordinator.id, true);
    const room = repository.createRoom({
      name: "个人网站小组",
      projectId: registered.project.id,
      memberBotIds: bots.slice(0, 3).map((bot) => bot.id),
      leadBotId: coordinator.id,
    });
    const productRoom = repository.createRoom({
      name: "产品讨论组",
      projectId: registered.project.id,
      memberBotIds: [bots[0]!.id, bots[1]!.id, bots[2]!.id, bots[5]!.id],
      leadBotId: coordinator.id,
    });
    const productPreview = repository.createAssistantEntry(productRoom.session.id, { speakerBotId: coordinator.id, speakerNameSnapshot: coordinator.name });
    repository.updateTranscriptEntry(productPreview.id, "好的，以下是讨论要点…", "completed");
    displayEntries.push({ id: productPreview.id, at: referenceTime(44) });
    displayConversations.push({ sessionId: productRoom.session.id, at: referenceTime(44) });
    repository.setRoomUnread(productRoom.room.id, true);

    const clientNonce = randomUUID();
    const preparedRun = repository.createRoomRunWithInitialTurns({
      roomId: room.room.id,
      sessionId: room.session.id,
      clientNonce,
      text: FIRST_MESSAGE,
      membershipVersion: room.room.membershipVersion,
      maxTurns: 8,
      maxHops: 3,
      maxTargetsPerTurn: 2,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      initialTurns: [{ agentId: coordinator.id, nonce: randomUUID(), turnPurpose: "work" }],
      routingMode: "automatic",
      routingReason: "UI-only visual fixture; no Agent generation is being validated.",
      orchestrationEnabled: true,
    });
    const turn = preparedRun.turns[0]!;
    repository.transitionRoomRun(preparedRun.run.id, "running");
    repository.transitionAgentTurn(turn.id, "running", { promptCutoffSeq: turn.inputSeq });
    const manifest: PromptManifest = {
      schemaVersion: 4,
      botId: coordinator.id,
      profileVersion: coordinator.version,
      sessionId: room.session.id,
      generation: room.session.generation,
      inputSeq: turn.inputSeq,
      promptCutoffSeq: turn.inputSeq,
      roomId: room.room.id,
      roomMembershipVersion: room.room.membershipVersion,
      executorBotId: coordinator.id,
      sourceTurnId: turn.id,
      blocks: [],
      digest: "ui-only-approved-reference-fixture",
    };
    let runtime = repository.createRuntimeRun(clientNonce, "fake", manifest, {
      executorBotId: coordinator.id,
      executionKey: `${preparedRun.run.id}:${turn.logicalTurnId}`,
    });
    repository.attachRoomTurnRuntime(turn.id, runtime.id);
    runtime = repository.transitionRuntimeRun(runtime.id, "dispatching");
    runtime = repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "ui-only-reference-fixture" });
    const assistant = repository.createAssistantEntry(room.session.id, {
      speakerBotId: coordinator.id, speakerNameSnapshot: coordinator.name, sourceTurnId: turn.id,
    });
    repository.attachAssistantEntry(runtime.id, assistant.id);
    const executor = new WorkspaceToolExecutor(repository, workspaceService);
    const files = [
      { name: "个人网站建议书.md", content: sizedFixtureMarkdown("个人网站建议书", 4 * 1024) },
      { name: "上线清单.md", content: sizedFixtureMarkdown("上线清单", 2 * 1024) },
    ];
    for (const [index, file] of files.entries()) {
      const prepared = repository.prepareToolInvocation({
        runtimeRunId: runtime.id,
        toolCallId: `ui-only-reference-write-${index}`,
        idempotencyKey: randomUUID(),
        tool: { kind: "workspace-write", workspaceId: registered.workspace.id, path: file.name, content: file.content },
      });
      repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
      const executed = await executor.execute(prepared.invocation.id);
      displayToolOrder.push({ id: executed.invocation.id, at: referenceTime(42, index + 1) });
      expect(executed.invocation.state).toBe("succeeded");
      const actual = readFileSync(join(workspaceRoot, file.name));
      expect(actual.toString("utf8")).toBe(file.content);
      expect(executed.invocation.resultMetadata?.bytes).toBe(actual.byteLength);
      expect(executed.invocation.resultMetadata?.sha256).toBe(createHash("sha256").update(actual).digest("hex"));
      journalProof.push({
        invocationId: executed.invocation.id, runtimeRunId: runtime.id, assistantEntryId: assistant.id,
        workspaceId: registered.workspace.id, path: file.name, state: executed.invocation.state,
        attemptCount: executed.invocation.attemptCount, bytes: actual.byteLength,
        sha256: createHash("sha256").update(actual).digest("hex"),
        approvalResolution: repository.getApprovalRequest(prepared.approval.id).resolution,
      });
    }
    repository.updateTranscriptEntry(assistant.id, ASSISTANT_MESSAGE, "completed");
    repository.transitionRuntimeRun(runtime.id, "completed");
    repository.transitionAgentTurn(turn.id, "completed", { outcome: { kind: "sent" } });
    repository.transitionRoomRun(preparedRun.run.id, "completed");
    const followupNonce = randomUUID();
    repository.prepareMessage({ sessionId: room.session.id, clientNonce: followupNonce, text: FOLLOWUP_MESSAGE });
    const followup = repository.acknowledgeUserMessage(followupNonce);
    displayEntries.push(
      { id: preparedRun.run.triggerMessageId, at: referenceTime(41), omitRoutingBadge: true },
      { id: assistant.id, at: referenceTime(42) },
      { id: followup.id, at: referenceTime(49) },
    );
    displayConversations.push({ sessionId: room.session.id, at: referenceTime(49) });
    repository.setSetting("appearance.theme", "dark", false);
    repository.setSetting("ui.userProfile", JSON.stringify({ name: "我", avatarUrl: null }), false);
    return { roomId: room.room.id, sessionId: room.session.id, files, displayEntries, displayConversations, displayToolOrder, journalProof };
  } finally {
    repository.close();
  }
}

function applyDisplayTimestamps(databasePath: string, fixture: Awaited<ReturnType<typeof seedReference>>): void {
  const database = new DatabaseSync(databasePath);
  try {
    for (const entry of fixture.displayEntries) {
      database.prepare("UPDATE transcript_entries SET created_at = ?, updated_at = ? WHERE id = ?").run(entry.at, entry.at, entry.id);
      // A nullable display nonce omits automatic-routing decoration from this
      // preview, matching the approved image. Send/room/tool journals remain
      // intact; this fixture must never be used as message acceptance evidence.
      if (entry.omitRoutingBadge) database.prepare("UPDATE transcript_entries SET client_nonce = NULL WHERE id = ?").run(entry.id);
    }
    for (const conversation of fixture.displayConversations) {
      database.prepare("UPDATE conversation_metadata SET last_activity_at = ? WHERE session_id = ?").run(conversation.at, conversation.sessionId);
    }
    // Stable UI ordering only; success, approval, hash and byte receipts above
    // still come from the real executor and are never manufactured by this SQL.
    for (const tool of fixture.displayToolOrder) {
      database.prepare("UPDATE tool_invocations SET created_at = ? WHERE id = ?").run(tool.at, tool.id);
    }
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
}

async function captureReference(page: Page, theme: "dark" | "light", outputDir: string): Promise<void> {
  await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode()));
  });
  await expect(page.locator("article.message-user").first()).toBeInViewport();
  await expect(page.locator("article.message-user").last()).toBeInViewport();
  await page.screenshot({ path: join(outputDir, `${theme}.png`), scale: "css", animations: "disabled", caret: "hide" });
  for (const [name, selector] of [["chat", ".conversation"], ["rail", ".nav-rail"]] as const) {
    const clip = await page.locator(selector).boundingBox();
    expect(clip).not.toBeNull();
    await page.screenshot({ path: join(outputDir, `${theme}-${name}.png`), clip: clip!, scale: "css", animations: "disabled", caret: "hide" });
  }
}

test("UI-only approved light/dark reference: real avatars and journal-backed files, not Agent execution acceptance", async () => {
  test.setTimeout(60_000);
  test.info().annotations.push({ type: "scope", description: "UI-only reference rendering. Seeded Agent messages and room states are not business acceptance evidence. Browser plugin not available; using the repository Playwright Electron workflow." });
  const outputDir = process.env.AEVOREN_BOT_UI_REFERENCE_OUTPUT_DIR?.trim() || DEFAULT_OUTPUT_DIR;
  expect(isAbsolute(outputDir), "Reference screenshots must use an absolute output directory outside the checkout").toBe(true);
  const relativeOutput = relative(process.cwd(), resolve(outputDir));
  const insideCheckout = relativeOutput === "" || !isAbsolute(relativeOutput) && relativeOutput.split(/[\\/]/u)[0] !== "..";
  expect(insideCheckout, "Do not save visual artifacts inside the repository").toBe(false);
  mkdirSync(outputDir, { recursive: true });
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-ui-reference-data-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "aevoren-ui-reference-files-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  let application: ElectronApplication | undefined;
  try {
    const fixture = await seedReference(databasePath, workspaceRoot);
    applyDisplayTimestamps(databasePath, fixture);
    writeFileSync(join(outputDir, "journal-proof.json"), JSON.stringify({
      scope: "UI-only reference rendering; seeded Agent messages and room states are not business acceptance evidence.",
      pipeline: "prepareToolInvocation → resolveToolApproval(allow-once) → WorkspaceToolExecutor.execute → readFileSync + byte/hash comparison",
      files: fixture.journalProof,
    }, null, 2), "utf8");
    const width = Number(process.env.AEVOREN_BOT_UI_REFERENCE_WIDTH || 1440);
    const height = Number(process.env.AEVOREN_BOT_UI_REFERENCE_HEIGHT || 832);
    expect(Number.isInteger(width) && width >= 390).toBe(true);
    expect(Number.isInteger(height) && height >= 640).toBe(true);
    application = await electron.launch({
      args: ["."], cwd: process.cwd(),
      env: {
        ...process.env,
        TZ: "Asia/Shanghai",
        AEVOREN_BOT_USER_DATA_DIR: userDataDir,
        AEVOREN_BOT_FAKE_PROVIDER: "1",
        AEVOREN_BOT_TEST_HIDDEN: "1",
        AEVOREN_BOT_ATTACHMENT_TEST_PATHS: join(workspaceRoot, fixture.files[0]!.name),
      },
    });
    const page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await application.evaluate(({ BrowserWindow }, viewport) => BrowserWindow.getAllWindows()[0]?.setContentSize(viewport.width, viewport.height), { width, height });
    await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([width, height]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isVisible()))).toBe(true);
    await expect(page).toHaveTitle("Aevoren Bot");
    expect(page.url()).toMatch(/^(file:|https?:)/u);
    await page.locator('.sidebar-list .bot-row[aria-label="个人网站小组"]').click();
    await expect(page.locator(".conversation-header h1")).toHaveText("个人网站小组");
    await expect(page.locator(".conversation-header-counts")).toHaveText("3 位 Agent");
    await expect(page.locator(".sidebar-list .bot-row")).toHaveCount(8);
    await expect(page.locator(".conversation-header button")).toHaveCount(1);
    await expect(page.locator("article.message-user")).toHaveCount(2);
    await expect(page.locator("article.message-assistant")).toHaveCount(1);
    await expect(page.locator(".artifact-card")).toHaveCount(2);
    await expect(page.locator(".artifact-card").first()).toContainText("个人网站建议书.md");
    await expect(page.locator(".artifact-card").last()).toContainText("上线清单.md");
    await expect(page.getByRole("button", { name: "查看协作详情", exact: true })).toBeVisible();
    await expect(page.locator(".message-evidence-panel")).toHaveCount(0);
    await expect(page.locator(".inspector")).not.toBeVisible();
    const journal = await page.evaluate((sessionId) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.tools.list({ sessionId }), fixture.sessionId);
    expect(journal.ok && journal.data.map((invocation) => ({ path: invocation.targetPath, state: invocation.state }))).toEqual([
      { path: "个人网站建议书.md", state: "succeeded" },
      { path: "上线清单.md", state: "succeeded" },
    ]);
    await page.getByRole("button", { name: "添加文本附件", exact: true }).click();
    await expect(page.locator(".attachment-chip")).toHaveCount(1);
    await page.getByLabel("消息", { exact: true }).fill("继续讨论这份文件…");
    for (const theme of ["dark", "light"] as const) {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByLabel("外观主题").selectOption(theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
      await expect.poll(() => page.locator(".nav-rail img, .sidebar-list img, .conversation img").evaluateAll((images) => images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
      const uniqueAvatars = await page.locator(".nav-rail img, .sidebar-list img, .conversation img").evaluateAll((images) => new Set(images.map((image) => (image as HTMLImageElement).currentSrc)).size);
      expect(uniqueAvatars).toBe(8);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(page.locator("vite-error-overlay, #webpack-dev-server-client-overlay")).toHaveCount(0);
      await captureReference(page, theme, outputDir);
    }
    expect(consoleErrors).toEqual([]);
    for (const file of fixture.files) expect(readFileSync(join(workspaceRoot, file.name), "utf8")).toBe(file.content);
  } finally {
    if (application) await application.close();
    removeTestDirectory(userDataDir);
    removeTestDirectory(workspaceRoot);
  }
});
