import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi, PromptManifest } from "@shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { removeTestDirectory } from "./test-cleanup";

test("shows contextual approval, failure recovery, and artifact evidence without a persistent stage tracker", async () => {
  test.setTimeout(45_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-workflow-ux-data-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "aevoren-workflow-ux-root-"));
  const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
  const team = repository.createContentTeamTemplate();
  const planner = team.bots.find((bot) => bot.name === "选题策划师")!;
  mkdirSync(join(workspaceRoot, "02-briefs"));
  const content = `# 候选 A\n标题：证据链设计\n核心角度：真实执行证据\n证据来源：research.md\n风险：样本范围有限\n推荐理由：上下游依据最完整\n\n# 候选 B\n标题：自动接力\n核心角度：跨 Runtime 交接\n\n# 候选 C\n标题：人工门禁\n核心角度：高风险操作控制\n`;
  const longBriefBody = `# 结论\n三个候选 Brief 已写入，等待你批准。\n\n## 候选 A\n标题：证据链设计\n核心角度：真实执行证据\n证据来源：research.md\n风险：样本范围有限\n推荐理由：上下游依据最完整\n\n## 候选 B\n标题：自动接力\n核心角度：跨 Runtime 交接\n\n## 候选 C\n标题：人工门禁\n核心角度：高风险操作控制\n\n# 交付物\n02-briefs/options.md\n\n# 下一步\n请选择候选 A、B 或 C。\n\n# 详细证据\n${"这是用于验证长消息折叠且保持原始内容可访问的真实界面文本。".repeat(45)}\nUNIQUE_LONG_DETAIL_END`;
  writeFileSync(join(workspaceRoot, "02-briefs", "options.md"), content, "utf8");
  const registered = await new WorkspaceService(repository).registerRoot(workspaceRoot);
  repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: true });
  const clientNonce = randomUUID();
  const roomRun = repository.createRoomRunWithInitialTurns({
    roomId: team.room.room.id,
    sessionId: team.room.session.id,
    clientNonce,
    text: "生成三个候选，然后等待人工选题批准。",
    membershipVersion: team.room.room.membershipVersion,
    maxTurns: 8,
    maxHops: 3,
    maxTargetsPerTurn: 2,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    initialTurns: [{ agentId: planner.id, nonce: randomUUID() }],
    routingMode: "automatic",
    routingReason: "UI regression fixture: completed planning turn",
    orchestrationEnabled: true,
  });
  const sourceTurn = roomRun.turns[0]!;
  repository.transitionRoomRun(roomRun.run.id, "running");
  repository.transitionAgentTurn(sourceTurn.id, "running", { promptCutoffSeq: sourceTurn.inputSeq });
  const manifest: PromptManifest = {
    schemaVersion: 4,
    botId: planner.id,
    profileVersion: planner.version,
    sessionId: team.room.session.id,
    generation: 1,
    inputSeq: 1,
    promptCutoffSeq: 1,
    roomId: team.room.room.id,
    roomMembershipVersion: team.room.room.membershipVersion,
    executorBotId: planner.id,
    sourceTurnId: sourceTurn.id,
    blocks: [],
    digest: "workflow-ux-seed",
  };
  let runtime = repository.createRuntimeRun(clientNonce, "fake", manifest, { executorBotId: planner.id, executionKey: `${roomRun.run.id}:${sourceTurn.logicalTurnId}` });
  repository.attachRoomTurnRuntime(sourceTurn.id, runtime.id);
  runtime = repository.transitionRuntimeRun(runtime.id, "dispatching");
  runtime = repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "workflow-ux-seed" });
  const assistant = repository.createAssistantEntry(team.room.session.id, { speakerBotId: planner.id, speakerNameSnapshot: planner.name, sourceTurnId: sourceTurn.id });
  runtime = repository.attachAssistantEntry(runtime.id, assistant.id);
  const readPrepared = repository.prepareToolInvocation({
    runtimeRunId: runtime.id,
    toolCallId: "read-brief-source",
    idempotencyKey: randomUUID(),
    tool: { kind: "workspace-read", workspaceId: registered.workspace.id, path: "02-briefs/options.md", maxBytes: 65_536 },
  });
  repository.resolveToolApproval(readPrepared.approval.id, readPrepared.approval.version, "allow-once");
  repository.transitionToolInvocation(readPrepared.invocation.id, "dispatching");
  repository.transitionToolInvocation(readPrepared.invocation.id, "running");
  repository.completeToolInvocation(readPrepared.invocation.id, createHash("sha256").update(content).digest("hex"), {
    bytes: Buffer.byteLength(content),
    truncated: false,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  const prepared = repository.prepareToolInvocation({
    runtimeRunId: runtime.id,
    toolCallId: "write-brief",
    idempotencyKey: randomUUID(),
    tool: { kind: "workspace-write", workspaceId: registered.workspace.id, path: "02-briefs/options.md", content },
  });
  repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
  repository.transitionToolInvocation(prepared.invocation.id, "dispatching");
  repository.transitionToolInvocation(prepared.invocation.id, "running");
  repository.completeToolInvocation(prepared.invocation.id, createHash("sha256").update(content).digest("hex"), {
    path: "02-briefs/options.md",
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    created: true,
  });
  repository.updateTranscriptEntry(assistant.id, longBriefBody.replace("标题：证据链设计", "标题：这不是文件中的真实候选标题"), "completed");
  repository.transitionRuntimeRun(runtime.id, "completed");
  repository.transitionAgentTurn(sourceTurn.id, "completed", { outcome: { kind: "sent" } });
  repository.transitionRoomRun(roomRun.run.id, "completed");
  const ordinaryApprovalNonce = randomUUID();
  repository.prepareMessage({ sessionId: team.room.session.id, clientNonce: ordinaryApprovalNonce, text: "APPROVED：批准候选 B（普通文字，没有有效审批凭证）" });
  repository.acknowledgeUserMessage(ordinaryApprovalNonce);
  repository.setSetting("appearance.theme", "dark", false);
  repository.close();

  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AEVOREN_BOT_USER_DATA_DIR: userDataDir,
      AEVOREN_BOT_FAKE_PROVIDER: "1",
      AEVOREN_BOT_FAKE_FAILURE: "first-run-before-start",
      AEVOREN_BOT_FAKE_DELAY_MS: "5",
      AEVOREN_BOT_TEST_HIDDEN: "1",
    },
  });
  try {
    const page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.locator(".bot-row").filter({ hasText: "自媒体内容团队" }).click();
    const approvalCard = page.getByTestId("brief-approval-card");
    const briefMessage = approvalCard.locator("xpath=ancestor::article[contains(@class, 'message-assistant')]");
    await expect(approvalCard).toBeVisible();
    await expect(page.locator("article.message-user").filter({ hasText: "普通文字，没有有效审批凭证" })).toBeVisible();
    await expect(briefMessage.getByRole("region", { name: "交付物状态" })).toContainText("02-briefs/options.md");
    await expect(briefMessage.getByTestId("tool-activity-run")).toContainText("已完成 2 个步骤");
    await expect(briefMessage.getByTestId("workspace-tool-activity")).toHaveCount(2);
    await expect(page.getByRole("button", { name: /保存为 Markdown/u })).toHaveCount(0);
    await expect(page.locator(".conversation-header").getByTestId("brief-approval-card")).toHaveCount(0);
    await expect(approvalCard.getByRole("radio", { name: /证据链设计/u })).toBeVisible();
    await expect(approvalCard).not.toContainText("这不是文件中的真实候选标题");
    await expect(approvalCard.getByRole("button", { name: "批准并交给主笔", exact: true })).toBeDisabled();
    await expect(page.getByRole("region", { name: "交付物状态" }).getByText("02-briefs/options.md", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "交付物状态" })).toContainText("1 个成果");
    const artifactsButton = page.getByRole("button", { name: "打开会话成果，共 1 个" });
    await expect(artifactsButton).toBeVisible();
    await artifactsButton.click();
    await expect(page.getByRole("complementary", { name: "会话成果" })).toContainText("options.md");
    await page.screenshot({ path: join(tmpdir(), "aevoren-artifact-shelf.png") });
    await page.getByRole("button", { name: "关闭会话成果" }).last().click();
    await page.getByRole("region", { name: "交付物状态" }).getByRole("button", { name: "打开文件位置" }).click();
    await expect(page.getByText("结论、交付物与下一步", { exact: true })).toBeVisible();
    await expect(page.getByText(/UNIQUE_LONG_DETAIL_END/u)).toHaveCount(0);
    await page.getByRole("button", { name: "展开证据与完整过程" }).click();
    await expect(page.getByText(/UNIQUE_LONG_DETAIL_END/u)).toBeVisible();
    await page.getByRole("button", { name: "收起详细内容" }).click();

    await approvalCard.getByRole("radio", { name: /证据链设计/u }).check();
    await expect(approvalCard).toContainText("证据链设计");
    await expect(approvalCard).toContainText("真实执行证据");
    await expect(approvalCard).toContainText("research.md");
    await expect(approvalCard).toContainText("样本范围有限");
    await expect(approvalCard).toContainText("上下游依据最完整");
    await expect(approvalCard.getByRole("button", { name: "批准并交给主笔", exact: true })).toBeEnabled();
    for (const width of [1440, 1180, 1020, 620, 390]) {
      await application.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0]?.setSize(nextWidth, 900), width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      await approvalCard.scrollIntoViewIfNeeded();
      expect(await approvalCard.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (width === 1440 || width === 1180 || width === 390) await page.screenshot({ path: join(tmpdir(), `aevoren-authoritative-brief-${width}.png`) });
    }
    // Actual disk integrity must be checked again at approval, not just at preview.
    writeFileSync(join(workspaceRoot, "02-briefs/options.md"), `${content}\nChanged after preview.`, "utf8");
    await approvalCard.getByRole("button", { name: "批准并交给主笔", exact: true }).click();
    await expect(approvalCard.getByRole("alert")).toContainText("本次决定未能提交");
    await expect(approvalCard.getByRole("radio", { name: /证据链设计/u })).toBeChecked();
    const rejectedSnapshot = await page.evaluate((roomId) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.getSnapshot(roomId), team.room.room.id);
    expect(rejectedSnapshot.ok && rejectedSnapshot.data.batches.length).toBe(1);
    writeFileSync(join(workspaceRoot, "02-briefs/options.md"), content, "utf8");
    await approvalCard.getByRole("button", { name: "批准并交给主笔", exact: true }).click();
    const failure = page.locator(".composer-run-status").getByRole("alert");
    await expect(page.locator(".composer-run-status .run-status-card")).toHaveCount(1);
    await expect(failure).toContainText("内容主笔失败");
    await expect(failure).toContainText("已完成到");
    await expect(failure).toContainText("仍然有效");
    await expect(failure).toContainText("下一步");
    await page.screenshot({ path: join(tmpdir(), "aevoren-room-failure-ui-fallback.png") });
    await failure.getByRole("button", { name: "重试此步骤" }).click();
    await expect(page.locator('article.message-assistant[data-status="completed"]').last()).toBeAttached();
    await expect(page.getByTestId("room-batch-state")).toHaveCount(0);
    await expect(page.getByTestId("brief-approval-card")).toHaveCount(0);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 900));
    await page.reload();
    await page.locator(".bot-row").filter({ hasText: "自媒体内容团队" }).click();
    await expect(page.getByRole("heading", { name: "自媒体内容团队" })).toBeVisible();
    const approvedView = await page.evaluate(({ roomId, sourceRuntimeRunId }) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.rooms.getBriefApproval({ roomId, sourceRuntimeRunId }), { roomId: team.room.room.id, sourceRuntimeRunId: runtime.id });
    expect(approvedView.ok && approvedView.data.approved).toBe(true);
    await expect(page.getByTestId("brief-approval-card")).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
    removeTestDirectory(workspaceRoot);
  }
});

