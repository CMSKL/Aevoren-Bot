import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ExecutionWorker } from "./execution-worker";
import { createWorkerServer } from "./server";

const environmentId = z.string().uuid().parse(process.env.AEVOREN_WORKER_ENVIRONMENT_ID);
const token = z.string().regex(/^[a-f0-9]{64}$/u).parse(process.env.AEVOREN_WORKER_TOKEN);
const stateDirectory = "/var/lib/aevoren";
mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
if (lstatSync(stateDirectory).isSymbolicLink()) throw new Error("Worker state must be a private directory");
chmodSync(stateDirectory, 0o700);
process.umask(0o007);
const worker = new ExecutionWorker({ environmentId, stateDirectory, workspaceDirectory: "/workspace",
  helperPath: join(dirname(fileURLToPath(import.meta.url)), "file-helper.mjs") });
await worker.initialize();
const server = createWorkerServer(worker, token);
server.listen(8_080, "0.0.0.0");
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  void worker.close().finally(() => process.exit(0));
});
