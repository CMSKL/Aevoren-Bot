import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import type { BrowserScope, ComputerView } from "../../src/shared/browser-contracts";
import { ENV_WORKER_VERSION } from "../../src/shared/environment-contracts";
import { AppRepository } from "../../src/main/database";
import { DockerDriver } from "../../src/main/docker-driver";
import { BrowserDockerDriver } from "../../src/main/browser-docker-driver";
import { openInspector } from "../smoke/navigation";
import { removeTestDirectory } from "../smoke/test-cleanup";

type TestBot = { id: string; sessionId: string; name: string };
type Fixture = { page: Page; application: ElectronApplication; bots: TestBot[]; room: { id: string; sessionId: string; name: string }; url: string; cookie: string; downloadPath: string };
function value<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.safeMessage}`); return result.data; }
async function control(page: Page, scope: BrowserScope): Promise<ComputerView | null> {
  return value(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computer.view(input), scope));
}
async function closeApplication(application: ElectronApplication): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([application.close(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("fixture close timeout")), 15_000); })]); }
  catch { application.process().kill("SIGKILL"); }
  finally { if (timer) clearTimeout(timer); }
}
function shellQuote(text: string): string { return `'${text.replaceAll("'", "'\\''")}'`; }

async function withBrowser(callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-electron-browser-"));
  const databasePath = join(directory, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  const bots = ["浏览器验收成员 A", "浏览器验收成员 B"].map(name => {
    const created = repository.createBot();
    const bot = repository.updateBot(created.bot.id, created.bot.version, { name });
    return { id: bot.id, sessionId: created.session.id, name };
  });
  const createdRoom = repository.createRoom({ name: "浏览器验收群", memberBotIds: bots.map(bot => bot.id), leadBotId: null });
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
    if (application) await closeApplication(application);
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
  await parent.getByRole("tab", { name: "浏览器", exact: true }).click();
  const panel = parent.getByRole("region", { name: "浏览器", exact: true });
  await expect(panel.getByRole("button", { name: "启动浏览器与电脑", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "启动浏览器与电脑", exact: true }).click();
  await expect(panel.getByRole("status").first()).toHaveText("运行中", { timeout: 120_000 });
  return panel;
}
async function takeover(panel: Locator): Promise<void> {
  await panel.getByRole("button", { name: "接管电脑", exact: true }).click();
  await expect(panel.getByRole("button", { name: "归还 AI", exact: true })).toBeVisible();
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
      await panel.getByRole("button", { name: "连接电脑", exact: true }).click();
      await expect(panel.getByRole("button", { name: "电脑已连接", exact: true })).toBeVisible();
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
      await expect(panel.getByText("too-large.bin · 下载失败（BROWSER_DOWNLOAD_TOO_LARGE）。文件未保存。", { exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: "保存下载文件", exact: true })).toHaveCount(1);

      const selectedBeforeNativeTab = await panel.getByLabel("当前浏览器页面", { exact: true }).inputValue();
      await nativeUrl(f.page, canvas, `${f.url}/check`, true);
      await expect.poll(async () => value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.tabs(input), { ...scope, expectedEpoch: (await control(f.page, scope))!.epoch })).some(page => page.url === `${f.url}/check`)).toBe(true);
      await panel.getByRole("button", { name: "刷新状态", exact: true }).click(); await panel.getByLabel("当前浏览器页面", { exact: true }).selectOption(selectedBeforeNativeTab);
      // The desktop's focused native tab differs from the DOM selector. UI capture must retain the actual screen's provenance.
      await panel.getByRole("button", { name: "归还 AI", exact: true }).click(); await expect(image).toBeVisible();
      await takeover(panel); await panel.getByRole("button", { name: "连接电脑", exact: true }).click(); await expect(canvas).toBeVisible();

      const takeoverView = (await control(f.page, scope))!;
      await contact.getByRole("tab", { name: "执行环境", exact: true }).click();
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
      await panel.getByRole("button", { name: "归还 AI", exact: true }).click();
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
      const room = f.page.getByRole("dialog", { name: "群聊设置", exact: true }); await room.getByRole("tab", { name: "浏览器", exact: true }).click();
      const member = room.getByLabel("浏览器成员", { exact: true }); const groupScope = { sessionId: f.room.sessionId, executorBotId: bot.id };
      await member.selectOption(bot.id); panel = room.getByRole("region", { name: "浏览器", exact: true });
      // Before startup the only URL draft belongs to this exact member and chat.
      value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.start(input), groupScope));
      await panel.getByRole("button", { name: "刷新状态", exact: true }).click(); await panel.getByRole("button", { name: "启动浏览器与电脑", exact: true }).click();
      await expect(panel.getByRole("status").first()).toHaveText("运行中", { timeout: 120_000 }); await takeover(panel); await navigate(panel, `${f.url}/check`);
      await expect(panel.locator(".computer-page-text")).toContainText("COOKIE_EMPTY");
      await panel.getByLabel("浏览器网址", { exact: true }).fill(`${f.url}/group-a-unsent`);
      await member.selectOption(f.bots[1]!.id); await expect(panel.getByRole("status").first()).toHaveText("尚未创建浏览器");
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
