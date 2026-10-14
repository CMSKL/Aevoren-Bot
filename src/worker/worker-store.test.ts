import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerExecutionRequest } from "@shared/environment-contracts";
import { WorkerStore } from "./worker-store";

const roots: string[] = [];
const stores: WorkerStore[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aevoren-worker-ledger-")); roots.push(root);
  const filename = join(root, "worker.sqlite");
  const environmentId = crypto.randomUUID();
  const store = new WorkerStore(filename, environmentId, crypto.randomUUID()); stores.push(store);
  const request: WorkerExecutionRequest = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), runtimeRunId: crypto.randomUUID(),
    command: "fixture command metadata", cwd: ".", kind: "foreground", timeoutMs: 120_000 };
  return { store, request, filename, environmentId };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Worker SQLite journal", () => {
  it("reuses an identical request and rejects changed inputs without creating another job", () => {
    const f = fixture();
    expect(f.store.existing(f.request)).toBeNull();
    f.store.create(f.request, 1_010);
    f.store.running(f.request.id, 123);
    expect(f.store.existing(f.request)?.id).toBe(f.request.id);
    expect(() => f.store.existing({ ...f.request, command: "different metadata" })).toThrowError(expect.objectContaining({ code: "WORKER_IDEMPOTENCY_CONFLICT" }));
    expect(f.store.list()).toHaveLength(1);
  });
  it("preserves actual log bytes, advances cursors and marks removed logs as truncated", () => {
    const f = fixture(); f.store.create(f.request, 1_010);
    const bytes = Buffer.from([0, 255, 128]);
    const first = f.store.append(f.request.id, "stdout", "\0��", bytes);
    expect(Buffer.from(first.bytesBase64!, "base64")).toEqual(bytes);
    expect(f.store.logs(f.request.id, 0)[0]).toEqual(first);
    for (let index = 0; index < 80; index += 1) f.store.append(f.request.id, "stdout", "x".repeat(16_384));
    expect(f.store.get(f.request.id).truncated).toBe(true);
    expect(f.store.firstSeq(f.request.id)).toBeGreaterThan(1);
    expect(f.store.logs(f.request.id, 0).length).toBeGreaterThan(0);
    expect(() => f.store.logs(f.request.id, 1)).toThrowError(expect.objectContaining({ code: "WORKER_LOG_CURSOR_EXPIRED", status: 410 }));
  });
  it("marks active jobs interrupted on a genuine database reopen and never recreates them", () => {
    const f = fixture(); f.store.create(f.request, 1_010); f.store.running(f.request.id, 123);
    const other = { ...f.request, id: crypto.randomUUID(), kind: "background" as const };
    f.store.create(other, 1_011); f.store.running(other.id, 124); f.store.finish(other.id, "completed", 0, null);
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = new WorkerStore(f.filename, f.environmentId, crypto.randomUUID()); stores.push(reopened);
    expect(reopened.existing(f.request)).toMatchObject({ state: "interrupted", endedAt: expect.any(String) });
    expect(reopened.get(other.id)).toMatchObject({ state: "completed", exitCode: 0 });
    expect(reopened.list()).toHaveLength(2);
  });
  it("rolls back appended bytes when persisting the log cursor fails", () => {
    const f = fixture(); f.store.create(f.request, 1_010);
    const raw = new DatabaseSync(f.filename);
    raw.exec("CREATE TRIGGER reject_cursor BEFORE UPDATE OF last_seq ON jobs BEGIN SELECT RAISE(ABORT, 'cursor failed'); END;");
    raw.close();
    expect(() => f.store.append(f.request.id, "stdout", "actual retained test bytes", Buffer.from("actual retained test bytes"))).toThrow("cursor failed");
    expect(f.store.logs(f.request.id, 0)).toEqual([]);
    expect(f.store.get(f.request.id).lastSeq).toBe(0);
  });
  it("keeps a closed execution session closed after restart and rejects a mismatched runtime identity", () => {
    const f = fixture(); f.store.create(f.request, 1_010);
    expect(() => f.store.create({ ...f.request, id: crypto.randomUUID(), runtimeRunId: crypto.randomUUID() }, 1_011)).toThrowError(expect.objectContaining({ code: "WORKER_SESSION_SCOPE_INVALID" }));
    f.store.cancelSession(f.request.sessionId);
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = new WorkerStore(f.filename, f.environmentId, crypto.randomUUID()); stores.push(reopened);
    expect(reopened.sessionCancelled(f.request.sessionId)).toBe(true);
    expect(() => reopened.create({ ...f.request, id: crypto.randomUUID() }, 1_011)).toThrowError(expect.objectContaining({ code: "WORKER_SESSION_CANCELLED" }));
  });
  it("rejects a different environment using the same private state volume without relabeling its jobs", () => {
    const f = fixture(); f.store.create(f.request, 1_010); f.store.running(f.request.id, 123);
    expect(() => new WorkerStore(f.filename, crypto.randomUUID(), crypto.randomUUID())).toThrowError(expect.objectContaining({ code: "WORKER_STATE_SCOPE_INVALID" }));
    expect(f.store.get(f.request.id)).toMatchObject({ environmentId: f.environmentId, state: "running" });
  });
  it("persists an early per-id cancellation without sealing the shared session or blocking its sibling", () => {
    const f = fixture(); f.store.cancelPending(f.request.id, "foreground");
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = new WorkerStore(f.filename, f.environmentId, crypto.randomUUID()); stores.push(reopened);
    expect(() => reopened.create(f.request, 1_010)).toThrowError(expect.objectContaining({ code: "WORKER_JOB_CANCELLED" }));
    expect(reopened.sessionCancelled(f.request.sessionId)).toBe(false);
    const sibling = { ...f.request, id: crypto.randomUUID() };
    expect(reopened.create(sibling, 1_011).id).toBe(sibling.id);
    expect(reopened.list()).toHaveLength(1);
  });
});
