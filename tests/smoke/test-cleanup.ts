import { rmSync } from "node:fs";

/** Best-effort cleanup for macOS temporary directories after Electron is killed. */
export function removeTestDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    console.warn(`temporary smoke directory cleanup deferred: ${path}`, error);
  }
}
