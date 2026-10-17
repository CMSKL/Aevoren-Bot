import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { AevorenBotError } from "./errors";

/** Trusted user action: fixed Docker Desktop target, never a model-supplied command. */
export async function openDockerDesktop(): Promise<void> {
  if (process.platform === "darwin" && existsSync("/Applications/Docker.app")) {
    await promisify(execFile)("/usr/bin/open", ["-g", "-a", "/Applications/Docker.app"]); return;
  }
  const windowsPath = join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe");
  if (process.platform === "win32" && existsSync(windowsPath)) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(windowsPath, [], { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
    }); return;
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    const { shell } = await import("electron");
    await shell.openExternal("https://www.docker.com/products/docker-desktop/"); return;
  }
  throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE", "请先启动本机 Docker Linux 服务后重试。");
}
