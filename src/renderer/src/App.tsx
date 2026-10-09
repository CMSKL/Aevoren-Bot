import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PROJECT_ID } from "@shared/contracts";
import { isPublicReadTool } from "@shared/tool-automation";
import type {
  AppearanceTheme,
  AppError,
  ApprovalRequest,
  ApprovalResolution,
  AttachmentDraft,
  Bot,
  BriefApprovalCommand,
  ConversationBatchDeleteInput,
  ConversationSummary,
  LoginItemStatus,
  Project,
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
import { ContactDetail } from "./components/ContactDetail";
import { SettingsDialog } from "./components/SettingsDialog";
import { NewBotChooser } from "./components/NewBotChooser";
import { ProfileInspector, type ProfileInspectorHandle } from "./components/ProfileInspector";
import { RoomInspector, type RoomInspectorHandle } from "./components/RoomInspector";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceDialog } from "./components/WorkspaceDialog";
import { UpdateStatusNotice } from "./components/UpdateStatusNotice";
import { mergeBufferedEvents, mergeRuntimeRun, mergeTranscriptEntry } from "./runtime-state";
import { mergeRoomRuntimeEvents } from "./room-runtime-state";
import { updateActionErrorMessage, type UpdateAction } from "./update-actions";

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
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [sidebarTab, setSidebarTab] = useState<"chats" | "contacts" | "workspace">("chats");
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [clearTarget, setClearTarget] = useState<ConversationSummary | null>(null);
  const [clearingConversation, setClearingConversation] = useState(false);
  const [projectChanging, setProjectChanging] = useState(false);
  const [projectChangeError, setProjectChangeError] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState(DEFAULT_PROJECT_ID);
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
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [managedWorkspaceId, setManagedWorkspaceId] = useState<string | null>(null);
  const [workspaceAddPending, setWorkspaceAddPending] = useState(false);
  const [workspaceAddError, setWorkspaceAddError] = useState<string | null>(null);
  const workspaceAddInFlightRef = useRef(false);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [creationProjectId, setCreationProjectId] = useState<string | undefined>(undefined);
  const [creationMode, setCreationMode] = useState<"chat" | "room">("chat");
  const [mobilePanel, setMobilePanel] = useState<"bots" | "profile" | null>(null);
  const [creatingBot, setCreatingBot] = useState(false);
  const [createError, setCreateError] = useState<AppError | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateActionPending, setUpdateActionPending] = useState<UpdateAction | null>(null);
  const [updateActionError, setUpdateActionError] = useState<string | null>(null);
  const updateActionInFlightRef = useRef(false);
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
  const conversationRefreshRef = useRef(0);
  const sidebarTabRef = useRef(sidebarTab);
  useEffect(() => { sidebarTabRef.current = sidebarTab; }, [sidebarTab]);

  const mergeConversation = useCallback((next: ConversationSummary): void => {
    setConversations((current) => {
      const existing = current.find((item) => item.sessionId === next.sessionId);
      if (existing && existing.version > next.version) return current;
      return [...current.filter((item) => item.sessionId !== next.sessionId), next];
    });
  }, []);

  const refreshConversations = useCallback(async (): Promise<void> => {
    const request = ++conversationRefreshRef.current;
    const result = await window.aevorenBot.conversations.list();
    if (request !== conversationRefreshRef.current) return;
    if (!result.ok) { setError(result.error); return; }
    setConversations((current) => result.data.map((next) => {
      const existing = current.find((item) => item.sessionId === next.sessionId);
      return existing && existing.version > next.version ? existing : next;
    }));
  }, []);

  const activateConversation = useCallback(async (sessionId: string): Promise<ConversationSummary | null> => {
    const shown = await window.aevorenBot.conversations.setHidden({ sessionId, hidden: false });
    if (!shown.ok) { setError(shown.error); return null; }
    mergeConversation(shown.data);
    const read = await window.aevorenBot.conversations.setUnread({ sessionId, unread: false });
    if (!read.ok) { setError(read.error); return null; }
    mergeConversation(read.data);
    return read.data;
  }, [mergeConversation]);

  const flushActive = useCallback(async (): Promise<boolean> => {
    if (selectedRoomIdRef.current) return await roomRef.current?.flush() ?? true;
    return await profileRef.current?.flush() ?? true;
  }, []);
  const closeSettings = useCallback((): void => setSettingsOpen(false), []);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = (): void => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => { refreshTimer = null; void refreshConversations(); }, 120);
    };
    window.addEventListener("focus", scheduleRefresh);
    const unsubscribeTranscript = window.aevorenBot.events.subscribeTranscript((event) => {
      scheduleRefresh();
      if (event.sessionId === sessionIdRef.current && sidebarTabRef.current !== "contacts"
        && document.visibilityState === "visible" && event.entry.role === "assistant"
        && ["completed", "failed", "cancelled"].includes(event.entry.status)) {
        void window.aevorenBot.conversations.setUnread({ sessionId: event.sessionId, unread: false }).then((result) => {
          if (result.ok) mergeConversation(result.data);
        });
      }
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
      scheduleRefresh();
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
      scheduleRefresh();
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
      scheduleRefresh();
      if (event.invocation.state === "succeeded" && ["bot-create", "room-create"].includes(event.invocation.toolKind)) {
        void Promise.all([window.aevorenBot.bots.list(), window.aevorenBot.rooms.list({ includeArchived: true })]).then(([botResult, roomResult]) => {
          const resourceId = event.invocation.resultMetadata?.resourceId;
          const bot = botResult.ok ? botResult.data.find((item) => item.id === resourceId) : undefined;
          const room = roomResult.ok ? roomResult.data.find((item) => item.id === resourceId) : undefined;
          if (bot) setBots((current) => {
            const existing = current.find((item) => item.id === bot.id);
            if (existing && existing.version > bot.version) return current;
            return [...current.filter((item) => item.id !== bot.id), bot];
          });
          if (room) setRooms((current) => {
            const existing = current.find((item) => item.id === room.id);
            if (existing && existing.version > room.version) return current;
            return [...current.filter((item) => item.id !== room.id), room];
          });
        });
      }
      if (event.sessionId === loadingSessionIdRef.current) {
        bufferedToolRef.current.push(event);
        return;
      }
      if (event.sessionId !== sessionIdRef.current) return;
      setToolInvocations((current) => mergeToolInvocation(current, event.invocation));
      setApprovalRequests((current) => mergePendingApproval(current, event.approval));
    });
    const unsubscribeUpdate = window.aevorenBot.events.subscribeUpdate((event) => {
      setUpdateState(event.state);
      if (["available", "downloading", "downloaded", "up-to-date", "updated"].includes(event.state.status)) setUpdateActionError(null);
    });
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
      if (refreshTimer) clearTimeout(refreshTimer);
      window.removeEventListener("focus", scheduleRefresh);
      unsubscribeTranscript();
      unsubscribeSend();
      unsubscribeRuntime();
      unsubscribeRoom();
      unsubscribeTool();
      unsubscribeUpdate();
      unsubscribeClose();
      unsubscribeCloseBlocked();
    };
  }, [flushActive, mergeConversation, refreshConversations]);

  useEffect(() => {
    let active = true;
    const refreshWorkspaces = (): void => {
      void Promise.all([window.aevorenBot.workspaces.list(), window.aevorenBot.projects.list()]).then(([result, projectResult]) => {
        if (!active) return;
        if (result.ok) setWorkspaces(result.data);
        if (projectResult.ok) setProjects(projectResult.data);
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
    const conversation = await activateConversation(nextSession.id);
    if (requestId !== openRequestRef.current) return;
    if (!conversation) { setLoading(false); return; }
    if (conversation.projectId) {
      setActiveProjectId(conversation.projectId);
      sessionStorage.setItem("aevoren-bot:project", conversation.projectId);
    }
    setProjectChangeError(null);
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
  }, [activateConversation, flushActive]);

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
    const conversation = await activateConversation(nextSession.id);
    if (requestId !== openRequestRef.current) return;
    if (!conversation) { setLoading(false); return; }
    if (conversation.projectId) {
      setActiveProjectId(conversation.projectId);
      sessionStorage.setItem("aevoren-bot:project", conversation.projectId);
    }
    setProjectChangeError(null);
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
  }, [activateConversation, flushActive]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.aevorenBot.bots.list(),
      window.aevorenBot.rooms.list({ includeArchived: true }),
      window.aevorenBot.projects.list(),
      window.aevorenBot.conversations.list(),
    ]).then(async ([botResult, roomResult, projectResult, conversationResult]) => {
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
      if (!projectResult.ok) {
        setError(projectResult.error);
        setLoading(false);
        return;
      }
      setBots(botResult.data);
      setRooms(roomResult.data);
      setProjects(projectResult.data);
      if (!conversationResult.ok) { setError(conversationResult.error); setLoading(false); return; }
      setConversations(conversationResult.data);
      const visible = new Set(conversationResult.data.filter((item) => !item.hiddenAt).map((item) => item.botId ?? item.roomId));
      const rememberedProjectId = sessionStorage.getItem("aevoren-bot:project");
      const activeProject = projectResult.data.find((project) => project.id === rememberedProjectId)
        ?? projectResult.data.find((project) => project.id === DEFAULT_PROJECT_ID)
        ?? projectResult.data[0];
      if (activeProject) setActiveProjectId((current) => current === DEFAULT_PROJECT_ID ? activeProject.id : current);
      const selected = sessionStorage.getItem("aevoren-bot:selected");
      const selectedRoom = selected?.startsWith("room:")
        ? roomResult.data.find((room) => room.id === selected.slice(5) && room.archivedAt === null && visible.has(room.id))
        : undefined;
      const selectedBot = selected?.startsWith("bot:")
        ? botResult.data.find((bot) => bot.id === selected.slice(4) && visible.has(bot.id))
        : undefined;
      const firstVisibleBot = botResult.data.find((bot) => visible.has(bot.id));
      if (selectedRoom) await openRoom(selectedRoom, false);
      else if (selectedBot) await openBot(selectedBot, false);
      else if (firstVisibleBot) await openBot(firstVisibleBot, false);
      else {
        const firstActiveRoom = roomResult.data.find((room) => room.archivedAt === null && visible.has(room.id));
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

  async function createBot(projectId?: string): Promise<void> {
    if (chooserActionRef.current) return;
    chooserActionRef.current = "create";
    setCreatingBot(true);
    try {
      if (!(await flushActive())) return;
      setCreateError(null);
      const result = await window.aevorenBot.bots.create(projectId ? { projectId } : undefined);
      if (!result.ok) {
        setCreateError(result.error);
        return;
      }
      if (projectId) {
        setActiveProjectId(projectId);
        sessionStorage.setItem("aevoren-bot:project", projectId);
      }
      setBots((current) => [...current, result.data.bot]);
      await openBot(result.data.bot, false);
      if (sidebarTab === "contacts") setSidebarTab("chats");
      setInspectorCollapsed(false);
      setMobilePanel(window.matchMedia("(max-width: 1180px)").matches ? "profile" : null);
      await refreshConversations();
    } catch {
      setCreateError({ code: "INTERNAL_ERROR", domain: "internal", retryable: true, safeMessage: "Bot 创建未完成，请稍后重试。" });
    } finally {
      chooserActionRef.current = null;
      setCreatingBot(false);
    }
  }

  async function createRoom(memberBotIds: string[], projectId = creationProjectId, leadBotId?: string | null): Promise<void> {
    if (chooserActionRef.current) return;
    chooserActionRef.current = "create";
    setCreatingBot(true);
    try {
      if (!(await flushActive())) return;
      setCreateError(null);
      const result = await window.aevorenBot.rooms.create({ memberBotIds, ...(projectId ? { projectId } : {}), ...(leadBotId !== undefined ? { leadBotId } : {}) });
      if (!result.ok) {
        setCreateError(result.error);
        return;
      }
      setRooms((current) => [...current, result.data.room]);
      if (projectId) {
        setActiveProjectId(projectId);
        sessionStorage.setItem("aevoren-bot:project", projectId);
      }
      await openRoom(result.data.room, false);
      if (sidebarTab === "contacts") setSidebarTab("chats");
      await refreshConversations();
    } finally {
      chooserActionRef.current = null;
      setCreatingBot(false);
    }
  }

  async function createContentTeam(projectId = creationProjectId): Promise<void> {
    if (chooserActionRef.current) return;
    chooserActionRef.current = "create";
    setCreatingBot(true);
    try {
      if (!(await flushActive())) return;
      setCreateError(null);
      const result = await window.aevorenBot.teams.createContentTeam(projectId ? { projectId } : undefined);
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
      if (sidebarTab === "contacts") setSidebarTab("chats");
      await refreshConversations();
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
    const conversation = conversations.find((item) => item.botId === bot.id);
    if (!conversation) return false;
    const result = await window.aevorenBot.conversations.setPinned({ sessionId: conversation.sessionId, pinned });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    mergeConversation(result.data);
    return true;
  }

  async function setBotUnread(bot: Bot, unread: boolean): Promise<boolean> {
    const conversation = conversations.find((item) => item.botId === bot.id);
    if (!conversation) return false;
    const result = await window.aevorenBot.conversations.setUnread({ sessionId: conversation.sessionId, unread });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    mergeConversation(result.data);
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
    setSidebarTab("chats");
    setInspectorCollapsed(false);
    setMobilePanel(window.matchMedia("(max-width: 1180px)").matches ? "profile" : null);
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
    await refreshConversations();
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
    const conversation = conversations.find((item) => item.botId === bot.id);
    if (!conversation) return false;
    const result = await window.aevorenBot.conversations.setHidden({ sessionId: conversation.sessionId, hidden });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    mergeConversation(result.data);
    if (hidden && selectedBot?.id === bot.id) clearSelection();
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
    const visible = new Set(conversations.filter((item) => !item.hiddenAt).map((item) => item.botId ?? item.roomId));
    const nextBot = nextBots.find((bot) => visible.has(bot.id));
    if (nextBot) {
      await openBot(nextBot, false);
      return;
    }
    const nextRoom = nextRooms.find((room) => room.archivedAt === null && visible.has(room.id));
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
    await refreshConversations();
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
    const conversation = conversations.find((item) => item.roomId === room.id);
    if (!conversation) return false;
    const result = await window.aevorenBot.conversations.setPinned({ sessionId: conversation.sessionId, pinned });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    mergeConversation(result.data);
    return true;
  }

  async function setRoomUnread(room: Room, unread: boolean): Promise<boolean> {
    const conversation = conversations.find((item) => item.roomId === room.id);
    if (!conversation) return false;
    const result = await window.aevorenBot.conversations.setUnread({ sessionId: conversation.sessionId, unread });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    mergeConversation(result.data);
    return true;
  }

  async function setRoomHidden(room: Room, hidden: boolean): Promise<boolean> {
    if (selectedRoom?.room.id === room.id && !(await flushActive())) return false;
    const conversation = conversations.find((item) => item.roomId === room.id);
    if (!conversation) return false;
    const result = await window.aevorenBot.conversations.setHidden({ sessionId: conversation.sessionId, hidden });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    mergeConversation(result.data);
    if (hidden && selectedRoom?.room.id === room.id) clearSelection();
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
    await refreshConversations();
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
    await refreshConversations();
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
    await refreshConversations();

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

  async function hideConversations(input: ConversationBatchDeleteInput): Promise<boolean> {
    if (!(await flushActive())) return false;
    const targets = conversations.filter((item) => (item.botId && input.botIds.includes(item.botId)) || (item.roomId && input.roomIds.includes(item.roomId)));
    const results = await Promise.all(targets.map((item) => window.aevorenBot.conversations.setHidden({ sessionId: item.sessionId, hidden: true })));
    for (const result of results) {
      if (result.ok) {
        mergeConversation(result.data);
        if (result.data.sessionId === sessionIdRef.current) clearSelection();
      } else setError(result.error);
    }
    return results.every((result) => result.ok);
  }

  async function clearConversation(): Promise<void> {
    if (!clearTarget || clearingConversation || !(await flushActive())) return;
    setClearingConversation(true);
    const target = clearTarget;
    try {
      const result = await window.aevorenBot.conversations.clear(target.sessionId);
      if (!result.ok) { setError(result.error); return; }
      setClearTarget(null);
      await refreshConversations();
      if (sessionIdRef.current === target.sessionId) {
        const bot = bots.find((item) => item.id === target.botId);
        const room = rooms.find((item) => item.id === target.roomId);
        if (bot) await openBot(bot, false);
        else if (room) await openRoom(room, false);
      }
    } finally { setClearingConversation(false); }
  }

  async function changeConversationProject(projectId: string | null): Promise<void> {
    const conversation = conversations.find((item) => item.sessionId === sessionIdRef.current);
    if (!conversation || projectChanging || !(await flushActive())) return;
    setProjectChanging(true);
    setProjectChangeError(null);
    try {
      const result = await window.aevorenBot.conversations.setProject({ sessionId: conversation.sessionId, projectId, expectedVersion: conversation.version });
      if (!result.ok) {
        setProjectChangeError(result.error.safeMessage);
        await refreshConversations();
        return;
      }
      mergeConversation(result.data);
      if (projectId) setActiveProjectId(projectId);
    } finally { setProjectChanging(false); }
  }

  async function addContactToRoom(bot: Bot, roomId: string): Promise<boolean> {
    if (!(await flushActive())) return false;
    const detail = await window.aevorenBot.rooms.get(roomId);
    if (!detail.ok) { setError(detail.error); return false; }
    if (detail.data.members.some((member) => member.botId === bot.id)) return true;
    const result = await window.aevorenBot.rooms.addMember({ roomId, botId: bot.id, expectedMembershipVersion: detail.data.room.membershipVersion });
    if (!result.ok) { setError(result.error); return false; }
    updateRoomRecord(result.data.room);
    if (selectedRoomIdRef.current === roomId) setSelectedRoom(result.data);
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

  async function addWorkspace(projectId?: string): Promise<void> {
    if (workspaceAddInFlightRef.current) return;
    workspaceAddInFlightRef.current = true;
    setWorkspaceAddPending(true);
    setWorkspaceAddError(null);
    try {
      const result = await window.aevorenBot.workspaces.add(projectId ? { projectId } : undefined);
      if (!result.ok) { setWorkspaceAddError(result.error.safeMessage); return; }
      if (!result.data) return;
      const workspace = result.data.workspace;
      const project = result.data.project;
      setWorkspaces((current) => {
        const withoutCurrent = current.filter((item) => item.id !== workspace.id);
        return [...withoutCurrent, workspace].toSorted((left, right) => (
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
        ));
      });
      setProjects((current) => [...current.filter((item) => item.id !== project.id), project]);
      setActiveProjectId(project.id);
      sessionStorage.setItem("aevoren-bot:project", project.id);
      window.dispatchEvent(new Event("aevoren:workspaces-changed"));
    } catch {
      setWorkspaceAddError("添加文件夹失败，请稍后重试。");
    } finally {
      workspaceAddInFlightRef.current = false;
      setWorkspaceAddPending(false);
    }
  }

  function handleArchived(room: Room): void {
    setRooms((current) => current.map((item) => item.id === room.id ? room : item));
    selectedRoomIdRef.current = null;
    const visibleBot = bots.find((bot) => conversations.some((item) => item.botId === bot.id && !item.hiddenAt));
    if (visibleBot) void openBot(visibleBot, false);
    else clearSelection();
  }

  const activeRoomBatch = roomBatches.some((batch) => batch.state === "queued" || batch.state === "running");
  const activeDirectRun = liveState !== null && ["starting", "running", "composing", "retrying", "cancelling"].includes(liveState.state);
  const activeConversation = conversations.find((item) => item.sessionId === session?.id) ?? null;
  const selectedContact = bots.find((bot) => bot.id === selectedContactId) ?? null;
  const conversationWorkspace = {
    projects,
    projectId: activeConversation?.projectId ?? null,
    pending: projectChanging || activeRoomBatch || activeDirectRun || submitting,
    error: projectChangeError,
    onChange: (projectId: string | null): void => { void changeConversationProject(projectId); },
  };
  const updateRestartBlocked = submitting || activeRoomBatch || activeDirectRun;

  async function runUpdateAction(action: UpdateAction): Promise<void> {
    if (updateActionInFlightRef.current) return;
    if (action === "install" && updateRestartBlocked) {
      setUpdateActionError("当前任务完成后即可重启更新。");
      return;
    }
    updateActionInFlightRef.current = true;
    setUpdateActionPending(action);
    setUpdateActionError(null);
    try {
      if (action === "install" && !(await flushActive())) {
        setUpdateActionError("资料未能保存，请先保存后再重启更新。");
        return;
      }
      const result = await window.aevorenBot.updates[action === "install" ? "installAndRestart" : action]();
      if (result.ok) setUpdateState(result.data);
      else {
        setUpdateActionError(updateActionErrorMessage(action, result.error));
        if (result.error.code === "UPDATE_NOT_READY") {
          const current = await window.aevorenBot.updates.getState();
          if (current.ok) setUpdateState(current.data);
        }
      }
    } catch {
      setUpdateActionError(updateActionErrorMessage(action));
    } finally {
      updateActionInFlightRef.current = false;
      setUpdateActionPending(null);
    }
  }

  async function savePublicReadAutomation(enabled: boolean): Promise<AppError | null> {
    const result = await window.aevorenBot.settings.saveGeneral({ autoApprovePublicReadTools: enabled });
    if (!result.ok) return result.error;
    setAutoApprovePublicReadTools(result.data.autoApprovePublicReadTools);
    return null;
  }

  async function resolveToolApproval(approval: ApprovalRequest, resolution: ApprovalResolution): Promise<boolean> {
    const result = await window.aevorenBot.approvals.resolve({ sessionId: approval.sessionId, id: approval.id, expectedVersion: approval.version, resolution });
    if (!result.ok) { setError(result.error); return false; }
    setToolInvocations(current => mergeToolInvocation(current, result.data.invocation));
    setApprovalRequests(current => mergePendingApproval(current, result.data.approval));
    return true;
  }

  return (
    <div className={`app-shell${inspectorCollapsed || sidebarTab === "contacts" ? " inspector-collapsed" : ""}`}>
      <Sidebar
        bots={bots}
        rooms={rooms}
        conversations={conversations}
        tab={sidebarTab}
        onTabChange={(tab) => { void flushActive().then((saved) => {
          if (!saved) return;
          setSidebarTab(tab);
          if (tab === "contacts") setMobilePanel((current) => current === "profile" ? null : current);
        }); }}
        selectedContactId={selectedContactId}
        onSelectContact={(bot) => { setSelectedContactId(bot.id); setMobilePanel(null); }}
        onHideBatch={hideConversations}
        onClearConversation={(conversation) => { setError(null); setClearTarget(conversation); }}
        projects={projects}
        activeProjectId={activeProjectId}
        workspaces={workspaces}
        selectedBotId={selectedBot?.id ?? null}
        selectedRoomId={selectedRoom?.room.id ?? null}
        busy={loading || creatingBot}
        addingWorkspace={workspaceAddPending}
        workspaceError={workspaceAddError}
        creationError={newBotOpen ? null : createError?.safeMessage ?? null}
        mobileOpen={mobilePanel === "bots"}
        createButtonRef={newBotButtonRef}
        onCreateProject={() => void addWorkspace()}
        onBindProject={(projectId) => void addWorkspace(projectId)}
        onSelectProject={(projectId) => {
          setActiveProjectId(projectId);
          sessionStorage.setItem("aevoren-bot:project", projectId);
        }}
        onOpenWorkspaces={(workspaceId) => {
          setManagedWorkspaceId(workspaceId);
          setWorkspacesOpen(true);
        }}
        onCreate={() => {
          if (chooserActionRef.current) return;
          setCreateError(null);
          setMobilePanel(null);
          setCreationProjectId(sidebarTab === "workspace" ? activeProjectId : undefined);
          setCreationMode("chat");
          setNewBotOpen(true);
        }}
        onCreateBot={(projectId) => void createBot(projectId)}
        onCreateRoom={(projectId) => {
          if (chooserActionRef.current) return;
          setCreateError(null);
          setMobilePanel(null);
          setCreationProjectId(projectId);
          setCreationMode("room");
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
      {sidebarTab === "contacts" ? <ContactDetail
        bot={selectedContact}
        rooms={rooms}
        busy={loading || creatingBot}
        error={error?.safeMessage ?? null}
        onOpenBots={() => setMobilePanel("bots")}
        onSend={(bot) => { setSidebarTab("chats"); void openBot(bot); }}
        onEdit={(bot) => void editBot(bot)}
        onAddToRoom={addContactToRoom}
      /> : <Conversation
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
        onResolveApproval={resolveToolApproval}
        onRememberPublicRead={async (approval) => {
          // This is a user-clicked entry to the existing opt-in setting, not a
          // new default or a blanket grant for already-waiting operations.
          const invocation = toolInvocations.find(tool => tool.id === approval.toolInvocationId && tool.sessionId === approval.sessionId);
          if (!invocation || invocation.state !== "awaiting-approval" || !isPublicReadTool(invocation.toolKind)) return false;
          const error = await savePublicReadAutomation(true);
          if (error) { setError(error); return false; }
          return resolveToolApproval(approval, "allow-once");
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
      />}
      {selectedRoom ? (
        <RoomInspector
          key={`room-inspector:${selectedRoom.room.id}`}
          ref={roomRef}
          id="conversation-inspector"
          detail={selectedRoom}
          bots={bots}
          conversationWorkspace={conversationWorkspace}
          active={activeRoomBatch}
          mobileOpen={mobilePanel === "profile"}
          onDetailUpdated={updateRoom}
          onError={setError}
          onOpenBot={(bot) => void openBot(bot)}
          onMobileClose={() => void closeInspector()}
        />
      ) : (
        <ProfileInspector
          ref={profileRef}
          id="conversation-inspector"
          bot={selectedBot}
          workspaceIds={activeConversation?.workspaceIds ?? []}
          conversationWorkspace={conversationWorkspace}
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
        updateActionPending={updateActionPending}
        updateActionError={updateActionError}
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
        onAutoApprovePublicReadToolsChange={savePublicReadAutomation}
        onUpdateCheckIntervalChange={async (minutes) => {
          const result = await window.aevorenBot.settings.saveGeneral({ updateCheckIntervalMinutes: minutes });
          if (!result.ok) return result.error;
          setUpdateCheckIntervalMinutes(result.data.updateCheckIntervalMinutes);
          return null;
        }}
        onCheckUpdate={() => void runUpdateAction("check")}
        onRetryUpdate={() => void runUpdateAction("retry")}
        onInstallUpdate={() => void runUpdateAction("install")}
      />
      <WorkspaceDialog
        open={workspacesOpen}
        workspaceId={managedWorkspaceId}
        onClose={() => setWorkspacesOpen(false)}
      />
      {newBotOpen ? (
        <NewBotChooser
          bots={bots}
          initialGroupMode={creationMode === "room"}
          creating={creatingBot}
          error={createError}
          onClose={() => {
            setCreateError(null);
            setNewBotOpen(false);
            requestAnimationFrame(() => {
              if (document.activeElement === document.body) newBotButtonRef.current?.focus();
            });
          }}
          onCreate={() => void createBot(creationProjectId)}
          onCreateRoom={(botIds, leadBotId) => void createRoom(botIds, creationProjectId, leadBotId)}
          onCreateContentTeam={() => void createContentTeam()}
          onSelect={(bot) => {
            if (chooserActionRef.current) return;
            chooserActionRef.current = "select";
            setNewBotOpen(false);
            void openBot(bot).finally(() => { chooserActionRef.current = null; });
          }}
        />
      ) : null}
      {clearTarget ? <div className="bot-delete-backdrop" role="presentation">
        <section className="bot-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="clear-conversation-title" aria-describedby="clear-conversation-description" onKeyDown={(event) => {
          if (event.key === "Escape" && !clearingConversation) setClearTarget(null);
          if (event.key === "Tab") {
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
            if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
            else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
          }
        }}>
          <h2 id="clear-conversation-title">清空聊天记录？</h2>
          <p id="clear-conversation-description">这会永久清空当前聊天的消息记录。联系人、群成员和工作区文件会保留。</p>
          {error ? <p role="alert">{error.safeMessage}</p> : null}
          <div className="bot-delete-actions">
            <button autoFocus type="button" className="secondary-button" disabled={clearingConversation} onClick={() => setClearTarget(null)}>取消</button>
            <button type="button" className="danger-confirm-button" disabled={clearingConversation} onClick={() => void clearConversation()}>{clearingConversation ? "清空中…" : "清空记录"}</button>
          </div>
        </section>
      </div> : null}
      <UpdateStatusNotice
        state={updateState}
        restartBlocked={updateRestartBlocked}
        actionPending={updateActionPending}
        actionError={updateActionError}
        onRetry={() => void runUpdateAction("retry")}
        onInstall={() => void runUpdateAction("install")}
      />
    </div>
  );
}
