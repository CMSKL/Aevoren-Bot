import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AppError, Bot, BotPatch, McpServerInfo, ModelSelection, ProviderInstanceInfo, Workspace } from "@shared/contracts";
import { CheckIcon, CloseIcon } from "./Icons";
import { MemoryPanel, type MemoryPanelHandle } from "./MemoryPanel";

type ProfileDraft = Pick<Bot, "name" | "label" | "description" | "instructions">;
export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "failed";

export type ProfileInspectorHandle = {
  flush(): Promise<boolean>;
  focusName(): void;
};

type ProfileInspectorProps = {
  bot: Bot | null;
  mobileOpen: boolean;
  onBotUpdated(bot: Bot): void;
  onError(error: AppError | null): void;
  onMobileClose(): void;
};

function toDraft(bot: Bot): ProfileDraft {
  return {
    name: bot.name,
    label: bot.label,
    description: bot.description,
    instructions: bot.instructions,
  };
}

function sameDraft(left: ProfileDraft, right: ProfileDraft): boolean {
  return (
    left.name === right.name &&
    left.label === right.label &&
    left.description === right.description &&
    left.instructions === right.instructions
  );
}

export const ProfileInspector = forwardRef<ProfileInspectorHandle, ProfileInspectorProps>(function ProfileInspector(
  { bot, mobileOpen, onBotUpdated, onError, onMobileClose },
  ref,
) {
  const [draft, setDraft] = useState<ProfileDraft | null>(bot ? toDraft(bot) : null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [providers, setProviders] = useState<ProviderInstanceInfo[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [modelSaving, setModelSaving] = useState(false);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [memoryScopeSaving, setMemoryScopeSaving] = useState(false);
  const [modelDraft, setModelDraft] = useState(bot?.modelSelection.modelId ?? "");
  const draftRef = useRef(draft);
  const savedRef = useRef<ProfileDraft | null>(bot ? toDraft(bot) : null);
  const botIdRef = useRef(bot?.id ?? null);
  const versionRef = useRef(bot?.version ?? 1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const memoryPanelRef = useRef<MemoryPanelHandle>(null);

  useEffect(() => {
    if (bot?.id === botIdRef.current) {
      if (bot) versionRef.current = bot.version;
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    const next = bot ? toDraft(bot) : null;
    botIdRef.current = bot?.id ?? null;
    versionRef.current = bot?.version ?? 1;
    draftRef.current = next;
    savedRef.current = next;
    setDraft(next);
    setStatus("idle");
  }, [bot]);

  useEffect(() => {
    setModelDraft(bot?.modelSelection.modelId ?? "");
  }, [bot?.id, bot?.modelSelection.modelId]);

  useEffect(() => {
    if (!bot?.id) {
      setProviders([]);
      setMcpServers([]);
      setWorkspaces([]);
      return;
    }
    const loadProviders = (): void => {
      void window.aevorenBot.providers.list().then((result) => {
        if (result.ok) setProviders(result.data);
        else onError(result.error);
      });
    };
    const loadMcp = (): void => {
      void window.aevorenBot.mcp.list().then((result) => {
        if (result.ok) setMcpServers(result.data);
        else onError(result.error);
      });
    };
    const loadWorkspaces = (): void => {
      void window.aevorenBot.workspaces.list().then((result) => {
        if (result.ok) setWorkspaces(result.data);
        else onError(result.error);
      });
    };
    loadProviders();
    loadMcp();
    loadWorkspaces();
    window.addEventListener("aevoren:providers-changed", loadProviders);
    window.addEventListener("aevoren:mcp-changed", loadMcp);
    window.addEventListener("aevoren:workspaces-changed", loadWorkspaces);
    return () => {
      window.removeEventListener("aevoren:providers-changed", loadProviders);
      window.removeEventListener("aevoren:mcp-changed", loadMcp);
      window.removeEventListener("aevoren:workspaces-changed", loadWorkspaces);
    };
  }, [bot?.id, onError]);

  async function saveCurrent(): Promise<boolean> {
    if (!botIdRef.current || !draftRef.current || !savedRef.current) return true;
    if (sameDraft(draftRef.current, savedRef.current)) {
      setStatus("saved");
      return true;
    }
    if (savePromiseRef.current) {
      const previousSucceeded = await savePromiseRef.current;
      if (!previousSucceeded) return false;
      return saveCurrent();
    }

    const snapshot = { ...draftRef.current };
    const id = botIdRef.current;
    const expectedVersion = versionRef.current;
    setStatus("saving");
    onError(null);
    const operation = window.aevorenBot.bots.update({ id, expectedVersion, patch: snapshot as BotPatch }).then((result) => {
      if (!result.ok) {
        setStatus("failed");
        onError(result.error);
        return false;
      }
      versionRef.current = result.data.version;
      savedRef.current = snapshot;
      onBotUpdated(result.data);
      setStatus(draftRef.current && sameDraft(draftRef.current, snapshot) ? "saved" : "dirty");
      return true;
    });
    savePromiseRef.current = operation;
    try {
      return await operation;
    } finally {
      savePromiseRef.current = null;
    }
  }

  async function flush(): Promise<boolean> {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const saved = await saveCurrent();
    if (!saved) return false;
    if (draftRef.current && savedRef.current && !sameDraft(draftRef.current, savedRef.current)) return flush();
    return await memoryPanelRef.current?.flush() ?? true;
  }

  useImperativeHandle(ref, () => ({
    flush,
    focusName() {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    },
  }));

  function update(field: keyof ProfileDraft, value: string): void {
    if (!draftRef.current) return;
    const next = { ...draftRef.current, [field]: value };
    draftRef.current = next;
    setDraft(next);
    setStatus("dirty");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void saveCurrent();
    }, 400);
  }

  async function updateModelSelection(selection: ModelSelection): Promise<void> {
    if (!botIdRef.current || modelSaving) return;
    if (!(await flush())) return;
    setModelSaving(true);
    onError(null);
    const result = await window.aevorenBot.bots.update({
      id: botIdRef.current,
      expectedVersion: versionRef.current,
      patch: { modelSelection: selection },
    });
    if (result.ok) {
      versionRef.current = result.data.version;
      onBotUpdated(result.data);
      setStatus("saved");
    } else {
      onError(result.error);
      setStatus("failed");
    }
    setModelSaving(false);
  }

  async function updateMcpSelection(mcpServerIds: string[] | null): Promise<void> {
    if (!botIdRef.current || mcpSaving) return;
    if (!(await flush())) return;
    setMcpSaving(true);
    onError(null);
    const result = await window.aevorenBot.bots.update({
      id: botIdRef.current,
      expectedVersion: versionRef.current,
      patch: { mcpServerIds },
    });
    if (result.ok) {
      versionRef.current = result.data.version;
      onBotUpdated(result.data);
      setStatus("saved");
    } else {
      onError(result.error);
      setStatus("failed");
    }
    setMcpSaving(false);
  }

  async function updateMemoryWorkspaceSelection(memoryWorkspaceIds: string[]): Promise<void> {
    if (!botIdRef.current || memoryScopeSaving) return;
    if (!(await flush())) return;
    setMemoryScopeSaving(true);
    onError(null);
    const result = await window.aevorenBot.bots.update({
      id: botIdRef.current,
      expectedVersion: versionRef.current,
      patch: { memoryWorkspaceIds },
    });
    if (result.ok) {
      versionRef.current = result.data.version;
      onBotUpdated(result.data);
      setStatus("saved");
    } else {
      onError(result.error);
      setStatus("failed");
    }
    setMemoryScopeSaving(false);
  }

  if (!bot || !draft) {
    return (
      <aside className={`inspector inspector-empty${mobileOpen ? " mobile-open" : ""}`} aria-label="Bot 设置">
        <button className="drawer-close-button" type="button" aria-label="关闭 Bot 设置" onClick={onMobileClose}>
          <CloseIcon />
        </button>
        <span>创建 Bot 后，可在这里定义它的职责。</span>
      </aside>
    );
  }

  const selectedProvider = providers.find((provider) => provider.id === bot.modelSelection.providerInstanceId) ?? null;

  return (
    <aside className={`inspector${mobileOpen ? " mobile-open" : ""}`} aria-label="Bot 设置">
      <header className="inspector-header">
        <h2>Bot 详情</h2>
        <div className="inspector-header-actions">
          <div className={`save-status status-${status}`} data-testid="profile-save-status">
            {status === "saving" ? "保存中…" : null}
            {status === "dirty" ? "未保存" : null}
            {status === "failed" ? "保存失败" : null}
            {status === "idle" || status === "saved" ? <><CheckIcon />已保存</> : null}
          </div>
          <button className="drawer-close-button" type="button" aria-label="关闭 Bot 设置" onClick={onMobileClose}>
            <CloseIcon />
          </button>
        </div>
      </header>

      <label className="field">
        <span>名称</span>
        <input ref={nameInputRef} value={draft.name} maxLength={80} placeholder="Bob" onChange={(event) => update("name", event.target.value)} onBlur={() => void flush()} />
      </label>
      <div className="field provider-selection-field">
        <span>模型供应商</span>
        <select
          aria-label="模型供应商"
          value={bot.modelSelection.providerInstanceId}
          disabled={modelSaving || providers.length === 0}
          onChange={(event) => {
            const provider = providers.find((candidate) => candidate.id === event.target.value);
            if (!provider) return;
            setModelDraft(provider.models.default);
            void updateModelSelection({
              providerInstanceId: provider.id,
              modelId: provider.models.default,
            });
          }}
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.displayName}{provider.status === "available" ? "" : "（不可用）"}
            </option>
          ))}
        </select>
        {selectedProvider?.reason ? <small>{selectedProvider.reason}</small> : null}
      </div>
      <label className="field provider-selection-field">
        <span>模型</span>
        <input
          aria-label="Bot 模型"
          list={`provider-models-${bot.id}`}
          value={modelDraft}
          disabled={modelSaving || !selectedProvider}
          placeholder={selectedProvider?.models.default || "输入模型 ID"}
          onChange={(event) => setModelDraft(event.target.value)}
          onBlur={() => {
            const modelId = modelDraft.trim();
            if (!modelId) {
              setModelDraft(bot.modelSelection.modelId);
              return;
            }
            if (modelId === bot.modelSelection.modelId) return;
            void updateModelSelection({ providerInstanceId: bot.modelSelection.providerInstanceId, modelId });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <datalist id={`provider-models-${bot.id}`}>
          {selectedProvider?.models.options.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </datalist>
      </label>
      <div className="field mcp-access-field">
        <span>MCP 访问</span>
        <select
          aria-label="MCP 访问范围"
          value={bot.mcpServerIds == null ? "all" : "custom"}
          disabled={mcpSaving}
          onChange={(event) => void updateMcpSelection(
            event.target.value === "all" ? null : mcpServers.filter((server) => server.enabled).map((server) => server.id),
          )}
        >
          <option value="all">全部已启用 Server</option>
          <option value="custom">自定义 Server</option>
        </select>
        <small>{bot.mcpServerIds == null ? "自动使用全部已启用的只读 MCP 工具" : `已选择 ${bot.mcpServerIds.length} 个 Server`}</small>
        {bot.mcpServerIds != null ? <div className="mcp-access-list">
          {mcpServers.map((server) => {
            const checked = bot.mcpServerIds?.includes(server.id) ?? false;
            return <label key={server.id}>
              <input
                type="checkbox"
                checked={checked}
                disabled={mcpSaving || !server.enabled && !checked}
                onChange={() => void updateMcpSelection(checked
                  ? (bot.mcpServerIds ?? []).filter((id) => id !== server.id)
                  : [...(bot.mcpServerIds ?? []), server.id])}
              />
              <span>{server.name}</span>
              <small>{server.enabled ? server.status : "未启用"}</small>
            </label>;
          })}
        </div> : null}
      </div>
      <div className="field mcp-access-field">
        <span>项目 Memory</span>
        <small>只注入明确绑定的 Workspace 长期状态</small>
        <div className="mcp-access-list">
          {workspaces.length === 0 ? <small>尚未授权 Workspace</small> : workspaces.map((workspace) => {
            const selected = (bot.memoryWorkspaceIds ?? []).includes(workspace.id);
            return <label key={workspace.id}>
              <input
                type="checkbox"
                checked={selected}
                disabled={memoryScopeSaving}
                onChange={() => void updateMemoryWorkspaceSelection(selected
                  ? (bot.memoryWorkspaceIds ?? []).filter((id) => id !== workspace.id)
                  : [...(bot.memoryWorkspaceIds ?? []), workspace.id])}
              />
              <span>{workspace.name}</span>
              <small>{selected ? "已绑定" : "未绑定"}</small>
            </label>;
          })}
        </div>
      </div>
      <label className="field">
        <span>标签（可选）</span>
        <input value={draft.label} maxLength={120} placeholder="研究、市场、行政" onChange={(event) => update("label", event.target.value)} onBlur={() => void flush()} />
      </label>
      <label className="field">
        <span>描述</span>
        <textarea value={draft.description} maxLength={2_000} rows={5} placeholder="详细说明用途和工作方式" onChange={(event) => update("description", event.target.value)} onBlur={() => void flush()} />
      </label>
      {bot.instructions.trim() ? (
        <label className="field field-grow">
          <span>Instructions</span>
          <textarea value={draft.instructions} maxLength={20_000} rows={10} onChange={(event) => update("instructions", event.target.value)} onBlur={() => void flush()} />
        </label>
      ) : null}
      {status === "failed" ? <button className="secondary-button full-width" type="button" onClick={() => void flush()}>重试保存</button> : null}
      <MemoryPanel ref={memoryPanelRef} botId={bot.id} onError={onError} />
    </aside>
  );
});
