import { describe, expect, it, vi } from "vitest";
import type { UpdateProgress } from "@shared/contracts";
import {
  parsePendingUpdateReceipt,
  resolveUpdateChannel,
  UpdateService,
  type PendingUpdateReceipt,
  type UpdateAdapter,
  type UpdateAdapterConfiguration,
  type UpdateCheckResultLike,
  type UpdateInfoLike,
} from "./update-service";

class FakeUpdateAdapter implements UpdateAdapter {
  configuration: UpdateAdapterConfiguration | null = null;
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;
  result: UpdateCheckResultLike | null = {
    isUpdateAvailable: false,
    updateInfo: { version: "1.0.0" },
  };
  checkError: Error | null = null;
  downloadError: Error | null = null;
  installError: Error | null = null;
  private checking: Array<() => void> = [];
  private available: Array<(info: UpdateInfoLike) => void> = [];
  private notAvailable: Array<(info: UpdateInfoLike) => void> = [];
  private progress: Array<(progress: UpdateProgress) => void> = [];
  private downloaded: Array<(info: UpdateInfoLike) => void> = [];
  private errors: Array<(error: unknown) => void> = [];

  configure(configuration: UpdateAdapterConfiguration): void { this.configuration = configuration; }
  onChecking(listener: () => void): void { this.checking.push(listener); }
  onUpdateAvailable(listener: (info: UpdateInfoLike) => void): void { this.available.push(listener); }
  onUpdateNotAvailable(listener: (info: UpdateInfoLike) => void): void { this.notAvailable.push(listener); }
  onDownloadProgress(listener: (progress: UpdateProgress) => void): void { this.progress.push(listener); }
  onUpdateDownloaded(listener: (info: UpdateInfoLike) => void): void { this.downloaded.push(listener); }
  onError(listener: (error: unknown) => void): void { this.errors.push(listener); }

  async checkForUpdates(): Promise<UpdateCheckResultLike | null> {
    this.checkCalls += 1;
    this.checking.forEach((listener) => listener());
    if (this.checkError) throw this.checkError;
    if (this.result?.isUpdateAvailable) this.available.forEach((listener) => listener(this.result!.updateInfo));
    else if (this.result) this.notAvailable.forEach((listener) => listener(this.result!.updateInfo));
    return this.result;
  }

  async downloadUpdate(): Promise<readonly string[]> {
    this.downloadCalls += 1;
    if (this.downloadError) throw this.downloadError;
    const version = this.result?.updateInfo.version ?? "1.0.1";
    this.progress.forEach((listener) => listener({ percent: 51.5, bytesPerSecond: 1_024, transferred: 515, total: 1_000 }));
    this.downloaded.forEach((listener) => listener({ version }));
    return ["update.zip"];
  }

  quitAndInstall(): void {
    this.installCalls += 1;
    if (this.installError) throw this.installError;
  }

  emitError(error = new Error("private update URL must not leak")): void {
    this.errors.forEach((listener) => listener(error));
  }
}

function receipt(version: string, previousVersion = "1.0.0", attemptCount = 0): PendingUpdateReceipt {
  return {
    version,
    previousVersion,
    downloadedAt: "2026-09-16T00:00:00.000Z",
    requestedAt: null,
    attemptCount,
  };
}

function createStore(pending: PendingUpdateReceipt | null = null): {
  store: { getPendingReceipt(): PendingUpdateReceipt | null; setPendingReceipt(value: PendingUpdateReceipt | null): void };
  values: Array<PendingUpdateReceipt | null>;
} {
  let current = pending;
  const values: Array<PendingUpdateReceipt | null> = [];
  return {
    values,
    store: {
      getPendingReceipt: () => current,
      setPendingReceipt(value) {
        current = value;
        values.push(value);
      },
    },
  };
}

describe("resolveUpdateChannel", () => {
  it("disables unpackaged, unconfigured and explicitly disabled builds", () => {
    expect(resolveUpdateChannel({ isPackaged: false, hasUpdateConfiguration: true, currentVersion: "1.0.0" })).toBe("development");
    expect(resolveUpdateChannel({ isPackaged: true, hasUpdateConfiguration: false, currentVersion: "1.0.0" })).toBe("development");
    expect(resolveUpdateChannel({ isPackaged: true, hasUpdateConfiguration: true, currentVersion: "1.0.0", disabled: true })).toBe("development");
  });

  it("separates stable and prerelease packages", () => {
    expect(resolveUpdateChannel({ isPackaged: true, hasUpdateConfiguration: true, currentVersion: "1.2.3" })).toBe("stable");
    expect(resolveUpdateChannel({ isPackaged: true, hasUpdateConfiguration: true, currentVersion: "1.2.3-beta.2" })).toBe("beta");
  });
});

