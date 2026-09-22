import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi } from "@shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";

const isolatedDatabase = process.env.AEVOREN_BOT_REAL_PROVIDER_DB_PATH;
const releasesEndpoint = "repos/CMSKL/Aevoren-Bot/releases?per_page=10";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

type Release = {
  id: number; tag_name: string; html_url: string; published_at: string; draft: boolean;
  assets: Array<{ id: number; name: string; size: number; download_count: number; browser_download_url: string }>;
};

function temporaryPath(path: string): string {
  const canonical = realpathSync(path);
  if (![realpathSync("/tmp"), realpathSync(tmpdir())].some((root) => canonical.startsWith(`${root}${sep}`))) {
    throw new Error("Real acceptance requires an isolated database and output directory inside a temporary directory.");
  }
  return canonical;
}

function collectEvidence(database: DatabaseSync, roomId: string, sessionId: string) {
  return {
    batches: database.prepare("SELECT * FROM room_batches WHERE room_id = ? ORDER BY created_at,rowid").all(roomId),
    turns: database.prepare("SELECT * FROM room_turns WHERE batch_id IN (SELECT id FROM room_batches WHERE room_id = ?) ORDER BY created_at,rowid").all(roomId),
    handoffs: database.prepare("SELECT * FROM agent_handoffs WHERE run_id IN (SELECT id FROM room_batches WHERE room_id = ?) ORDER BY created_at,rowid").all(roomId),
    // Deliberately scoped to the new public-data task; never export settings, credentials or other conversations.
    runtimes: database.prepare("SELECT id,executor_bot_id,state,route,provider_instance_id,provider_model_id,assistant_entry_id,prompt_manifest_json,last_error_code,created_at,accepted_at,finished_at FROM runtime_runs WHERE session_id = ? ORDER BY created_at,rowid").all(sessionId),
    tools: database.prepare("SELECT * FROM tool_invocations WHERE session_id = ? ORDER BY created_at,rowid").all(sessionId),
    transcript: database.prepare("SELECT * FROM transcript_entries WHERE session_id = ? ORDER BY seq").all(sessionId),
  };
}

async function waitForStage(page: Page, database: DatabaseSync, roomId: string, sessionId: string, stage: "approval" | "report", reportPath: string): Promise<void> {
  const deadline = Date.now() + 8 * 60_000;
  let terminalSince: number | null = null;
  while (Date.now() < deadline) {
    const failed = database.prepare("SELECT id,state,last_error_code FROM runtime_runs WHERE session_id = ? AND state IN ('failed','cancelled','interrupted')").all(sessionId);
    const badBatches = database.prepare("SELECT id,state FROM room_batches WHERE room_id = ? AND state IN ('partial','cancelled','interrupted')").all(roomId);
    if (failed.length || badBatches.length) throw new Error(`Real chain failed before ${stage}: ${JSON.stringify({ failed, badBatches })}`);
    const batches = database.prepare("SELECT state FROM room_batches WHERE room_id = ? ORDER BY created_at,rowid").all(roomId);
    const expectedBatches = stage === "approval" ? 1 : 2;
    const settled = batches.length >= expectedBatches && batches.every((batch) => batch.state === "completed");
    const visibleApproval = await page.getByTestId("brief-approval-card").isVisible();
    if (settled && (stage === "approval" ? visibleApproval : existsSync(reportPath) && !visibleApproval)) return;
    if (settled) {
      terminalSince ??= Date.now();
      if (Date.now() - terminalSince > 3_000) throw new Error(`Real chain ended before ${stage}; no manual continuation is allowed.`);
    } else terminalSince = null;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`Real chain timed out waiting for ${stage}; evidence was retained.`);
}

