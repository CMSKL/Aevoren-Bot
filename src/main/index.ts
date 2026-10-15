import { NativeOutboundAdapter } from "./native-connectors/outbound";
import { NativeWriteHttpClient } from "./native-connectors/write-http";
import type { NativeFetch } from "./native-connectors/http";
import { NativeOutboundService } from "./native-outbound-service";
import "./identity";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, nativeTheme, Notification, safeStorage, shell } from "electron";
import { valid } from "semver";
import { IPC } from "@shared/channels";
import type { RoomRuntimeEvent, RuntimeEvent, SendStateEvent, ToolEvent, TranscriptEvent, UpdateState } from "@shared/contracts";
import { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import { registerIpc } from "./ipc";
import { SendWorker } from "./send-worker";
import { RoomCoordinator } from "./room-coordinator";
import { GeneralSettingsService, type SecretCodec } from "./settings";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { ElectronUpdateAdapter } from "./electron-update-adapter";
import { UpdateLogger } from "./update-logger";
import { parsePendingUpdateReceipt, resolveUpdateChannel, UpdateService } from "./update-service";
import { ProviderService } from "./provider-service";
import { CapabilityRegistry } from "./capability-registry";
import { NetworkToolExecutor } from "./network-tool-executor";
import { McpService } from "./mcp-service";
import { RoutineService } from "./routine-service";
import { DeviceToolExecutor } from "./device-tool-executor";
import { readAttachments } from "./attachments";
import { saveArtifact as writeArtifact } from "./artifacts";
import { createConfiguredJevProvider, DecisionService } from "./decision-service";
import { MemoryCaptureService } from "./memory-capture-service";
import { LibraryService } from "./library-service";
import { writeLibraryExport } from "./library-export";
import { EnvironmentService } from "./environment-service";
import { DemonstrationService } from "./demonstration-service";
import { BrowserService } from "./browser-service";
import { SkillExecutionService } from "./skill-execution-service";
import { NativeConnectorService } from "./native-connector-service";
import { NativeHttpClient } from "./native-connectors/http";
import { GoogleNativeOAuth } from "./native-connectors/google-oauth";
import { GmailNativeAdapter } from "./native-connectors/gmail";
import { DriveNativeAdapter } from "./native-connectors/drive";
import { NotionNativeAdapter } from "./native-connectors/notion";
import { SKILL_EXECUTION_EVENTS } from "@shared/skill-execution-channels";
import { BROWSER_EVENTS } from "@shared/browser-channels";
import { ENVIRONMENT_EVENTS } from "@shared/environment-channels";
import { environmentDirectoryPathSchema, environmentFilePathSchema } from "@shared/environment-schemas";
import { readEnvironmentUpload, writeEnvironmentDownload } from "./environment-file-transfer";

const userDataOverride = process.env.AEVOREN_BOT_USER_DATA_DIR;
if (userDataOverride) app.setPath("userData", userDataOverride);
const hideTestWindow = process.env.AEVOREN_BOT_TEST_HIDDEN === "1";
if (process.env.AEVOREN_BOT_TEST_HIDDEN === "0") {
  // Windows ARM VMs may expose a 200% desktop scale, which otherwise moves
  // the desktop inspector below the viewport during visible Electron smoke
  // tests. Keep the production window untouched and normalize only explicit
  // visible test runs.
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
}

let mainWindow: BrowserWindow | null = null;
let repository: AppRepository | null = null;
let runtimeCoordinator: SendWorker | null = null;
let roomCoordinator: RoomCoordinator | null = null;
let updateService: UpdateService | null = null;
let providerService: ProviderService | null = null;
let mcpService: McpService | null = null;
let environmentService: EnvironmentService | null = null;
let browserService: BrowserService | null = null;
let skillExecutionService: SkillExecutionService | null = null;
let nativeConnectorService: NativeConnectorService | null = null;
let nativeOutboundService: NativeOutboundService | null = null;
let routineService: RoutineService | null = null;
let allowClose = false;
let closeRequested = false;
let quitRequested = false;
let productExitRequested = false;
let rendererReady = false;
let rendererEverReady = false;
let pendingClose = false;
const savedArtifactPaths = new Set<string>();
let closeConfirmationTimer: ReturnType<typeof setTimeout> | null = null;
let shutdownPromise: Promise<void> | null = null;

const CLOSE_CONFIRMATION_TIMEOUT_MS = 5_000;

function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(app.getAppPath(), "resources", "icon.png");
}

