import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import type { ElectronApplication } from "@playwright/test";

const run = promisify(execFile);

/** Bound teardown of the isolated fixture; never signal an unrelated process. */
export async function closeTestApplication(application: Pick<ElectronApplication, "close" | "process">): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([application.close(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Isolated Electron close timed out")), 3_000);
    })]);
  } catch {
    if (timer) clearTimeout(timer);
    // Successful close disposes Playwright's process channel; read it only when
    // graceful teardown failed and the owned process may still need termination.
    const owned = application.process();
    const terminal = (): boolean => owned.exitCode !== null || owned.signalCode !== null;
    let closed = terminal() && owned.stdio.every(stream => !stream || stream.destroyed);
    let finish!: () => void;
    const closeEvent = new Promise<void>(resolve => { finish = resolve; });
    const onClose = (): void => { closed = true; finish(); };
    owned.once("close", onClose);
    try {
      console.warn("Isolated Electron close did not finish; terminating only its owned fixture process tree.");
      const pid = owned.pid;
      if (!closed && !terminal() && pid && Number.isSafeInteger(pid) && pid > 0) {
        if (process.platform === "win32") {
          // ChildProcess.kill marks `killed` before descendants exit, preventing
          // Playwright's later cleanup from repairing inherited open pipes.
          // Keep the existing 1.5s command + 2s pipe allowance as one finite
          // window, so the command can finish before validating the owned tree.
          const forcedStarted = performance.now();
          let commandError: unknown;
          const forcedDeadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(commandError ?? new Error("Owned Windows process tree or stdio did not close")), 3_500);
          });
          const command = run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
          try {
            await Promise.race([command.catch(error => { commandError = error; }), forcedDeadline]);
            if (!closed) await Promise.race([closeEvent, forcedDeadline]);
            if (!terminal() || owned.stdio.some(stream => stream && !stream.destroyed) || performance.now() - forcedStarted >= 3_500) {
              throw commandError ?? new Error("Owned Windows process tree or stdio did not finish within its cleanup budget");
            }
          } finally {
            if (timer) clearTimeout(timer);
            // The command handle is ours; never retry a PID after the tree closes.
            try { if (command.child.exitCode === null && command.child.signalCode === null) command.child.kill("SIGKILL"); }
            finally { command.child.stdout?.destroy(); command.child.stderr?.destroy(); command.child.unref(); }
          }
        } else {
          // Playwright gives Electron its own POSIX group. Check that ownership
          // before using a negative PID; ordinary children get a PID-only kill.
          const group = await run("ps", ["-o", "pgid=", "-p", String(pid)], { timeout: 1_000 }).then(result => Number(result.stdout.trim()), () => null);
          if (!terminal()) {
            try { process.kill(group === pid ? -pid : pid, "SIGKILL"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
        }
      }
      if (timer) clearTimeout(timer);
      if (!closed) await Promise.race([closeEvent, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Owned Electron process or stdio did not close")), 2_000);
      })]);
    } finally {
      owned.removeListener("close", onClose);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Best-effort cleanup for macOS temporary directories after Electron is killed. */
export function removeTestDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    if (process.platform !== "win32") console.warn(`temporary smoke directory cleanup deferred: ${path}`, error);
  }
}