test("runs the real content team from public release research through approval, review and observed asset-data report", async () => {
  test.skip(!isolatedDatabase, "requires AEVOREN_BOT_REAL_PROVIDER_DB_PATH pointing to an isolated configured database copy");
  test.setTimeout(18 * 60_000);
  const databasePath = temporaryPath(isolatedDatabase!);
  const requestedOutput = process.env.AEVOREN_BOT_REAL_TEAM_OUTPUT_DIR;
  const output = requestedOutput ? resolve(requestedOutput) : mkdtempSync("/tmp/aevoren-content-team-real-");
  mkdirSync(output, { recursive: true });
  temporaryPath(output);
  const root = join(output, "workspace");
  // A fresh workspace prevents an old report from accidentally satisfying this run.
  mkdirSync(root);
  const suffix = Date.now().toString(36);
  const roomName = `公开 Beta 内容协作-${suffix}`;
  const outputPaths = {
    research: `01-inbox/research-${suffix}.md`, brief: `02-briefs/brief-${suffix}.md`,
    draft: `03-drafts/draft-${suffix}.md`, review: `04-review/review-${suffix}.md`,
    csv: `05-data/release-assets-${suffix}.csv`, report: `06-reports/report-${suffix}.md`,
  };
  for (const folder of ["01-inbox", "02-briefs", "03-drafts", "04-review", "05-data", "06-reports"]) mkdirSync(join(root, folder));
  writeFileSync(join(root, "voice.md"), "# 对外产品更新文案\n简洁、准确，面向 Aevoren Bot 用户；只引用已核验的公开 Release 信息。不得虚构功能、口碑、用户数或社媒指标。\n", "utf8");

  // This is a real public GitHub API snapshot, not a generated analytics fixture.
  const fetchedAt = new Date().toISOString();
  const raw = execFileSync("gh", ["api", releasesEndpoint, "--hostname", "github.com"], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const releases = JSON.parse(raw) as Release[];
  const release = releases.find((item) => !item.draft && item.assets.length > 0);
  expect(release, "No public release with real asset records is available").toBeDefined();
  for (const asset of release!.assets) {
    expect(Number.isSafeInteger(asset.size) && asset.size >= 0).toBe(true);
    expect(Number.isSafeInteger(asset.download_count) && asset.download_count >= 0).toBe(true);
  }
  const sourceUrl = `https://api.github.com/repos/CMSKL/Aevoren-Bot/releases/${release!.id}`;
  const quote = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = "asset_id,asset_name,size_bytes,download_count,release_tag,published_at,observed_at,source_url\n" +
    release!.assets.map((asset) => [asset.id, asset.name, asset.size, asset.download_count, release!.tag_name, release!.published_at, fetchedAt, sourceUrl].map(quote).join(",")).join("\n") + "\n";
  const expectedMetrics = {
    asset_count: release!.assets.length,
    total_size_bytes: release!.assets.reduce((total, asset) => total + asset.size, 0),
    total_download_count: release!.assets.reduce((total, asset) => total + asset.download_count, 0),
  };
  const provenance = { source: sourceUrl, collectionEndpoint: `https://api.github.com/${releasesEndpoint}`, fetchedAt, tag: release!.tag_name, publishedAt: release!.published_at, rawSha256: hash(raw), csvSha256: hash(csv), dataKind: "Observed public release-asset distribution statistics; not user social-media analytics", expectedMetrics };
  writeFileSync(join(root, outputPaths.csv), csv, "utf8");
  writeFileSync(join(output, "public-source-snapshot.json"), raw, "utf8");
  writeFileSync(join(output, "input-provenance.json"), JSON.stringify(provenance, null, 2), "utf8");

  const repository = new AppRepository(databasePath);
  let roomId: string;
  let sessionId: string;
  try {
    expect(repository.getDefaultModelSelection().providerInstanceId, "Configured real API must be selected in the isolated copy").toBe("openai-compatible.default");
    // The database is a copy. Prevent copied Routines from initiating unrelated requests.
    for (const routine of repository.listRoutines()) if (routine.enabled) repository.setRoutineEnabled(routine.id, routine.version, false, null);
    for (const run of repository.listPendingRoutineRuns()) repository.transitionRoutineRun(run.id, "cancelled");
    for (const workspace of repository.listWorkspaces()) repository.removeWorkspace(workspace.id, workspace.version);
    const registered = await new WorkspaceService(repository).registerRoot(root);
    repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: true });
    repository.setSetting("tools.autoApprovePublicRead", "true", false);
    repository.deleteSetting("template.content-team.roomId");
    const team = repository.createContentTeamTemplate();
    roomId = repository.updateRoom(team.room.room.id, team.room.room.version, { name: roomName }).id;
    sessionId = team.room.session.id;
  } finally { repository.close(); }

  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith("AEVOREN_BOT_FAKE_") && !["AEVOREN_BOT_DB_PATH", "AEVOREN_BOT_USER_DATA_DIR"].includes(entry[0]),
  ));
  const testUserData = join(output, "isolated-app-data");
  mkdirSync(testUserData);
  environment.AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE = "1";
  environment.AEVOREN_BOT_DB_PATH = databasePath;
  environment.AEVOREN_BOT_USER_DATA_DIR = testUserData;
  environment.AEVOREN_BOT_TEST_HIDDEN = "1";
  let application: ElectronApplication | null = null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec("PRAGMA busy_timeout = 2000");
  const consoleErrors: string[] = [];
  let passed = false;
  let failure: string | null = null;
  const startedAt = new Date().toISOString();
  try {
    application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    const page = await application.firstWindow();
    page.on("pageerror", (error) => consoleErrors.push(error.name));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push("renderer-console-error"); });
    const connection = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.providers.test("openai-compatible.default"));
    expect(connection.ok, connection.ok ? undefined : connection.error.code).toBe(true);
    await page.locator(".bot-row").filter({ hasText: roomName }).click();
    await expect(page.getByRole("heading", { name: roomName })).toBeVisible();
    await page.getByLabel("消息").fill(
      `为 Aevoren Bot 当前公开 Beta ${release!.tag_name} 制作一份准确的产品更新公告并复盘公开下载资产数据。` +
      `从情报侦察员开始自动团队协作，真实读取官方 Release API ${sourceUrl}，公开页面 ${release!.html_url}；不要发布到外部。` +
      `按顺序产出 ${outputPaths.research}、${outputPaths.brief}。Brief 给出 A/B/C 三个互斥候选，每个写明标题、核心角度、证据来源、风险和推荐理由；然后等我点击批准。` +
      `批准后继续自动产出 ${outputPaths.draft}、${outputPaths.review}，事实编辑完成后交给数据复盘师。` +
      `明确授权复盘师真实读取 ${outputPaths.csv}，这是 ${fetchedAt} 采集的 GitHub Release 资产快照，不是社媒曝光或转化数据。` +
      `只根据 CSV 的真实行与 size_bytes、download_count 字段计算 asset_count、total_size_bytes、total_download_count；不要估算或虚构用户数。` +
      `最终把来源路径、观察时间、字段定义、口径和局限写到 ${outputPaths.report}，并包含一个 JSON 代码块，三个数值键恰好为 asset_count、total_size_bytes、total_download_count。` +
      `使用 voice.md。所有文件由 Bot 真实工具写入；阶段间由系统自动交接，不要求我指定 Bot、重新告知路径或手动保存。`,
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await waitForStage(page, database, roomId, sessionId, "approval", join(root, outputPaths.report));
    const approvalCard = page.getByTestId("brief-approval-card");
    await page.locator(".conversation").screenshot({ path: join(output, "brief-awaiting-approval.png") });
    await approvalCard.getByRole("radio", { name: /候选 A/u }).check();
    await approvalCard.getByRole("button", { name: "批准并交给主笔", exact: true }).click();
    await waitForStage(page, database, roomId, sessionId, "report", join(root, outputPaths.report));
    await page.locator(".conversation").screenshot({ path: join(output, "completed-chain.png") });

    const evidence = collectEvidence(database, roomId, sessionId);
    expect(evidence.batches.map((batch) => ({ routing: batch.routing_mode, orchestration: batch.orchestration_enabled, state: batch.state }))).toEqual([
      { routing: "automatic", orchestration: 1, state: "completed" }, { routing: "automatic", orchestration: 1, state: "completed" },
    ]);
    expect(evidence.turns.map((turn) => ({ name: turn.member_name_snapshot, state: turn.state }))).toEqual([
      { name: "情报侦察员", state: "completed" }, { name: "选题策划师", state: "completed" },
      { name: "内容主笔", state: "completed" }, { name: "事实编辑", state: "completed" }, { name: "数据复盘师", state: "completed" },
    ]);
    expect(evidence.handoffs).toHaveLength(3);
    expect(evidence.handoffs.every((handoff) => handoff.state === "accepted")).toBe(true);
    expect(evidence.runtimes).toHaveLength(5);
    expect(evidence.runtimes.every((runtime) => runtime.route === "openai-compatible" && runtime.state === "completed" && !runtime.last_error_code)).toBe(true);
    expect(evidence.transcript.filter((entry) => entry.role === "user")).toHaveLength(2);
    expect(evidence.tools.length).toBeGreaterThan(0);
    const failedExternalReads = evidence.tools.filter((tool) => tool.state !== "succeeded" && ["web-fetch", "web-search"].includes(String(tool.tool_kind)));
    const failedCriticalTools = evidence.tools.filter((tool) => tool.state !== "succeeded" && !["web-fetch", "web-search"].includes(String(tool.tool_kind)));
    expect(failedCriticalTools, "Workspace, computation and local tool failures cannot be accepted as a completed chain").toEqual([]);
    expect(failedExternalReads.every((tool) => tool.last_error_code && !tool.result_digest)).toBe(true);
    if (failedExternalReads.length > 0) {
      const disclosedFailures = `${readFileSync(join(root, outputPaths.research), "utf8")}\n${readFileSync(join(root, outputPaths.review), "utf8")}`;
      expect(disclosedFailures).toMatch(/NETWORK_TOOL_|未.{0,12}(?:成功|取到|取得)|失败/iu);
    }
    expect(evidence.tools.filter((tool) => tool.state === "succeeded").every((tool) => tool.result_digest && tool.finished_at)).toBe(true);
    expect(evidence.tools.some((tool) => ["web-fetch", "web-search"].includes(String(tool.tool_kind)) && tool.state === "succeeded")).toBe(true);
    for (const path of Object.values(outputPaths).filter((path) => path !== outputPaths.csv)) {
      const writes = evidence.tools.filter((tool) => tool.tool_kind === "workspace-write" && tool.target_path === path);
      expect(writes, `One actual write for ${path}`).toHaveLength(1);
      const bytes = readFileSync(join(root, path));
      expect(bytes.length).toBeGreaterThan(0);
      expect(JSON.parse(String(writes[0]!.result_metadata_json))).toMatchObject({ sha256: hash(bytes), bytes: bytes.length });
    }
    const downstream = evidence.turns.slice(1);
    expect(downstream.every((turn) => turn.execution_receipt_json !== null)).toBe(true);
    for (const turn of downstream) {
      const receipt = JSON.parse(String(turn.execution_receipt_json));
      expect(receipt.taskRequirements.text).toContain(outputPaths.report);
      expect(receipt.tools.length).toBeGreaterThan(0);
      expect(receipt.artifacts.length).toBeGreaterThan(0);
      for (const artifact of receipt.artifacts) expect(hash(readFileSync(join(root, artifact.path)))).toBe(artifact.sha256);
    }
    const writerReceipt = JSON.parse(String(evidence.turns[2]!.execution_receipt_json));
    expect(writerReceipt.approvedBrief.candidate).toBe("A");
    expect(writerReceipt.artifacts.some((artifact: { path: string }) => artifact.path === outputPaths.brief)).toBe(true);
    const csvReads = evidence.tools.filter((tool) => tool.tool_kind === "workspace-read" && tool.target_path === outputPaths.csv);
    expect(csvReads.length).toBeGreaterThan(0);
    expect(csvReads.every((tool) => JSON.parse(String(tool.result_metadata_json)).sha256 === provenance.csvSha256)).toBe(true);
    const reportWrite = evidence.tools.find((tool) => tool.tool_kind === "workspace-write" && tool.target_path === outputPaths.report)!;
    expect(csvReads.some((tool) => tool.runtime_run_id === reportWrite.runtime_run_id && String(tool.finished_at) <= String(reportWrite.started_at))).toBe(true);
    const report = readFileSync(join(root, outputPaths.report), "utf8");
    const metrics = [...report.matchAll(/```json\s*([\s\S]*?)```/gu)].map((match) => JSON.parse(match[1]!)).find((value) => value.asset_count !== undefined);
    expect(metrics, "Computed report metrics must match independent calculations from the observed API data").toMatchObject(expectedMetrics);
    expect(report, "No unrequested mental-arithmetic conversions or percentages may supplement Host-verified metrics").not.toMatch(/(?:≈|约\s*\d|\d+(?:\.\d+)?\s*(?:MiB|MB|GiB|GB)|\d+(?:\.\d+)?%)/u);
    expect(report).toContain(outputPaths.csv);
    expect(report).toContain("size_bytes");
    expect(report).toContain("download_count");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(consoleErrors).toEqual([]);
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const evidence = collectEvidence(database, roomId, sessionId);
    writeFileSync(join(output, "execution-evidence.json"), JSON.stringify(evidence, null, 2), "utf8");
    writeFileSync(join(output, "acceptance-result.json"), JSON.stringify({ passed, failure, startedAt, finishedAt: new Date().toISOString(), roomId, sessionId, provenance, consoleErrors, evidencePath: "execution-evidence.json", workspace: root }, null, 2), "utf8");
    database.close();
    if (application) await application.close();
    await test.info().attach("real-chain-acceptance", { path: join(output, "acceptance-result.json"), contentType: "application/json" });
    console.log(`Real content-team evidence retained: ${output}`);
    // No automatic deletion: inspect files, provenance, Runtime evidence and failures after the run.
  }
});
