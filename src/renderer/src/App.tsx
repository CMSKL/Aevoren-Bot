import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppError,
  Bot,
  Room,
  RoomBatch,
  RoomDetail,
  RoomRuntimeEvent,
  RoomTurn,
  RuntimeEvent,
  RuntimeRun,
  Session,
  SessionLiveState,
  TranscriptEntry,
  TranscriptEvent,
} from "@shared/contracts";
import { Conversation } from "./components/Conversation";
import { ModelSettingsDialog } from "./components/ModelSettingsDialog";
import { NewBotChooser } from "./components/NewBotChooser";
import { ProfileInspector, type ProfileInspectorHandle } from "./components/ProfileInspector";
import { RoomInspector, type RoomInspectorHandle } from "./components/RoomInspector";
import { Sidebar } from "./components/Sidebar";
import { mergeBufferedEvents, mergeRuntimeRun, mergeTranscriptEntry } from "./runtime-state";

function mergeRoomEvents(
  batches: RoomBatch[],
  turns: RoomTurn[],
  events: RoomRuntimeEvent[],
): { batches: RoomBatch[]; turns: RoomTurn[] } {
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
  const turnMap = new Map(turns.map((turn) => [turn.id, turn]));
  for (const event of events) {
    const existingBatch = batchMap.get(event.batch.id);
    if (!existingBatch || existingBatch.version < event.batch.version) batchMap.set(event.batch.id, event.batch);
    for (const turn of event.turns) {
      const existingTurn = turnMap.get(turn.id);
      if (!existingTurn || existingTurn.version < turn.version) turnMap.set(turn.id, turn);
    }
  }
  return {
    batches: [...batchMap.values()].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    turns: [...turnMap.values()].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.position - right.position),
  };
}

