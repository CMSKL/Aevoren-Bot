import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import type { BrowserDownloadsPage, BrowserScope, ComputerView } from "../../src/shared/browser-contracts";
import { ENV_WORKER_VERSION } from "../../src/shared/environment-contracts";
import { AppRepository } from "../../src/main/database";
import { DockerDriver } from "../../src/main/docker-driver";
import { BrowserDockerDriver } from "../../src/main/browser-docker-driver";
import { openInspector, selectDetailsTab } from "../smoke/navigation";
import { closeTestApplication, removeTestDirectory } from "../smoke/test-cleanup";

type TestBot = { id: string; sessionId: string; name: string };
type Fixture = { page: Page; application: ElectronApplication; bots: TestBot[]; room: { id: string; sessionId: string; name: string }; url: string; cookie: string; downloadPath: string };
function value<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.safeMessage}`); return result.data; }
async function control(page: Page, scope: BrowserScope): Promise<ComputerView | null> {
  return value(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computer.view(input), scope));
}
function shellQuote(text: string): string { return `'${text.replaceAll("'", "'\\''")}'`; }

async function withBrowser(callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-electron-browser-"));
  const databasePath = join(directory, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  const bots = ["浏览器验收成员 A", "浏览器验收成员 B"].map((name, index) => {
    const created = repository.createBot();
    const bot = repository.updateBot(created.bot.id, created.bot.version, { name, avatarShape: "rounded", avatarColor: index === 0 ? "cobalt" : "cyan" });
    return { id: bot.id, sessionId: created.session.id, name };
  });
  const createdRoom = repository.createRoom({ name: "浏览器验收群", memberBotIds: bots.map(bot => bot.id), leadBotId: null });
  repository.setSetting("appearance.theme", "dark", false);
  repository.setSetting("memory.capture.enabled", "false", false); repository.close();
  const cookie = randomUUID(); const route = `/fixture-${randomUUID()}`;
  const bytes = Buffer.from("BROWSER_ACTUAL_DOWNLOAD\n", "utf8");
  const html = `<!doctype html><html><head><title>真实浏览器验收页面</title></head><body><h1 id="receipt">BROWSER_ACTUAL_PAGE</h1><label>验收输入<input aria-label="验收输入" id="field"></label><button onclick="document.getElementById('receipt').textContent=document.getElementById('field').value">记录内容</button><a href="${route}/download" download>保存验收文件</a><a href="${route}/too-large" download>超限下载文件</a><p id="cookie"></p><script>document.addEventListener('keydown',event=>{if(event.key==='F8')document.getElementById('receipt').textContent='RFB_DOM_CHANGE_PROVEN'});document.getElementById('cookie').textContent=document.cookie.includes('aevorenFixture=')?'COOKIE_PRESENT':'COOKIE_EMPTY'</script></body></html>`;
  const server: Server = createServer((request, response) => {
    if (request.url === `${route}/download`) { response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=browser-actual.txt", "content-length": bytes.length }); response.end(bytes); return; }
    if (request.url === `${route}/too-large`) { const large = Buffer.alloc(1_048_577, 65); response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=too-large.bin", "content-length": large.length }); response.end(large); return; }
    if (request.url !== route && request.url !== `${route}/set` && request.url !== `${route}/check`) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(request.url.endsWith("/set") ? { "set-cookie": `aevorenFixture=${cookie}; Path=${route}; SameSite=Lax; Max-Age=3600` } : {}) }); response.end(html);
  });
  let application: ElectronApplication | undefined;
  const downloadPath = join(directory, "browser-downloaded.txt");
  let closeError: unknown;
  try {
    await new Promise<void>(accept => server.listen(0, "0.0.0.0", accept));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture server port missing");
    // Docker Desktop's host alias serves only this synthetic random fixture path.
    const url = `http://host.docker.internal:${address.port}${route}`;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name, content]) => content !== undefined && !name.startsWith("AEVOREN_BOT_")));
    const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: { ...environment, AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_ENVIRONMENT_DOWNLOAD_TEST_PATH: downloadPath, AEVOREN_BOT_BROWSER_DOWNLOAD_TEST_PATH: downloadPath } });
    if (executablePath) {
      const packaged = await application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, version: app.getVersion(), resourcesPath: process.resourcesPath }));
      expect(packaged.isPackaged).toBe(true);
      expect(packaged.version).toBe(JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version);
      for (const name of ["index.mjs", "engine.mjs", "Dockerfile", "package.json"]) expect(existsSync(join(packaged.resourcesPath, "browser-worker", name))).toBe(true);
      for (const name of ["index.mjs", "file-helper.mjs", "Dockerfile", "package.json"]) expect(existsSync(join(packaged.resourcesPath, "environment-worker", name))).toBe(true);
      const executionWorkerVersion: unknown = JSON.parse(readFileSync(join(packaged.resourcesPath, "environment-worker", "package.json"), "utf8")).version;
      expect(executionWorkerVersion).toBe(ENV_WORKER_VERSION);
      expect(existsSync(join(packaged.resourcesPath, "docs", "BROWSER_COMPUTER.md"))).toBe(true);
      await test.info().attach("actual-package-runtime", { body: JSON.stringify({ ...packaged, executionWorkerVersion, browserContext: join(packaged.resourcesPath, "browser-worker") }), contentType: "application/json" });
    }
    const page = await application.firstWindow(); const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { aevorenBot?: AevorenBotApi }).aevorenBot?.browser))).toBe(true);
    const initialized = value(await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.initialize()));
    expect(initialized.probe.available).toBe(true); expect(initialized.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    await callback({ page, application, bots, room: { id: createdRoom.room.id, sessionId: createdRoom.session.id, name: createdRoom.room.name }, url, cookie, downloadPath });
    expect(errors).toEqual([]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally {
    if (application) { try { await closeTestApplication(application); } catch (error) { closeError = error; } }
    server.closeAllConnections();
    await new Promise<void>(accept => server.close(() => accept()));
    const cleanup = new AppRepository(databasePath);
    const browserRecords = cleanup.browsers.listInternal(); const environments = cleanup.environments.listInternal(); cleanup.close();
    const docker = new DockerDriver(); const browserDocker = new BrowserDockerDriver();
    await docker.probe(); await browserDocker.probe();
    const cliEnvironment = { ...process.env }; delete cliEnvironment.DOCKER_HOST; delete cliEnvironment.DOCKER_CONTEXT;
    const command = (args: string[]): void => {
      try { execFileSync("docker", ["--context", Reflect.get(docker, "context") as string, ...args], { env: cliEnvironment, stdio: "pipe" }); }
      catch (error) { if (!/No such volume|No such network|network .* not found/.test(String((error as { stderr?: Buffer }).stderr ?? ""))) throw error; }
    };
    // Every ID is from this fixture's private SQLite. No global Docker inventory is removed.
    for (const browser of browserRecords) { await browserDocker.stopBrowser(browser.id, browser.environmentId, true); for (const kind of ["state", "profile", "downloads"]) command(["volume", "rm", `aevoren-browser-${kind}-${browser.id}`]); }
    for (const environment of environments) { await docker.stop(environment.id); await docker.remove(environment.id); command(["volume", "rm", `aevoren-work-${environment.id}`, `aevoren-state-${environment.id}`]); command(["network", "rm", `aevoren-scope-${environment.id}`]); }
    removeTestDirectory(directory);
  }
  if (closeError) throw closeError;
}

async function nativeUrl(page: Page, canvas: Locator, url: string, newTab = false): Promise<void> {
  await canvas.click(); await page.keyboard.press(newTab ? "Control+t" : "Control+l", { delay: 100 });
  // RFB's extended key events use physical scancodes. Send an actual Shift chord for ':' instead of CDP's implicit shift modifier.
  for (const character of url) await page.keyboard.press(character === ":" ? "Shift+Semicolon" : character, { delay: 10 });
  await page.keyboard.press("Enter");
}

async function privateInspector(f: Fixture, bot: TestBot): Promise<Locator> {
  await f.page.getByRole("listitem", { name: bot.name, exact: true }).click(); await openInspector(f.page);
  return f.page.getByRole("main", { name: "联系人资料", exact: true });
}
async function startBrowser(f: Fixture, parent: Locator, scope: BrowserScope): Promise<Locator> {
  value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.start(input), scope));
  await selectDetailsTab(parent, "浏览器");
  const panel = parent.getByRole("region", { name: "浏览器", exact: true });
  await expect(panel.getByRole("button", { name: "启动浏览器与电脑", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "启动浏览器与电脑", exact: true }).click();
  await expect(panel.getByRole("status").first()).toHaveText("运行中", { timeout: 120_000 });
  return panel;
}
async function takeover(panel: Locator): Promise<void> {
  await panel.getByRole("button", { name: "我来操作", exact: true }).click();
  await expect(panel.getByRole("button", { name: "交给 AI", exact: true })).toBeVisible();
}
async function navigate(panel: Locator, url: string): Promise<void> {
  await panel.getByLabel("浏览器网址", { exact: true }).fill(url); await panel.getByRole("button", { name: "打开网址", exact: true }).click();
  await expect(panel.locator(".computer-url")).toHaveText(url);
  await panel.getByRole("button", { name: "读取页面", exact: true }).click(); await expect(panel.locator(".computer-page-text")).toContainText("BROWSER_ACTUAL_PAGE");
}

