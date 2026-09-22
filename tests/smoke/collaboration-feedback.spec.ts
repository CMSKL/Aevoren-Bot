import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { PromptManifest } from "@shared/contracts";
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
  const content = "# 候选 A\n# 候选 B\n# 候选 C\n";
  const longBriefBody = `# 结论\n三个候选 Brief 已写入，等待你批准。\n\n# 交付物\n02-briefs/options.md\n\n# 下一步\n请选择候选 A、B 或 C。\n\n# 详细证据\n${"这是用于验证长消息折叠且保持原始内容可访问的真实界面文本。".repeat(45)}\nUNIQUE_LONG_DETAIL_END`;
  writeFileSync(join(workspaceRoot, "02-briefs", "options.md"), content, "utf8");
  const registered = await new WorkspaceService(repository).registerRoot(workspaceRoot);
  repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: true });
  const clientNonce = randomUUID();
  repository.prepareMessage({ sessionId: team.room.session.id, clientNonce, text: "生成三个候选，然后等待人工选题批准。" });
  repository.acknowledgeUserMessage(clientNonce);
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
    sourceTurnId: randomUUID(),
    blocks: [],
    digest: "workflow-ux-seed",
  };
  let runtime = repository.createRuntimeRun(clientNonce, "fake", manifest, { executorBotId: planner.id, executionKey: "workflow-ux-seed" });
  runtime = repository.transitionRuntimeRun(runtime.id, "dispatching");
  runtime = repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "workflow-ux-seed" });
  const assistant = repository.createAssistantEntry(team.room.session.id, { speakerBotId: planner.id, speakerNameSnapshot: planner.name });
  runtime = repository.attachAssistantEntry(runtime.id, assistant.id);
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
  repository.updateTranscriptEntry(assistant.id, longBriefBody, "completed");
  repository.transitionRuntimeRun(runtime.id, "completed");
  repository.setSetting("appearance.theme", "dark", false);
  repository.close();

  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AEVOREN_BOT_USER_DATA_DIR: userDataDir,
      AEVOREN_BOT_FAKE_PROVIDER: "1",
      AEVOREN_BOT_FAKE_FAILURE: "first-run-after-delta",
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
    await expect(briefMessage.getByRole("region", { name: "交付物状态" })).toContainText("02-briefs/options.md");
    await expect(page.locator(".conversation-header").getByTestId("brief-approval-card")).toHaveCount(0);
    await expect(approvalCard.getByRole("radio", { name: /候选 A/u })).toBeVisible();
    await expect(approvalCard.getByRole("button", { name: "批准并交给主笔", exact: true })).toBeDisabled();
    await expect(page.getByRole("region", { name: "交付物状态" }).getByText("02-briefs/options.md", { exact: true })).toBeVisible();
    await expect(page.getByText(/文件已保存 1 个/u)).toBeVisible();
    await page.getByRole("region", { name: "交付物状态" }).getByRole("button", { name: "打开文件位置" }).click();
    await expect(page.getByText("结论、交付物与下一步", { exact: true })).toBeVisible();
    await expect(page.getByText(/UNIQUE_LONG_DETAIL_END/u)).toHaveCount(0);
    await page.getByRole("button", { name: "展开证据与完整过程" }).click();
    await expect(page.getByText(/UNIQUE_LONG_DETAIL_END/u)).toBeVisible();
    await page.getByRole("button", { name: "收起详细内容" }).click();

    await approvalCard.getByRole("radio", { name: /候选 A/u }).check();
    await expect(approvalCard.getByRole("button", { name: "批准并交给主笔", exact: true })).toBeEnabled();
    await approvalCard.getByRole("button", { name: "批准并交给主笔", exact: true }).click();
    const failure = page.locator(".composer-run-status").getByRole("alert");
    await expect(failure).toContainText("选题策划师失败");
    await expect(failure).toContainText("已完成到");
    await expect(failure).toContainText("仍然有效");
    await expect(failure).toContainText("下一步");
    await failure.getByRole("button", { name: "重试此步骤" }).click();
    await expect(page.locator(".superseded-attempt-note")).toContainText("较早失败版本，已由后续重试替代");
    await expect(page.locator('article.message-assistant[data-status="completed"]').last()).toBeAttached();
    await expect(page.getByTestId("brief-approval-card")).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
    removeTestDirectory(workspaceRoot);
  }
});
