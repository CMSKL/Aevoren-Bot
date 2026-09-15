import { gte, gt, prerelease, valid } from "semver";
import type { AppError, UpdateChannel, UpdateProgress, UpdateState } from "@shared/contracts";
import { AevorenBotError } from "./errors";

export type UpdateInfoLike = {
  version: string;
  releaseDate?: string;
};

export type UpdateCheckResultLike = {
  isUpdateAvailable: boolean;
  updateInfo: UpdateInfoLike;
};

export type UpdateAdapterConfiguration = {
  channel: "latest" | "beta";
  allowPrerelease: boolean;
};

export interface UpdateAdapter {
  configure(configuration: UpdateAdapterConfiguration): void;
  onChecking(listener: () => void): void;
  onUpdateAvailable(listener: (info: UpdateInfoLike) => void): void;
  onUpdateNotAvailable(listener: (info: UpdateInfoLike) => void): void;
  onDownloadProgress(listener: (progress: UpdateProgress) => void): void;
  onUpdateDownloaded(listener: (info: UpdateInfoLike) => void): void;
  onError(listener: (error: unknown) => void): void;
  checkForUpdates(): Promise<UpdateCheckResultLike | null>;
  downloadUpdate(): Promise<readonly string[]>;
  quitAndInstall(): void;
}

export interface UpdateReceiptStore {
  getPendingVersion(): string | null;
  setPendingVersion(version: string | null): void;
}

export type UpdateServiceOptions = {
  currentVersion: string;
  channel: UpdateChannel;
  startupDelayMs?: number;
  intervalMs?: number;
  receiptStore?: UpdateReceiptStore;
  emit?(state: UpdateState): void;
};

const DEFAULT_STARTUP_DELAY_MS = 15_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function updateError(code: "UPDATE_CHECK_FAILED" | "UPDATE_DOWNLOAD_FAILED" | "UPDATE_INSTALL_FAILED"): AppError {
  const messages = {
    UPDATE_CHECK_FAILED: "检查更新失败，当前版本可继续使用。",
    UPDATE_DOWNLOAD_FAILED: "更新下载失败，当前版本可继续使用。",
    UPDATE_INSTALL_FAILED: "更新安装未能启动，当前版本可继续使用。",
  } as const;
  return {
    code,
    domain: "update",
    retryable: true,
    safeMessage: messages[code],
  };
}

function initialState(options: UpdateServiceOptions): UpdateState {
  const base: UpdateState = {
    channel: options.channel,
    status: options.channel === "development" ? "disabled" : "idle",
    currentVersion: options.currentVersion,
    availableVersion: null,
    progress: null,
    checkedAt: null,
    error: null,
  };
  const pending = options.receiptStore?.getPendingVersion() ?? null;
  if (!pending || !valid(pending) || !valid(options.currentVersion) || !gte(options.currentVersion, pending)) return base;
  options.receiptStore?.setPendingVersion(null);
  return {
    ...base,
    status: "updated",
    availableVersion: options.currentVersion,
  };
}

export function resolveUpdateChannel(input: {
  isPackaged: boolean;
  hasUpdateConfiguration: boolean;
  currentVersion: string;
  disabled?: boolean;
}): UpdateChannel {
  if (!input.isPackaged || !input.hasUpdateConfiguration || input.disabled) return "development";
  return (prerelease(input.currentVersion)?.length ?? 0) > 0 ? "beta" : "stable";
}

