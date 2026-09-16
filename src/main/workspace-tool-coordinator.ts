import { randomUUID } from "node:crypto";
import type {
  ApprovalResolution,
  ToolApprovalResult,
  ToolEvent,
  WorkspaceToolRequest,
} from "@shared/contracts";
import { asAppError, AevorenBotError } from "./errors";
import type { AppRepository } from "./database";
import type { WorkspaceToolExecutor } from "./workspace-tool-executor";

export type WorkspaceToolOutcome = {
  toolCallId: string;
  tool: WorkspaceToolRequest;
  content: string;
};

type Waiter = {
  resolve(value: WorkspaceToolOutcome): void;
  reject(error: unknown): void;
  signal: AbortSignal;
  abort(): void;
  timer: ReturnType<typeof setTimeout>;
};

export class WorkspaceToolCoordinator {
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly repository: AppRepository,
    private readonly executor: WorkspaceToolExecutor,
    private readonly emit: (event: ToolEvent) => void,
  ) {}

  requestAndWait(
    runtimeRunId: string,
    toolCallId: string,
    tool: WorkspaceToolRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceToolOutcome> {
    const prepared = this.repository.prepareToolInvocation({
      runtimeRunId,
      toolCallId,
      idempotencyKey: randomUUID(),
      tool,
    });
    if (prepared.approval.state !== "pending" || prepared.invocation.state !== "awaiting-approval") {
      throw new AevorenBotError("TOOL_STATE_INVALID", undefined, undefined, { currentState: prepared.invocation.state });
    }
    if (this.waiters.has(prepared.approval.id)) throw new AevorenBotError("TOOL_IDEMPOTENCY_CONFLICT");
    return new Promise<WorkspaceToolOutcome>((resolve, reject) => {
      const abort = (): void => {
        const waiter = this.waiters.get(prepared.approval.id);
        if (!waiter) return;
        this.clearWaiter(prepared.approval.id);
        try {
          this.repository.cancelToolInvocation(prepared.invocation.id);
          this.emitCurrent(prepared.approval.id);
        } catch {
          // A concurrent terminal transition already won; cancellation is still terminal to this Runtime.
        }
        reject(new DOMException("Aborted", "AbortError"));
      };
      const delay = Math.max(0, Date.parse(prepared.approval.expiresAt) - Date.now() + 1);
      const timer = setTimeout(() => this.expire(prepared.approval.id), delay);
      this.waiters.set(prepared.approval.id, { resolve, reject, signal, abort, timer });
      signal.addEventListener("abort", abort, { once: true });
      this.emitCurrent(prepared.approval.id);
      if (signal.aborted) abort();
    });
  }

  async resolve(
    sessionId: string,
    id: string,
    expectedVersion: number,
    resolution: ApprovalResolution,
  ): Promise<ToolApprovalResult> {
    const approval = this.repository.getApprovalRequest(id);
    if (approval.sessionId !== sessionId) throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
    const waiter = this.waiters.get(id);
    if (resolution === "allow-once" && !waiter) {
      throw new AevorenBotError("TOOL_STATE_INVALID", undefined, undefined, { currentState: "detached" });
    }
    const decided = this.repository.resolveToolApproval(id, expectedVersion, resolution);
    this.emitCurrent(id);
    if (resolution === "deny") {
      if (waiter) {
        this.clearWaiter(id);
        waiter.resolve({
          toolCallId: decided.invocation.toolCallId,
          tool: decided.invocation.arguments,
          content: JSON.stringify({ ok: false, error: { code: "TOOL_DENIED" } }),
        });
      }
      return decided;
    }

    try {
      const result = await this.executor.execute(decided.invocation.id, waiter!.signal);
      const current = { invocation: result.invocation, approval: this.repository.getApprovalRequest(id) };
      this.emitCurrent(id);
      this.clearWaiter(id);
      waiter!.resolve({
        toolCallId: result.invocation.toolCallId,
        tool: result.invocation.arguments,
        content: result.content,
      });
      return current;
    } catch (error) {
      const appError = asAppError(error);
      const current = {
        invocation: this.repository.getToolInvocation(decided.invocation.id),
        approval: this.repository.getApprovalRequest(id),
      };
      this.emitCurrent(id);
      this.clearWaiter(id);
      if (error instanceof DOMException && error.name === "AbortError") waiter!.reject(error);
      else waiter!.resolve({
        toolCallId: current.invocation.toolCallId,
        tool: current.invocation.arguments,
        content: JSON.stringify({ ok: false, error: { code: appError.code } }),
      });
      return current;
    }
  }

  private expire(id: string): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    const approval = this.repository.getApprovalRequest(id);
    if (Date.parse(approval.expiresAt) > Date.now()) {
      clearTimeout(waiter.timer);
      waiter.timer = setTimeout(() => this.expire(id), Date.parse(approval.expiresAt) - Date.now() + 1);
      return;
    }
    try {
      this.repository.resolveToolApproval(id, approval.version, "deny");
    } catch (error) {
      if (!(error instanceof AevorenBotError) || error.code !== "APPROVAL_EXPIRED") {
        this.clearWaiter(id);
        waiter.reject(error);
        return;
      }
    }
    this.emitCurrent(id);
    const current = this.repository.getToolInvocation(approval.toolInvocationId);
    this.clearWaiter(id);
    waiter.resolve({
      toolCallId: current.toolCallId,
      tool: current.arguments,
      content: JSON.stringify({ ok: false, error: { code: "APPROVAL_EXPIRED" } }),
    });
  }

  private emitCurrent(approvalId: string): void {
    const approval = this.repository.getApprovalRequest(approvalId);
    this.emit({
      sessionId: approval.sessionId,
      approval,
      invocation: this.repository.getToolInvocation(approval.toolInvocationId),
    });
  }

  private clearWaiter(id: string): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.abort);
    this.waiters.delete(id);
  }
}
