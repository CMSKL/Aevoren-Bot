import { accessSync, constants, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";

const guiPath = "/usr/bin:/bin:/usr/sbin:/sbin";
const dockerPath = "/Applications/Docker.app/Contents/Resources/bin/docker";
function hasDesktopCli(): boolean {
  try { accessSync(dockerPath, constants.X_OK); return true; } catch { return false; }
}

test("discovers the real installed Docker CLI from a packaged macOS GUI PATH", async () => {
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  test.skip(process.platform !== "darwin" || !executablePath || !hasDesktopCli(), "Requires an actual macOS package and installed Docker Desktop CLI");
  const data = mkdtempSync(join(tmpdir(), "aevoren-docker-gui-package-"));
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith("AEVOREN_") && entry[0] !== "ELECTRON_RENDERER_URL"));
  delete inherited.DOCKER_HOST;
  delete inherited.DOCKER_CONTEXT;
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ executablePath, args: [], cwd: process.cwd(), env: {
      ...inherited, PATH: guiPath, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_FAKE_PROVIDER: "1",
      AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_USER_DATA_DIR: data,
    } });
    const owned = application.process();
    const runtime = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath(), path: process.env.PATH, databaseOverride: process.env.AEVOREN_BOT_DB_PATH ?? null }));
    expect(runtime.packaged).toBe(true);
    expect(runtime.version).toBe(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version);
    expect(runtime.path).toBe(guiPath);
    expect(runtime.databaseOverride).toBeNull();
    const page = await application.firstWindow();
    await page.waitForURL(pathToFileURL(join(runtime.appPath, "out", "renderer", "index.html")).href, { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { aevorenBot?: AevorenBotApi }).aevorenBot?.environments))).toBe(true);
    const result = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.probe());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.safeMessage);
    expect(result.data.dockerInstalled).toBe(true);
    expect(await application.evaluate(() => process.env.PATH)).toBe(guiPath);
    await test.info().attach("actual-docker-gui-probe", { body: JSON.stringify({ packaged: runtime.packaged, version: runtime.version,
      guiPath: runtime.path, probe: result.data }), contentType: "application/json" });
    await closeTestApplication(application);
    expect({ code: owned.exitCode, signal: owned.signalCode }).toEqual({ code: 0, signal: null });
    application = undefined;
  } finally {
    try { if (application) await closeTestApplication(application); }
    finally { removeTestDirectory(data); }
  }
});
