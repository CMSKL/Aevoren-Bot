import { rmSync } from "node:fs";
import type { ElectronApplication } from "@playwright/test";

/** Bound teardown of the isolated fixture; never signal another Electron process. */
export async function closeTestApplication(application: Pick<ElectronApplication, "close" | "process">): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([application.close(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Isolated Electron close timed out")), 3_000);
    })]);
  } catch { application.process().kill("SIGKILL"); }
  finally { if (timer) clearTimeout(timer); }
}

/** Best-effort cleanup for macOS temporary directories after Electron is killed. */
export function removeTestDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    if (process.platform !== "win32") console.warn(`temporary smoke directory cleanup deferred: ${path}`, error);
  }
}
