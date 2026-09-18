import { removeTestDirectory } from "./test-cleanup";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import type { AevorenBotApi } from "../../src/shared/contracts";

const appVersion = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

test("keeps auto-update disabled and silent in the unpackaged development app", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-update-smoke-"));
  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AEVOREN_BOT_USER_DATA_DIR: userDataDir,
      AEVOREN_BOT_FAKE_PROVIDER: "1",
    },
  });
  try {
    const page = await application.firstWindow();
    const state = await page.evaluate(async () =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.updates.getState(),
    );
    expect(state).toEqual({
      ok: true,
      data: {
        channel: "development",
        status: "disabled",
        currentVersion: appVersion,
        availableVersion: null,
        progress: null,
        checkedAt: null,
        error: null,
      },
    });
    await expect(page.locator(".update-status-notice")).toHaveCount(0);
    const checked = await page.evaluate(async () =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.updates.check(),
    );
    expect(checked).toEqual(state);
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});

test("restores an interrupted install receipt without retrying or claiming success", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-update-interrupted-"));
  const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
  repository.setSetting("update.pendingReceipt", JSON.stringify({
    version: "0.3.0",
    previousVersion: appVersion,
    downloadedAt: "2026-09-16T00:00:00.000Z",
    requestedAt: "2026-09-16T00:01:00.000Z",
    attemptCount: 1,
  }), false);
  repository.setSetting("update.pendingVersion", "0.3.0", false);
  repository.close();

  const application = await electron.launch({
    args: ["."],
    cwd: process.cwd(),
    env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1" },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByText("上次更新未完成", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "重新下载" })).toBeVisible();
    await expect(page.getByText("已更新至", { exact: false })).toHaveCount(0);
    const state = await page.evaluate(async () =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.updates.getState(),
    );
    expect(state).toMatchObject({
      ok: true,
      data: { channel: "development", status: "install-interrupted", currentVersion: appVersion, availableVersion: "0.3.0" },
    });
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});

test("keeps a packaged local test build offline when no trusted feed is embedded", async () => {
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  test.skip(!executablePath, "requires a local package:mac artifact");
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-packaged-update-smoke-"));
  const application = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      AEVOREN_BOT_USER_DATA_DIR: userDataDir,
      AEVOREN_BOT_FAKE_PROVIDER: "1",
    },
  });
  try {
    const page = await application.firstWindow();
    const state = await page.evaluate(async () =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.updates.getState(),
    );
    expect(state).toMatchObject({ ok: true, data: { channel: "development", status: "disabled" } });
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});

test("enables the packaged release channel only when trusted feed metadata is present", async () => {
  const executablePath = process.env.AEVOREN_RELEASE_TEST_APP_PATH;
  test.skip(!executablePath, "requires an unsigned release-metadata fixture package");
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-release-update-smoke-"));
  const application = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      AEVOREN_BOT_USER_DATA_DIR: userDataDir,
      AEVOREN_BOT_FAKE_PROVIDER: "1",
    },
  });
  try {
    const page = await application.firstWindow();
    const state = await page.evaluate(async () =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.updates.getState(),
    );
    expect(state).toMatchObject({
      ok: true,
      data: { channel: "beta", status: "idle", currentVersion: appVersion },
    });
  } finally {
    await application.close();
    removeTestDirectory(userDataDir);
  }
});
