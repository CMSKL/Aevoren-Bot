import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { AppError, Bot, RoomDetail, RoomPatch } from "@shared/contracts";
import { buildBotIdentityMap } from "../bot-identity";
import { CheckIcon, CloseIcon } from "./Icons";

type Draft = Pick<RoomDetail["room"], "name" | "description">;
type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "failed";

export type RoomInspectorHandle = { flush(): Promise<boolean> };

type Props = {
  detail: RoomDetail | null;
  bots: Bot[];
  active: boolean;
  mobileOpen: boolean;
  onDetailUpdated(detail: RoomDetail): void;
  onArchived(room: RoomDetail["room"]): void;
  onError(error: AppError | null): void;
  onOpenBot(bot: Bot): void;
  onMobileClose(): void;
};

function toDraft(detail: RoomDetail): Draft {
  return { name: detail.room.name, description: detail.room.description };
}

function same(left: Draft, right: Draft): boolean {
  return left.name === right.name && left.description === right.description;
}

export const RoomInspector = forwardRef<RoomInspectorHandle, Props>(function RoomInspector(
  { detail, bots, active, mobileOpen, onDetailUpdated, onArchived, onError, onOpenBot, onMobileClose },
  ref,
) {
  const [draft, setDraft] = useState<Draft | null>(detail ? toDraft(detail) : null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [selectedBotId, setSelectedBotId] = useState("");
  const [memberPending, setMemberPending] = useState(false);
  const draftRef = useRef(draft);
  const savedRef = useRef<Draft | null>(detail ? toDraft(detail) : null);
  const detailRef = useRef(detail);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const availableBots = useMemo(
    () => bots.filter((bot) => !detail?.members.some((member) => member.botId === bot.id)),
    [bots, detail],
  );
  const botIdentities = useMemo(() => buildBotIdentityMap(bots), [bots]);

  async function saveCurrent(): Promise<boolean> {
    const currentDetail = detailRef.current;
    if (!currentDetail || !draftRef.current || !savedRef.current || same(draftRef.current, savedRef.current)) return true;
    if (savePromiseRef.current) {
      const succeeded = await savePromiseRef.current;
      return succeeded ? saveCurrent() : false;
    }
    const snapshot = { ...draftRef.current };
    setStatus("saving");
    onError(null);
    const operation = window.msBot.rooms.update({
      id: currentDetail.room.id,
      expectedVersion: currentDetail.room.version,
      patch: snapshot as RoomPatch,
    }).then((result) => {
      if (!result.ok) {
        setStatus("failed");
        onError(result.error);
        return false;
      }
      const nextDetail = { ...currentDetail, room: result.data };
      detailRef.current = nextDetail;
      savedRef.current = snapshot;
      onDetailUpdated(nextDetail);
      setStatus(draftRef.current && same(draftRef.current, snapshot) ? "saved" : "dirty");
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
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const saved = await saveCurrent();
    if (!saved) return false;
    if (draftRef.current && savedRef.current && !same(draftRef.current, savedRef.current)) return flush();
    return true;
  }

  useImperativeHandle(ref, () => ({ flush }));

  function update(field: keyof Draft, value: string): void {
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

  async function changeMember(operation: "add" | "remove", botId: string): Promise<void> {
    const current = detailRef.current;
    if (!current || memberPending || active) return;
    setMemberPending(true);
    onError(null);
    const input = { roomId: current.room.id, botId, expectedMembershipVersion: current.room.membershipVersion };
    const result = operation === "add" ? await window.msBot.rooms.addMember(input) : await window.msBot.rooms.removeMember(input);
    setMemberPending(false);
    if (!result.ok) {
      onError(result.error);
      return;
    }
    detailRef.current = result.data;
    setSelectedBotId("");
    onDetailUpdated(result.data);
  }

  if (!detail || !draft) return <aside className="inspector inspector-empty" aria-label="群聊设置" />;

  return (
    <aside className={`inspector${mobileOpen ? " mobile-open" : ""}`} aria-label="群聊设置">
      <header className="inspector-header">
        <h2>群聊设置</h2>
        <div className="inspector-header-actions">
          <div className={`save-status status-${status}`} data-testid="room-save-status">
            {status === "saving" ? "保存中…" : null}
            {status === "dirty" ? "未保存" : null}
            {status === "failed" ? "保存失败" : null}
            {status === "idle" || status === "saved" ? <><CheckIcon />已保存</> : null}
          </div>
          <button className="drawer-close-button" type="button" aria-label="关闭群聊设置" onClick={onMobileClose}><CloseIcon /></button>
        </div>
      </header>
      <label className="field">
        <span>名称</span>
        <input value={draft.name} maxLength={72} onChange={(event) => update("name", event.target.value)} onBlur={() => void flush()} />
      </label>
      <label className="field">
        <span>描述</span>
        <textarea value={draft.description} maxLength={2_000} rows={4} placeholder="说明这个群聊的协作目标" onChange={(event) => update("description", event.target.value)} onBlur={() => void flush()} />
      </label>
      <section className="room-members" aria-label="群聊成员">
        <div className="room-section-title"><strong>成员</strong><span>{detail.members.length}/6</span></div>
        {detail.members.map((member) => {
          const identity = botIdentities.get(member.botId)!;
          return <div className="room-member-row" key={member.botId}>
            <button className="member-main-link" type="button" title={identity.inline} onClick={() => onOpenBot(member.bot)}>{identity.inline}</button>
            <button
              className="text-button danger-button"
              type="button"
              disabled={active || memberPending || detail.members.length <= 2}
              onClick={() => void changeMember("remove", member.botId)}
            >移除</button>
          </div>;
        })}
        {detail.members.length < 6 && availableBots.length > 0 ? (
          <div className="room-add-member">
            <select aria-label="选择要添加的 Bot" value={selectedBotId} onChange={(event) => setSelectedBotId(event.target.value)} disabled={active || memberPending}>
              <option value="">选择 Bot…</option>
              {availableBots.map((bot) => <option value={bot.id} key={bot.id}>{botIdentities.get(bot.id)!.inline}</option>)}
            </select>
            <button className="secondary-button" type="button" disabled={!selectedBotId || active || memberPending} onClick={() => void changeMember("add", selectedBotId)}>添加</button>
          </div>
        ) : null}
        {active ? <p className="room-lock-note">本批回复完成或取消后才能修改成员。</p> : null}
      </section>
      {status === "failed" ? <button className="secondary-button full-width" type="button" onClick={() => void flush()}>重试保存</button> : null}
      <button
        className="secondary-button full-width archive-button"
        type="button"
        disabled={active || memberPending}
        onClick={async () => {
          if (!(await flush())) return;
          const result = await window.msBot.rooms.archive({ id: detail.room.id, archived: true });
          if (!result.ok) onError(result.error);
          else onArchived(result.data);
        }}
      >归档群聊</button>
    </aside>
  );
});