const electronSecretCodec: SecretCodec = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
};

function emitTranscript(event: TranscriptEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.transcriptEvent, event);
}

function emitSendState(event: SendStateEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.sendStateEvent, event);
}

function emitRuntime(event: RuntimeEvent): void {
  if (["cancel-requested", "completed", "failed", "cancelled", "interrupted"].includes(event.run.state)) void browserService?.cancelRuntime(event.run.id).catch(() => undefined);
  if (["cancel-requested", "completed", "failed", "cancelled", "interrupted"].includes(event.run.state)) void environmentService?.cancelRuntime(event.run.id).catch(() => undefined);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.runtimeEvent, event);
}

function emitRoomRuntime(event: RoomRuntimeEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.roomRuntimeEvent, event);
}

function emitTool(event: ToolEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.toolEvent, event);
  if (event.approval.state === "pending") showNotification("Aevoren Bot 等待确认", "有一项工具调用需要你的批准。");
}

function showNotification(title: string, body: string): void {
  if (hideTestWindow) return;
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  notification.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });
  notification.show();
}

function emitUpdate(state: UpdateState): void {
  if (state.status === "error" && state.error?.code === "UPDATE_INSTALL_FAILED") allowClose = false;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.updateEvent, { state });
}

function clearCloseConfirmationTimer(): void {
  if (!closeConfirmationTimer) return;
  clearTimeout(closeConfirmationTimer);
  closeConfirmationTimer = null;
}

function armCloseConfirmationTimer(): void {
  clearCloseConfirmationTimer();
  closeConfirmationTimer = setTimeout(() => {
    closeConfirmationTimer = null;
    closeRequested = false;
    pendingClose = false;
    quitRequested = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.appCloseBlocked);
  }, CLOSE_CONFIRMATION_TIMEOUT_MS);
}

async function finishClose(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!quitRequested && routineService?.hasEnabled()) {
    clearCloseConfirmationTimer();
    closeRequested = false;
    pendingClose = false;
    mainWindow.hide();
    return;
  }
  roomCoordinator?.beginShutdown();
  shutdownPromise ??= (async () => {
    await nativeOutboundService?.shutdown();
    await nativeConnectorService?.shutdown();
    await skillExecutionService?.shutdown();
    await runtimeCoordinator?.shutdown();
    await roomCoordinator?.shutdown();
    await environmentService?.shutdown();
    await browserService?.shutdown();
    await providerService?.dispose();
    await mcpService?.dispose();
    routineService?.stop();
  })();
  try {
    await shutdownPromise;
  } catch {
    shutdownPromise = null;
    closeRequested = false;
    pendingClose = false;
    quitRequested = false;
    mainWindow.webContents.send(IPC.appCloseBlocked);
    return;
  }
  allowClose = true;
  if (quitRequested) app.quit();
  else mainWindow.close();
}

function requestRendererFlush(window: BrowserWindow): void {
  if (closeRequested) return;
  if (!rendererReady) {
    pendingClose = true;
    armCloseConfirmationTimer();
    return;
  }
  closeRequested = true;
  pendingClose = false;
  window.webContents.send(IPC.appBeforeClose);
  armCloseConfirmationTimer();
}

