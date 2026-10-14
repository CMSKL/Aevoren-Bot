import { chownSync, chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isIP } from "node:net";
import { BrowserWorker } from "./browser-worker";
import { EngineClient } from "./engine-client";
import { Desktop } from "./desktop";
import { createBrowserServer } from "./server";
import { browserDownloadSchema, browserDownloadFailureSchema } from "@shared/browser-schemas";

const environmentId = z.string().uuid().parse(process.env.AEVOREN_BROWSER_ENVIRONMENT_ID);
const browserSessionId = z.string().uuid().parse(process.env.AEVOREN_BROWSER_SESSION_ID);
const token = z.string().regex(/^[a-f0-9]{64}$/u).parse(process.env.AEVOREN_BROWSER_TOKEN);
const previewExecutionIp = process.env.AEVOREN_PREVIEW_EXECUTION_IP;
if (previewExecutionIp && isIP(previewExecutionIp) !== 4) throw new Error("Preview target must be an owned IPv4 address");
const stateDirectory = "/var/lib/aevoren-browser-state", profileDirectory = "/var/lib/aevoren-browser-profile", downloadsDirectory = "/var/lib/aevoren-browser-downloads";
for (const directory of [stateDirectory, profileDirectory, downloadsDirectory]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Browser volumes must be owned directories");
  const uid = directory === stateDirectory ? 0 : 1_000;
  if (info.uid === 0) { chmodSync(directory, 0o700); if (uid !== 0) chownSync(directory, uid, uid); }
  else if (info.uid !== uid || info.mode & 0o077) throw new Error("Browser volume ownership is invalid");
}
process.umask(0o077);
const desktop = new Desktop();
await desktop.start();
const engine = new EngineClient({ enginePath: join(dirname(fileURLToPath(import.meta.url)), "engine.mjs"), browserSessionId, environmentId, previewExecutionIp, profileDirectory, downloadsDirectory,
  onDownload: record => {
    const valid = browserDownloadSchema.parse({ ...record, browserSessionId, mimeType: "application/octet-stream" });
    worker.store.addDownload(valid);
  }, onDownloadFailure: record => { worker.store.addDownloadFailure(browserDownloadFailureSchema.parse(record)); }, onStopped: () => worker.engineStopped() });
const worker = new BrowserWorker({ environmentId, browserSessionId, stateDirectory, downloadsDirectory }, engine);
await engine.start(worker.store.control());
worker.acknowledgeControl();
const server = createBrowserServer(worker, token);
server.listen(8_081, "0.0.0.0");
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true; server.close(); server.closeAllConnections();
  void worker.close().finally(() => { desktop.close(); process.exit(0); });
});
