import { join } from "node:path";
import { app, BrowserWindow, safeStorage, shell } from "electron";
import { IPC } from "@shared/channels";
import type { SendStateEvent, TranscriptEvent } from "@shared/contracts";
import { AppRepository } from "./database";
import { registerIpc } from "./ipc";
import { SendWorker } from "./send-worker";
import { ModelSettingsService, type SecretCodec } from "./settings";

const userDataOverride = process.env.MS_BOT_USER_DATA_DIR;
if (userDataOverride) app.setPath("userData", userDataOverride);

let mainWindow: BrowserWindow | null = null;
let repository: AppRepository | null = null;
let allowClose = false;
let closeRequested = false;
let quitRequested = false;

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

function requestRendererFlush(window: BrowserWindow): void {
  if (closeRequested) return;
  closeRequested = true;
  window.webContents.send(IPC.appBeforeClose);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
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
  window.on("close", (event) => {
    if (allowClose) return;
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
  const settings = new ModelSettingsService(repository, electronSecretCodec);
  mainWindow = createWindow();
  const forceFakeProvider = process.env.MS_BOT_FAKE_PROVIDER === "1";
  const sendWorker = new SendWorker(
    repository,
    settings,
    { transcript: emitTranscript, sendState: emitSendState },
    forceFakeProvider,
  );
  registerIpc({
    window: mainWindow,
    repository,
    settings,
    sendWorker,
    forceFakeProvider,
    confirmClose(canClose) {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (!canClose) {
        closeRequested = false;
        quitRequested = false;
        return;
      }
      allowClose = true;
      if (quitRequested) app.quit();
      else mainWindow.close();
    },
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (allowClose) return;
  event.preventDefault();
  quitRequested = true;
  if (mainWindow && !mainWindow.isDestroyed()) requestRendererFlush(mainWindow);
  else {
    allowClose = true;
    app.quit();
  }
});
app.on("quit", () => {
  repository?.close();
  repository = null;
});
