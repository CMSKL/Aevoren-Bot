import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AppError, Bot, BotPatch } from "@shared/contracts";
import { CheckIcon, CloseIcon } from "./Icons";

type ProfileDraft = Pick<Bot, "name" | "label" | "description" | "instructions">;
export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "failed";

export type ProfileInspectorHandle = {
  flush(): Promise<boolean>;
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
  const draftRef = useRef(draft);
  const savedRef = useRef<ProfileDraft | null>(bot ? toDraft(bot) : null);
  const botIdRef = useRef(bot?.id ?? null);
  const versionRef = useRef(bot?.version ?? 1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);

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
    const operation = window.msBot.bots.update({ id, expectedVersion, patch: snapshot as BotPatch }).then((result) => {
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
    return true;
  }

  useImperativeHandle(ref, () => ({ flush }));

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

  return (
    <aside className={`inspector${mobileOpen ? " mobile-open" : ""}`} aria-label="Bot 设置">
      <header className="inspector-header">
        <h2>Bot 设置</h2>
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
        <input value={draft.name} maxLength={80} placeholder="Bob" onChange={(event) => update("name", event.target.value)} onBlur={() => void flush()} />
      </label>
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
    </aside>
  );
});
