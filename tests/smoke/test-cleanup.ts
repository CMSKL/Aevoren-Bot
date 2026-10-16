import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import type { ElectronApplication } from "@playwright/test";

const run = promisify(execFile);
type WindowsCommandMeasurement = { phase: string; elapsedMs: number; pid: number | null; exitCode: number | null;
  signalCode: NodeJS.Signals | null; killed: boolean; stdout?: string; stderr?: string };

/** Bound teardown of the isolated fixture; never signal an unrelated process. */
export async function closeTestApplication(application: Pick<ElectronApplication, "close" | "process">,
  measureWindowsCommand?: (event: WindowsCommandMeasurement) => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([application.close(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Isolated Electron close timed out")), 3_000);
    })]);
  } catch {
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
          const requested = performance.now();
          measureWindowsCommand?.({ phase: "requested", elapsedMs: 0, pid: null, exitCode: null, signalCode: null, killed: false });
          // Only the controlled Node tree measures completion beyond the original
          // command deadline. It still asserts that deadline and its original 5s bound.
          const command = run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: measureWindowsCommand ? 10_000 : 1_500 });
          const observe = (phase: string, output?: { stdout: string; stderr: string }): void => measureWindowsCommand?.({ phase,
            elapsedMs: Math.round(performance.now() - requested), pid: command.child.pid ?? null,
            exitCode: command.child.exitCode, signalCode: command.child.signalCode, killed: command.child.killed,
            ...(output ? { stdout: output.stdout.slice(0, 800), stderr: output.stderr.slice(0, 800) } : {}) });
          const onSpawn = (): void => observe("spawn"), onExit = (): void => observe("exit"), onCommandClose = (): void => observe("close");
          let measurementTimer: ReturnType<typeof setTimeout> | undefined, measurementLimit: ReturnType<typeof setTimeout> | undefined;
          if (measureWindowsCommand) {
            observe("created");
            command.child.once("spawn", onSpawn); command.child.once("exit", onExit); command.child.once("close", onCommandClose);
            measurementTimer = setTimeout(() => observe("original-1500ms-budget-elapsed"), 1_500);
          }
          const completion = command.then(output => { observe("resolved", output); }, error => {
            observe("rejected", { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") });
            if (!terminal()) throw error;
          });
          try {
            await (measureWindowsCommand ? Promise.race([completion, new Promise<never>((_resolve, reject) => {
              measurementLimit = setTimeout(() => {
                observe("measurement-10s-limit");
                try { command.child.kill("SIGKILL"); } catch { observe("measurement-command-abort-failed"); }
                command.child.stdout?.destroy(); command.child.stderr?.destroy(); command.child.unref();
                reject(new Error("Controlled Windows taskkill measurement exceeded its 10s limit"));
              }, Math.max(1, 10_000 - (performance.now() - requested)));
            })]) : completion);
          } finally {
            if (measurementTimer) clearTimeout(measurementTimer);
            if (measurementLimit) clearTimeout(measurementLimit);
            command.child.removeListener("spawn", onSpawn); command.child.removeListener("exit", onExit); command.child.removeListener("close", onCommandClose);
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
