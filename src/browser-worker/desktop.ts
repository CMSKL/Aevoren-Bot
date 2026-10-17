import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { ENGINE_ENVIRONMENT } from "./engine-client";
import { BrowserWorkerError } from "./worker-error";

export class Desktop {
  private readonly children: ChildProcess[] = [];

  private launch(command: string, args: string[]): void {
    const child = spawn(command, args, { uid: 1_000, gid: 1_000, cwd: "/", env: ENGINE_ENVIRONMENT, stdio: "ignore" });
    child.on("error", () => undefined);
    this.children.push(child);
  }

  async start(): Promise<void> {
    this.launch("Xvfb", [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"]);
    // The X socket is private to this container. No host display or X authority is mounted.
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await new Promise<boolean>(resolve => {
        const socket = connect("/tmp/.X11-unix/X99");
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
      });
      if (ready) break;
      if (attempt === 99) throw new BrowserWorkerError("BROWSER_DESKTOP_START_FAILED", 503);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    this.launch("openbox", ["--sm-disable"]);
    this.launch("x11vnc", ["-display", ":99", "-localhost", "-rfbport", "5900", "-forever", "-shared", "-nopw", "-noxdamage", "-quiet"]);
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await new Promise<boolean>(resolve => {
        const socket = connect(5_900, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
      });
      if (ready) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new BrowserWorkerError("BROWSER_DESKTOP_START_FAILED", 503);
  }

  close(): void { for (const child of this.children) child.kill("SIGTERM"); }
}
