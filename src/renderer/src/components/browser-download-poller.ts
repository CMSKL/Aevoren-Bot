import type { ApiResult } from "@shared/contracts";
import type { BrowserDownloadsPage, BrowserEpochInput } from "@shared/browser-contracts";

export function pollBrowserDownloads(input: BrowserEpochInput,
  read: (input: BrowserEpochInput) => Promise<ApiResult<BrowserDownloadsPage>>,
  onReceipt: (data: BrowserDownloadsPage) => void,
  onError: (message: string) => void): () => void {
  let disposed = false;
  let pending = false;
  const poll = async (): Promise<void> => {
    if (disposed || pending) return;
    pending = true;
    try {
      const result = await read(input);
      if (disposed) return;
      if (result.ok) onReceipt(result.data);
      else onError(result.error.safeMessage);
    } catch { if (!disposed) onError("无法更新下载状态，请刷新实际连接。"); }
    finally { pending = false; }
  };
  const timer = setInterval(() => { void poll(); }, 3000);
  void poll();
  return () => { disposed = true; clearInterval(timer); };
}