test.describe("actual browser companion through hidden Electron", () => {
  test.skip(process.env.AEVOREN_DOCKER_INTEGRATION !== "1" || process.env.AEVOREN_BROWSER_INTEGRATION !== "1", "Requires explicit browser and Docker opt-in; no simulated DOM, screenshots or VNC server is substituted.");
  test.skip(process.platform !== "darwin" && process.platform !== "win32", "This desktop fixture uses Docker Desktop's actual host alias.");
  test.setTimeout(300_000);

  test("opens a cold computer, connects with one takeover action, and returns real control to AI", async () => {
    await withBrowser(async f => {
      const bot = f.bots[0]!, scope = { sessionId: bot.sessionId, executorBotId: bot.id };
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.get(input), scope))).toBeNull();
      const contact = await privateInspector(f, bot);
      await selectDetailsTab(contact, "电脑");
      const panel = contact.getByRole("region", { name: "电脑", exact: true });
      await expect(panel.getByRole("status").first()).toHaveText("运行中", { timeout: 120_000 });
      const image = panel.getByRole("img", { name: "当前聊天与成员的真实浏览器屏幕", exact: true });
      await expect(image).toBeVisible();
      expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1280);
      await expect(panel.getByRole("button", { name: "启动浏览器与电脑", exact: true })).toHaveCount(0);
      await panel.getByRole("button", { name: "放大", exact: true }).click();
      await expect(panel.getByRole("dialog", { name: "电脑大图", exact: true })).toBeVisible();
      await f.page.keyboard.press("Escape");
      await expect(panel.getByRole("dialog", { name: "电脑大图", exact: true })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "放大", exact: true })).toBeFocused();
      await panel.getByRole("button", { name: "我来操作", exact: true }).click();
      const canvas = panel.locator(".computer-vnc canvas"); await expect(canvas).toBeVisible();
      await expect.poll(() => canvas.evaluate(element => (element as HTMLCanvasElement).width)).toBe(1280);
      const user = (await control(f.page, scope))!; expect(user.owner).toBe("user");
      await expect(image).toBeHidden();
      await nativeUrl(f.page, canvas, f.url);
      await expect.poll(async () => value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.tabs(input), { ...scope, expectedEpoch: user.epoch })).map(tab => tab.url)).toContain(f.url);
      await expect.poll(async () => {
        const tabs = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.tabs(input), { ...scope, expectedEpoch: user.epoch }));
        const target = tabs.find(tab => tab.url === f.url); if (!target) return "";
        const observed = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.observe(input), { ...scope, expectedEpoch: user.epoch, pageId: target.id }));
        return observed.text;
      }).toContain("BROWSER_ACTUAL_PAGE");
      if (process.env.AEVOREN_COMPUTER_REAL_SCREENSHOT) await f.page.screenshot({ path: process.env.AEVOREN_COMPUTER_REAL_SCREENSHOT });
      await panel.getByRole("button", { name: "交给 AI", exact: true }).click();
      await expect(image).toBeVisible(); expect((await control(f.page, scope))?.owner).toBe("ai");
      await expect(canvas).toHaveCount(0);
      await selectDetailsTab(contact, "详情"); await selectDetailsTab(contact, "电脑");
      await expect(image).toBeVisible();
      await panel.getByRole("button", { name: "我来操作", exact: true }).click();
      await expect(panel.locator(".computer-vnc canvas")).toBeVisible();
      await panel.getByRole("button", { name: "交给 AI", exact: true }).click();
      await expect(image).toBeVisible();
    });
  });

  test("renders real pixels, connects noVNC only after takeover, runs human DOM actions and previews an actual registered service", async () => {
    await withBrowser(async f => {
      const bot = f.bots[0]!; const scope = { sessionId: bot.sessionId, executorBotId: bot.id };
      const contact = await privateInspector(f, bot); let panel = await startBrowser(f, contact, scope);
      const image = panel.getByRole("img", { name: "当前聊天与成员的真实浏览器屏幕", exact: true });
      await expect(image).toBeVisible();
      expect(await image.evaluate(element => ({ width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight, source: (element as HTMLImageElement).src.startsWith("data:image/") }))).toMatchObject({ width: expect.any(Number), height: expect.any(Number), source: true });
      expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(1000);
      await expect(panel.locator(".computer-vnc canvas")).toHaveCount(0);
      await takeover(panel); await expect(image).toBeHidden();
      await expect(panel.locator(".computer-vnc canvas")).toBeVisible();
      await expect(panel.locator(".computer-toolbar")).toContainText("你在操作");
      const canvas = panel.locator(".computer-vnc canvas"); await expect(canvas).toBeVisible();
      expect(await canvas.evaluate(element => (element as HTMLCanvasElement).width)).toBeGreaterThan(1000);
      await expect.poll(() => canvas.evaluate(element => (element as HTMLCanvasElement).getContext("2d")?.getImageData(0, 0, 1, 1).data[3])).toBe(255);
      await canvas.evaluate(element => {
        const fixture = window as unknown as { __aevorenBrowserFixtureKeys: Array<{ key: string; code: string; type: string; trusted: boolean }> };
        fixture.__aevorenBrowserFixtureKeys = [];
        for (const type of ["keydown", "keyup"]) element.addEventListener(type, event => { const key = event as KeyboardEvent; fixture.__aevorenBrowserFixtureKeys.push({ key: key.key, code: key.code, type, trusted: key.isTrusted }); });
      });
      // Actual noVNC keyboard transport navigates Chromium, independently of the DOM API.
      await nativeUrl(f.page, canvas, f.url);
      const nativeInput = await canvas.evaluate(element => ({ active: document.activeElement === element, activeTag: document.activeElement?.tagName, tabindex: element.getAttribute("tabindex"), keys: (window as unknown as { __aevorenBrowserFixtureKeys: unknown[] }).__aevorenBrowserFixtureKeys, pixels: (element as HTMLCanvasElement).toDataURL("image/png").split(",")[1] }));
      await test.info().attach("native-rfb-input", { body: JSON.stringify({ ...nativeInput, pixels: undefined }), contentType: "application/json" });
      await test.info().attach("native-rfb-screen", { body: Buffer.from(nativeInput.pixels!, "base64"), contentType: "image/png" });
      let observedUrls: string[] = [];
      try { await expect.poll(async () => {
        const view = (await control(f.page, scope))!;
        const pages = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.tabs(input), { ...scope, expectedEpoch: view.epoch }));
        observedUrls = pages.map(page => page.url); return pages.some(page => page.url === f.url);
      }).toBe(true); } finally { await test.info().attach("native-rfb-actual-pages", { body: JSON.stringify({ observedUrls }), contentType: "application/json" }); const bytes = await canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL("image/png").split(",")[1]); await test.info().attach("native-rfb-screen-after-navigation", { body: Buffer.from(bytes!, "base64"), contentType: "image/png" }); }
      await panel.getByRole("button", { name: "刷新状态", exact: true }).click(); await navigate(panel, f.url);
      await canvas.click(); await f.page.keyboard.press("F8");
      let rfbReceipt = "";
      try {
        // The local key event and the remote DOM reply use different transports. Wait for the real native effect, without replaying input.
        await expect.poll(async () => {
          const view = (await control(f.page, scope))!;
          rfbReceipt = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.read(input), { ...scope, expectedEpoch: view.epoch, pageId: await panel.getByLabel("当前浏览器页面", { exact: true }).inputValue() })).text;
          return rfbReceipt;
        }).toContain("RFB_DOM_CHANGE_PROVEN");
      } finally { await test.info().attach("native-rfb-actual-dom-receipt", { body: JSON.stringify({ text: rfbReceipt, keys: await canvas.evaluate(() => (window as unknown as { __aevorenBrowserFixtureKeys: unknown[] }).__aevorenBrowserFixtureKeys) }), contentType: "application/json" }); }
      await panel.getByRole("button", { name: "读取页面", exact: true }).click(); await expect(panel.locator(".computer-page-text")).toContainText("RFB_DOM_CHANGE_PROVEN");
      await panel.getByLabel("浏览器页面元素", { exact: true }).selectOption({ label: "input · 验收输入" });
      await panel.getByLabel("浏览器输入内容", { exact: true }).fill("DOM_HUMAN_ACTUAL_RECEIPT"); await panel.getByRole("button", { name: "填写元素", exact: true }).click();
      await panel.getByRole("button", { name: "读取页面", exact: true }).click(); await expect(panel.getByLabel("浏览器页面元素", { exact: true })).toBeVisible();
      await panel.getByLabel("浏览器页面元素", { exact: true }).selectOption({ label: "button · 记录内容" }); await panel.getByRole("button", { name: "点击元素", exact: true }).click();
      await panel.getByRole("button", { name: "读取页面", exact: true }).click(); await expect(panel.locator(".computer-page-text")).toContainText("DOM_HUMAN_ACTUAL_RECEIPT");

      await panel.getByLabel("浏览器页面元素", { exact: true }).selectOption({ label: "a · 保存验收文件" }); await panel.getByRole("button", { name: "点击元素", exact: true }).click();
      await panel.getByRole("button", { name: "保存下载文件", exact: true }).click();
      await expect.poll(() => existsSync(f.downloadPath)).toBe(true); expect(readFileSync(f.downloadPath)).toEqual(Buffer.from("BROWSER_ACTUAL_DOWNLOAD\n", "utf8"));
      await panel.getByRole("button", { name: "读取页面", exact: true }).click(); await panel.getByLabel("浏览器页面元素", { exact: true }).selectOption({ label: "a · 超限下载文件" }); await panel.getByRole("button", { name: "点击元素", exact: true }).click();
      let downloadReceipt: BrowserDownloadsPage | undefined;
      try {
        // The Worker bounds a download to 10s; allow 2s for the completion receipt over local IPC.
        await expect.poll(async () => {
          downloadReceipt = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.downloads(input), { ...scope, expectedEpoch: (await control(f.page, scope))!.epoch }));
          return downloadReceipt.errors.some(error => error.name === "too-large.bin" && error.errorCode === "BROWSER_DOWNLOAD_TOO_LARGE");
        }, { timeout: 12_000 }).toBe(true);
      } finally { await test.info().attach("actual-download-receipts", { body: JSON.stringify(downloadReceipt ?? null), contentType: "application/json" }); }
      expect(downloadReceipt!.items).toHaveLength(1);
      await expect(panel.getByText("too-large.bin · 下载失败（BROWSER_DOWNLOAD_TOO_LARGE）。文件未保存。", { exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: "保存下载文件", exact: true })).toHaveCount(1);

      const selectedBeforeNativeTab = await panel.getByLabel("当前浏览器页面", { exact: true }).inputValue();
      await canvas.click();
      const currentUserView = (await control(f.page, scope))!;
      const focusedBefore = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computer.screenshot(input), { ...scope, expectedEpoch: currentUserView.epoch }));
      expect(focusedBefore.frame.pageId).toBe(selectedBeforeNativeTab);
      expect(focusedBefore.frame.documentVersion).not.toBeNull();
      await test.info().attach("actual-desktop-before-tab", { body: Buffer.from(focusedBefore.frame.dataBase64, "base64"), contentType: focusedBefore.frame.mimeType });
      await nativeUrl(f.page, canvas, `${f.url}/check`, true);
      await expect.poll(async () => value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.tabs(input), { ...scope, expectedEpoch: (await control(f.page, scope))!.epoch })).some(page => page.url === `${f.url}/check`)).toBe(true);
      const nativeNewPage = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.tabs(input), { ...scope, expectedEpoch: currentUserView.epoch })).find(page => page.url === `${f.url}/check`)!;
      const desktopBounds = await canvas.boundingBox(); if (!desktopBounds) throw new Error("Native desktop bounds unavailable");
      await canvas.click({ position: { x: desktopBounds.width / 2, y: desktopBounds.height * 0.75 }, delay: 100 });
      const focusedAfter = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computer.screenshot(input), { ...scope, expectedEpoch: currentUserView.epoch }));
      await test.info().attach("actual-desktop-after-tab", { body: Buffer.from(focusedAfter.frame.dataBase64, "base64"), contentType: focusedAfter.frame.mimeType });
      await test.info().attach("actual-focus-after-native-click", { body: JSON.stringify({ ...focusedAfter.frame, dataBase64: undefined }), contentType: "application/json" });
      expect(focusedAfter.frame.browserSessionId).toBe(focusedBefore.frame.browserSessionId); expect(focusedAfter.frame.controlEpoch).toBe(focusedBefore.frame.controlEpoch);
      const stalePhysicalInput = await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computer.key(input), { ...scope, expectedEpoch: currentUserView.epoch, pageId: focusedBefore.frame.pageId!, observationId: focusedBefore.frame.observationId, documentVersion: focusedBefore.frame.documentVersion!, key: "F8", clientNonce: randomUUID() });
      expect(stalePhysicalInput).toMatchObject({ ok: false, error: { code: "BROWSER_OBSERVATION_REQUIRED" } });
      await test.info().attach("actual-focus-provenance", { body: JSON.stringify({ before: { ...focusedBefore.frame, dataBase64: undefined }, after: { ...focusedAfter.frame, dataBase64: undefined }, stalePhysicalInput }), contentType: "application/json" });
      expect(focusedAfter.frame.pageId).toBe(nativeNewPage.id); expect(focusedAfter.frame.pageId).not.toBe(focusedBefore.frame.pageId);
      await panel.getByRole("button", { name: "刷新状态", exact: true }).click(); await panel.getByLabel("当前浏览器页面", { exact: true }).selectOption(selectedBeforeNativeTab);
      // The desktop's focused native tab differs from the DOM selector. UI capture must retain the actual screen's provenance.
      await panel.getByRole("button", { name: "交给 AI", exact: true }).click(); await expect(image).toBeVisible();
      await takeover(panel); await expect(panel.locator(".computer-vnc canvas")).toBeVisible(); await expect(canvas).toBeVisible();

      const takeoverView = (await control(f.page, scope))!;
      await selectDetailsTab(contact, "执行环境");
      await expect(panel.locator(".computer-vnc canvas")).toHaveCount(0);
      expect(await control(f.page, scope)).toMatchObject({ owner: "user", epoch: takeoverView.epoch });
      const program = `require('node:http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<h1>REGISTERED_SERVICE_ACTUAL</h1>')}).listen(8230,'0.0.0.0',()=>console.log('PREVIEW_ACTUAL_LISTENING'))`;
      const process = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.start(input), { ...scope, command: `node -e ${shellQuote(program)}`, clientNonce: randomUUID() }));
      await expect.poll(async () => value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.execution.logs(input), { ...scope, id: process.id })).logs.map(log => log.text).join("")).toContain("PREVIEW_ACTUAL_LISTENING");
      const port = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.registerPort(input), { ...scope, processId: process.id, port: 8230, label: "真实预览服务" }));
      await expect.poll(async () => value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.processes.listPorts(input), scope)).find(record => record.id === port.id)?.state).toBe("listening");
      const executionPanel = contact.getByRole("region", { name: "执行环境", exact: true }); await executionPanel.getByRole("button", { name: "刷新状态", exact: true }).click();
      await executionPanel.getByRole("button", { name: "打开服务预览", exact: true }).click();
      panel = contact.getByRole("region", { name: "浏览器", exact: true }); await expect(panel).toBeVisible();
      await panel.getByRole("button", { name: "读取页面", exact: true }).click(); await expect(panel.locator(".computer-page-text")).toContainText("REGISTERED_SERVICE_ACTUAL");
      const previews = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.preview.list(input), { ...scope, expectedEpoch: takeoverView.epoch }));
      expect(previews).toEqual(expect.arrayContaining([expect.objectContaining({ registeredPortId: port.id, state: "open" })]));
      await panel.getByRole("button", { name: "交给 AI", exact: true }).click();
      await expect.poll(async () => (await control(f.page, scope))?.owner).toBe("ai");
      expect((await control(f.page, scope))!.epoch).toBeGreaterThan(takeoverView.epoch);
      await expect(panel.getByRole("img", { name: "当前聊天与成员的真实浏览器屏幕", exact: true })).toBeVisible();
    });
  });

  test("preserves per-member URL drafts and keeps the same Bot's private login data out of its group browser", async () => {
    await withBrowser(async f => {
      const bot = f.bots[0]!; const privateScope = { sessionId: bot.sessionId, executorBotId: bot.id };
      let contact = await privateInspector(f, bot); let panel = await startBrowser(f, contact, privateScope); await takeover(panel);
      await navigate(panel, `${f.url}/set`); await expect(panel.locator(".computer-page-text")).toContainText("COOKIE_PRESENT");
      const privateSession = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.get(input), privateScope))!;
      value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.stop(input), { ...privateScope, expectedVersion: privateSession.version, clientNonce: randomUUID() }));
      await contact.getByRole("button", { name: "发消息", exact: true }).click();
      await f.page.getByRole("listitem", { name: f.room.name, exact: true }).click(); await openInspector(f.page);
      const room = f.page.getByRole("dialog", { name: "群聊设置", exact: true }); await selectDetailsTab(room, "浏览器");
      const member = room.getByLabel("浏览器成员", { exact: true }); const groupScope = { sessionId: f.room.sessionId, executorBotId: bot.id };
      await member.selectOption(bot.id); panel = room.getByRole("region", { name: "浏览器", exact: true });
      // Before startup the only URL draft belongs to this exact member and chat.
      value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.start(input), groupScope));
      await panel.getByRole("button", { name: "刷新状态", exact: true }).click(); await panel.getByRole("button", { name: "启动浏览器与电脑", exact: true }).click();
      await expect(panel.getByRole("status").first()).toHaveText("运行中", { timeout: 120_000 }); await takeover(panel); await navigate(panel, `${f.url}/check`);
      await expect(panel.locator(".computer-page-text")).toContainText("COOKIE_EMPTY");
      await panel.getByLabel("浏览器网址", { exact: true }).fill(`${f.url}/group-a-unsent`);
      await member.selectOption(f.bots[1]!.id); await expect(panel.getByRole("status").first()).toHaveText("已停止");
      await expect(panel.getByLabel("浏览器网址", { exact: true })).toHaveValue(""); await panel.getByLabel("浏览器网址", { exact: true }).fill(`${f.url}/group-b-unsent`);
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.get(input), { sessionId: f.room.sessionId, executorBotId: f.bots[1]!.id }))).toBeNull();
      await member.selectOption(bot.id); await expect(panel.getByLabel("浏览器网址", { exact: true })).toHaveValue(`${f.url}/group-a-unsent`);
      await member.selectOption(f.bots[1]!.id); await expect(panel.getByLabel("浏览器网址", { exact: true })).toHaveValue(`${f.url}/group-b-unsent`); await member.selectOption(bot.id);
      expect(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.tabs(input), { ...groupScope, expectedEpoch: (await control(f.page, groupScope))!.epoch })).some(page => page.url.endsWith("group-a-unsent"))).toBe(false);
      const groupSession = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.get(input), groupScope))!;
      value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.stop(input), { ...groupScope, expectedVersion: groupSession.version, clientNonce: randomUUID() }));
      await room.getByRole("button", { name: "关闭群聊设置", exact: true }).click();
      contact = await privateInspector(f, bot); panel = await startBrowser(f, contact, privateScope);
      if ((await control(f.page, privateScope))?.owner !== "user") await takeover(panel);
      await navigate(panel, `${f.url}/check`); await expect(panel.locator(".computer-page-text")).toContainText("COOKIE_PRESENT");
    });
  });
});