export function App(): React.JSX.Element {
  const [bots, setBots] = useState<Bot[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<RoomDetail | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [runs, setRuns] = useState<RuntimeRun[]>([]);
  const [roomBatches, setRoomBatches] = useState<RoomBatch[]>([]);
  const [roomTurns, setRoomTurns] = useState<RoomTurn[]>([]);
  const [roomTargetSelections, setRoomTargetSelections] = useState<Record<string, string[]>>({});
  const [liveState, setLiveState] = useState<SessionLiveState | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [closeNotice, setCloseNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"bots" | "profile" | null>(null);
  const [creatingBot, setCreatingBot] = useState(false);
  const [createError, setCreateError] = useState<AppError | null>(null);
  const newBotButtonRef = useRef<HTMLButtonElement>(null);
  const profileRef = useRef<ProfileInspectorHandle>(null);
  const roomRef = useRef<RoomInspectorHandle>(null);
  const sessionIdRef = useRef<string | null>(null);
  const selectedRoomIdRef = useRef<string | null>(null);
  const loadingSessionIdRef = useRef<string | null>(null);
  const bufferedTranscriptRef = useRef<TranscriptEvent[]>([]);
  const bufferedRuntimeRef = useRef<RuntimeEvent[]>([]);
  const bufferedRoomRef = useRef<RoomRuntimeEvent[]>([]);
  const runtimeVersionsRef = useRef(new Map<string, number>());
  const openRequestRef = useRef(0);
  const chooserActionRef = useRef<"create" | "select" | null>(null);

  const flushActive = useCallback(async (): Promise<boolean> => {
    if (selectedRoomIdRef.current) return await roomRef.current?.flush() ?? true;
    return await profileRef.current?.flush() ?? true;
  }, []);

  useEffect(() => {
    const unsubscribeTranscript = window.msBot.events.subscribeTranscript((event) => {
      if (event.sessionId === loadingSessionIdRef.current) {
        bufferedTranscriptRef.current.push(event);
        return;
      }
      if (event.sessionId === sessionIdRef.current) setEntries((current) => mergeTranscriptEntry(current, event.entry));
    });
    const unsubscribeSend = window.msBot.events.subscribeSendState((event) => {
      if (event.sessionId === sessionIdRef.current && event.error) setError(event.error);
    });
    const unsubscribeRuntime = window.msBot.events.subscribeRuntime((event) => {
      if (event.sessionId === loadingSessionIdRef.current) {
        bufferedRuntimeRef.current.push(event);
        return;
      }
      if (event.sessionId !== sessionIdRef.current) return;
      const knownVersion = runtimeVersionsRef.current.get(event.run.id) ?? 0;
      if (knownVersion >= event.run.version) return;
      runtimeVersionsRef.current.set(event.run.id, event.run.version);
      setRuns((current) => mergeRuntimeRun(current, event.run));
      setLiveState(event.liveState);
      if (event.error) setError(event.error);
    });
    const unsubscribeRoom = window.msBot.events.subscribeRoomRuntime((event) => {
      if (event.sessionId === loadingSessionIdRef.current) {
        bufferedRoomRef.current.push(event);
        return;
      }
      if (event.roomId !== selectedRoomIdRef.current) return;
      setRoomBatches((current) => mergeRoomEvents(current, [], [event]).batches);
      setRoomTurns((current) => mergeRoomEvents([], current, [event]).turns);
      if (event.error) setError(event.error);
    });
    const unsubscribeClose = window.msBot.app.subscribeBeforeClose(() => {
      void flushActive().then((saved) => window.msBot.app.confirmClose(saved));
    });
    const unsubscribeCloseBlocked = window.msBot.app.subscribeCloseBlocked(() => {
      setCloseNotice("关闭未完成：资料仍保留在当前窗口，请稍后重试关闭。");
    });
    window.msBot.app.ready();
    return () => {
      unsubscribeTranscript();
      unsubscribeSend();
      unsubscribeRuntime();
      unsubscribeRoom();
      unsubscribeClose();
      unsubscribeCloseBlocked();
    };
  }, [flushActive]);

  const openBot = useCallback(async (bot: Bot, flushCurrent = true): Promise<void> => {
    const requestId = ++openRequestRef.current;
    if (flushCurrent && !(await flushActive())) return;
    setLoading(true);
    setError(null);
    setCloseNotice(null);
    const sessionResult = await window.msBot.sessions.getMain(bot.id);
    if (requestId !== openRequestRef.current) return;
    if (!sessionResult.ok) {
      setError(sessionResult.error);
      setLoading(false);
      return;
    }
    const nextSession = sessionResult.data;
    loadingSessionIdRef.current = nextSession.id;
    bufferedTranscriptRef.current = [];
    bufferedRuntimeRef.current = [];
    bufferedRoomRef.current = [];
    const snapshotResult = await window.msBot.runtime.getSessionSnapshot(nextSession.id);
    if (requestId !== openRequestRef.current) return;
    if (!snapshotResult.ok) {
      loadingSessionIdRef.current = null;
      setError(snapshotResult.error);
      setLoading(false);
      return;
    }
    const buffered = mergeBufferedEvents(
      snapshotResult.data.entries,
      snapshotResult.data.runs,
      bufferedTranscriptRef.current,
      bufferedRuntimeRef.current,
    );
    sessionIdRef.current = nextSession.id;
    selectedRoomIdRef.current = null;
    sessionStorage.setItem("ms-bot:selected", `bot:${bot.id}`);
    loadingSessionIdRef.current = null;
    setSelectedBot(bot);
    setSelectedRoom(null);
    setSession(nextSession);
    setEntries(buffered.entries);
    setRuns(buffered.runs);
    setRoomBatches([]);
    setRoomTurns([]);
    runtimeVersionsRef.current = new Map(buffered.runs.map((run) => [run.id, run.version]));
    setLiveState(buffered.lastRuntimeEvent?.liveState ?? snapshotResult.data.liveState);
    setNewBotOpen(false);
    setCreateError(null);
    setMobilePanel(null);
    setLoading(false);
  }, [flushActive]);

  const openRoom = useCallback(async (room: Room, flushCurrent = true): Promise<void> => {
    const requestId = ++openRequestRef.current;
    if (flushCurrent && !(await flushActive())) return;
    setLoading(true);
    setError(null);
    setCloseNotice(null);
    const detailResult = await window.msBot.rooms.get(room.id);
    if (requestId !== openRequestRef.current) return;
    if (!detailResult.ok) {
      setError(detailResult.error);
      setLoading(false);
      return;
    }
    const nextSession = detailResult.data.session;
    loadingSessionIdRef.current = nextSession.id;
    bufferedTranscriptRef.current = [];
    bufferedRuntimeRef.current = [];
    bufferedRoomRef.current = [];
    const snapshotResult = await window.msBot.roomRuntime.getSnapshot(room.id);
    if (requestId !== openRequestRef.current) return;
    if (!snapshotResult.ok) {
      loadingSessionIdRef.current = null;
      setError(snapshotResult.error);
      setLoading(false);
      return;
    }
    const buffered = mergeBufferedEvents(
      snapshotResult.data.entries,
      snapshotResult.data.runs,
      bufferedTranscriptRef.current,
      bufferedRuntimeRef.current,
    );
    const roomState = mergeRoomEvents(snapshotResult.data.batches, snapshotResult.data.turns, bufferedRoomRef.current);
    sessionIdRef.current = nextSession.id;
    selectedRoomIdRef.current = room.id;
    sessionStorage.setItem("ms-bot:selected", `room:${room.id}`);
    loadingSessionIdRef.current = null;
    setSelectedBot(null);
    setSelectedRoom(snapshotResult.data.detail);
    setSession(nextSession);
    setEntries(buffered.entries);
    setRuns(buffered.runs);
    setRoomBatches(roomState.batches);
    setRoomTurns(roomState.turns);
    runtimeVersionsRef.current = new Map(buffered.runs.map((run) => [run.id, run.version]));
    setLiveState(buffered.lastRuntimeEvent?.liveState ?? snapshotResult.data.liveState);
    setNewBotOpen(false);
    setCreateError(null);
    setMobilePanel(null);
    setLoading(false);
  }, [flushActive]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.msBot.bots.list(), window.msBot.rooms.list({ includeArchived: true })]).then(async ([botResult, roomResult]) => {
      if (cancelled) return;
      if (!botResult.ok) {
        setError(botResult.error);
        setLoading(false);
        return;
      }
      if (!roomResult.ok) {
        setError(roomResult.error);
        setLoading(false);
        return;
      }
      setBots(botResult.data);
      setRooms(roomResult.data);
      const selected = sessionStorage.getItem("ms-bot:selected");
      const selectedRoom = selected?.startsWith("room:")
        ? roomResult.data.find((room) => room.id === selected.slice(5) && room.archivedAt === null)
        : undefined;
      const selectedBot = selected?.startsWith("bot:")
        ? botResult.data.find((bot) => bot.id === selected.slice(4))
        : undefined;
      if (selectedRoom) await openRoom(selectedRoom, false);
      else if (selectedBot) await openBot(selectedBot, false);
      else if (botResult.data[0]) await openBot(botResult.data[0], false);
      else {
        const firstActiveRoom = roomResult.data.find((room) => room.archivedAt === null);
        if (firstActiveRoom) await openRoom(firstActiveRoom, false);
        else setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [openBot, openRoom]);

  const closeMobilePanel = useCallback(async (): Promise<void> => {
    if (mobilePanel === "profile" && !(await flushActive())) return;
    setMobilePanel(null);
  }, [flushActive, mobilePanel]);

  useEffect(() => {
    if (!mobilePanel) return;
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") void closeMobilePanel();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeMobilePanel, mobilePanel]);

  async function createBot(): Promise<void> {
    if (chooserActionRef.current) return;
    chooserActionRef.current = "create";
    setCreatingBot(true);
    try {
      if (!(await flushActive())) return;
      setCreateError(null);
      const result = await window.msBot.bots.create();
      if (!result.ok) {
        setCreateError(result.error);
        return;
      }
      setBots((current) => [...current, result.data.bot]);
      await openBot(result.data.bot, false);
    } finally {
      chooserActionRef.current = null;
      setCreatingBot(false);
    }
  }

  async function createRoom(memberBotIds: string[]): Promise<void> {
    if (chooserActionRef.current) return;
    chooserActionRef.current = "create";
    setCreatingBot(true);
    try {
      if (!(await flushActive())) return;
      setCreateError(null);
      const result = await window.msBot.rooms.create({ memberBotIds });
      if (!result.ok) {
        setCreateError(result.error);
        return;
      }
      setRooms((current) => [...current, result.data.room]);
      await openRoom(result.data.room, false);
    } finally {
      chooserActionRef.current = null;
      setCreatingBot(false);
    }
  }

  function updateBot(bot: Bot): void {
    setBots((current) => current.map((item) => item.id === bot.id ? bot : item));
    setSelectedBot((current) => current?.id === bot.id ? bot : current);
  }

  function updateRoom(detail: RoomDetail): void {
    setSelectedRoom(detail);
    setRooms((current) => current.map((item) => item.id === detail.room.id ? detail.room : item));
  }

  async function sendMessage(text: string, targetBotIds?: string[]): Promise<boolean> {
    if (!session || submitting) return false;
    setSubmitting(true);
    setError(null);
    setCloseNotice(null);
    const clientNonce = crypto.randomUUID();
    const result = selectedRoom
      ? await window.msBot.roomRuntime.send({ roomId: selectedRoom.room.id, sessionId: session.id, clientNonce, text, targetBotIds: targetBotIds ?? [] })
      : await window.msBot.messages.send({ sessionId: session.id, clientNonce, text });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    return true;
  }

  function handleArchived(room: Room): void {
    setRooms((current) => current.map((item) => item.id === room.id ? room : item));
    selectedRoomIdRef.current = null;
    if (bots[0]) void openBot(bots[0], false);
    else {
      setSelectedRoom(null);
      setSession(null);
      setEntries([]);
      setRuns([]);
      setRoomBatches([]);
      setRoomTurns([]);
    }
  }

  const activeRoomBatch = roomBatches.some((batch) => batch.state === "queued" || batch.state === "running");
  const selectedRoomTargetIds = selectedRoom
    ? (roomTargetSelections[selectedRoom.room.id] ?? selectedRoom.members.map((member) => member.botId))
        .filter((botId) => selectedRoom.members.some((member) => member.botId === botId))
    : [];

  return (
    <div className="app-shell">
      <Sidebar
        bots={bots}
        rooms={rooms}
        selectedBotId={selectedBot?.id ?? null}
        selectedRoomId={selectedRoom?.room.id ?? null}
        busy={loading}
        mobileOpen={mobilePanel === "bots"}
        createButtonRef={newBotButtonRef}
        onCreate={() => {
          if (chooserActionRef.current) return;
          setCreateError(null);
          setMobilePanel(null);
          setNewBotOpen(true);
        }}
        onMobileClose={() => setMobilePanel(null)}
        onSelectBot={(bot) => void openBot(bot)}
        onSelectRoom={(room) => void openRoom(room)}
        onRestoreRoom={(room) => {
          void flushActive().then(async (saved) => {
            if (!saved) return;
            const result = await window.msBot.rooms.archive({ id: room.id, archived: false });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setRooms((current) => current.map((item) => item.id === room.id ? result.data : item));
            void openRoom(result.data, false);
          });
        }}
      />
      <Conversation
        key={selectedBot?.id ?? selectedRoom?.room.id ?? "empty"}
        bot={selectedBot}
        room={selectedRoom}
        roomBatches={roomBatches}
        roomTurns={roomTurns}
        roomTargetBotIds={selectedRoomTargetIds}
        entries={entries}
        runs={runs}
        liveState={liveState}
        loading={loading}
        submitting={submitting}
        error={error}
        closeNotice={closeNotice}
        onOpenBots={() => setMobilePanel("bots")}
        onOpenProfile={() => setMobilePanel("profile")}
        onOpenSettings={() => setSettingsOpen(true)}
        onSend={sendMessage}
        onRetryMessage={(clientNonce) => {
          setSubmitting(true);
          void window.msBot.messages.retry(clientNonce).then((result) => {
            setSubmitting(false);
            if (!result.ok) setError(result.error);
          });
        }}
        onRetryRun={(runId) => {
          setSubmitting(true);
          void window.msBot.runtime.retry(runId).then((result) => {
            setSubmitting(false);
            if (!result.ok) setError(result.error);
          });
        }}
        onCancelRun={(runId) => void window.msBot.runtime.cancel(runId).then((result) => { if (!result.ok) setError(result.error); })}
        onCancelRoomBatch={(batchId) => void window.msBot.roomRuntime.cancel(batchId).then((result) => { if (!result.ok) setError(result.error); })}
        onRetryRoomTurn={(turnId) => void window.msBot.roomRuntime.retryTurn(turnId).then((result) => { if (!result.ok) setError(result.error); })}
        onContinueRoomBatch={(batchId) => void window.msBot.roomRuntime.continue(batchId).then((result) => { if (!result.ok) setError(result.error); })}
        onOpenSpeaker={(botId) => {
          const bot = bots.find((item) => item.id === botId);
          if (bot) void openBot(bot);
        }}
        onRoomTargetBotIdsChange={(botIds) => {
          if (!selectedRoom) return;
          setRoomTargetSelections((current) => ({ ...current, [selectedRoom.room.id]: botIds }));
        }}
      />
      {selectedRoom ? (
        <RoomInspector
          key={`room-inspector:${selectedRoom.room.id}`}
          ref={roomRef}
          detail={selectedRoom}
          bots={bots}
          active={activeRoomBatch}
          mobileOpen={mobilePanel === "profile"}
          onDetailUpdated={updateRoom}
          onArchived={handleArchived}
          onError={setError}
          onOpenBot={(bot) => void openBot(bot)}
          onMobileClose={() => void closeMobilePanel()}
        />
      ) : (
        <ProfileInspector
          ref={profileRef}
          bot={selectedBot}
          mobileOpen={mobilePanel === "profile"}
          onBotUpdated={updateBot}
          onError={setError}
          onMobileClose={() => void closeMobilePanel()}
        />
      )}
      {mobilePanel ? <button className="drawer-backdrop" type="button" aria-label="关闭侧边面板" onClick={() => void closeMobilePanel()} /> : null}
      <ModelSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {newBotOpen ? (
        <NewBotChooser
          bots={bots}
          creating={creatingBot}
          error={createError}
          onClose={() => {
            setCreateError(null);
            setNewBotOpen(false);
            requestAnimationFrame(() => newBotButtonRef.current?.focus());
          }}
          onCreate={() => void createBot()}
          onCreateRoom={(botIds) => void createRoom(botIds)}
          onSelect={(bot) => {
            if (chooserActionRef.current) return;
            chooserActionRef.current = "select";
            setNewBotOpen(false);
            void openBot(bot).finally(() => { chooserActionRef.current = null; });
          }}
        />
      ) : null}
    </div>
  );
}
