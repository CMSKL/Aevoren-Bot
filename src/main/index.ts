import "./identity";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, nativeTheme, Notification, safeStorage, shell } from "electron";
import { valid } from "semver";
import { IPC } from "@shared/channels";
import type { RoomRuntimeEvent, RuntimeEvent, SendStateEvent, ToolEvent, TranscriptEvent, UpdateState } from "@shared/contracts";
import { AppRepository } from "./database";
import { registerIpc } from "./ipc";
import { SendWorker } from "./send-worker";
import { RoomCoordinator } from "./room-coordinator";
import { GeneralSettingsService, type SecretCodec } from "./settings";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { ElectronUpdateAdapter } from "./electron-update-adapter";
import { parsePendingUpdateReceipt, resolveUpdateChannel, UpdateService } from "./update-service";
import { ProviderService } from "./provider-service";
import { CapabilityRegistry } from "./capability-registry";
import { NetworkToolExecutor } from "./network-tool-executor";
import { McpService } from "./mcp-service";
import { RoutineService } from "./routine-service";
import { DeviceToolExecutor } from "./device-tool-executor";

const userDataOverride = process.env.AEVOREN_BOT_USER_DATA_DIR;
if (userDataOverride) app.setPath("userData", userDataOverride);
const hideTestWindow = process.env.AEVOREN_BOT_TEST_HIDDEN === "1";

let mainWindow: BrowserWindow | null = null;
let repository: AppRepository | null = null;
let runtimeCoordinator: SendWorker | null = null;
let roomCoordinator: RoomCoordinator | null = null;
let updateService: UpdateService | null = null;
let providerService: ProviderService | null = null;
let mcpService: McpService | null = null;
let routineService: RoutineService | null = null;
let allowClose = false;
let closeRequested = false;
let quitRequested = false;
let rendererReady = false;
let rendererEverReady = false;
let pendingClose = false;
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
    await runtimeCoordinator?.shutdown();
    await roomCoordinator?.shutdown();
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
  const generalSettings = new GeneralSettingsService(repository, {
    supported: app.isPackaged && process.platform === "darwin",
    get: () => {
      const value = app.getLoginItemSettings({ type: "mainAppService" });
      return { openAtLogin: value.openAtLogin, status: value.status };
    },
    set: (openAtLogin) => app.setLoginItemSettings({ type: "mainAppService", openAtLogin }),
  });
  const openedAtLogin = (() => {
    if (!app.isPackaged || process.platform !== "darwin") return false;
    try {
      return app.getLoginItemSettings({ type: "mainAppService" }).wasOpenedAtLogin;
    } catch {
      return false;
    }
  })();
  const workspaceService = new WorkspaceService(repository);
  mcpService = new McpService(repository, electronSecretCodec, app.getVersion(), (url) => shell.openExternal(url));
  await mcpService.initialize();
  const workspaceToolCoordinator = new WorkspaceToolCoordinator(
    repository,
    new WorkspaceToolExecutor(repository, workspaceService, new NetworkToolExecutor(), mcpService, new DeviceToolExecutor(() => clipboard.readText())),
    emitTool,
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
  );
  runtimeCoordinator = sendWorker;
  routineService = new RoutineService(repository, sendWorker, (run) => {
    const title = run.state === "completed" ? "定时任务已完成" : run.state === "missed" ? "定时任务已错过" : "定时任务需要关注";
    showNotification(title, `${run.routineName} · ${run.state}`);
  });
  roomCoordinator = new RoomCoordinator(repository, sendWorker.executor, {
    transcript: emitTranscript,
    roomRuntime: emitRoomRuntime,
  });
  const updateConfigurationPath = join(process.resourcesPath, "app-update.yml");
  const updateChannel = resolveUpdateChannel({
    isPackaged: app.isPackaged,
    hasUpdateConfiguration: existsSync(updateConfigurationPath),
    currentVersion: app.getVersion(),
    disabled: process.env.AEVOREN_BOT_DISABLE_UPDATES === "1",
  });
  updateService = new UpdateService(new ElectronUpdateAdapter(), {
    currentVersion: app.getVersion(),
    channel: updateChannel,
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
  registerIpc({
    window: mainWindow,
    repository,
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
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "选择工作区文件夹",
        buttonLabel: "授权此文件夹",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
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
      allowClose = true;
    },
    cancelUpdateInstall() {
      allowClose = false;
    },
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