test("keeps a recoverable partial-reply failure card beside the Bot message", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-room-failure-inline-"));
  const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
  const first = repository.createBot().bot;
  const second = repository.createBot().bot;
  const room = repository.createRoom({ name: "部分回复失败群聊", memberBotIds: [first.id, second.id] });
  const clientNonce = randomUUID();
  const prepared = repository.createRoomRunWithInitialTurns({
    roomId: room.room.id,
    sessionId: room.session.id,
    clientNonce,
    text: "生成草稿",
    membershipVersion: room.room.membershipVersion,
    maxTurns: 8,
    maxHops: 3,
    maxTargetsPerTurn: 2,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    initialTurns: [{ agentId: first.id, nonce: randomUUID() }],
    routingMode: "automatic",
    routingReason: "UI fixture: failed after partial output",
    orchestrationEnabled: true,
  });
  const turn = prepared.turns[0]!;
  repository.transitionRoomRun(prepared.run.id, "running");
  repository.transitionAgentTurn(turn.id, "running", { promptCutoffSeq: turn.inputSeq });
  const manifest: PromptManifest = {
    schemaVersion: 4,
    botId: first.id,
    profileVersion: first.version,
    sessionId: room.session.id,
    generation: room.session.generation,
    inputSeq: turn.inputSeq,
    promptCutoffSeq: turn.inputSeq,
    roomId: room.room.id,
    roomMembershipVersion: room.room.membershipVersion,
    executorBotId: first.id,
    sourceTurnId: turn.id,
    blocks: [],
    digest: "partial-reply-failure-ui",
  };
  let runtime = repository.createRuntimeRun(clientNonce, "fake", manifest, {
    executorBotId: first.id,
    executionKey: `${prepared.run.id}:${turn.logicalTurnId}`,
  });
  repository.attachRoomTurnRuntime(turn.id, runtime.id);
  runtime = repository.transitionRuntimeRun(runtime.id, "dispatching");
  runtime = repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "partial-reply-failure-ui" });
  const assistant = repository.createAssistantEntry(room.session.id, {
    speakerBotId: first.id,
    speakerNameSnapshot: first.name,
    sourceTurnId: turn.id,
  });
  repository.attachAssistantEntry(runtime.id, assistant.id);
  repository.updateTranscriptEntry(assistant.id, "已形成一段草稿，但回复未完成。", "failed");
  repository.transitionRuntimeRun(runtime.id, "failed", { errorCode: "MODEL_STREAM_TRUNCATED" });
  repository.transitionAgentTurn(turn.id, "failed", { errorCode: "MODEL_STREAM_TRUNCATED", outcome: { kind: "error" } });
  repository.transitionRoomRun(prepared.run.id, "partial");
  repository.setSetting("appearance.theme", "dark", false);
  repository.close();

  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      env: {
        ...process.env,
        AEVOREN_BOT_USER_DATA_DIR: userDataDir,
        AEVOREN_BOT_FAKE_PROVIDER: "1",
        AEVOREN_BOT_TEST_HIDDEN: "1",
      },
    });
    const page = await application.firstWindow();
    await page.locator(".bot-row").filter({ hasText: room.room.name }).click();
    await expect(page.locator("article.message-assistant[data-status=\"failed\"]")).toContainText("已形成一段草稿");
    const failure = page.locator(".room-inline-failure").getByRole("alert");
    await expect(failure).toContainText("回复未完整完成");
    await expect(failure.getByRole("button", { name: "重试此步骤" })).toBeEnabled();
    await expect(page.locator(".composer-run-status .run-status-card")).toHaveCount(0);
    await page.screenshot({ path: join(tmpdir(), "aevoren-room-failure-ui-inline.png") });
    for (const width of [1180, 1020, 620, 390]) {
      await application.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0]?.setSize(nextWidth, 900), width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      expect(await failure.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 900));
  } finally {
    if (application) await application.close();
    removeTestDirectory(userDataDir);
  }
});
