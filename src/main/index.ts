import { join } from "node:path";
import { app, BrowserWindow, safeStorage, shell } from "electron";
import { IPC } from "@shared/channels";
import type { RuntimeEvent, SendStateEvent, TranscriptEvent } from "@shared/contracts";
import { AppRepository } from "./database";
import { registerIpc } from "./ipc";
import { SendWorker } from "./send-worker";
import { ModelSettingsService, type SecretCodec } from "./settings";

const userDataOverride = process.env.MS_BOT_USER_DATA_DIR;
if (userDataOverride) app.setPath("userData", userDataOverride);

let mainWindow: BrowserWindow | null = null;
let repository: AppRepository | null = null;
let runtimeCoordinator: SendWorker | null = null;
let allowClose = false;
let closeRequested = false;
let quitRequested = false;
let rendererReady = false;
let rendererEverReady = false;
let pendingClose = false;
let closeConfirmationTimer: ReturnType<typeof setTimeout> | null = null;
let shutdownPromise: Promise<void> | null = null;

const CLOSE_CONFIRMATION_TIMEOUT_MS = 5_000;

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
  shutdownPromise ??= runtimeCoordinator?.shutdown() ?? Promise.resolve();
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

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 420,
    minHeight: 640,
    backgroundColor: "#ffffff",
    title: "MS-Bot",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
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

app.whenReady().then(() => {
  const databasePath = process.env.MS_BOT_DB_PATH ?? join(app.getPath("userData"), "ms-bot.sqlite");
  repository = new AppRepository(databasePath);
  repository.recoverInterruptedSends();
  repository.recoverInterruptedRuntimeRuns();
  const settings = new ModelSettingsService(repository, electronSecretCodec);
  mainWindow = createWindow();
  const forceFakeProvider = process.env.MS_BOT_FAKE_PROVIDER === "1";
  const sendWorker = new SendWorker(
    repository,
    settings,
    { transcript: emitTranscript, sendState: emitSendState, runtime: emitRuntime },
    forceFakeProvider,
  );
  runtimeCoordinator = sendWorker;
  registerIpc({
    window: mainWindow,
    repository,
    settings,
    sendWorker,
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
  });
});

app.on("window-all-closed", () => app.quit());
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
  repository?.close();
  repository = null;
  runtimeCoordinator = null;
});