export class UpdateService {
  private state: UpdateState;
  private started = false;
  private checkPromise: Promise<UpdateState> | null = null;
  private downloadPromise: Promise<UpdateState> | null = null;
  private operation: "checking" | "downloading" | "installing" | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly adapter: UpdateAdapter,
    private readonly options: UpdateServiceOptions,
  ) {
    this.state = initialState(options);
    this.adapter.onChecking(() => {
      if (this.operation === "checking") this.replace({ status: "checking", error: null });
    });
    this.adapter.onUpdateAvailable((info) => {
      if (!this.isNewer(info.version)) return;
      this.replace({ status: "available", availableVersion: info.version, progress: null, error: null });
    });
    this.adapter.onUpdateNotAvailable(() => {
      if (this.operation !== "checking") return;
      this.replace({ status: "up-to-date", availableVersion: null, progress: null, error: null, checkedAt: new Date().toISOString() });
    });
    this.adapter.onDownloadProgress((progress) => {
      if (this.operation !== "downloading") return;
      this.replace({ status: "downloading", progress: normalizeProgress(progress), error: null });
    });
    this.adapter.onUpdateDownloaded((info) => {
      if (!this.isNewer(info.version)) return;
      this.options.receiptStore?.setPendingVersion(info.version);
      this.replace({
        status: "downloaded",
        availableVersion: info.version,
        progress: { percent: 100, bytesPerSecond: 0, transferred: 0, total: 0 },
        error: null,
      });
    });
    this.adapter.onError(() => {
      if (this.operation === "installing") this.fail("UPDATE_INSTALL_FAILED");
      else if (this.operation === "downloading") this.fail("UPDATE_DOWNLOAD_FAILED");
      else if (this.operation === "checking") this.fail("UPDATE_CHECK_FAILED");
    });
  }

  getState(): UpdateState {
    return structuredClone(this.state);
  }

  start(): void {
    if (this.started || this.state.channel === "development") return;
    this.started = true;
    this.adapter.configure({
      channel: this.state.channel === "beta" ? "beta" : "latest",
      allowPrerelease: this.state.channel === "beta",
    });
    this.startupTimer = setTimeout(() => void this.check(), this.options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
    this.intervalTimer = setInterval(() => void this.check(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.intervalTimer.unref?.();
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
    this.started = false;
  }

  async check(): Promise<UpdateState> {
    if (this.state.channel === "development") return this.getState();
    if (this.state.status === "downloaded" || this.state.status === "installing") return this.getState();
    if (this.checkPromise) return this.checkPromise;
    if (this.downloadPromise) return this.downloadPromise;
    this.checkPromise = this.performCheck();
    try {
      return await this.checkPromise;
    } finally {
      this.checkPromise = null;
    }
  }

  retry(): Promise<UpdateState> {
    return this.check();
  }

  installAndRestart(): UpdateState {
    if (this.state.status !== "downloaded") throw new AevorenBotError("UPDATE_NOT_READY");
    this.operation = "installing";
    this.replace({ status: "installing", error: null });
    try {
      this.adapter.quitAndInstall();
      return this.getState();
    } catch {
      this.fail("UPDATE_INSTALL_FAILED");
      throw new AevorenBotError("UPDATE_INSTALL_FAILED");
    }
  }

  private async performCheck(): Promise<UpdateState> {
    this.operation = "checking";
    this.replace({ status: "checking", progress: null, error: null });
    try {
      const result = await this.adapter.checkForUpdates();
      if (!result || !result.isUpdateAvailable || !this.isNewer(result.updateInfo.version)) {
        this.operation = null;
        this.replace({
          status: "up-to-date",
          availableVersion: null,
          progress: null,
          error: null,
          checkedAt: new Date().toISOString(),
        });
        return this.getState();
      }
      this.replace({
        status: "available",
        availableVersion: result.updateInfo.version,
        progress: null,
        checkedAt: new Date().toISOString(),
        error: null,
      });
      return await this.download(result.updateInfo.version);
    } catch {
      if (this.state.status !== "error") this.fail("UPDATE_CHECK_FAILED");
      return this.getState();
    } finally {
      if (this.operation === "checking") this.operation = null;
    }
  }

  private async download(version: string): Promise<UpdateState> {
    if (this.state.status === "downloaded" && this.state.availableVersion === version) return this.getState();
    if (this.downloadPromise) return this.downloadPromise;
    this.downloadPromise = (async () => {
      this.operation = "downloading";
      this.replace({
        status: "downloading",
        availableVersion: version,
        progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 },
        error: null,
      });
      try {
        await this.adapter.downloadUpdate();
        if (this.state.status !== "downloaded") {
          this.options.receiptStore?.setPendingVersion(version);
          this.replace({
            status: "downloaded",
            availableVersion: version,
            progress: { percent: 100, bytesPerSecond: 0, transferred: 0, total: 0 },
            error: null,
          });
        }
        return this.getState();
      } catch {
        if (this.state.status !== "error") this.fail("UPDATE_DOWNLOAD_FAILED");
        return this.getState();
      } finally {
        if (this.operation === "downloading") this.operation = null;
      }
    })();
    try {
      return await this.downloadPromise;
    } finally {
      this.downloadPromise = null;
    }
  }

  private isNewer(candidate: string): boolean {
    return valid(candidate) !== null && valid(this.state.currentVersion) !== null && gt(candidate, this.state.currentVersion);
  }

  private fail(code: "UPDATE_CHECK_FAILED" | "UPDATE_DOWNLOAD_FAILED" | "UPDATE_INSTALL_FAILED"): void {
    this.operation = null;
    this.replace({ status: "error", progress: null, error: updateError(code) });
  }

  private replace(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.options.emit?.(this.getState());
  }
}

function normalizeProgress(progress: UpdateProgress): UpdateProgress {
  return {
    percent: Math.min(100, Math.max(0, Number.isFinite(progress.percent) ? progress.percent : 0)),
    bytesPerSecond: Math.max(0, Number.isFinite(progress.bytesPerSecond) ? progress.bytesPerSecond : 0),
    transferred: Math.max(0, Number.isFinite(progress.transferred) ? progress.transferred : 0),
    total: Math.max(0, Number.isFinite(progress.total) ? progress.total : 0),
  };
}
