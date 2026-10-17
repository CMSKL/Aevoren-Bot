import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AppError, MemoryItem } from "@shared/contracts";

export type MemoryPanelHandle = {
  flush(): Promise<boolean>;
};

type MemoryPanelProps = {
  botId: string;
  onError(error: AppError | null): void;
};

type MemoryPanelStatus = "loading" | "saved" | "dirty" | "saving" | "failed";

function unexpectedError(safeMessage: string): AppError {
  return {
    code: "MEMORY_UI_FAILED",
    domain: "memory",
    retryable: true,
    safeMessage,
  };
}

export const MemoryPanel = forwardRef<MemoryPanelHandle, MemoryPanelProps>(function MemoryPanel(
  { botId, onError },
  ref,
) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newDraft, setNewDraft] = useState("");
  const [showDeleted, setShowDeleted] = useState(false);
  const [status, setStatus] = useState<MemoryPanelStatus>("loading");
  const [localError, setLocalError] = useState<string | null>(null);

  const itemsRef = useRef(items);
  const draftsRef = useRef(drafts);
  const newDraftRef = useRef(newDraft);
  const requestSequenceRef = useRef(0);
  const flushPromiseRef = useRef<Promise<boolean> | null>(null);

  function replaceItems(nextItems: MemoryItem[]): void {
    itemsRef.current = nextItems;
    setItems(nextItems);
  }

  function replaceDrafts(
    next: Record<string, string> | ((current: Record<string, string>) => Record<string, string>),
  ): void {
    const resolved = typeof next === "function" ? next(draftsRef.current) : next;
    draftsRef.current = resolved;
    setDrafts(resolved);
  }

  function replaceNewDraft(value: string): void {
    newDraftRef.current = value;
    setNewDraft(value);
  }

  function reportFailure(error: AppError): void {
    setLocalError(error.safeMessage);
    setStatus("failed");
    onError(error);
  }

  function hasDirtyDraft(): boolean {
    return (
      itemsRef.current.some(
        (item) =>
          item.deletedAt === null &&
          (draftsRef.current[item.id] ?? item.content).trim() !== item.content,
      ) || newDraftRef.current.trim().length > 0
    );
  }

  function settleStatus(): void {
    setStatus(hasDirtyDraft() ? "dirty" : "saved");
  }

  useEffect(() => {
    const requestSequence = ++requestSequenceRef.current;
    setStatus("loading");
    setLocalError(null);
    replaceItems([]);
    replaceDrafts({});
    replaceNewDraft("");
    setShowDeleted(false);

    void window.aevorenBot.memories
      .list({ botId, includeDeleted: true })
      .then((result) => {
        if (requestSequence !== requestSequenceRef.current) return;
        if (!result.ok) {
          setLocalError(result.error.safeMessage);
          setStatus("failed");
          onError(result.error);
          return;
        }
        replaceItems(result.data);
        replaceDrafts(Object.fromEntries(result.data.map((item) => [item.id, item.content])));
        setStatus("saved");
      })
      .catch(() => {
        if (requestSequence !== requestSequenceRef.current) return;
        const error = unexpectedError("Memory 加载失败。");
        setLocalError(error.safeMessage);
        setStatus("failed");
        onError(error);
      });

    return () => {
      requestSequenceRef.current += 1;
    };
  }, [botId, onError]);

  async function saveItem(item: MemoryItem): Promise<boolean> {
    const contentAtStart = (draftsRef.current[item.id] ?? item.content).trim();
    if (contentAtStart === item.content) return true;
    if (!contentAtStart) {
      reportFailure(unexpectedError("Memory 内容不能为空；如需移除，请使用删除。"));
      return false;
    }

    setStatus("saving");
    setLocalError(null);
    onError(null);
    try {
      const result = await window.aevorenBot.memories.update({
        id: item.id,
        expectedVersion: item.version,
        content: contentAtStart,
      });
      if (!result.ok) {
        reportFailure(result.error);
        return false;
      }
      replaceItems(itemsRef.current.map((current) => (current.id === result.data.id ? result.data : current)));
      replaceDrafts((current) => ({
        ...current,
        [result.data.id]:
          current[result.data.id] === contentAtStart
            ? result.data.content
            : (current[result.data.id] ?? result.data.content),
      }));
      settleStatus();
      return true;
    } catch {
      reportFailure(unexpectedError("Memory 保存失败，草稿已保留。"));
      return false;
    }
  }

  async function createMemory(): Promise<boolean> {
    const contentAtStart = newDraftRef.current.trim();
    if (!contentAtStart) {
      reportFailure(unexpectedError("请输入 Memory 内容。"));
      return false;
    }

    setStatus("saving");
    setLocalError(null);
    onError(null);
    try {
      const result = await window.aevorenBot.memories.create({ botId, content: contentAtStart });
      if (!result.ok) {
        reportFailure(result.error);
        return false;
      }
      replaceItems([...itemsRef.current, result.data]);
      replaceDrafts((current) => ({ ...current, [result.data.id]: result.data.content }));
      if (newDraftRef.current.trim() === contentAtStart) replaceNewDraft("");
      settleStatus();
      return true;
    } catch {
      reportFailure(unexpectedError("Memory 创建失败，草稿已保留。"));
      return false;
    }
  }

  async function flushAll(): Promise<boolean> {
    for (const item of itemsRef.current) {
      if (
        item.deletedAt === null &&
        (draftsRef.current[item.id] ?? item.content).trim() !== item.content &&
        !(await saveItem(item))
      ) {
        return false;
      }
    }
    if (newDraftRef.current.trim() && !(await createMemory())) return false;
    if (hasDirtyDraft()) return flushAll();
    setStatus("saved");
    return true;
  }

  useImperativeHandle(ref, () => ({
    async flush(): Promise<boolean> {
      if (flushPromiseRef.current) return flushPromiseRef.current;
      const promise = flushAll();
      flushPromiseRef.current = promise;
      try {
        return await promise;
      } finally {
        flushPromiseRef.current = null;
      }
    },
  }));

  async function deleteMemory(item: MemoryItem): Promise<void> {
    setStatus("saving");
    setLocalError(null);
    onError(null);
    try {
      const result = await window.aevorenBot.memories.delete({ id: item.id, expectedVersion: item.version });
      if (!result.ok) {
        reportFailure(result.error);
        return;
      }
      replaceItems(itemsRef.current.map((current) => (current.id === result.data.id ? result.data : current)));
      replaceDrafts((current) => ({ ...current, [result.data.id]: result.data.content }));
      settleStatus();
    } catch {
      reportFailure(unexpectedError("Memory 删除失败。"));
    }
  }

  async function restoreMemory(item: MemoryItem): Promise<void> {
    setStatus("saving");
    setLocalError(null);
    onError(null);
    try {
      const result = await window.aevorenBot.memories.restore({ id: item.id, expectedVersion: item.version });
      if (!result.ok) {
        reportFailure(result.error);
        return;
      }
      replaceItems(itemsRef.current.map((current) => (current.id === result.data.id ? result.data : current)));
      replaceDrafts((current) => ({ ...current, [result.data.id]: result.data.content }));
      settleStatus();
    } catch {
      reportFailure(unexpectedError("Memory 恢复失败。"));
    }
  }

  async function reloadMemories(): Promise<void> {
    setStatus("loading");
    setLocalError(null);
    onError(null);
    try {
      const result = await window.aevorenBot.memories.list({ botId, includeDeleted: true });
      if (!result.ok) {
        reportFailure(result.error);
        return;
      }
      replaceItems(result.data);
      replaceDrafts(Object.fromEntries(result.data.map((item) => [item.id, item.content])));
      replaceNewDraft("");
      setStatus("saved");
    } catch {
      reportFailure(unexpectedError("Memory 重新加载失败。"));
    }
  }

  const visibleItems = showDeleted ? items : items.filter((item) => item.deletedAt === null);
  const activeCount = items.filter((item) => item.deletedAt === null).length;
  const statusLabel: Record<MemoryPanelStatus, string> = {
    loading: "载入中",
    saved: "已保存",
    dirty: "未保存",
    saving: "保存中",
    failed: "保存失败",
  };

  return (
    <section className="memory-panel" aria-label="Memory">
      <div className="memory-panel-heading">
        <div>
          <h3>Memory</h3>
          <p>{activeCount}/100 条</p>
        </div>
        <span className={"memory-status status-" + status} data-testid="memory-status">
          {statusLabel[status]}
        </span>
      </div>

      <p className="memory-panel-note">
        这里保存已批准或你明确添加的长期参考；后台候选需在设置中确认，当前消息可更正已有 Memory。
      </p>

      <label className="field memory-compose">
        <span>新增 Memory</span>
        <textarea
          aria-label="新增 Memory"
          maxLength={4000}
          rows={3}
          value={newDraft}
          placeholder="例如：默认使用简体中文输出"
          onChange={(event) => {
            replaceNewDraft(event.target.value);
            setLocalError(null);
            setStatus(hasDirtyDraft() ? "dirty" : "saved");
          }}
        />
      </label>
      <button
        className="secondary-button full-width"
        type="button"
        disabled={status === "loading" || status === "saving" || !newDraft.trim()}
        onClick={() => void createMemory()}
      >
        添加 Memory
      </button>

      <div className="memory-panel-toolbar">
        <button className="text-button" type="button" onClick={() => setShowDeleted((current) => !current)}>
          {showDeleted ? "隐藏已删除" : "显示已删除"}
        </button>
        {localError ? <button className="text-button" type="button" onClick={() => void reloadMemories()}>重新加载</button> : null}
      </div>

      {localError ? <p className="memory-panel-error" role="alert">{localError}</p> : null}

      <div className="memory-list" data-testid="memory-list">
        {status !== "loading" && visibleItems.length === 0 ? (
          <p className="memory-list-empty">{showDeleted ? "暂无 Memory。" : "尚未添加 Memory。"}</p>
        ) : null}

        {visibleItems.map((item, index) => {
          const deleted = item.deletedAt !== null;
          const draftValue = drafts[item.id] ?? item.content;
          const dirty = !deleted && draftValue.trim() !== item.content;
          return (
            <article className={"memory-item" + (deleted ? " memory-item-deleted" : "")} key={item.id}>
              <div className="memory-item-meta">
                <span>#{index + 1}</span>
                <span>{deleted ? "已删除" : dirty ? "未保存" : "v" + item.version}</span>
              </div>
              <textarea
                aria-label={"Memory " + (index + 1)}
                disabled={deleted}
                maxLength={4000}
                rows={3}
                value={draftValue}
                onChange={(event) => {
                  replaceDrafts((current) => ({ ...current, [item.id]: event.target.value }));
                  setLocalError(null);
                  setStatus("dirty");
                }}
              />
              <div className="memory-item-actions">
                {deleted ? (
                  <button className="text-button" type="button" disabled={status === "saving"} onClick={() => void restoreMemory(item)}>
                    恢复 Memory
                  </button>
                ) : (
                  <>
                    <button className="text-button" type="button" disabled={!dirty || status === "saving"} onClick={() => void saveItem(item)}>
                      保存 Memory
                    </button>
                    <button className="text-button danger-text-button" type="button" disabled={status === "saving"} onClick={() => void deleteMemory(item)}>
                      删除 Memory
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
});
