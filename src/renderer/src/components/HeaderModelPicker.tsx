import { useEffect, useMemo, useRef, useState } from "react";
import type { AppError, Bot, ProviderInstanceInfo } from "@shared/contracts";
import { BotIcon, CheckIcon, RefreshIcon } from "./Icons";

type HeaderModelPickerProps = {
  bot: Bot;
  busy: boolean;
  onBotUpdated(bot: Bot): void;
  onError(error: AppError | null): void;
};

const PROVIDERS_CHANGED_EVENT = "aevoren:providers-changed";

function modelLabel(provider: ProviderInstanceInfo | undefined, modelId: string): string {
  return provider?.models.options.find((model) => model.id === modelId)?.label ?? (modelId || "选择模型");
}

function providerMark(provider: ProviderInstanceInfo): string {
  if (provider.driverKind === "codex-cli") return "C";
  if (provider.driverKind === "claude-cli") return "Cl";
  if (provider.driverKind === "ollama-cli") return "O";
  return "API";
}

function providerStatus(provider: ProviderInstanceInfo): string {
  if (provider.status === "available") return provider.runtimeVersion || "可用";
  if (provider.cliPath && !provider.authenticated) return "未登录";
  return provider.cliPath ? "不可用" : "未安装";
}

export function HeaderModelPicker({ bot, busy, onBotUpdated, onError }: HeaderModelPickerProps): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderInstanceInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState(bot.modelSelection.providerInstanceId);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeProvider = providers.find((provider) => provider.id === bot.modelSelection.providerInstanceId);
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? activeProvider;
  const cloudProviders = providers.filter((provider) => provider.access === "cloud");
  const localProviders = providers.filter((provider) => provider.access === "local");
  const models = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const options = selectedProvider?.models.options ?? [];
    if (!normalized) return options;
    return options.filter((model) => `${model.label} ${model.id}`.toLocaleLowerCase().includes(normalized));
  }, [query, selectedProvider]);

  useEffect(() => {
    const load = (): void => {
      void window.aevorenBot.providers.list().then((result) => {
        if (result.ok) setProviders(result.data);
        else onError(result.error);
      });
    };
    load();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, load);
    return () => window.removeEventListener(PROVIDERS_CHANGED_EVENT, load);
  }, [onError]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target instanceof Node ? event.target : null)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (query) setQuery("");
      else setOpen(false);
    };
    window.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeEscape);
    return () => {
      window.removeEventListener("mousedown", closeOutside);
      window.removeEventListener("keydown", closeEscape);
    };
  }, [open, query]);

  async function refresh(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    onError(null);
    const result = await window.aevorenBot.providers.scan();
    if (result.ok) {
      setProviders(result.data);
      window.dispatchEvent(new Event(PROVIDERS_CHANGED_EVENT));
    } else onError(result.error);
    setRefreshing(false);
  }

  async function choose(provider: ProviderInstanceInfo, modelId: string): Promise<void> {
    if (busy || saving || provider.status !== "available") return;
    if (provider.id === bot.modelSelection.providerInstanceId && modelId === bot.modelSelection.modelId) {
      setOpen(false);
      return;
    }
    setSaving(true);
    onError(null);
    const result = await window.aevorenBot.bots.update({
      id: bot.id,
      expectedVersion: bot.version,
      patch: { modelSelection: { providerInstanceId: provider.id, modelId } },
    });
    if (result.ok) {
      onBotUpdated(result.data);
      setSelectedProviderId(provider.id);
      setOpen(false);
      setQuery("");
    } else onError(result.error);
    setSaving(false);
  }

  return (
    <div className="header-model-picker" ref={rootRef}>
      <button
        className="header-model-trigger"
        type="button"
        disabled={busy || saving}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={activeProvider ? `${activeProvider.displayName} · ${modelLabel(activeProvider, bot.modelSelection.modelId)}` : bot.modelSelection.modelId}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) {
            setSelectedProviderId(bot.modelSelection.providerInstanceId);
            setQuery("");
            void refresh();
          }
        }}
      >
        <span className="header-model-mark">{activeProvider ? providerMark(activeProvider) : <BotIcon />}</span>
        <span className="header-model-trigger-copy">{modelLabel(activeProvider, bot.modelSelection.modelId)}</span>
        <span className="header-model-chevron" aria-hidden="true">⌄</span>
      </button>

      {open && !busy ? (
        <div className="header-model-popover" role="dialog" aria-label="选择模型">
          <aside className="header-model-rail" aria-label="模型供应商">
            {[{ label: "云", items: cloudProviders }, { label: "本地", items: localProviders }].map((group) => (
              group.items.length > 0 ? <div className="header-model-rail-group" key={group.label}>
                <small>{group.label}</small>
                {group.items.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    aria-label={provider.displayName}
                    aria-pressed={provider.id === selectedProvider?.id}
                    title={`${provider.displayName} · ${providerStatus(provider)}`}
                    className={provider.id === selectedProvider?.id ? "selected" : ""}
                    onClick={() => {
                      setSelectedProviderId(provider.id);
                      setQuery("");
                    }}
                  >
                    <span>{providerMark(provider)}</span>
                    {provider.status !== "available" ? <i /> : null}
                  </button>
                ))}
              </div> : null
            ))}
          </aside>

          <section className="header-model-catalog">
            {selectedProvider ? <>
              <header>
                <span>
                  <strong>{selectedProvider.displayName}</strong>
                  <small>{providerStatus(selectedProvider)}</small>
                </span>
                <button type="button" aria-label={`刷新 ${selectedProvider.displayName} 模型`} disabled={refreshing} onClick={() => void refresh()}>
                  <RefreshIcon />
                </button>
              </header>
              {selectedProvider.status === "available" && selectedProvider.models.options.length > 0 ? <>
                {selectedProvider.models.options.length > 5 ? (
                  <input
                    className="header-model-search"
                    aria-label="搜索模型"
                    value={query}
                    placeholder="搜索模型"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                ) : null}
                <div className="header-model-list">
                  {models.map((model) => {
                    const current = selectedProvider.id === bot.modelSelection.providerInstanceId && model.id === bot.modelSelection.modelId;
                    return (
                      <button key={model.id} type="button" className={current ? "selected" : ""} onClick={() => void choose(selectedProvider, model.id)}>
                        <span>
                          <strong>{model.label}</strong>
                          <small>
                            {[
                              model.id === selectedProvider.models.default ? "默认" : null,
                              model.provider ? `Provider · ${model.provider}` : model.custom ? "自定义" : model.id,
                              model.loaded ? "已加载" : null,
                            ].filter(Boolean).join(" · ")}
                          </small>
                        </span>
                        {current ? <CheckIcon /> : null}
                      </button>
                    );
                  })}
                  {models.length === 0 ? <p>没有匹配的模型。</p> : null}
                </div>
              </> : (
                <div className="header-model-unavailable">
                  <strong>{selectedProvider.cliPath ? "当前不可用" : "尚未安装"}</strong>
                  <p>{selectedProvider.reason || "请在设置 → 模型与 CLI 中检查此来源。"}</p>
                </div>
              )}
            </> : <div className="header-model-unavailable"><p>尚未发现模型来源。</p></div>}
          </section>
        </div>
      ) : null}
    </div>
  );
}
