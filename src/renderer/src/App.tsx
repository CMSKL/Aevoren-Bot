import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppearanceTheme,
  AppError,
  ApprovalRequest,
  AttachmentDraft,
  Bot,
  BriefApprovalCommand,
  ConversationBatchDeleteInput,
  LoginItemStatus,
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
  ToolEvent,
  ToolInvocation,
  TranscriptEntry,
  TranscriptEvent,
  UpdateCheckIntervalMinutes,
  UpdateState,
  Workspace,
} from "@shared/contracts";
import { Conversation } from "./components/Conversation";
import { SettingsDialog } from "./components/SettingsDialog";
import { NewBotChooser } from "./components/NewBotChooser";
import { ProfileInspector, type ProfileInspectorHandle } from "./components/ProfileInspector";
import { RoomInspector, type RoomInspectorHandle } from "./components/RoomInspector";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceDialog } from "./components/WorkspaceDialog";
import { UpdateStatusNotice } from "./components/UpdateStatusNotice";
import { mergeBufferedEvents, mergeRuntimeRun, mergeTranscriptEntry } from "./runtime-state";
import { mergeRoomRuntimeEvents } from "./room-runtime-state";

function mergeToolInvocation(current: ToolInvocation[], next: ToolInvocation): ToolInvocation[] {
  const existing = current.find((item) => item.id === next.id);
  if (existing && existing.version >= next.version) return current;
  return [...current.filter((item) => item.id !== next.id), next]
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function mergePendingApproval(current: ApprovalRequest[], next: ApprovalRequest): ApprovalRequest[] {
  const without = current.filter((item) => item.id !== next.id);
  return next.state === "pending" ? [...without, next] : without;
}

function mergeToolEvents(
  invocations: ToolInvocation[],
  approvals: ApprovalRequest[],
  events: readonly ToolEvent[],
): { invocations: ToolInvocation[]; approvals: ApprovalRequest[] } {
  return events.reduce((current, event) => ({
    invocations: mergeToolInvocation(current.invocations, event.invocation),
    approvals: mergePendingApproval(current.approvals, event.approval),
  }), { invocations, approvals });
}

export function App(): React.JSX.Element {
  const [bots, setBots] = useState<Bot[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<RoomDetail | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [runs, setRuns] = useState<RuntimeRun[]>([]);
  const [toolInvocations, setToolInvocations] = useState<ToolInvocation[]>([]);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
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
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [workspaceAddPending, setWorkspaceAddPending] = useState(false);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"bots" | "profile" | null>(null);
  const [creatingBot, setCreatingBot] = useState(false);
  const [createError, setCreateError] = useState<AppError | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [appearanceTheme, setAppearanceTheme] = useState<AppearanceTheme>("system");
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [launchAtLoginSupported, setLaunchAtLoginSupported] = useState(false);
  const [launchAtLoginStatus, setLaunchAtLoginStatus] = useState<LoginItemStatus>("unsupported");
  const [autoApprovePublicReadTools, setAutoApprovePublicReadTools] = useState(false);
  const [updateCheckIntervalMinutes, setUpdateCheckIntervalMinutes] = useState<UpdateCheckIntervalMinutes>(360);
  const newBotButtonRef = useRef<HTMLButtonElement>(null);
  const profileRef = useRef<ProfileInspectorHandle>(null);
  const roomRef = useRef<RoomInspectorHandle>(null);
  const sessionIdRef = useRef<string | null>(null);
  const selectedRoomIdRef = useRef<string | null>(null);
  const loadingSessionIdRef = useRef<string | null>(null);
  const bufferedTranscriptRef = useRef<TranscriptEvent[]>([]);
  const bufferedRuntimeRef = useRef<RuntimeEvent[]>([]);
  const bufferedRoomRef = useRef<RoomRuntimeEvent[]>([]);
  const bufferedToolRef = useRef<ToolEvent[]>([]);
  const runtimeVersionsRef = useRef(new Map<string, number>());
  const openRequestRef = useRef(0);
  const chooserActionRef = useRef<"create" | "select" | null>(null);

  const flushActive = useCallback(async (): Promise<boolean> => {
    if (selectedRoomIdRef.current) return await roomRef.current?.flush() ?? true;
    return await profileRef.current?.flush() ?? true;
  }, []);
  const closeSettings = useCallback((): void => setSettingsOpen(false), []);

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
    const unsubscribeTool = window.aevorenBot.events.subscribeTool((event) => {
      if (event.sessionId === loadingSessionIdRef.current) {
        bufferedToolRef.current.push(event);
        return;
      }
      if (event.sessionId !== sessionIdRef.current) return;
      setToolInvocations((current) => mergeToolInvocation(current, event.invocation));
      setApprovalRequests((current) => mergePendingApproval(current, event.approval));
    });
    const unsubscribeUpdate = window.aevorenBot.events.subscribeUpdate((event) => setUpdateState(event.state));
    const unsubscribeClose = window.aevorenBot.app.subscribeBeforeClose(() => {
      void flushActive().then((saved) => window.aevorenBot.app.confirmClose(saved));
    });
    const unsubscribeCloseBlocked = window.aevorenBot.app.subscribeCloseBlocked(() => {
      setCloseNotice("关闭未完成：资料仍保留在当前窗口，请稍后重试关闭。");
    });
    window.aevorenBot.app.ready();
    void window.aevorenBot.updates.getState().then((result) => {
      if (result.ok) setUpdateState(result.data);
    });
    void window.aevorenBot.settings.getGeneral().then((result) => {
      if (result.ok) {
        setAppearanceTheme(result.data.theme);
        setLaunchAtLogin(result.data.launchAtLogin);
        setLaunchAtLoginSupported(result.data.launchAtLoginSupported);
        setLaunchAtLoginStatus(result.data.launchAtLoginStatus);
        setAutoApprovePublicReadTools(result.data.autoApprovePublicReadTools);
        setUpdateCheckIntervalMinutes(result.data.updateCheckIntervalMinutes);
      }
    });
    return () => {
      unsubscribeTranscript();
      unsubscribeSend();
      unsubscribeRuntime();
      unsubscribeRoom();
      unsubscribeTool();
      unsubscribeUpdate();
      unsubscribeClose();
      unsubscribeCloseBlocked();
    };
  }, [flushActive]);

  useEffect(() => {
    let active = true;
    const refreshWorkspaces = (): void => {
      void window.aevorenBot.workspaces.list().then((result) => {
        if (active && result.ok) setWorkspaces(result.data);
      });
    };
    refreshWorkspaces();
    window.addEventListener("aevoren:workspaces-changed", refreshWorkspaces);
    return () => {
      active = false;
      window.removeEventListener("aevoren:workspaces-changed", refreshWorkspaces);
    };
  }, []);

  useEffect(() => {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = (): void => {
      document.documentElement.dataset.theme = appearanceTheme === "system"
        ? systemTheme.matches ? "dark" : "light"
        : appearanceTheme;
    };
    applyTheme();
    if (appearanceTheme !== "system") return;
    systemTheme.addEventListener("change", applyTheme);
    return () => systemTheme.removeEventListener("change", applyTheme);
  }, [appearanceTheme]);

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
    bufferedToolRef.current = [];
    const [snapshotResult, toolsResult, approvalsResult] = await Promise.all([
      window.aevorenBot.runtime.getSessionSnapshot(nextSession.id),
      window.aevorenBot.tools.list({ sessionId: nextSession.id }),
      window.aevorenBot.approvals.listPending({ sessionId: nextSession.id }),
    ]);
    if (requestId !== openRequestRef.current) return;
    if (!snapshotResult.ok) {
      loadingSessionIdRef.current = null;
      setError(snapshotResult.error);
      setLoading(false);
      return;
    }
    if (!toolsResult.ok) {
      loadingSessionIdRef.current = null;
      setError(toolsResult.error);
      setLoading(false);
      return;
    }
    if (!approvalsResult.ok) {
      loadingSessionIdRef.current = null;
      setError(approvalsResult.error);
      setLoading(false);
      return;
    }
    const buffered = mergeBufferedEvents(
      snapshotResult.data.entries,
      snapshotResult.data.runs,
      bufferedTranscriptRef.current,
      bufferedRuntimeRef.current,
    );
    const toolState = mergeToolEvents(toolsResult.data, approvalsResult.data, bufferedToolRef.current);
    sessionIdRef.current = nextSession.id;
    selectedRoomIdRef.current = null;
    sessionStorage.setItem("aevoren-bot:selected", `bot:${bot.id}`);
    loadingSessionIdRef.current = null;
    setSelectedBot(bot);
    setSelectedRoom(null);
    setSession(nextSession);
    setEntries(buffered.entries);
    setRuns(buffered.runs);
    setToolInvocations(toolState.invocations);
    setApprovalRequests(toolState.approvals);
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
    bufferedToolRef.current = [];
    const [snapshotResult, toolsResult, approvalsResult] = await Promise.all([
      window.aevorenBot.roomRuntime.getSnapshot(room.id),
      window.aevorenBot.tools.list({ sessionId: nextSession.id }),
      window.aevorenBot.approvals.listPending({ sessionId: nextSession.id }),
    ]);
    if (requestId !== openRequestRef.current) return;
    if (!snapshotResult.ok) {
      loadingSessionIdRef.current = null;
      setError(snapshotResult.error);
      setLoading(false);
      return;
    }
    if (!toolsResult.ok) {
      loadingSessionIdRef.current = null;
      setError(toolsResult.error);
      setLoading(false);
      return;
    }
    if (!approvalsResult.ok) {
      loadingSessionIdRef.current = null;
      setError(approvalsResult.error);
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
    const toolState = mergeToolEvents(toolsResult.data, approvalsResult.data, bufferedToolRef.current);
    sessionIdRef.current = nextSession.id;
    selectedRoomIdRef.current = room.id;
    sessionStorage.setItem("aevoren-bot:selected", `room:${room.id}`);
    loadingSessionIdRef.current = null;
    setSelectedBot(null);
    setSelectedRoom(snapshotResult.data.detail);
    setSession(nextSession);
    setEntries(buffered.entries);
    setRuns(buffered.runs);
    setToolInvocations(toolState.invocations);
    setApprovalRequests(toolState.approvals);
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

  const closeInspector = useCallback(async (): Promise<void> => {
    if (window.matchMedia("(max-width: 1180px)").matches) {
      await closeMobilePanel();
      return;
    }
    if (await flushActive()) setInspectorCollapsed(true);
  }, [closeMobilePanel, flushActive]);

  const toggleInspector = useCallback(async (): Promise<void> => {
    if (!(await flushActive())) return;
    setInspectorCollapsed((current) => !current);
  }, [flushActive]);

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

  async function createContentTeam(): Promise<void> {
    if (chooserActionRef.current) return;
    chooserActionRef.current = "create";
    setCreatingBot(true);
    try {
      if (!(await flushActive())) return;
      setCreateError(null);
      const result = await window.aevorenBot.teams.createContentTeam();
      if (!result.ok) {
        setCreateError(result.error);
        return;
      }
      setBots((current) => {
        const next = new Map(current.map((bot) => [bot.id, bot]));
        result.data.bots.forEach((bot) => next.set(bot.id, bot));
        return [...next.values()];
      });
      setRooms((current) => {
        const next = new Map(current.map((room) => [room.id, room]));
        next.set(result.data.room.room.id, result.data.room.room);
        return [...next.values()];
      });
      setNewBotOpen(false);
      await openRoom(result.data.room.room, false);
    } finally {
      chooserActionRef.current = null;
      setCreatingBot(false);
    }
  }

  function updateBot(bot: Bot): void {
    setBots((current) => current.map((item) => item.id === bot.id ? bot : item));
    setSelectedBot((current) => current?.id === bot.id ? bot : current);
    setSelectedRoom((current) => current && current.members.some((member) => member.botId === bot.id)
      ? {
          ...current,
          members: current.members.map((member) => member.botId === bot.id ? { ...member, bot } : member),
        }
      : current);
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
    setToolInvocations([]);
    setApprovalRequests([]);
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
    const nextRoom = nextRooms.find((room) => room.archivedAt === null && room.hiddenAt === null);
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

  function updateRoomRecord(room: Room): void {
    setRooms((current) => current.map((item) => item.id === room.id ? room : item));
    setSelectedRoom((current) => current?.room.id === room.id ? { ...current, room } : current);
  }

  async function renameRoom(room: Room, name: string): Promise<boolean> {
    if (selectedRoom?.room.id === room.id && !(await flushActive())) return false;
    const latest = await window.aevorenBot.rooms.get(room.id);
    if (!latest.ok) {
      setError(latest.error);
      return false;
    }
    const result = await window.aevorenBot.rooms.update({
      id: room.id,
      expectedVersion: latest.data.room.version,
      patch: { name },
    });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    updateRoomRecord(result.data);
    return true;
  }

  async function copyRoomId(room: Room): Promise<boolean> {
    const result = await window.aevorenBot.rooms.copyConversationId(room.id);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    return true;
  }

  async function setRoomPinned(room: Room, pinned: boolean): Promise<boolean> {
    const result = await window.aevorenBot.rooms.setPinned({ id: room.id, pinned });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    updateRoomRecord(result.data);
    return true;
  }

  async function setRoomUnread(room: Room, unread: boolean): Promise<boolean> {
    const result = await window.aevorenBot.rooms.setUnread({ id: room.id, unread });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    updateRoomRecord(result.data);
    return true;
  }

  async function setRoomHidden(room: Room, hidden: boolean): Promise<boolean> {
    if (selectedRoom?.room.id === room.id && !(await flushActive())) return false;
    const result = await window.aevorenBot.rooms.setHidden({ id: room.id, hidden });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    const nextRooms = rooms.map((item) => item.id === room.id ? result.data : item);
    updateRoomRecord(result.data);
    if (hidden && selectedRoom?.room.id === room.id) await openFallback(bots, nextRooms);
    return true;
  }

  async function archiveRoom(room: Room): Promise<boolean> {
    if (selectedRoom?.room.id === room.id && !(await flushActive())) return false;
    const result = await window.aevorenBot.rooms.archive({ id: room.id, archived: true });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    updateRoomRecord(result.data);
    if (selectedRoom?.room.id === room.id) handleArchived(result.data);
    return true;
  }

  async function deleteRoom(room: Room): Promise<boolean> {
    if (selectedRoom?.room.id === room.id && !(await flushActive())) return false;
    const result = await window.aevorenBot.rooms.delete(room.id);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    const nextRooms = rooms.filter((item) => item.id !== room.id);
    setRooms(nextRooms);
    if (selectedRoom?.room.id === room.id) await openFallback(bots, nextRooms);
    return true;
  }

  async function deleteConversations(input: ConversationBatchDeleteInput): Promise<boolean> {
    if (!(await flushActive())) return false;
    const result = await window.aevorenBot.conversations.deleteBatch(input);
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

    const currentRoomId = selectedRoom?.room.id ?? null;
    const currentRoomAffected = currentRoomId !== null && result.data.bots.some(
      (bot) => bot.affectedRoomIds.includes(currentRoomId),
    );
    if (currentRoomId && (input.roomIds.includes(currentRoomId) || currentRoomAffected)) {
      const currentRoom = roomResult.data.find((room) => room.id === currentRoomId && room.archivedAt === null);
      if (currentRoom) await openRoom(currentRoom, false);
      else await openFallback(botResult.data, roomResult.data);
    } else if (selectedBot && input.botIds.includes(selectedBot.id)) {
      await openFallback(botResult.data, roomResult.data);
    }
    return true;
  }

  async function sendMessage(text: string, targetBotIds?: string[], routingMode?: "automatic" | "explicit" | "everyone", attachments: AttachmentDraft[] = []): Promise<boolean> {
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
          attachments,
          targetBotIds: targetBotIds ?? [],
          routingMode: routingMode ?? "automatic",
        })
      : await window.aevorenBot.messages.send({ sessionId: session.id, clientNonce, text, attachments });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    return true;
  }

  async function approveBrief(command: BriefApprovalCommand): Promise<boolean> {
    if (submitting || selectedRoom?.room.id !== command.roomId) return false;
    setSubmitting(true);
    setError(null);
    try {
      const result = await window.aevorenBot.rooms.approveBrief(command);
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      return true;
    } catch {
      setError({ domain: "runtime", code: "BRIEF_APPROVAL_FAILED", retryable: true, safeMessage: "批准未能提交，请稍后重试。" });
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function addWorkspace(): Promise<{ workspace: Workspace } | { error: AppError } | null> {
    setWorkspaceAddPending(true);
    try {
      const result = await window.aevorenBot.workspaces.add();
      if (!result.ok) return { error: result.error };
      if (!result.data) return null;
      const workspace = result.data.workspace;
      setWorkspaces((current) => {
        const withoutCurrent = current.filter((item) => item.id !== workspace.id);
        return [...withoutCurrent, workspace].toSorted((left, right) => (
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
        ));
      });
      window.dispatchEvent(new Event("aevoren:workspaces-changed"));
      return { workspace };
    } finally {
      setWorkspaceAddPending(false);
    }
  }

  function handleArchived(room: Room): void {
    setRooms((current) => current.map((item) => item.id === room.id ? room : item));
    selectedRoomIdRef.current = null;
    const visibleBot = bots.find((bot) => bot.hiddenAt === null);
    if (visibleBot) void openBot(visibleBot, false);
    else clearSelection();
  }

  const activeRoomBatch = roomBatches.some((batch) => batch.state === "queued" || batch.state === "running");
  const activeDirectRun = liveState !== null && ["starting", "running", "composing", "retrying", "cancelling"].includes(liveState.state);
  const updateRestartBlocked = submitting || activeRoomBatch || activeDirectRun;

  return (
    <div className={`app-shell${inspectorCollapsed ? " inspector-collapsed" : ""}`}>
      <Sidebar
        bots={bots}
        rooms={rooms}
        workspaces={workspaces}
        selectedBotId={selectedBot?.id ?? null}
        selectedRoomId={selectedRoom?.room.id ?? null}
        busy={loading}
        workspaceAddPending={workspaceAddPending}
        mobileOpen={mobilePanel === "bots"}
        createButtonRef={newBotButtonRef}
        onAddWorkspace={addWorkspace}
        onOpenWorkspaces={() => setWorkspacesOpen(true)}
        onCreate={() => {
          if (chooserActionRef.current) return;
          setCreateError(null);
          setMobilePanel(null);
          setNewBotOpen(true);
        }}
        onOpenSettings={() => {
          setMobilePanel(null);
          setSettingsOpen(true);
        }}
        onMobileClose={() => setMobilePanel(null)}
        onSelectBot={(bot) => void openBot(bot)}
        onSelectRoom={(room) => void openRoom(room)}
        onRenameRoom={renameRoom}
        onCopyRoomId={copyRoomId}
        onArchiveRoom={archiveRoom}
        onPinRoom={setRoomPinned}
        onMarkRoomUnread={setRoomUnread}
        onHideRoom={setRoomHidden}
        onDeleteRoom={deleteRoom}
        onDeleteBatch={deleteConversations}
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
        toolInvocations={toolInvocations}
        approvalRequests={approvalRequests}
        liveState={liveState}
        loading={loading}
        submitting={submitting}
        error={error}
        closeNotice={closeNotice}
        onOpenBots={() => setMobilePanel("bots")}
        onOpenProfile={() => setMobilePanel("profile")}
        inspectorCollapsed={inspectorCollapsed}
        onToggleInspector={() => void toggleInspector()}
        onOpenWorkspaces={() => setWorkspacesOpen(true)}
        onPickAttachments={async () => {
          const result = await window.aevorenBot.attachments.pick();
          if (!result.ok) {
            setError(result.error);
            return [];
          }
          return result.data;
        }}
        onRevealWorkspaceArtifact={async (workspaceId, path) => {
          const result = await window.aevorenBot.workspaces.reveal({ workspaceId, path });
          if (!result.ok) {
            setError(result.error);
            return false;
          }
          return result.data;
        }}
        onBotUpdated={updateBot}
        onError={setError}
        onResolveApproval={async (approval, resolution) => {
          const result = await window.aevorenBot.approvals.resolve({
            sessionId: approval.sessionId,
            id: approval.id,
            expectedVersion: approval.version,
            resolution,
          });
          if (!result.ok) {
            setError(result.error);
            return false;
          }
          setToolInvocations((current) => mergeToolInvocation(current, result.data.invocation));
          setApprovalRequests((current) => mergePendingApproval(current, result.data.approval));
          return true;
        }}
        onSend={sendMessage}
        onApproveBrief={approveBrief}
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
        onRetryRoomTurn={async (turnId) => {
          const result = await window.aevorenBot.roomRuntime.retryTurn(turnId);
          if (!result.ok) {
            setError(result.error);
            return false;
          }
          setRoomTurns((current) => [...current.filter((turn) => turn.id !== result.data.id), result.data]
            .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
          const roomId = selectedRoomIdRef.current;
          if (roomId) {
            void (async () => {
              for (let attempt = 0; attempt < 120; attempt += 1) {
                if (selectedRoomIdRef.current !== roomId) return;
                let snapshot: Awaited<ReturnType<typeof window.aevorenBot.roomRuntime.getSnapshot>>;
                try {
                  snapshot = await window.aevorenBot.roomRuntime.getSnapshot(roomId);
                } catch {
                  return;
                }
                if (!snapshot.ok) return;
                setRoomBatches(snapshot.data.batches);
                setRoomTurns(snapshot.data.turns);
                setRoomHandoffs(snapshot.data.handoffs);
                setRoomHandoffRejections(snapshot.data.rejections);
                const retried = snapshot.data.turns.find((turn) => turn.id === result.data.id);
                if (retried && ["completed", "failed", "cancelled", "interrupted"].includes(retried.state)) return;
                await new Promise((resolve) => setTimeout(resolve, 250));
              }
            })();
          }
          return true;
        }}
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
          id="conversation-inspector"
          detail={selectedRoom}
          bots={bots}
          active={activeRoomBatch}
          mobileOpen={mobilePanel === "profile"}
          onDetailUpdated={updateRoom}
          onArchived={handleArchived}
          onError={setError}
          onOpenBot={(bot) => void openBot(bot)}
          onMobileClose={() => void closeInspector()}
        />
      ) : (
        <ProfileInspector
          ref={profileRef}
          id="conversation-inspector"
          bot={selectedBot}
          mobileOpen={mobilePanel === "profile"}
          onBotUpdated={updateBot}
          onError={setError}
          onMobileClose={() => void closeInspector()}
        />
      )}
      {mobilePanel ? <button className="drawer-backdrop" type="button" aria-label="关闭侧边面板" onClick={() => void closeMobilePanel()} /> : null}
      <SettingsDialog
        open={settingsOpen}
        theme={appearanceTheme}
        launchAtLogin={launchAtLogin}
        launchAtLoginSupported={launchAtLoginSupported}
        launchAtLoginStatus={launchAtLoginStatus}
        autoApprovePublicReadTools={autoApprovePublicReadTools}
        updateCheckIntervalMinutes={updateCheckIntervalMinutes}
        updateState={updateState}
        restartBlocked={updateRestartBlocked}
        activeBotId={selectedBot?.id ?? null}
        onClose={closeSettings}
        onThemeChange={async (theme) => {
          const result = await window.aevorenBot.settings.saveGeneral({ theme });
          if (!result.ok) return result.error;
          setAppearanceTheme(result.data.theme);
          return null;
        }}
        onLaunchAtLoginChange={async (enabled) => {
          const result = await window.aevorenBot.settings.saveGeneral({ launchAtLogin: enabled });
          if (!result.ok) return result.error;
          setLaunchAtLogin(result.data.launchAtLogin);
          setLaunchAtLoginSupported(result.data.launchAtLoginSupported);
          setLaunchAtLoginStatus(result.data.launchAtLoginStatus);
          return null;
        }}
        onAutoApprovePublicReadToolsChange={async (enabled) => {
          const result = await window.aevorenBot.settings.saveGeneral({ autoApprovePublicReadTools: enabled });
          if (!result.ok) return result.error;
          setAutoApprovePublicReadTools(result.data.autoApprovePublicReadTools);
          return null;
        }}
        onUpdateCheckIntervalChange={async (minutes) => {
          const result = await window.aevorenBot.settings.saveGeneral({ updateCheckIntervalMinutes: minutes });
          if (!result.ok) return result.error;
          setUpdateCheckIntervalMinutes(result.data.updateCheckIntervalMinutes);
          return null;
        }}
        onCheckUpdate={() => void window.aevorenBot.updates.check().then((result) => {
          if (result.ok) setUpdateState(result.data);
        })}
        onRetryUpdate={() => void window.aevorenBot.updates.retry().then((result) => {
          if (result.ok) setUpdateState(result.data);
        })}
        onInstallUpdate={() => {
          void flushActive().then((saved) => {
            if (!saved) return;
            void window.aevorenBot.updates.installAndRestart().then((result) => {
              if (result.ok) setUpdateState(result.data);
            });
          });
        }}
      />
      <WorkspaceDialog open={workspacesOpen} onClose={() => setWorkspacesOpen(false)} />
      {newBotOpen ? (
        <NewBotChooser
          bots={bots}
          creating={creatingBot}
          error={createError}
          onClose={() => {
            setCreateError(null);
            setNewBotOpen(false);
            requestAnimationFrame(() => {
              if (document.activeElement === document.body) newBotButtonRef.current?.focus();
            });
          }}
          onCreate={() => void createBot()}
          onCreateRoom={(botIds) => void createRoom(botIds)}
          onCreateContentTeam={() => void createContentTeam()}
          onSelect={(bot) => {
            if (chooserActionRef.current) return;
            chooserActionRef.current = "select";
            setNewBotOpen(false);
            void openBot(bot).finally(() => { chooserActionRef.current = null; });
          }}
        />
      ) : null}
      <UpdateStatusNotice
        state={updateState}
        restartBlocked={updateRestartBlocked}
        onRetry={() => void window.aevorenBot.updates.retry().then((result) => {
          if (result.ok) setUpdateState(result.data);
        })}
        onInstall={() => {
          void flushActive().then((saved) => {
            if (!saved) return;
            void window.aevorenBot.updates.installAndRestart().then((result) => {
              if (result.ok) setUpdateState(result.data);
            });
          });
        }}
      />
    </div>
  );
}
