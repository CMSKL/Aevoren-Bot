import type { ElectronApplication } from "@playwright/test";
import { IPC } from "../../src/shared/channels";

export async function observeTestClose(application: ElectronApplication): Promise<{ phases: Record<string, unknown>[]; record(phase: string): void; detach(): void }> {
  const owned = application.process(), started = performance.now(), phases: Record<string, unknown>[] = [];
  const prefix = "AEVOREN_MCP_CLOSE_PHASE ";
  let buffered = "";
  const record = (phase: string): void => {
    if (phases.length < 120) phases.push({ source: "fixture", phase, elapsedMs: Math.round(performance.now() - started),
      exitCode: owned.exitCode, signalCode: owned.signalCode, killed: owned.killed, stdioClosed: owned.stdio.map(stream => !stream || stream.destroyed) });
  };
  const exited = (): void => record("owned-exit"), closed = (): void => record("owned-close");
  const stderr = (chunk: Buffer): void => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n"); buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith(prefix) && phases.length < 120) {
        try { phases.push({ source: "main", observedAtMs: Math.round(performance.now() - started), ...JSON.parse(line.slice(prefix.length)) as Record<string, unknown> }); }
        catch { record("invalid-main-phase"); }
      } else if (line.includes("Waiting for the debugger to disconnect")) record("inspector-disconnect-wait");
    }
    if (buffered.length > 4096) buffered = "";
  };
  owned.once("exit", exited); owned.once("close", closed); owned.stderr?.on("data", stderr);
  try {
    await application.evaluate(({ app, BrowserWindow, ipcMain }, channels) => {
      const started = performance.now();
      const record = (phase: string, values: Record<string, number | boolean | string> = {}): void => {
        console.error("AEVOREN_MCP_CLOSE_PHASE " + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started), ...values }));
      };
      app.on("before-quit", () => {
        const windows = BrowserWindow.getAllWindows();
        try {
          const frames = windows.flatMap(window => window.webContents.isDestroyed() ? [] : window.webContents.mainFrame.framesInSubtree);
          record("before-quit", { windows: windows.length, frames: frames.length, frameProcesses: new Set(frames.map(frame => frame.processId)).size });
        } catch { record("before-quit", { windows: windows.length, frameStateAvailable: false }); }
      });
      app.on("will-quit", () => record("will-quit", { windows: BrowserWindow.getAllWindows().length }));
      app.prependListener("quit", (_event, exitCode) => record("quit-handlers-start", { exitCode }));
      app.on("quit", (_event, exitCode) => record("quit", { exitCode }));
      const observeWindow = (window: InstanceType<typeof BrowserWindow>): void => {
        record("window-observed", { windows: BrowserWindow.getAllWindows().length });
        window.on("close", () => { try { record("window-close", { destroyed: window.isDestroyed(), loading: !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.isLoadingMainFrame() }); } catch { record("window-close-state-unavailable"); } });
        window.on("closed", () => record("window-closed", { windows: BrowserWindow.getAllWindows().length }));
        window.webContents.on("render-process-gone", (_event, details) => record("renderer-gone", { reason: details.reason, exitCode: details.exitCode }));
      };
      app.on("browser-window-created", (_event, window) => observeWindow(window));
      for (const window of BrowserWindow.getAllWindows()) observeWindow(window);
      ipcMain.on(channels.ready, event => { try { record("renderer-ready", { mainFrame: !event.sender.isDestroyed() && event.senderFrame === event.sender.mainFrame }); } catch { record("renderer-ready-frame-unavailable"); } });
      ipcMain.on(channels.confirm, (event, value: unknown) => { try { record("flush-ack", { mainFrame: !event.sender.isDestroyed() && event.senderFrame === event.sender.mainFrame, canClose: value === true }); } catch { record("flush-ack-frame-unavailable", { canClose: value === true }); } });
    }, { ready: IPC.appRendererReady, confirm: IPC.appConfirmClose });
  } catch { record("main-probe-unavailable"); }
  record("probe-installed");
  return { phases, record, detach() { owned.removeListener("exit", exited); owned.removeListener("close", closed); owned.stderr?.removeListener("data", stderr); } };
}
