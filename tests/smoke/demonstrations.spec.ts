import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";
import { openInspector } from "./navigation";
test("hidden demonstration UI retains conflicts and publishes only an explicitly confirmed disabled Skill", async () => {
  const data = mkdtempSync(join(tmpdir(), "aevoren-demo-smoke-")), filename = join(data, "aevoren-bot.sqlite"), repository = new AppRepository(filename);
  const bot = repository.createBot(); repository.updateBot(bot.bot.id, bot.bot.version, { name: "示范验收 Bot" }); const scope = { sessionId: bot.session.id, executorBotId: bot.bot.id }, now = new Date().toISOString();
  const draft = repository.demonstrations.create(scope, { id: randomUUID(), browserSessionId: randomUUID(), epoch: 2, state: "interrupted", reason: "disconnect", events: [{ kind: "pointer", x: 30, y: 80, buttons: 1 }, { kind: "redacted-text" }], eventCount: 2, createdAt: now, updatedAt: now });
  repository.close(); const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("AEVOREN_BOT_"))), AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_FAKE_PROVIDER: "1" } });
  try {
    if (executablePath) {
      expect(await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))).toEqual({ packaged: true, version: JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version });
      expect(await app.evaluate(async () => { const fs = await import("node:fs/promises"), path = await import("node:path"); return fs.readFile(path.join(process.resourcesPath, "docs", "SKILL_DEMONSTRATIONS.md"), "utf8"); })).toContain("Browser Worker **1.1.0**");
    }
    const page = await app.firstWindow(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); await expect(page.locator(".app-shell")).toBeVisible();
    await page.getByRole("listitem", { name: "示范验收 Bot", exact: true }).click();
    await expect(page.getByRole("heading", { name: "示范验收 Bot", exact: true })).toBeVisible();
    await openInspector(page); const inspector = page.getByRole("main", { name: "联系人资料", exact: true }); await inspector.getByRole("tab", { name: "电脑", exact: true }).click();
    const panel = page.getByRole("region", { name: "示范技能", exact: true }); await panel.getByRole("button", { name: "示范技能草稿", exact: false }).click();
    await expect(panel.getByRole("button", { name: "开始示范", exact: true })).toBeDisabled();
    const text = panel.getByLabel("示范 SKILL.md 草稿", { exact: true }); await expect(text).toHaveValue(draft.body); await text.fill(draft.body + "\nUSER_LOCAL_EDIT");
    expect(await page.evaluate(async scope => { const r = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.library.list({ sessionId: scope.sessionId, includeDisabled: true }); if (!r.ok) throw new Error(r.error.code); return r.data.length; }, scope)).toBe(0);
    const changed = await page.evaluate(async input => { const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.demonstrations.updateDraft(input); if (!result.ok) throw new Error(result.error.code); return result.data; }, { ...scope, id: draft.id, expectedVersion: 1, name: draft.name, body: draft.body + "\nSAVED_ELSEWHERE" });
    await panel.getByRole("button", { name: "保存示范草稿", exact: true }).click(); await expect(panel.getByRole("alert")).toContainText("当前编辑仍保留"); await expect(text).toHaveValue(draft.body + "\nUSER_LOCAL_EDIT"); await expect(panel.getByRole("button", { name: "发布为停用 Skill", exact: true })).toBeDisabled();
    await panel.getByRole("button", { name: "放弃编辑", exact: true }).click(); await expect(panel.getByRole("button", { name: /示范技能草稿 · v2/ })).toBeVisible(); await panel.getByRole("button", { name: /示范技能草稿 · v2/ }).click(); await expect(text).toHaveValue(changed.body);
    await panel.getByRole("button", { name: "发布为停用 Skill", exact: true }).click(); await expect(panel.getByRole("group", { name: "确认发布示范 Skill", exact: true })).toBeVisible();
    expect(await page.evaluate(async scope => { const r = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.library.list({ sessionId: scope.sessionId, includeDisabled: true }); if (!r.ok) throw new Error(r.error.code); return r.data.length; }, scope)).toBe(0);
    await panel.getByRole("button", { name: "确认发布停用 Skill", exact: true }).click(); await expect(panel.getByRole("group", { name: "确认发布示范 Skill", exact: true })).toBeHidden();
    const saved = await page.evaluate(async input => { const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot; const d = await api.demonstrations.readDraft(input); if (!d.ok) throw new Error(d.error.code); const listed = await api.library.list({ sessionId: input.sessionId, includeDisabled: true }); if (!listed.ok) throw new Error(listed.error.code); return { draft: d.data, resources: listed.data }; }, { ...scope, id: draft.id });
    expect(saved.draft.state).toBe("published"); expect(saved.resources).toHaveLength(1); expect(saved.resources[0]).toMatchObject({ kind: "skill", enabled: false, id: saved.draft.publishedResourceId }); expect(errors).toEqual([]);
    await app.close(); const reopened = new AppRepository(filename); try { expect(reopened.demonstrations.read(scope, draft.id)).toMatchObject({ state: "published", version: 2 }); expect(reopened.skillExecutions.list(scope)).toEqual([]); } finally { reopened.close(); }
  } finally { await closeTestApplication(app); removeTestDirectory(data); }
});
