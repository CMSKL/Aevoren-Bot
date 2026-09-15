import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";

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
        currentVersion: "0.1.0",
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
    rmSync(userDataDir, { recursive: true, force: true });
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
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("enables the stable channel only when a packaged release contains trusted feed metadata", async () => {
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
      data: { channel: "stable", status: "idle", currentVersion: "0.1.0" },
    });
  } finally {
    await application.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
