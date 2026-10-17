import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { IPC } from "@shared/channels";
import type { ProductViewInput, ProductViewResult } from "@shared/product-view";

/** A scoped request/reply bridge, never arbitrary Renderer code execution. */
export class ProductViewService {
  private readonly pending = new Map<string, (result: ProductViewResult) => void>();
  constructor(private readonly window: BrowserWindow) {
    window.once("closed", () => { for (const reply of this.pending.values()) reply({ status: "cancelled", reason: "窗口已关闭。" }); });
  }

  request(input: ProductViewInput): Promise<ProductViewResult> {
    if (this.window.isDestroyed() || this.window.webContents.isLoadingMainFrame()) {
      return Promise.resolve({ status: "waiting_user", reason: "界面尚未就绪，请打开应用后重试。" });
    }
    if (input.action === "window_show") { this.window.show(); return Promise.resolve({ status: "completed" }); }
    if (input.action === "window_hide") { this.window.hide(); return Promise.resolve({ status: "completed" }); }
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ status: "waiting_user", reason: "此操作需要当前界面或用户继续处理。" }); }, 15_000);
      this.pending.set(id, (result) => { clearTimeout(timer); this.pending.delete(id); resolve(result); });
      this.window.webContents.send(IPC.productViewEvent, { id, input });
    });
  }

  respond(id: string, result: ProductViewResult): boolean {
    const reply = this.pending.get(id);
    if (!reply || JSON.stringify(result).length > 600_000) return false;
    reply(result);
    return true;
  }
}
