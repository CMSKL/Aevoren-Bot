import { useEffect, useMemo, useState } from "react";
import type { AppError, MemoryItem, MemoryKind, MemoryProposal, MemoryScopeSelector, Workspace } from "@shared/contracts";
import { CheckIcon, TrashIcon } from "./Icons";

type ScopedMemorySettingsPanelProps = {
  active: boolean;
};

export function ScopedMemorySettingsPanel({ active }: ScopedMemorySettingsPanelProps): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedScope, setSelectedScope] = useState("user");
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [kinds, setKinds] = useState<Record<string, MemoryKind>>({});
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [proposalDrafts, setProposalDrafts] = useState<Record<string, string>>({});
  const [proposalKinds, setProposalKinds] = useState<Record<string, MemoryKind>>({});
  const [newDraft, setNewDraft] = useState("");
  const [newKind, setNewKind] = useState<MemoryKind>("fact");
  const [captureEnabled, setCaptureEnabled] = useState(true);
  const [capturePending, setCapturePending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  const selector = useMemo<MemoryScopeSelector>(() => selectedScope === "user"
    ? { scope: "user", scopeKey: "user" }
    : { scope: "workspace", scopeKey: selectedScope }, [selectedScope]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.all([
      window.aevorenBot.workspaces.list(),
      window.aevorenBot.memories.list({ ...selector, includeDeleted: true }),
      window.aevorenBot.memories.listProposals({ state: "pending" }),
      window.aevorenBot.settings.getGeneral(),
    ]).then(([workspaceResult, memoryResult, proposalResult, settingsResult]) => {
      if (cancelled) return;
      if (workspaceResult.ok) setWorkspaces(workspaceResult.data);
      else setError(workspaceResult.error);
      if (memoryResult.ok) {
        setItems(memoryResult.data);
        setDrafts(Object.fromEntries(memoryResult.data.map((item) => [item.id, item.content])));
        setKinds(Object.fromEntries(memoryResult.data.map((item) => [item.id, item.kind])));
      } else setError(memoryResult.error);
      if (proposalResult.ok) {
        setProposals(proposalResult.data);
        setProposalDrafts(Object.fromEntries(proposalResult.data.map((item) => [item.id, item.content])));
        setProposalKinds(Object.fromEntries(proposalResult.data.map((item) => [item.id, item.kind])));
      } else setError(proposalResult.error);
      if (settingsResult.ok) setCaptureEnabled(settingsResult.data.memoryCaptureEnabled);
      else setError(settingsResult.error);
    });
    return () => { cancelled = true; };
  }, [active, selector]);

  const create = async (): Promise<void> => {
    const content = newDraft.trim();
    if (!content || busy) return;
    setBusy("create");
    setError(null);
    const result = await window.aevorenBot.memories.create({ ...selector, content, kind: newKind });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems((current) => [...current, result.data]);
    setDrafts((current) => ({ ...current, [result.data.id]: result.data.content }));
    setKinds((current) => ({ ...current, [result.data.id]: result.data.kind }));
    setNewDraft("");
    setNewKind("fact");
  };

  const changeCapture = async (enabled: boolean): Promise<void> => {
    if (capturePending) return;
    setCapturePending(true);
    setCaptureEnabled(enabled);
    setError(null);
    const result = await window.aevorenBot.settings.saveGeneral({ memoryCaptureEnabled: enabled });
    setCapturePending(false);
    if (!result.ok) {
      setCaptureEnabled(!enabled);
      setError(result.error);
      return;
    }
    setCaptureEnabled(result.data.memoryCaptureEnabled);
  };

  const save = async (item: MemoryItem): Promise<void> => {
    const content = (drafts[item.id] ?? item.content).trim();
    const kind = kinds[item.id] ?? item.kind;
    if (!content || content === item.content && kind === item.kind || busy) return;
    setBusy(item.id);
    setError(null);
    const result = await window.aevorenBot.memories.update({ id: item.id, expectedVersion: item.version, content, kind });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems((current) => current.map((candidate) => candidate.id === result.data.id ? result.data : candidate));
    setDrafts((current) => ({ ...current, [result.data.id]: result.data.content }));
    setKinds((current) => ({ ...current, [result.data.id]: result.data.kind }));
  };

  const resolveProposal = async (proposal: MemoryProposal, accept: boolean): Promise<void> => {
    if (busy) return;
    setBusy(proposal.id);
    setError(null);
    const result = accept
      ? await window.aevorenBot.memories.acceptProposal({
          id: proposal.id,
          expectedVersion: proposal.version,
          content: proposalDrafts[proposal.id] ?? proposal.content,
          kind: proposalKinds[proposal.id] ?? proposal.kind,
        })
      : await window.aevorenBot.memories.rejectProposal({ id: proposal.id, expectedVersion: proposal.version });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setProposals((current) => current.filter((candidate) => candidate.id !== proposal.id));
    if (accept && "memory" in result.data) {
      const memory = result.data.memory;
      if (memory.scope === selector.scope && memory.scopeKey === selector.scopeKey) {
        setItems((current) => [...current, memory]);
        setDrafts((current) => ({ ...current, [memory.id]: memory.content }));
        setKinds((current) => ({ ...current, [memory.id]: memory.kind }));
      }
    }
  };

  const changeDeleted = async (item: MemoryItem): Promise<void> => {
    if (busy) return;
    setBusy(item.id);
    setError(null);
    const result = item.deletedAt
      ? await window.aevorenBot.memories.restore({ id: item.id, expectedVersion: item.version })
      : await window.aevorenBot.memories.delete({ id: item.id, expectedVersion: item.version });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems((current) => current.map((candidate) => candidate.id === result.data.id ? result.data : candidate));
  };

  return (
    <div className="settings-panel-form scoped-memory-settings">
      <div className="settings-section-heading">
        <h2>长期记忆</h2>
        <p>后台只从用户消息提取候选；批准后才进入长期记忆。当前消息始终优先于已有记忆。</p>
      </div>
      <div className="settings-card">
        <label className="settings-row">
          <span><strong>后台生成候选</strong><small>仅分析当前用户消息；失败不会影响正式回复</small></span>
          <input aria-label="后台生成 Memory 候选" type="checkbox" checked={captureEnabled} disabled={capturePending} onChange={(event) => void changeCapture(event.target.checked)} />
        </label>
      </div>
      {proposals.length > 0 ? <section className="memory-proposals" aria-label="待确认 Memory">
        <div className="settings-subsection-heading">
          <strong>待确认</strong>
          <span>{proposals.length} 条</span>
        </div>
        {proposals.map((proposal) => <article className="settings-card memory-proposal" key={proposal.id}>
          <div className="memory-proposal-meta">
            <span>{proposal.scope === "user" ? "全部 Bot" : proposal.scope === "workspace" ? "Workspace" : "Bot 专属"}</span>
            <span>{proposal.reason}</span>
          </div>
          <div className="memory-proposal-editor">
            <select aria-label={`候选类型 ${proposal.id}`} value={proposalKinds[proposal.id] ?? proposal.kind} disabled={busy !== null} onChange={(event) => setProposalKinds((current) => ({ ...current, [proposal.id]: event.target.value as MemoryKind }))}>
              <MemoryKindOptions />
            </select>
            <textarea aria-label={`Memory 候选 ${proposal.id}`} value={proposalDrafts[proposal.id] ?? proposal.content} maxLength={4_000} rows={3} disabled={busy !== null} onChange={(event) => setProposalDrafts((current) => ({ ...current, [proposal.id]: event.target.value }))} />
          </div>
          <footer>
            {proposal.supersedesMemoryId ? <span>批准后替换已有记忆</span> : <span>尚未写入长期记忆</span>}
            <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void resolveProposal(proposal, false)}>拒绝</button>
            <button className="primary-button" type="button" disabled={busy !== null || !(proposalDrafts[proposal.id] ?? proposal.content).trim()} onClick={() => void resolveProposal(proposal, true)}>批准</button>
          </footer>
        </article>)}
      </section> : null}
      <label className="settings-field-row settings-card memory-scope-picker">
        <span><strong>记忆范围</strong><small>切换范围不会复制或合并现有记忆</small></span>
        <select aria-label="Memory 范围" value={selectedScope} onChange={(event) => setSelectedScope(event.target.value)}>
          <option value="user">用户偏好（全部 Bot）</option>
          {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>Workspace · {workspace.name}</option>)}
        </select>
      </label>

      <div className="settings-card scoped-memory-create">
        <select aria-label="新增 Memory 类型" value={newKind} onChange={(event) => setNewKind(event.target.value as MemoryKind)}>
          <MemoryKindOptions />
        </select>
        <textarea aria-label="新增范围 Memory" value={newDraft} maxLength={4_000} rows={3} placeholder="记录稳定偏好、约束或项目长期状态" onChange={(event) => setNewDraft(event.target.value)} />
        <button className="primary-button" type="button" disabled={busy !== null || !newDraft.trim()} onClick={() => void create()}>{busy === "create" ? "添加中…" : "添加 Memory"}</button>
      </div>

      <div className="scoped-memory-list">
        {items.length === 0 ? <div className="workspace-empty">这个范围还没有 Memory。</div> : items.map((item) => (
          <article className={`settings-card scoped-memory-item${item.deletedAt ? " deleted" : ""}`} key={item.id}>
            <select aria-label={`Memory 类型 ${item.id}`} value={kinds[item.id] ?? item.kind} disabled={item.deletedAt !== null || busy === item.id} onChange={(event) => setKinds((current) => ({ ...current, [item.id]: event.target.value as MemoryKind }))}>
              <MemoryKindOptions />
            </select>
            <textarea aria-label={`Memory ${item.id}`} value={drafts[item.id] ?? item.content} disabled={item.deletedAt !== null || busy === item.id} maxLength={4_000} rows={3} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))} />
            <footer>
              <span>{item.source === "model-captured" ? "后台候选 · 已批准" : "用户添加"} · v{item.version}{item.deletedAt ? " · 已删除" : item.expiresAt && item.expiresAt <= new Date().toISOString() ? " · 已过期" : ""}</span>
              <button className="secondary-button" type="button" disabled={busy !== null || item.deletedAt !== null || (drafts[item.id] ?? item.content).trim() === item.content && (kinds[item.id] ?? item.kind) === item.kind} onClick={() => void save(item)}><CheckIcon />保存</button>
              <button className={`icon-button${item.deletedAt ? "" : " danger"}`} type="button" aria-label={item.deletedAt ? "恢复 Memory" : "删除 Memory"} disabled={busy !== null} onClick={() => void changeDeleted(item)}>{item.deletedAt ? "↺" : <TrashIcon />}</button>
            </footer>
          </article>
        ))}
      </div>
      <p className="settings-security-note">Memory 是本地参考数据，不是系统权限。待确认、已拒绝、已删除或已过期的内容不会进入模型上下文。</p>
      {error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
    </div>
  );
}

function MemoryKindOptions(): React.JSX.Element {
  return <>
    <option value="fact">事实</option>
    <option value="preference">偏好</option>
    <option value="decision">决定</option>
    <option value="procedure">程序</option>
  </>;
}
