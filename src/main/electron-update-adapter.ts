import electronUpdater, { type ProgressInfo, type UpdateInfo } from "electron-updater";
import type { UpdateProgress } from "@shared/contracts";
import type { UpdateAdapter, UpdateAdapterConfiguration, UpdateCheckResultLike, UpdateInfoLike } from "./update-service";

const { autoUpdater } = electronUpdater;

export class ElectronUpdateAdapter implements UpdateAdapter {
  configure(configuration: UpdateAdapterConfiguration): void {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.channel = configuration.channel;
    autoUpdater.allowPrerelease = configuration.allowPrerelease;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = null;
  }

  onChecking(listener: () => void): void {
    autoUpdater.on("checking-for-update", listener);
  }

  onUpdateAvailable(listener: (info: UpdateInfoLike) => void): void {
    autoUpdater.on("update-available", (info: UpdateInfo) => listener(info));
  }

  onUpdateNotAvailable(listener: (info: UpdateInfoLike) => void): void {
    autoUpdater.on("update-not-available", (info: UpdateInfo) => listener(info));
  }

  onDownloadProgress(listener: (progress: UpdateProgress) => void): void {
    autoUpdater.on("download-progress", (progress: ProgressInfo) => listener(progress));
  }

  onUpdateDownloaded(listener: (info: UpdateInfoLike) => void): void {
    autoUpdater.on("update-downloaded", (info: UpdateInfo) => listener(info));
  }

  onError(listener: (error: unknown) => void): void {
    autoUpdater.on("error", listener);
  }

  async checkForUpdates(): Promise<UpdateCheckResultLike | null> {
    const result = await autoUpdater.checkForUpdates();
    if (!result) return null;
    return { isUpdateAvailable: result.isUpdateAvailable, updateInfo: result.updateInfo };
  }

  downloadUpdate(): Promise<readonly string[]> {
    return autoUpdater.downloadUpdate();
  }

  quitAndInstall(): void {
    autoUpdater.quitAndInstall(false, true);
  }
}
