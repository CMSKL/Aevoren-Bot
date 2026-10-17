import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AppError, Bot, BotPatch, McpServerInfo, ModelSelection, ProviderInstanceInfo, Workspace } from "@shared/contracts";
import { ChevronDownIcon, DocumentIcon, SettingsIcon, WorkspaceIcon } from "./Icons";
import { MemoryPanel, type MemoryPanelHandle } from "./MemoryPanel";
import { ModelSettingsPanel, type ModelSettingsPanelState } from "./ModelSettingsDialog";
import { ProviderStatusPill } from "./ProviderPresentation";

type ProfileDraft = Pick<Bot, "name" | "label" | "description" | "instructions">;
export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "failed";

export type ProfileInspectorHandle = {
  flush(): Promise<boolean>;
  focusName(): void;
};

type ProfileInspectorProps = {
  bot: Bot | null;
  workspaceIds: string[];
  activeTab: "profile" | "models" | "memory";
  editing: boolean;
  onBotUpdated(bot: Bot): void;
  onError(error: AppError | null): void;
  onSaveStatusChange(status: SaveStatus): void;
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
  { bot, workspaceIds, activeTab, editing, onBotUpdated, onError, onSaveStatusChange },
  ref,
) {
  const [draft, setDraft] = useState<ProfileDraft | null>(bot ? toDraft(bot) : null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [providers, setProviders] = useState<ProviderInstanceInfo[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const fileWorkspaces = workspaces.filter((workspace) => workspaceIds.includes(workspace.id));
  const [modelSaving, setModelSaving] = useState(false);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [memoryScopeSaving, setMemoryScopeSaving] = useState(false);
  const [modelDraft, setModelDraft] = useState(bot?.modelSelection.modelId ?? "");
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [connectionsVisited, setConnectionsVisited] = useState(false);
  const [providerLoading, setProviderLoading] = useState(true);
  const [providerChecking, setProviderChecking] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const modelDraftRef = useRef(modelDraft);
  const modelSelectionRef = useRef(bot?.modelSelection);
  const draftRef = useRef(draft);
  const savedRef = useRef<ProfileDraft | null>(bot ? toDraft(bot) : null);
  const botIdRef = useRef(bot?.id ?? null);
  const versionRef = useRef(bot?.version ?? 1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const failedPatchRef = useRef<BotPatch | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const memoryPanelRef = useRef<MemoryPanelHandle>(null);
  const connectionStateRef = useRef<ModelSettingsPanelState>({ dirty: false, pending: false });
  const connectionStateChanged = useCallback((state: ModelSettingsPanelState): void => {
    const wasDirty = connectionStateRef.current.dirty;
    connectionStateRef.current = state;
    if (state.dirty) setStatus("dirty");
    else if (wasDirty && !savePromiseRef.current) {
      const clean = draftRef.current && savedRef.current && sameDraft(draftRef.current, savedRef.current)
        && (modelDraftRef.current.trim() || modelSelectionRef.current?.modelId) === modelSelectionRef.current?.modelId
        && failedPatchRef.current === null;
      setStatus(clean ? "saved" : "dirty");
    }
    if (!state.dirty && !state.pending) setConnectionNotice(null);
  }, []);

  useEffect(() => { onSaveStatusChange(status); }, [status, onSaveStatusChange]);

  useEffect(() => {
    if (bot?.id === botIdRef.current) {
      if (bot) {
        const clean = draftRef.current && savedRef.current && sameDraft(draftRef.current, savedRef.current)
          && (modelDraftRef.current.trim() || modelSelectionRef.current?.modelId) === modelSelectionRef.current?.modelId
          && failedPatchRef.current === null;
        if (clean || bot.version === versionRef.current) versionRef.current = bot.version;
        if (clean && !savePromiseRef.current) {
          const next = toDraft(bot);
          if (draftRef.current && !sameDraft(draftRef.current, next)) {
            draftRef.current = next;
            savedRef.current = next;
            setDraft(next);
          }
        }
      }
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
    const previous = modelSelectionRef.current;
    if (bot?.modelSelection.providerInstanceId !== previous?.providerInstanceId || modelDraftRef.current === previous?.modelId) {
      modelDraftRef.current = bot?.modelSelection.modelId ?? "";
      setModelDraft(modelDraftRef.current);
    }
    modelSelectionRef.current = bot?.modelSelection;
  }, [bot?.modelSelection]);

  useEffect(() => {
    let active = true;
    let providerRequest = 0;
    if (!bot?.id) {
      setProviders([]);
      setMcpServers([]);
      setWorkspaces([]);
      return;
    }
    const loadProviders = (): void => {
      const request = ++providerRequest;
      setProviderLoading(true);
      void window.aevorenBot.providers.list().then((result) => {
        if (!active || request !== providerRequest) return;
        if (result.ok) setProviders(result.data);
        else onError(result.error);
        setProviderLoading(false);
      }).catch((error: unknown) => {
        if (!active || request !== providerRequest) return;
        console.warn("Contact provider list failed", error);
        setProviderLoading(false);
        onError({ code: "CONTACT_PROVIDER_READ_FAILED", domain: "provider", retryable: true, safeMessage: "模型来源暂时无法读取，请重试。" });
      });
    };
    const loadMcp = (): void => {
      void window.aevorenBot.mcp.list().then((result) => {
        if (!active) return;
        if (result.ok) setMcpServers(result.data);
        else onError(result.error);
      }).catch((error: unknown) => {
        if (!active) return;
        console.warn("Contact MCP list failed", error);
        onError({ code: "CONTACT_TOOL_READ_FAILED", domain: "tool", retryable: true, safeMessage: "工具范围暂时无法读取，请稍后重试。" });
      });
    };
    const loadWorkspaces = (): void => {
      void window.aevorenBot.workspaces.list().then((result) => {
        if (!active) return;
        if (result.ok) setWorkspaces(result.data);
        else onError(result.error);
      }).catch((error: unknown) => {
        if (!active) return;
        console.warn("Contact memory scope list failed", error);
        onError({ code: "CONTACT_MEMORY_SCOPE_FAILED", domain: "memory", retryable: true, safeMessage: "记忆范围暂时无法读取，请稍后重试。" });
      });
    };
    loadProviders();
    loadMcp();
    loadWorkspaces();
    window.addEventListener("aevoren:providers-changed", loadProviders);
    window.addEventListener("aevoren:mcp-changed", loadMcp);
    window.addEventListener("aevoren:workspaces-changed", loadWorkspaces);
    return () => {
      active = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener("aevoren:providers-changed", loadProviders);
      window.removeEventListener("aevoren:mcp-changed", loadMcp);
      window.removeEventListener("aevoren:workspaces-changed", loadWorkspaces);
    };
  }, [bot?.id, onError]);

  async function saveCurrent(): Promise<boolean> {
    if (!botIdRef.current || !draftRef.current || !savedRef.current) return true;
    if (savePromiseRef.current) {
      const previousSucceeded = await savePromiseRef.current;
      if (!previousSucceeded) return false;
      return saveCurrent();
    }
    if (sameDraft(draftRef.current, savedRef.current)) return true;

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
      setStatus(!connectionStateRef.current.dirty && draftRef.current && sameDraft(draftRef.current, snapshot) ? "saved" : "dirty");
      return true;
    }).catch((error: unknown) => {
      console.warn("Contact profile save failed", error);
      setStatus("failed");
      onError({ code: "CONTACT_PROFILE_SAVE_FAILED", domain: "bot", retryable: true, safeMessage: "资料未能保存，修改已保留，请重试。" });
      return false;
    });
    savePromiseRef.current = operation;
    try {
      return await operation;
    } finally {
      savePromiseRef.current = null;
    }
  }

  async function flush(): Promise<boolean> {
    if (connectionStateRef.current.dirty || connectionStateRef.current.pending) {
      setConnectionsOpen(true);
      setConnectionNotice(connectionStateRef.current.pending ? "本机连接正在处理，请完成后再离开。" : "本机连接配置尚未保存，请先保存或放弃修改。");
      return false;
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const saved = await saveCurrent();
    if (!saved) return false;
    if (draftRef.current && savedRef.current && !sameDraft(draftRef.current, savedRef.current)) return flush();
    if (failedPatchRef.current && !(await savePatch(failedPatchRef.current))) return false;
    const modelId = modelDraftRef.current.trim();
    const selection = modelSelectionRef.current;
    if (!modelId) {
      modelDraftRef.current = selection?.modelId ?? "";
      setModelDraft(modelDraftRef.current);
    } else if (selection && modelId !== selection.modelId && !(await savePatch({ modelSelection: { ...selection, modelId } }))) return false;
    const memorySaved = await memoryPanelRef.current?.flush() ?? true;
    if (memorySaved) setStatus("saved");
    return memorySaved;
  }

  useImperativeHandle(ref, () => ({
    flush,
    focusName() {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    },
  }));

  function update(field: keyof ProfileDraft, value: ProfileDraft[typeof field]): void {
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

  async function savePatch(patch: BotPatch): Promise<boolean> {
    if (!botIdRef.current || !(await saveCurrent())) return false;
    if (savePromiseRef.current) {
      if (!(await savePromiseRef.current)) return false;
      return savePatch(patch);
    }
    setModelSaving(true);
    setMcpSaving(true);
    setMemoryScopeSaving(true);
    setStatus("saving");
    onError(null);
    const operation = window.aevorenBot.bots.update({
      id: botIdRef.current,
      expectedVersion: versionRef.current,
      patch,
    }).then((result) => {
      if (!result.ok) {
        failedPatchRef.current = patch;
        onError(result.error);
        setStatus("failed");
        return false;
      }
      versionRef.current = result.data.version;
      failedPatchRef.current = null;
      if (patch.modelSelection) {
        modelSelectionRef.current = result.data.modelSelection;
        modelDraftRef.current = result.data.modelSelection.modelId;
        setModelDraft(result.data.modelSelection.modelId);
      }
      onBotUpdated(result.data);
      setStatus(connectionStateRef.current.dirty || (draftRef.current && savedRef.current && !sameDraft(draftRef.current, savedRef.current)) ? "dirty" : "saved");
      return true;
    }).catch((error: unknown) => {
      failedPatchRef.current = patch;
      console.warn("Contact configuration save failed", error);
      setStatus("failed");
      onError({ code: "CONTACT_CONFIGURATION_SAVE_FAILED", domain: "bot", retryable: true, safeMessage: "配置未能保存，请重试。" });
      return false;
    });
    savePromiseRef.current = operation;
    try { return await operation; } finally {
      savePromiseRef.current = null;
      setModelSaving(false);
      setMcpSaving(false);
      setMemoryScopeSaving(false);
    }
  }

  async function updateModelSelection(selection: ModelSelection): Promise<void> {
    if (modelSaving) return;
    await savePatch({ modelSelection: selection });
  }

  async function updateMcpSelection(mcpServerIds: string[] | null): Promise<void> {
    if (mcpSaving) return;
    await savePatch({ mcpServerIds });
  }

  async function updateMemoryWorkspaceSelection(memoryWorkspaceIds: string[]): Promise<void> {
    if (memoryScopeSaving) return;
    await savePatch({ memoryWorkspaceIds });
  }

  async function checkProvider(): Promise<void> {
    if (!selectedProvider || providerChecking) return;
    setProviderChecking(true);
    onError(null);
    try {
      const result = await window.aevorenBot.providers.refresh(selectedProvider.id);
      if (result.ok) {
        setProviders((current) => current.map((provider) => provider.id === result.data.id ? result.data : provider));
        window.dispatchEvent(new Event("aevoren:providers-changed"));
      } else onError(result.error);
    } catch (error: unknown) {
      console.warn("Contact provider check failed", error);
      onError({ code: "CONTACT_PROVIDER_CHECK_FAILED", domain: "provider", retryable: true, safeMessage: "检测未完成，请稍后重试。" });
    } finally { setProviderChecking(false); }
  }

  if (!bot || !draft) return null;
  const selectedProvider = providers.find((provider) => provider.id === bot.modelSelection.providerInstanceId) ?? null;
  const displayProviderName = (provider: ProviderInstanceInfo): string => provider.driverKind === "openai-compatible" ? "API"
    : provider.driverKind === "claude-cli" ? "Claude Code" : provider.driverKind === "codex-cli" ? "Codex CLI" : provider.displayName;

  return (
    <section className="contact-editor-fields" aria-label="联系人资料编辑器">
      {connectionNotice ? <p className="dialog-error" role="alert">{connectionNotice}</p> : null}
      <div id={`contact-${bot.id}-profile-panel`} role="tabpanel" aria-labelledby={`contact-${bot.id}-profile-tab`} hidden={activeTab !== "profile"} className="contact-tab-panel contact-profile-fields">
        <label className="field contact-field">
          <span>名称</span>
          <input ref={nameInputRef} value={draft.name} maxLength={80} readOnly={!editing} placeholder="Bot 名称" onChange={(event) => update("name", event.target.value)} onBlur={() => void flush()} />
        </label>
        <label className="field contact-field">
          <span>标签（可选）</span>
          <input value={draft.label} maxLength={120} readOnly={!editing} placeholder="研究、市场、行政" onChange={(event) => update("label", event.target.value)} onBlur={() => void flush()} />
        </label>
        <label className="field contact-field">
          <span>描述</span>
          <textarea value={draft.description} maxLength={2_000} readOnly={!editing} rows={3} placeholder="说明这位 Bot 的用途" onChange={(event) => update("description", event.target.value)} onBlur={() => void flush()} />
        </label>
        <details className="contact-section-disclosure">
          <summary><DocumentIcon /><strong>职责与规则</strong><ChevronDownIcon className="contact-disclosure-chevron" /></summary>
          <label className="field"><span>高级指令</span><textarea aria-label="Instructions" value={draft.instructions} maxLength={20_000} readOnly={!editing} rows={8} placeholder="定义职责、工作方式和边界" onChange={(event) => update("instructions", event.target.value)} onBlur={() => void flush()} /></label>
        </details>
        <p className="contact-editor-note">修改自动保存；保存失败时保留修改并可重试。</p>
      </div>
      <div id={`contact-${bot.id}-models-panel`} role="tabpanel" aria-labelledby={`contact-${bot.id}-models-tab`} hidden={activeTab !== "models"} className="contact-tab-panel">
        <div className="contact-field contact-provider-row">
          <label htmlFor={`contact-provider-${bot.id}`}>调用方式</label>
          <div>
            <select id={`contact-provider-${bot.id}`} aria-label="模型供应商" value={bot.modelSelection.providerInstanceId} disabled={modelSaving || providerLoading || providers.length === 0} onChange={(event) => {
              const provider = providers.find((candidate) => candidate.id === event.target.value);
              if (provider) void updateModelSelection({ providerInstanceId: provider.id, modelId: provider.models.default });
            }}>
              {!selectedProvider ? <option value={bot.modelSelection.providerInstanceId}>{providerLoading ? "读取中…" : "当前来源不可用"}</option> : null}
              {providers.map((provider) => <option key={provider.id} value={provider.id}>{displayProviderName(provider)}</option>)}
            </select>
            <small>可选 API、Claude Code、Codex CLI。</small>
          </div>
          <div className="contact-provider-status">
            {selectedProvider ? <ProviderStatusPill provider={selectedProvider} /> : <span>{providerLoading ? "读取状态中…" : "待配置"}</span>}
            <button className="secondary-button" type="button" disabled={providerChecking || providerLoading || !selectedProvider} onClick={() => void checkProvider()}>{providerChecking ? "检测中…" : "检测状态"}</button>
          </div>
        </div>
        <label className="field contact-field">
          <span>使用模型</span>
          <div>
            <input aria-label="Bot 模型" list={`provider-models-${bot.id}`} value={modelDraft} disabled={modelSaving || !selectedProvider} placeholder={selectedProvider?.models.default || "输入模型 ID"} onChange={(event) => {
              if (failedPatchRef.current?.modelSelection) failedPatchRef.current = null;
              modelDraftRef.current = event.target.value;
              setModelDraft(event.target.value);
              setStatus("dirty");
            }} onBlur={() => void flush()} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
            <datalist id={`provider-models-${bot.id}`}>{selectedProvider?.models.options.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
            <small>仅更改这位 Bot 的调用方式与模型。</small>
          </div>
        </label>
        <details className="contact-section-disclosure" open={connectionsOpen} onToggle={(event) => {
          const open = event.currentTarget.open;
          setConnectionsOpen(open);
          if (open) setConnectionsVisited(true);
        }}>
          <summary><SettingsIcon /><strong>本机连接设置</strong><span className="contact-shared-label">共享</span><ChevronDownIcon className="contact-disclosure-chevron" /></summary>
          <p className="contact-editor-note">地址、密钥与 CLI 路径为本机共享，修改会影响使用相同连接的其他 Bot。连接配置需点击保存后生效。</p>
          {connectionsVisited ? <div hidden={!connectionsOpen}><ModelSettingsPanel open onStateChange={connectionStateChanged} /></div> : null}
        </details>
        {!connectionsOpen ? <p className="contact-editor-note">地址、密钥与 CLI 路径为本机共享，修改会影响使用相同连接的其他 Bot。</p> : null}
        <details className="contact-section-disclosure">
          <summary><WorkspaceIcon /><strong>工具范围</strong><span>配置这位 Bot 可使用的 MCP 服务</span><ChevronDownIcon className="contact-disclosure-chevron" /></summary>
          <label className="field">
            <span>外部工具（MCP）</span>
            <select aria-label="MCP 访问范围" value={bot.mcpServerIds == null ? "all" : "custom"} disabled={mcpSaving} onChange={(event) => void updateMcpSelection(event.target.value === "all" ? null : mcpServers.filter((server) => server.enabled).map((server) => server.id))}>
              <option value="all">全部已启用服务</option><option value="custom">自定义服务</option>
            </select>
            <small>{bot.mcpServerIds == null ? "自动使用全部已启用的只读外部工具" : `已选择 ${bot.mcpServerIds.length} 个服务`}</small>
          </label>
          {bot.mcpServerIds != null ? <div className="mcp-access-list">{mcpServers.map((server) => {
            const checked = bot.mcpServerIds?.includes(server.id) ?? false;
            return <label key={server.id}><input type="checkbox" checked={checked} disabled={mcpSaving || !server.enabled && !checked} onChange={() => void updateMcpSelection(checked ? (bot.mcpServerIds ?? []).filter((id) => id !== server.id) : [...(bot.mcpServerIds ?? []), server.id])} /><span>{server.name}</span><small>{server.enabled ? server.status : "未启用"}</small></label>;
          })}</div> : null}
          <p className="contact-editor-note">文件访问仍由各会话的目录授权决定，不会因修改 Bot 资料而改变。{fileWorkspaces.length > 0 ? `当前会话已授权：${fileWorkspaces.map((workspace) => workspace.name).join("、")}` : ""}</p>
        </details>
      </div>
      <div id={`contact-${bot.id}-memory-panel`} role="tabpanel" aria-labelledby={`contact-${bot.id}-memory-tab`} hidden={activeTab !== "memory"} className="contact-tab-panel">
        {activeTab === "memory" ? <MemoryPanel ref={memoryPanelRef} botId={bot.id} onError={onError} /> : null}
        <details className="contact-section-disclosure">
          <summary><WorkspaceIcon /><strong>文件夹记忆范围</strong><ChevronDownIcon className="contact-disclosure-chevron" /></summary>
          <p className="contact-editor-note">只把明确绑定的长期状态加入模型上下文；不等同于文件访问授权。</p>
          <div className="mcp-access-list">{workspaces.length === 0 ? <small>尚未绑定文件夹记忆</small> : workspaces.map((workspace) => {
            const selected = (bot.memoryWorkspaceIds ?? []).includes(workspace.id);
            return <label key={workspace.id}><input type="checkbox" checked={selected} disabled={memoryScopeSaving} onChange={() => void updateMemoryWorkspaceSelection(selected ? (bot.memoryWorkspaceIds ?? []).filter((id) => id !== workspace.id) : [...(bot.memoryWorkspaceIds ?? []), workspace.id])} /><span>{workspace.name}</span><small>{selected ? "已注入" : "未注入"}</small></label>;
          })}</div>
        </details>
      </div>
      {status === "failed" ? <button className="secondary-button" type="button" onClick={() => void flush()}>重试保存</button> : null}
    </section>
  );
});
