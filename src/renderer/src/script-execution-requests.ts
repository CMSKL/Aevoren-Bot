import type { Execution } from "@shared/environment-contracts";
import type { SkillScriptRunInput } from "@shared/skill-execution-contracts";

type RunRecord = { key: string; nonce: string; executionId?: string };
const retained = new Map<string, RunRecord>();
type Receipt = Pick<Execution, "id" | "state">;

export function createScriptExecutionRequests(scopeKey: string) {
  let query = 0;
  return {
    beginRun(input: Omit<SkillScriptRunInput, "clientNonce">): RunRecord {
      query += 1;
      const key = JSON.stringify(input); const previous = retained.get(scopeKey);
      const record = previous?.key === key ? previous : { key, nonce: crypto.randomUUID() };
      retained.set(scopeKey, record); return record;
    },
    acceptRun(record: RunRecord, receipt: Receipt): void {
      record.executionId = receipt.id;
      if (receipt.state !== "unknown" && retained.get(scopeKey) === record) retained.delete(scopeKey);
    },
    beginQuery(): number { return ++query; },
    isCurrentQuery(request: number): boolean { return request === query; },
    acceptQuery(request: number, id: string, receipt: Receipt): boolean {
      if (request !== query || receipt.id !== id) return false;
      if (receipt.state !== "unknown" && retained.get(scopeKey)?.executionId === id) retained.delete(scopeKey);
      return true;
    },
    invalidate(): void { query += 1; },
  };
}
