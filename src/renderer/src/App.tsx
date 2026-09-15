import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppError,
  Bot,
  Room,
  RoomBatch,
  RoomDetail,
  RoomHandoffRejectionView,
  RoomHandoffView,
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
import { mergeRoomRuntimeEvents } from "./room-runtime-state";

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
  const [roomHandoffs, setRoomHandoffs] = useState<RoomHandoffView[]>([]);
  const [roomHandoffRejections, setRoomHandoffRejections] = useState<RoomHandoffRejectionView[]>([]);
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
    const unsubscribeTranscript = window.aevorenBot.events.subscribeTranscript((event) => {
      if (event.sessionId === loadingSessionIdRef.current) {
        bufferedTranscriptRef.current.push(event);
        return;
      }
      if (event.sessionId === sessionIdRef.current) setEntries((current) => mergeTranscriptEntry(current, event.entry));
    });
    const unsubscribeSend = window.aevorenBot.events.subscribeSendState((event) => {
      if (event.sessionId === sessionIdRef.current && event.error) setError(event.error);
    });
    const unsubscribeRuntime = window.aevorenBot.events.subscribeRuntime((event) => {
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
    const unsubscribeRoom = window.aevorenBot.events.subscribeRoomRuntime((event) => {
      if (event.sessionId === loadingSessionIdRef.current) {
        bufferedRoomRef.current.push(event);
        return;
      }
      if (event.roomId !== selectedRoomIdRef.current) return;
      setRoomBatches((current) => mergeRoomRuntimeEvents(current, [], [], [], [event]).batches);
      setRoomTurns((current) => mergeRoomRuntimeEvents([], current, [], [], [event]).turns);
      setRoomHandoffs((current) => mergeRoomRuntimeEvents([], [], current, [], [event]).handoffs);
      setRoomHandoffRejections((current) => mergeRoomRuntimeEvents([], [], [], current, [event]).rejections);
      if (event.error) setError(event.error);
    });
    const unsubscribeClose = window.aevorenBot.app.subscribeBeforeClose(() => {
      void flushActive().then((saved) => window.aevorenBot.app.confirmClose(saved));
    });
    const unsubscribeCloseBlocked = window.aevorenBot.app.subscribeCloseBlocked(() => {
      setCloseNotice("关闭未完成：资料仍保留在当前窗口，请稍后重试关闭。");
    });
    window.aevorenBot.app.ready();
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
    const sessionResult = await window.aevorenBot.sessions.getMain(bot.id);
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
    const snapshotResult = await window.aevorenBot.runtime.getSessionSnapshot(nextSession.id);
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
    sessionStorage.setItem("aevoren-bot:selected", `bot:${bot.id}`);
    loadingSessionIdRef.current = null;
    setSelectedBot(bot);
    setSelectedRoom(null);
    setSession(nextSession);
    setEntries(buffered.entries);
    setRuns(buffered.runs);
    setRoomBatches([]);
    setRoomTurns([]);
    setRoomHandoffs([]);
    setRoomHandoffRejections([]);
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
    const detailResult = await window.aevorenBot.rooms.get(room.id);
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
    const snapshotResult = await window.aevorenBot.roomRuntime.getSnapshot(room.id);
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
    const roomState = mergeRoomRuntimeEvents(
      snapshotResult.data.batches,
      snapshotResult.data.turns,
      snapshotResult.data.handoffs,
      snapshotResult.data.rejections ?? [],
      bufferedRoomRef.current,
    );
    sessionIdRef.current = nextSession.id;
    selectedRoomIdRef.current = room.id;
    sessionStorage.setItem("aevoren-bot:selected", `room:${room.id}`);
    loadingSessionIdRef.current = null;
    setSelectedBot(null);
    setSelectedRoom(snapshotResult.data.detail);
    setSession(nextSession);
    setEntries(buffered.entries);
    setRuns(buffered.runs);
    setRoomBatches(roomState.batches);
    setRoomTurns(roomState.turns);
    setRoomHandoffs(roomState.handoffs);
    setRoomHandoffRejections(roomState.rejections);
    runtimeVersionsRef.current = new Map(buffered.runs.map((run) => [run.id, run.version]));
    setLiveState(buffered.lastRuntimeEvent?.liveState ?? snapshotResult.data.liveState);
    setNewBotOpen(false);
    setCreateError(null);
    setMobilePanel(null);
    setLoading(false);
  }, [flushActive]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.aevorenBot.bots.list(), window.aevorenBot.rooms.list({ includeArchived: true })]).then(async ([botResult, roomResult]) => {
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
      const selected = sessionStorage.getItem("aevoren-bot:selected");
      const selectedRoom = selected?.startsWith("room:")
        ? roomResult.data.find((room) => room.id === selected.slice(5) && room.archivedAt === null)
        : undefined;
      const selectedBot = selected?.startsWith("bot:")
        ? botResult.data.find((bot) => bot.id === selected.slice(4) && bot.hiddenAt === null)
        : undefined;
      const firstVisibleBot = botResult.data.find((bot) => bot.hiddenAt === null);
      if (selectedRoom) await openRoom(selectedRoom, false);
      else if (selectedBot) await openBot(selectedBot, false);
      else if (firstVisibleBot) await openBot(firstVisibleBot, false);
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
      const result = await window.aevorenBot.bots.create();
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
      const result = await window.aevorenBot.rooms.create({ memberBotIds });
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

  async function setBotPinned(bot: Bot, pinned: boolean): Promise<boolean> {
    const result = await window.aevorenBot.bots.setPinned({ id: bot.id, pinned });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    updateBot(result.data);
    return true;
  }

  async function setBotUnread(bot: Bot, unread: boolean): Promise<boolean> {
    const result = await window.aevorenBot.bots.setUnread({ id: bot.id, unread });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    updateBot(result.data);
    return true;
  }

  async function renameBot(bot: Bot, name: string): Promise<boolean> {
    if (selectedBot?.id === bot.id && !(await flushActive())) return false;
    const latest = await window.aevorenBot.bots.list();
    if (!latest.ok) {
      setError(latest.error);
      return false;
    }
    const current = latest.data.find((item) => item.id === bot.id);
    if (!current) return false;
    const result = await window.aevorenBot.bots.update({ id: bot.id, expectedVersion: current.version, patch: { name } });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    updateBot(result.data);
    return true;
  }

  async function editBot(bot: Bot): Promise<void> {
    await openBot(bot);
    if (sessionStorage.getItem("aevoren-bot:selected") !== `bot:${bot.id}`) return;
    setMobilePanel("profile");
    window.setTimeout(() => {
      if (sessionStorage.getItem("aevoren-bot:selected") !== `bot:${bot.id}` || document.activeElement !== document.body) return;
      profileRef.current?.focusName();
    }, 200);
  }

  async function duplicateBot(bot: Bot): Promise<boolean> {
    if (selectedBot?.id === bot.id && !(await flushActive())) return false;
    const result = await window.aevorenBot.bots.duplicate(bot.id);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setBots((current) => [...current, result.data.bot]);
    await openBot(result.data.bot, false);
    return true;
  }

  async function copyBotId(bot: Bot): Promise<boolean> {
    const result = await window.aevorenBot.bots.copyConversationId(bot.id);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    return true;
  }

  async function setBotHidden(bot: Bot, hidden: boolean): Promise<boolean> {
    if (selectedBot?.id === bot.id && !(await flushActive())) return false;
    const result = await window.aevorenBot.bots.setHidden({ id: bot.id, hidden });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    updateBot(result.data);
    return true;
  }

  function clearSelection(): void {
    sessionIdRef.current = null;
    selectedRoomIdRef.current = null;
    sessionStorage.removeItem("aevoren-bot:selected");
    setSelectedBot(null);
    setSelectedRoom(null);
    setSession(null);
    setEntries([]);
    setRuns([]);
    setRoomBatches([]);
    setRoomTurns([]);
    setRoomHandoffs([]);
    setRoomHandoffRejections([]);
    setLiveState(null);
  }

  async function openFallback(nextBots: Bot[], nextRooms: Room[]): Promise<void> {
    const nextBot = nextBots.find((bot) => bot.hiddenAt === null);
    if (nextBot) {
      await openBot(nextBot, false);
      return;
    }
    const nextRoom = nextRooms.find((room) => room.archivedAt === null);
    if (nextRoom) {
      await openRoom(nextRoom, false);
      return;
    }
    clearSelection();
  }

  async function deleteBot(bot: Bot): Promise<boolean> {
    if (!(await flushActive())) return false;
    const result = await window.aevorenBot.bots.delete(bot.id);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    const [botResult, roomResult] = await Promise.all([
      window.aevorenBot.bots.list(),
      window.aevorenBot.rooms.list({ includeArchived: true }),
    ]);
    if (!botResult.ok) {
      setError(botResult.error);
      return false;
    }
    if (!roomResult.ok) {
      setError(roomResult.error);
      return false;
    }
    setBots(botResult.data);
    setRooms(roomResult.data);
    if (selectedRoom && result.data.affectedRoomIds.includes(selectedRoom.room.id)) {
      const currentRoom = roomResult.data.find((room) => room.id === selectedRoom.room.id && room.archivedAt === null);
      if (currentRoom) await openRoom(currentRoom, false);
      else await openFallback(botResult.data, roomResult.data);
    } else if (selectedBot?.id === bot.id) {
      await openFallback(botResult.data, roomResult.data);
    }
    return true;
  }

  function updateRoom(detail: RoomDetail): void {
    setSelectedRoom(detail);
    setRooms((current) => current.map((item) => item.id === detail.room.id ? detail.room : item));
  }

  async function sendMessage(text: string, targetBotIds?: string[], routingMode?: "automatic" | "explicit" | "everyone"): Promise<boolean> {
    if (!session || submitting) return false;
    setSubmitting(true);
    setError(null);
    setCloseNotice(null);
    const clientNonce = crypto.randomUUID();
    const result = selectedRoom
      ? await window.aevorenBot.roomRuntime.send({
          roomId: selectedRoom.room.id,
          sessionId: session.id,
          clientNonce,
          text,
          targetBotIds: targetBotIds ?? [],
          routingMode: routingMode ?? "automatic",
        })
      : await window.aevorenBot.messages.send({ sessionId: session.id, clientNonce, text });
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
    const visibleBot = bots.find((bot) => bot.hiddenAt === null);
    if (visibleBot) void openBot(visibleBot, false);
    else clearSelection();
  }

  const activeRoomBatch = roomBatches.some((batch) => batch.state === "queued" || batch.state === "running");

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
        onPinBot={setBotPinned}
        onMarkBotUnread={setBotUnread}
        onRenameBot={renameBot}
        onEditBot={(bot) => void editBot(bot)}
        onDuplicateBot={duplicateBot}
        onCopyBotId={copyBotId}
        onHideBot={setBotHidden}
        onDeleteBot={deleteBot}
        onRestoreRoom={(room) => {
          void flushActive().then(async (saved) => {
            if (!saved) return;
            const result = await window.aevorenBot.rooms.archive({ id: room.id, archived: false });
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
        roomHandoffs={roomHandoffs}
        roomHandoffRejections={roomHandoffRejections}
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
          void window.aevorenBot.messages.retry(clientNonce).then((result) => {
            setSubmitting(false);
            if (!result.ok) setError(result.error);
          });
        }}
        onRetryRun={(runId) => {
          setSubmitting(true);
          void window.aevorenBot.runtime.retry(runId).then((result) => {
            setSubmitting(false);
            if (!result.ok) setError(result.error);
          });
        }}
        onCancelRun={(runId) => void window.aevorenBot.runtime.cancel(runId).then((result) => { if (!result.ok) setError(result.error); })}
        onCancelRoomBatch={(batchId) => void window.aevorenBot.roomRuntime.cancel(batchId).then((result) => { if (!result.ok) setError(result.error); })}
        onRetryRoomTurn={(turnId) => void window.aevorenBot.roomRuntime.retryTurn(turnId).then((result) => { if (!result.ok) setError(result.error); })}
        onContinueRoomBatch={(batchId) => void window.aevorenBot.roomRuntime.continue(batchId).then((result) => { if (!result.ok) setError(result.error); })}
        onOpenSpeaker={(botId) => {
          const bot = bots.find((item) => item.id === botId);
          if (bot) void openBot(bot);
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