describe("UpdateService", () => {
  it("never configures or contacts the network in development", async () => {
    const adapter = new FakeUpdateAdapter();
    const service = new UpdateService(adapter, { currentVersion: "1.0.0", channel: "development" });
    service.start();
    expect(await service.check()).toMatchObject({ status: "disabled", channel: "development" });
    expect(adapter.configuration).toBeNull();
    expect(adapter.checkCalls).toBe(0);
  });

  it("configures stable and beta channels without allowing downgrade", () => {
    const stable = new FakeUpdateAdapter();
    new UpdateService(stable, { currentVersion: "1.0.0", channel: "stable" }).start();
    expect(stable.configuration).toEqual({ channel: "latest", allowPrerelease: false });
    const beta = new FakeUpdateAdapter();
    new UpdateService(beta, { currentVersion: "1.1.0-beta.1", channel: "beta" }).start();
    expect(beta.configuration).toEqual({ channel: "beta", allowPrerelease: true });
  });

  it("reports no update without downloading", async () => {
    const adapter = new FakeUpdateAdapter();
    const service = new UpdateService(adapter, { currentVersion: "1.0.0", channel: "stable" });
    service.start();
    expect(await service.check()).toMatchObject({ status: "up-to-date", availableVersion: null, error: null });
    expect(adapter.downloadCalls).toBe(0);
  });

  it.each(["1.0.0", "0.9.9", "not-semver"])("rejects non-newer feed version %s", async (version) => {
    const adapter = new FakeUpdateAdapter();
    adapter.result = { isUpdateAvailable: true, updateInfo: { version } };
    const service = new UpdateService(adapter, { currentVersion: "1.0.0", channel: "stable" });
    service.start();
    expect((await service.check()).status).toBe("up-to-date");
    expect(adapter.downloadCalls).toBe(0);
  });

  it("automatically downloads one newer version, emits progress and writes a receipt", async () => {
    const adapter = new FakeUpdateAdapter();
    adapter.result = { isUpdateAvailable: true, updateInfo: { version: "1.1.0" } };
    const receipt = createStore();
    const events: string[] = [];
    const service = new UpdateService(adapter, {
      currentVersion: "1.0.0",
      channel: "stable",
      receiptStore: receipt.store,
      emit: (state) => events.push(`${state.status}:${state.progress?.percent ?? "-"}`),
    });
    service.start();
    expect(await service.check()).toMatchObject({ status: "downloaded", availableVersion: "1.1.0" });
    expect(events).toContain("downloading:51.5");
    expect(receipt.values).toContainEqual(expect.objectContaining({
      version: "1.1.0",
      previousVersion: "1.0.0",
      requestedAt: null,
      attemptCount: 0,
    }));
    expect(adapter.downloadCalls).toBe(1);
    await service.check();
    expect(adapter.checkCalls).toBe(1);
    expect(adapter.downloadCalls).toBe(1);
  });

  it("keeps the running version usable after a network/download failure and retries", async () => {
    const adapter = new FakeUpdateAdapter();
    adapter.result = { isUpdateAvailable: true, updateInfo: { version: "1.1.0" } };
    adapter.downloadError = new Error("ECONNRESET secret-host");
    const service = new UpdateService(adapter, { currentVersion: "1.0.0", channel: "stable" });
    service.start();
    expect(await service.check()).toMatchObject({
      status: "error",
      currentVersion: "1.0.0",
      error: { code: "UPDATE_DOWNLOAD_FAILED", retryable: true },
    });
    adapter.downloadError = null;
    expect(await service.retry()).toMatchObject({ status: "downloaded", availableVersion: "1.1.0" });
    expect(adapter.downloadCalls).toBe(2);
  });

  it("does not leak updater errors and classifies check failures", async () => {
    const adapter = new FakeUpdateAdapter();
    adapter.checkError = new Error("https://secret.invalid/token");
    const service = new UpdateService(adapter, { currentVersion: "1.0.0", channel: "stable" });
    service.start();
    expect(await service.check()).toMatchObject({ error: { code: "UPDATE_CHECK_FAILED" } });
    expect(JSON.stringify(service.getState())).not.toContain("secret.invalid");
  });

  it("only installs a downloaded update and recovers from a synchronous install failure", async () => {
    const adapter = new FakeUpdateAdapter();
    const receiptStore = createStore();
    const service = new UpdateService(adapter, { currentVersion: "1.0.0", channel: "stable", receiptStore: receiptStore.store });
    service.start();
    expect(() => service.installAndRestart()).toThrowError(expect.objectContaining({ code: "UPDATE_NOT_READY" }));
    adapter.result = { isUpdateAvailable: true, updateInfo: { version: "1.1.0" } };
    await service.check();
    adapter.installError = new Error("install unavailable");
    expect(() => service.installAndRestart()).toThrowError(expect.objectContaining({ code: "UPDATE_INSTALL_FAILED" }));
    expect(service.getState()).toMatchObject({ status: "error", currentVersion: "1.0.0", error: { code: "UPDATE_INSTALL_FAILED" } });
    expect(adapter.installCalls).toBe(1);
    expect(receiptStore.values.at(-1)).toMatchObject({ version: "1.1.0", requestedAt: expect.any(String), attemptCount: 1 });
  });

  it("confirms a successfully launched downloaded version and clears its receipt", () => {
    const receiptStore = createStore(receipt("1.1.0"));
    const service = new UpdateService(new FakeUpdateAdapter(), {
      currentVersion: "1.1.0",
      channel: "stable",
      receiptStore: receiptStore.store,
    });
    expect(service.getState()).toMatchObject({ status: "updated", currentVersion: "1.1.0", availableVersion: "1.1.0" });
    expect(receiptStore.values).toEqual([null]);
  });

  it("reports an interrupted install when the old version launches again without retrying automatically", () => {
    const receiptStore = createStore(receipt("1.1.0", "1.0.0", 1));
    const adapter = new FakeUpdateAdapter();
    adapter.result = { isUpdateAvailable: true, updateInfo: { version: "1.1.0" } };
    const service = new UpdateService(adapter, {
      currentVersion: "1.0.0",
      channel: "stable",
      receiptStore: receiptStore.store,
    });
    expect(service.getState()).toMatchObject({
      status: "install-interrupted",
      currentVersion: "1.0.0",
      availableVersion: "1.1.0",
      error: { code: "UPDATE_INSTALL_INTERRUPTED", retryable: true },
    });
    expect(adapter.checkCalls).toBe(0);
    expect(receiptStore.values).toEqual([]);
  });

  it("parses only complete, safe pending update receipts", () => {
    const value = receipt("1.1.0");
    expect(parsePendingUpdateReceipt(JSON.stringify(value))).toEqual(value);
    expect(parsePendingUpdateReceipt("not-json")).toBeNull();
    expect(parsePendingUpdateReceipt(JSON.stringify({ ...value, version: "next" }))).toBeNull();
    expect(parsePendingUpdateReceipt(JSON.stringify({ ...value, attemptCount: -1 }))).toBeNull();
  });

  it("checks after startup and at the configured interval without overlap", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeUpdateAdapter();
      const service = new UpdateService(adapter, {
        currentVersion: "1.0.0",
        channel: "stable",
        startupDelayMs: 100,
        intervalMs: 1_000,
      });
      service.start();
      await vi.advanceTimersByTimeAsync(99);
      expect(adapter.checkCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(adapter.checkCalls).toBe(1);
      service.setCheckIntervalMinutes(60);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(adapter.checkCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000 - 1_001);
      expect(adapter.checkCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(adapter.checkCalls).toBe(2);
      service.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(adapter.checkCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("automatically downloads a newer version found by the startup check", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeUpdateAdapter();
      adapter.result = { isUpdateAvailable: true, updateInfo: { version: "1.1.0" } };
      const service = new UpdateService(adapter, {
        currentVersion: "1.0.0",
        channel: "stable",
        startupDelayMs: 100,
        intervalMs: 60_000,
      });
      service.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(adapter.checkCalls).toBe(1);
      expect(adapter.downloadCalls).toBe(1);
      expect(service.getState()).toMatchObject({ status: "downloaded", availableVersion: "1.1.0" });
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
