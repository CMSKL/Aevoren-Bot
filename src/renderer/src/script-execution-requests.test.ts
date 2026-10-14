import { describe, expect, it } from "vitest";
import type { Execution } from "@shared/environment-contracts";
import { createScriptExecutionRequests } from "./script-execution-requests";

const input = { sessionId: "session-a", executorBotId: "bot-a", grantId: "grant-a", expectedGrantVersion: 1, args: ["literal"], cwd: ".", timeoutMs: 120000 };
describe("script execution request lifecycle", () => {
  it("retains one nonce for unknown state until that exact execution ID has a confirmed receipt", () => {
    const requests = createScriptExecutionRequests("unknown-script-scope");
    const first = requests.beginRun(input); requests.acceptRun(first, { id: "execution-a", state: "unknown" });
    expect(requests.beginRun(input).nonce).toBe(first.nonce);
    const query = requests.beginQuery();
    expect(requests.acceptQuery(query, "execution-a", { id: "different-execution", state: "completed" })).toBe(false);
    expect(requests.beginRun(input).nonce).toBe(first.nonce);
    const unknownQuery = requests.beginQuery(); requests.acceptQuery(unknownQuery, "execution-a", { id: "execution-a", state: "unknown" });
    expect(requests.beginRun(input).nonce).toBe(first.nonce);
    const confirmedQuery = requests.beginQuery(); expect(requests.acceptQuery(confirmedQuery, "execution-a", { id: "execution-a", state: "completed" })).toBe(true);
    expect(requests.beginRun(input).nonce).not.toBe(first.nonce);
  });
  it("does not publish a delayed old-task query after a newer script was submitted in the same scope", async () => {
    const requests = createScriptExecutionRequests("same-scope-delayed-query");
    const old = requests.beginRun(input); requests.acceptRun(old, { id: "old-task", state: "running" });
    let resolve!: (receipt: Pick<Execution, "id" | "state">) => void;
    const pending = new Promise<Pick<Execution, "id" | "state">>(accept => { resolve = accept; });
    const published: string[] = []; const query = requests.beginQuery();
    const update = pending.then(receipt => { if (requests.acceptQuery(query, "old-task", receipt)) published.push(receipt.id); });
    const next = requests.beginRun({ ...input, args: ["new task"] }); requests.acceptRun(next, { id: "new-task", state: "running" }); published.push("new-task");
    resolve({ id: "old-task", state: "completed" }); await update;
    expect(published).toEqual(["new-task"]);
    expect(requests.isCurrentQuery(query)).toBe(false);
  });
  it("isolates pending nonces between the same Bot's private and group script scopes", () => {
    const privateRequests = createScriptExecutionRequests("private-revision-a"); const groupRequests = createScriptExecutionRequests("group-revision-a");
    const privateRun = privateRequests.beginRun(input); privateRequests.acceptRun(privateRun, { id: "private-task", state: "unknown" });
    const groupRun = groupRequests.beginRun(input);
    expect(groupRun.nonce).not.toBe(privateRun.nonce);
    const oldQuery = privateRequests.beginQuery(); privateRequests.invalidate();
    expect(privateRequests.acceptQuery(oldQuery, "private-task", { id: "private-task", state: "completed" })).toBe(false);
    expect(privateRequests.beginRun(input).nonce).toBe(privateRun.nonce);
  });
});
