import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalRequest, ApprovalResolution, ToolInvocation } from "@shared/contracts";
import type { EnvironmentScope } from "@shared/environment-contracts";
import { isMcpWrite } from "../mcp-write-review";
import { isOutboundSend } from "../outbound-approval-review";
import { ToolPermissionDialog } from "./ToolPermissionDialog";

type Props = EnvironmentScope & { active: boolean; ownerName: string };
type Pending = { scope: string; approval: ApprovalRequest; invocation: ToolInvocation };

// One active Apps surface owns the ordered native/MCP approval queue. Domain
// forms keep their own intents; a delayed form response cannot create a portal.
export function ScopedAppsApprovalHost({ sessionId, executorBotId, active, ownerName }: Props): React.JSX.Element | null {
  const scopeKey = `${sessionId}:${executorBotId}`;
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const sequence = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    const current = generation.current, request = ++sequence.current;
    try {
      const [approvals, tools] = await Promise.all([window.aevorenBot.approvals.listPending({ sessionId }), window.aevorenBot.tools.list({ sessionId })]);
      if (current !== generation.current || request !== sequence.current) return;
      if (!approvals.ok || !tools.ok) {
        setPending(null);
        setError(!approvals.ok ? approvals.error.safeMessage : !tools.ok ? tools.error.safeMessage : null);
        return;
      }
      const invocations = new Map(tools.data.filter(value => value.sessionId === sessionId && value.executorBotId === executorBotId && value.state === "awaiting-approval" && (isOutboundSend(value) || isMcpWrite(value))).map(value => [value.id, value]));
      const next = approvals.data.filter(value => value.sessionId === sessionId && value.executorBotId === executorBotId && value.state === "pending" && invocations.has(value.toolInvocationId))
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
      setPending(next ? { scope: scopeKey, approval: next, invocation: invocations.get(next.toolInvocationId)! } : null);
      setError(null);
    } catch { if (current === generation.current && request === sequence.current) { setPending(null); setError("暂时无法核对此聊天与成员的待审批操作。"); } }
  }, [sessionId, executorBotId, scopeKey]);
  useEffect(() => {
    generation.current += 1;
    if (!active) return;
    let disposed = false, inFlight = false;
    const refresh = (): void => { if (!inFlight && !disposed) { inFlight = true; void load().finally(() => { inFlight = false; }); } };
    queueMicrotask(refresh);
    const timer = setInterval(refresh, 500);
    window.addEventListener("aevoren:apps-approval-changed", refresh);
    return () => { disposed = true; generation.current += 1; clearInterval(timer); window.removeEventListener("aevoren:apps-approval-changed", refresh); };
  }, [active, load]);

  async function resolve(approval: ApprovalRequest, resolution: ApprovalResolution): Promise<boolean> {
    const current = generation.current;
    const result = await window.aevorenBot.approvals.resolve({ sessionId: approval.sessionId, id: approval.id, expectedVersion: approval.version, resolution });
    if (current !== generation.current) return false;
    if (!result.ok) { setError(result.error.safeMessage); return false; }
    await load();
    return true;
  }
  async function stop(): Promise<void> {
    if (!pending || pending.scope !== scopeKey) return;
    const current = generation.current;
    const result = await window.aevorenBot.runtime.cancel(pending.invocation.runtimeRunId);
    if (current !== generation.current) return;
    if (!result.ok) setError(result.error.safeMessage); else await load();
  }

  if (!active) return null;
  return <>{error ? <p className="connector-error" role="alert">{error}</p> : null}{pending?.scope === scopeKey ? <ToolPermissionDialog key={pending.approval.id} approval={pending.approval} invocation={pending.invocation} label={isMcpWrite(pending.invocation) ? "调用 MCP 固定工具" : "外发固定草稿"} botName={ownerName} onResolve={resolve} onStop={() => void stop()} /> : null}</>;
}