function createWindow(showOnCreate = !hideTestWindow): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: showOnCreate,
    minWidth: 390,
    minHeight: 640,
    icon: appIconPath(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#080808" : "#f5f5f5",
    title: "Aevoren Bot",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 12, y: 12 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      backgroundThrottling: !hideTestWindow,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const currentUrl = window.webContents.getURL();
    if (url !== currentUrl) event.preventDefault();
  });
  window.webContents.on("did-start-loading", () => {
    rendererReady = false;
    if (!closeRequested) return;
    clearCloseConfirmationTimer();
    closeRequested = false;
    pendingClose = true;
    armCloseConfirmationTimer();
  });
  window.on("close", (event) => {
    if (allowClose) return;
    if (!rendererEverReady) return;
    event.preventDefault();
    requestRendererFlush(window);
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) void window.loadURL(rendererUrl);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));

  return window;
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    if (hideTestWindow) app.dock?.hide();
    else app.dock?.setIcon(appIconPath());
  }
  const databasePath = process.env.AEVOREN_BOT_DB_PATH ?? join(app.getPath("userData"), "aevoren-bot.sqlite");
  repository = new AppRepository(databasePath, {
    appVersion: app.getVersion(),
    backupDirectory: join(app.getPath("userData"), "Backups"),
  });
  repository.setSetting("app.lastOpenedVersion", app.getVersion(), false);
  repository.recoverInterruptedSends();
  repository.recoverInterruptedRooms();
  repository.recoverInterruptedRuntimeRuns();
  repository.recoverToolInvocations();
  const forceFakeProvider = process.env.AEVOREN_BOT_FAKE_PROVIDER === "1";
  providerService = new ProviderService(
    repository,
    electronSecretCodec,
    join(app.getPath("userData"), "ProviderWorkspaces"),
    !forceFakeProvider,
  );
  await providerService.initialize();
  const decisionShadowEnabled = process.env.AEVOREN_DECISION_SHADOW === "1";
  const decisionService = new DecisionService(
    repository,
    decisionShadowEnabled ? createConfiguredJevProvider(repository, electronSecretCodec) : null,
    decisionShadowEnabled,
  );
  const loginItemOptions = process.platform === "darwin" ? { type: "mainAppService" as const } : undefined;
  const readLoginItemSettings = () => loginItemOptions
    ? app.getLoginItemSettings(loginItemOptions)
    : app.getLoginItemSettings();
  const writeLoginItemSettings = (openAtLogin: boolean) => loginItemOptions
    ? app.setLoginItemSettings({ ...loginItemOptions, openAtLogin })
    : app.setLoginItemSettings({ openAtLogin });
  const generalSettings = new GeneralSettingsService(repository, {
    // Electron's Windows login-item status is incomplete on packaged ARM
    // builds. Keep this optional setting fail-closed until a dedicated startup
    // task adapter is validated; it must never crash the settings Renderer.
    supported: app.isPackaged && process.platform === "darwin",
    get: () => {
      const value = readLoginItemSettings();
      return { openAtLogin: value.openAtLogin, status: value.status };
    },
    set: writeLoginItemSettings,
  });
  const openedAtLogin = (() => {
    if (!app.isPackaged || process.platform !== "darwin") return false;
    try {
      return readLoginItemSettings().wasOpenedAtLogin;
    } catch {
      return false;
    }
  })();
  const workspaceService = new WorkspaceService(repository);
  const libraryService = new LibraryService(repository, join(app.getPath("userData"), "library-blobs"), { workspaceService });
  environmentService = new EnvironmentService(repository.environments, electronSecretCodec,
    app.isPackaged ? join(process.resourcesPath, "environment-worker") : join(app.getAppPath(), "out", "worker"), (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ENVIRONMENT_EVENTS.changed, event);
    });
  void environmentService.recover().catch(() => undefined);
  const productSkillExecutionService = new SkillExecutionService(repository, libraryService, environmentService, event => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(SKILL_EXECUTION_EVENTS.changed, event);
  });
  skillExecutionService = productSkillExecutionService;
  let nativeHttp: NativeHttpClient | undefined;
  let nativeTestFetch: NativeFetch | undefined;
  const nativeTestOrigin = hideTestWindow && userDataOverride ? process.env.AEVOREN_BOT_NATIVE_TEST_ORIGIN : undefined;
  if (nativeTestOrigin) {
    const origin = new URL(nativeTestOrigin);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw new AevorenBotError("INVALID_REQUEST");
    nativeTestFetch = (url, input) => {
      const destination = new URL(url.pathname + url.search, origin);
      const headers = new Headers(input.headers);
      headers.set("x-aevoren-native-host", url.hostname);
      return fetch(destination, { ...input, headers, redirect: "error" });
    };
    nativeHttp = new NativeHttpClient(nativeTestFetch);
  }
  const productNativeConnectorService = new NativeConnectorService(repository, electronSecretCodec, {
    openExternal: url => shell.openExternal(url),
    ...(nativeHttp ? { oauth: new GoogleNativeOAuth(nativeHttp), gmail: new GmailNativeAdapter(nativeHttp),
      drive: new DriveNativeAdapter(nativeHttp), notion: new NotionNativeAdapter(nativeHttp) } : {}),
  });
  nativeConnectorService = productNativeConnectorService;
  const productNativeOutboundService = new NativeOutboundService(repository, productNativeConnectorService, nativeHttp && nativeTestFetch ? new NativeOutboundAdapter(nativeHttp,new NativeWriteHttpClient(nativeTestFetch)) : undefined);
  nativeOutboundService = productNativeOutboundService;
  browserService = new BrowserService(repository, electronSecretCodec,
    app.isPackaged ? join(process.resourcesPath, "browser-worker") : join(app.getAppPath(), "out", "browser-worker"),
    join(app.getPath("userData"), "browser-media"), environmentService, event => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_EVENTS.changed, event);
    });
  environmentService.setCompanionLifecycle((scope, remove) => browserService!.release(scope, remove));
  for (const saved of repository.browsers.listInternal()) void browserService.get(saved).catch(() => undefined);
  mcpService = new McpService(repository, electronSecretCodec, app.getVersion(), (url) => shell.openExternal(url));
  await mcpService.initialize();
  const workspaceToolExecutor = new WorkspaceToolExecutor(repository, workspaceService, new NetworkToolExecutor(), mcpService, new DeviceToolExecutor(() => clipboard.readText()));
  const workspaceToolCoordinator = new WorkspaceToolCoordinator(
    repository,
    workspaceToolExecutor,
    emitTool,
    decisionService,
  );
  const platform = process.platform === "darwin" || process.platform === "win32" || process.platform === "linux"
    ? process.platform
    : "other";
  const capabilityRegistry = new CapabilityRegistry(repository, providerService, {
    name: "Aevoren Bot",
    version: app.getVersion(),
    platform,
    architecture: process.arch,
    packaged: app.isPackaged,
  }, undefined, mcpService, () => routineService?.list() ?? []);
  mainWindow = createWindow(!hideTestWindow && !openedAtLogin);
  const sendWorker = new SendWorker(
    repository,
    providerService,
    { transcript: emitTranscript, sendState: emitSendState, runtime: emitRuntime },
    forceFakeProvider,
    undefined,
    undefined,
    workspaceToolCoordinator,
    capabilityRegistry,
    mcpService,
    decisionService,
    forceFakeProvider ? undefined : new MemoryCaptureService(repository, providerService),
  );
  runtimeCoordinator = sendWorker;
  routineService = new RoutineService(repository, sendWorker, (run) => {
    const title = run.state === "completed" ? "定时任务已完成" : run.state === "missed" ? "定时任务已错过" : "定时任务需要关注";
    showNotification(title, `${run.routineName} · ${run.state}`);
  });
  roomCoordinator = new RoomCoordinator(repository, sendWorker.executor, {
    transcript: emitTranscript,
    roomRuntime: emitRoomRuntime,
  }, decisionService);
  const updateConfigurationPath = join(process.resourcesPath, "app-update.yml");
  const updateChannel = resolveUpdateChannel({
    isPackaged: app.isPackaged,
    hasUpdateConfiguration: existsSync(updateConfigurationPath),
    currentVersion: app.getVersion(),
    disabled: process.env.AEVOREN_BOT_DISABLE_UPDATES === "1",
  });
  updateService = new UpdateService(new ElectronUpdateAdapter(new UpdateLogger(join(app.getPath("userData"), "logs", "updates.log"))), {
    currentVersion: app.getVersion(),
    channel: updateChannel,
    intervalMs: generalSettings.getConfiguration().updateCheckIntervalMinutes * 60 * 1_000,
    receiptStore: {
      getPendingReceipt: () => {
        const receipt = parsePendingUpdateReceipt(repository?.getSetting("update.pendingReceipt")?.value);
        if (receipt) return receipt;
        const legacyVersion = repository?.getSetting("update.pendingVersion")?.value || null;
        if (!legacyVersion || !valid(legacyVersion)) return null;
        return {
          version: legacyVersion,
          previousVersion: app.getVersion(),
          downloadedAt: new Date().toISOString(),
          requestedAt: null,
          attemptCount: 0,
        };
      },
      setPendingReceipt: (receipt) => {
        repository?.setSetting("update.pendingReceipt", receipt ? JSON.stringify(receipt) : "", false);
        repository?.setSetting("update.pendingVersion", receipt?.version ?? "", false);
      },
    },
    emit: emitUpdate,
  });
  const updateRepository = repository;
  const productUpdateService = updateService;
  const productOperations = registerIpc({
    window: mainWindow,
    repository,
    libraryService,
    environmentService,
    browserService,
    demonstrationService: new DemonstrationService(repository, browserService, libraryService),
    skillExecutionService: productSkillExecutionService,
    nativeConnectorService: productNativeConnectorService,
    nativeOutboundService: productNativeOutboundService,
    async saveBrowserDownload(input, context) {
      const file = await browserService!.downloadData(input, context);
      let path = hideTestWindow && userDataOverride ? process.env.AEVOREN_BOT_BROWSER_DOWNLOAD_TEST_PATH : undefined;
      if (!path) {
        if (!mainWindow || mainWindow.isDestroyed()) return null;
        const selected = await dialog.showSaveDialog(mainWindow, { title: "保存浏览器下载", defaultPath: basename(file.download.name) });
        if (selected.canceled || !selected.filePath) return null;
        path = selected.filePath;
      }
      const bytes = file.bytes;
      const output = await writeEnvironmentDownload(path, bytes, () => {
        repository!.browsers.assertAccess(input, input.expectedEpoch, context.actor ?? "user");
      }, context.signal);
      return { path: output, name: basename(file.download.name), size: bytes.length };
    },
    async pickEnvironmentUpload(input, signal) {
      const directory = environmentDirectoryPathSchema.parse(input.directory ?? ".");
      const testPath = hideTestWindow && userDataOverride ? process.env.AEVOREN_BOT_ENVIRONMENT_UPLOAD_TEST_PATH : undefined;
      let paths: string[];
      if (testPath) paths = [testPath];
      else {
        if (!mainWindow || mainWindow.isDestroyed()) return null;
        const selected = await dialog.showOpenDialog(mainWindow, { title: "上传文件到隔离环境", properties: ["openFile"] });
        if (selected.canceled) return null;
        paths = selected.filePaths;
      }
      const output: import("@shared/environment-contracts").EnvironmentFileWriteResult[] = [];
      for (const path of paths) {
        const content = await readEnvironmentUpload(path, signal);
        const target = environmentFilePathSchema.parse(directory === "." ? basename(path) : `${directory}/${basename(path)}`);
        output.push(await environmentService!.writeFile({ sessionId: input.sessionId, executorBotId: input.executorBotId, path: target, content: content.toString("base64"), encoding: "base64" }, signal));
      }
      return output;
    },
    async downloadEnvironmentFile(input, signal) {
      const file = await environmentService!.readFile(input);
      let path = hideTestWindow && userDataOverride ? process.env.AEVOREN_BOT_ENVIRONMENT_DOWNLOAD_TEST_PATH : undefined;
      if (!path) {
        if (!mainWindow || mainWindow.isDestroyed()) return null;
        const selected = await dialog.showSaveDialog(mainWindow, { title: "下载隔离环境文件", defaultPath: basename(file.path) });
        if (selected.canceled || !selected.filePath) return null;
        path = selected.filePath;
      }
      const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
      const output = await writeEnvironmentDownload(path, bytes, () => {
        if (!repository!.environments.get(input)) throw new AevorenBotError("ENVIRONMENT_NOT_FOUND");
      }, signal);
      return { path: output, name: basename(file.path), size: bytes.length };
    },
    libraryChanged(event) {
      void productSkillExecutionService.libraryChanged(event).catch(() => undefined);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.libraryEvent, event);
    },
    async pickLibraryPaths(input, signal) {
      signal?.throwIfAborted();
      const testPaths = hideTestWindow && userDataOverride ? process.env.AEVOREN_BOT_LIBRARY_IMPORT_TEST_PATHS?.split("\n").filter(Boolean) : undefined;
      if (testPaths?.length) return testPaths;
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: input.kind === "skill" ? "导入 Skill" : "导入资料",
        properties: input.directory ? ["openDirectory"] : ["openFile", "multiSelections"],
      });
      signal?.throwIfAborted();
      return result.canceled ? null : result.filePaths;
    },
    async exportLibraryResource(input, signal) {
      const snapshot = await libraryService.prepareExport(input, signal);
      let path = hideTestWindow && userDataOverride ? process.env.AEVOREN_BOT_LIBRARY_EXPORT_TEST_PATH : undefined;
      const safeName = snapshot.name.replace(/[^\p{L}\p{N} _-]/gu, "-").slice(0, 80) || "resource";
      if (!path) {
        if (!mainWindow || mainWindow.isDestroyed()) return null;
        if (snapshot.kind === "skill") {
          const result = await dialog.showOpenDialog(mainWindow, { title: "选择 Skill 导出位置", buttonLabel: "导出到新文件夹", properties: ["openDirectory", "createDirectory"] });
          if (result.canceled || !result.filePaths[0]) return null;
          path = join(result.filePaths[0], `${safeName}-${randomUUID().slice(0, 8)}`);
        } else {
          const result = await dialog.showSaveDialog(mainWindow, { title: "导出资料固定版本", defaultPath: `${safeName}.md`, filters: [{ name: "Markdown", extensions: ["md"] }], properties: ["createDirectory"] });
          if (result.canceled || !result.filePath) return null;
          path = result.filePath;
        }
      }
      const output = await writeLibraryExport(snapshot, path, signal, () => {
        repository!.library.read({ ...input, revisionId: snapshot.revisionId });
      });
      return { resourceId: snapshot.resourceId, revisionId: snapshot.revisionId, path: output };
    },
    providers: providerService,
    generalSettings,
    sendWorker,
    roomCoordinator,
    workspaceService,
    workspaceToolCoordinator,
    capabilityRegistry,
    mcpService,
    routineService,
    updateService,
    async pickWorkspaceRoot() {
      const testPath = process.env.AEVOREN_BOT_TEST_HIDDEN === "1"
        ? process.env.AEVOREN_BOT_WORKSPACE_TEST_PATH?.trim()
        : undefined;
      if (testPath) return testPath;
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "选择工作区文件夹",
        buttonLabel: "授权此文件夹",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    async pickAttachments() {
      const testPaths = process.env.AEVOREN_BOT_TEST_HIDDEN === "1"
        ? process.env.AEVOREN_BOT_ATTACHMENT_TEST_PATHS?.split("\n").map((value) => value.trim()).filter(Boolean)
        : undefined;
      if (testPaths && testPaths.length > 0) return readAttachments(testPaths);
      if (!mainWindow || mainWindow.isDestroyed()) return [];
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "添加文本附件",
        buttonLabel: "添加附件",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "文本与代码", extensions: ["txt", "md", "markdown", "csv", "json", "yaml", "yml", "xml", "html", "htm", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "sql", "py", "go", "rs", "java", "sh", "toml", "ini", "log", "diff"] }],
      });
      return result.canceled ? [] : readAttachments(result.filePaths);
    },
    async saveArtifact(input) {
      const testPath = process.env.AEVOREN_BOT_TEST_HIDDEN === "1" ? process.env.AEVOREN_BOT_ARTIFACT_TEST_PATH : undefined;
      if (testPath) {
        const saved = await writeArtifact(testPath, input);
        savedArtifactPaths.add(saved.path);
        return saved;
      }
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "保存结果文件",
        buttonLabel: "保存 Markdown",
        defaultPath: input.name.toLocaleLowerCase("en-US").endsWith(".md") ? input.name : `${input.name}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
        properties: ["createDirectory"],
      });
      if (result.canceled || !result.filePath) return null;
      const saved = await writeArtifact(result.filePath, input);
      savedArtifactPaths.add(saved.path);
      return saved;
    },
    revealArtifact(path) {
      if (!savedArtifactPaths.has(path)) return false;
      if (!hideTestWindow) shell.showItemInFolder(path);
      return true;
    },
    async revealWorkspaceTarget(input) {
      const target = await workspaceService.resolveExistingTarget(input.workspaceId, input.path, "file");
      if (!hideTestWindow) shell.showItemInFolder(target.canonicalPath);
      return true;
    },
    requestUpdateAfterRun(runId) {
      const downloaded = productUpdateService.getState();
      if (downloaded.status !== "downloaded") throw new AevorenBotError("UPDATE_NOT_READY");
      const timer = setInterval(() => {
        if (!repository) { clearInterval(timer); return; }
        let run: import("@shared/contracts").RuntimeRun;
        try { run = repository.getRuntimeRun(runId); } catch { clearInterval(timer); return; }
        if (["failed", "cancelled", "interrupted"].includes(run.state)) { clearInterval(timer); return; }
        if (run.state !== "completed" || repository.hasActiveTasks()) return;
        clearInterval(timer);
        const current = productUpdateService.getState();
        if (current.status !== "downloaded" || current.availableVersion !== downloaded.availableVersion) return;
        allowClose = true;
        try { productUpdateService.installAndRestart(); } catch { allowClose = false; }
      }, 100);
      timer.unref();
      return { status: "running", result: { scheduled: true, condition: "当前请求完成且没有其他活跃任务时安装更新；请求被取消或失败则取消安装。" } };
    },
    requestExitAfterRun(runId) {
      const timer = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed() || !repository) { clearInterval(timer); return; }
        let run: import("@shared/contracts").RuntimeRun;
        try { run = repository.getRuntimeRun(runId); } catch { clearInterval(timer); return; }
        if (["failed", "cancelled", "interrupted"].includes(run.state)) { clearInterval(timer); return; }
        if (run.state !== "completed" || repository.hasActiveTasks()) return;
        clearInterval(timer);
        productExitRequested = true;
        quitRequested = true;
        requestRendererFlush(mainWindow);
      }, 100);
      timer.unref();
      return { status: "running", result: { scheduled: true, condition: "当前请求完成且没有其他活跃任务时退出；请求被取消或失败则取消退出。" } };
    },
    forceFakeProvider,
    rendererReady() {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      rendererReady = true;
      rendererEverReady = true;
      if (pendingClose) requestRendererFlush(mainWindow);
    },
    confirmClose(canClose) {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (!closeRequested) return;
      if (productExitRequested && repository?.hasActiveTasks()) {
        productExitRequested = false; quitRequested = false; closeRequested = false; pendingClose = false;
        clearCloseConfirmationTimer();
        return;
      }
      productExitRequested = false;
      clearCloseConfirmationTimer();
      if (!canClose) {
        closeRequested = false;
        pendingClose = false;
        quitRequested = false;
        return;
      }
      void finishClose();
    },
    prepareUpdateInstall() {
      if (updateRepository.hasActiveTasks()) throw new AevorenBotError("UPDATE_TASKS_RUNNING");
      allowClose = true;
    },
    cancelUpdateInstall() {
      allowClose = false;
    },
  });
  workspaceToolExecutor.setProductOperations(productOperations);
  sendWorker.executor.setDelegationCancellation((runId) => {
    for (const child of updateRepository.listDelegatedRuntimeRuns(runId)) sendWorker.executor.cancelRun(child.id);
    for (const batch of updateRepository.listDelegatedRoomBatches(runId)) roomCoordinator?.cancel(batch.id);
  });
  updateService.start();
  routineService.start();
});

app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
});
app.on("before-quit", (event) => {
  if (allowClose) return;
  if (!rendererEverReady) {
    allowClose = true;
    return;
  }
  event.preventDefault();
  quitRequested = true;
  if (mainWindow && !mainWindow.isDestroyed()) requestRendererFlush(mainWindow);
  else {
    allowClose = true;
    app.quit();
  }
});
app.on("quit", () => {
  clearCloseConfirmationTimer();
  updateService?.stop();
  repository?.close();
  repository = null;
  runtimeCoordinator = null;
  roomCoordinator = null;
  updateService = null;
  providerService = null;
  mcpService = null;
  routineService = null;
});
