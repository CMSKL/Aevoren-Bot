import { useEffect, useMemo, useState } from "react";
import type { AppError, MemoryItem, MemoryScopeSelector, Workspace } from "@shared/contracts";
import { CheckIcon, TrashIcon } from "./Icons";

type ScopedMemorySettingsPanelProps = {
  active: boolean;
};

export function ScopedMemorySettingsPanel({ active }: ScopedMemorySettingsPanelProps): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedScope, setSelectedScope] = useState("user");
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newDraft, setNewDraft] = useState("");
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
    ]).then(([workspaceResult, memoryResult]) => {
      if (cancelled) return;
      if (workspaceResult.ok) setWorkspaces(workspaceResult.data);
      else setError(workspaceResult.error);
      if (memoryResult.ok) {
        setItems(memoryResult.data);
        setDrafts(Object.fromEntries(memoryResult.data.map((item) => [item.id, item.content])));
      } else setError(memoryResult.error);
    });
    return () => { cancelled = true; };
  }, [active, selector]);

  const create = async (): Promise<void> => {
    const content = newDraft.trim();
    if (!content || busy) return;
    setBusy("create");
    setError(null);
    const result = await window.aevorenBot.memories.create({ ...selector, content });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems((current) => [...current, result.data]);
    setDrafts((current) => ({ ...current, [result.data.id]: result.data.content }));
    setNewDraft("");
  };

  const save = async (item: MemoryItem): Promise<void> => {
    const content = (drafts[item.id] ?? item.content).trim();
    if (!content || content === item.content || busy) return;
    setBusy(item.id);
    setError(null);
    const result = await window.aevorenBot.memories.update({ id: item.id, expectedVersion: item.version, content });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems((current) => current.map((candidate) => candidate.id === result.data.id ? result.data : candidate));
    setDrafts((current) => ({ ...current, [result.data.id]: result.data.content }));
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
        <p>用户级偏好会进入所有 Bot；Workspace 记忆只进入明确绑定该 Workspace 的 Bot。模型不能自动写入。</p>
      </div>
      <label className="settings-field-row settings-card memory-scope-picker">
        <span><strong>记忆范围</strong><small>切换范围不会复制或合并现有记忆</small></span>
        <select aria-label="Memory 范围" value={selectedScope} onChange={(event) => setSelectedScope(event.target.value)}>
          <option value="user">用户偏好（全部 Bot）</option>
          {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>Workspace · {workspace.name}</option>)}
        </select>
      </label>

      <div className="settings-card scoped-memory-create">
        <textarea aria-label="新增范围 Memory" value={newDraft} maxLength={4_000} rows={3} placeholder="记录稳定偏好、约束或项目长期状态" onChange={(event) => setNewDraft(event.target.value)} />
        <button className="primary-button" type="button" disabled={busy !== null || !newDraft.trim()} onClick={() => void create()}>{busy === "create" ? "添加中…" : "添加 Memory"}</button>
      </div>

      <div className="scoped-memory-list">
        {items.length === 0 ? <div className="workspace-empty">这个范围还没有 Memory。</div> : items.map((item) => (
          <article className={`settings-card scoped-memory-item${item.deletedAt ? " deleted" : ""}`} key={item.id}>
            <textarea aria-label={`Memory ${item.id}`} value={drafts[item.id] ?? item.content} disabled={item.deletedAt !== null || busy === item.id} maxLength={4_000} rows={3} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))} />
            <footer>
              <span>v{item.version}{item.deletedAt ? " · 已删除" : ""}</span>
              <button className="secondary-button" type="button" disabled={busy !== null || item.deletedAt !== null || (drafts[item.id] ?? item.content).trim() === item.content} onClick={() => void save(item)}><CheckIcon />保存</button>
              <button className={`icon-button${item.deletedAt ? "" : " danger"}`} type="button" aria-label={item.deletedAt ? "恢复 Memory" : "删除 Memory"} disabled={busy !== null} onClick={() => void changeDeleted(item)}>{item.deletedAt ? "↺" : <TrashIcon />}</button>
            </footer>
          </article>
        ))}
      </div>
      <p className="settings-security-note">Memory 是用户管理的参考事实，不是系统权限。当前消息可以纠正 Memory，删除后不会再进入新的运行。</p>
      {error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
    </div>
  );
}
