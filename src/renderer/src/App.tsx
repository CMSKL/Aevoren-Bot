import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppError,
  Bot,
  RuntimeEvent,
  RuntimeRun,
  Session,
  SessionLiveState,
  TranscriptEvent,
  TranscriptEntry,
} from "@shared/contracts";
import { Conversation } from "./components/Conversation";
import { ModelSettingsDialog } from "./components/ModelSettingsDialog";
import { NewBotChooser } from "./components/NewBotChooser";
import { ProfileInspector, type ProfileInspectorHandle } from "./components/ProfileInspector";
import { Sidebar } from "./components/Sidebar";
import { mergeBufferedEvents, mergeRuntimeRun, mergeTranscriptEntry } from "./runtime-state";

function idleLiveState(sessionId: string): SessionLiveState {
  return {
    sessionId,
    state: "idle",
    activeRunId: null,
    activeClientNonce: null,
    lastActivityAt: null,
    staleAfterMs: 30_000,
  };
}

export function App(): React.JSX.Element {
  const [bots, setBots] = useState<Bot[]>([]);
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [runs, setRuns] = useState<RuntimeRun[]>([]);
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
  const sessionIdRef = useRef<string | null>(null);
  const loadingSessionIdRef = useRef<string | null>(null);
  const bufferedTranscriptRef = useRef<TranscriptEvent[]>([]);
  const bufferedRuntimeRef = useRef<RuntimeEvent[]>([]);
  const runtimeVersionsRef = useRef(new Map<string, number>());
  const openRequestRef = useRef(0);
  const chooserActionRef = useRef<"create" | "select" | null>(null);

  useEffect(() => {
    const unsubscribeTranscript = window.msBot.events.subscribeTranscript((event) => {
      if (event.sessionId === loadingSessionIdRef.current) {
        bufferedTranscriptRef.current.push(event);
        return;
      }
      if (event.sessionId !== sessionIdRef.current) return;
      setEntries((current) => mergeTranscriptEntry(current, event.entry));
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
    const unsubscribeClose = window.msBot.app.subscribeBeforeClose(() => {
      void profileRef.current?.flush().then((saved) => window.msBot.app.confirmClose(saved));
      if (!profileRef.current) window.msBot.app.confirmClose(true);
    });
    const unsubscribeCloseBlocked = window.msBot.app.subscribeCloseBlocked(() => {
      setCloseNotice("关闭未完成：资料仍保留在当前窗口，请稍后重试关闭。");
    });
    window.msBot.app.ready();
    return () => {
      unsubscribeTranscript();
      unsubscribeSend();
      unsubscribeRuntime();
      unsubscribeClose();
      unsubscribeCloseBlocked();
    };
  }, []);

  const openBot = useCallback(async (bot: Bot, flushCurrent = true): Promise<void> => {
    const requestId = ++openRequestRef.current;
    if (flushCurrent && profileRef.current && !(await profileRef.current.flush())) return;
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
    loadingSessionIdRef.current = null;
    bufferedTranscriptRef.current = [];
    bufferedRuntimeRef.current = [];
    setSelectedBot(bot);
    setSession(nextSession);
    setEntries(buffered.entries);
    setRuns(buffered.runs);
    runtimeVersionsRef.current = new Map(buffered.runs.map((run) => [run.id, run.version]));
    setLiveState(buffered.lastRuntimeEvent?.liveState ?? snapshotResult.data.liveState);
    setNewBotOpen(false);
    setCreateError(null);
    setMobilePanel(null);
    setLoading(false);
  }, []);

  const closeMobilePanel = useCallback(async (): Promise<void> => {
    if (mobilePanel === "profile" && profileRef.current && !(await profileRef.current.flush())) return;
    setMobilePanel(null);
  }, [mobilePanel]);

  useEffect(() => {
    if (!mobilePanel) return;
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") void closeMobilePanel();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeMobilePanel, mobilePanel]);

  useEffect(() => {
    let cancelled = false;
    void window.msBot.bots.list().then(async (result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        setLoading(false);
        return;
      }
      setBots(result.data);
      if (result.data[0]) await openBot(result.data[0], false);
      else setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [openBot]);

  async function createBot(): Promise<void> {
    if (chooserActionRef.current) return;
    chooserActionRef.current = "create";
    setCreatingBot(true);
    try {
      if (profileRef.current && !(await profileRef.current.flush())) return;
      setError(null);
      setCloseNotice(null);
      setCreateError(null);
      const result = await window.msBot.bots.create();
      if (!result.ok) {
        setCreateError(result.error);
        return;
      }
      openRequestRef.current += 1;
      setBots((current) => [...current, result.data.bot]);
      sessionIdRef.current = result.data.session.id;
      setSelectedBot(result.data.bot);
      setSession(result.data.session);
      setEntries([]);
      setRuns([]);
      runtimeVersionsRef.current = new Map();
      setLiveState(idleLiveState(result.data.session.id));
      setNewBotOpen(false);
    } finally {
      chooserActionRef.current = null;
      setCreatingBot(false);
    }
  }

  function selectBotFromChooser(bot: Bot): void {
    if (chooserActionRef.current) return;
    chooserActionRef.current = "select";
    setCreateError(null);
    setNewBotOpen(false);
    void openBot(bot).finally(() => {
      chooserActionRef.current = null;
    });
  }

  function updateBot(bot: Bot): void {
    setBots((current) => current.map((item) => (item.id === bot.id ? bot : item)));
    setSelectedBot((current) => (current?.id === bot.id ? bot : current));
  }

  function closeNewBotChooser(): void {
    setCreateError(null);
    setNewBotOpen(false);
    requestAnimationFrame(() => newBotButtonRef.current?.focus());
  }

  async function sendMessage(text: string): Promise<boolean> {
    if (!session || submitting || liveState?.activeRunId) return false;
    setSubmitting(true);
    setError(null);
    setCloseNotice(null);
    const result = await window.msBot.messages.send({
      sessionId: session.id,
      clientNonce: crypto.randomUUID(),
      text,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    return true;
  }

  function retryMessage(clientNonce: string): void {
    if (submitting || liveState?.activeRunId) return;
    setSubmitting(true);
    setError(null);
    void window.msBot.messages.retry(clientNonce).then((result) => {
      setSubmitting(false);
      if (!result.ok) setError(result.error);
    });
  }

  function retryRun(runId: string): void {
    if (submitting || liveState?.activeRunId) return;
    setSubmitting(true);
    setError(null);
    void window.msBot.runtime.retry(runId).then((result) => {
      setSubmitting(false);
      if (!result.ok) setError(result.error);
    });
  }

  function cancelRun(runId: string): void {
    void window.msBot.runtime.cancel(runId).then((result) => {
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="app-shell">
      <Sidebar
        bots={bots}
        selectedBotId={selectedBot?.id ?? null}
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
        onSelect={(bot) => void openBot(bot)}
      />
      <Conversation
        bot={selectedBot}
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
        onRetryMessage={retryMessage}
        onRetryRun={retryRun}
        onCancelRun={cancelRun}
      />
      <ProfileInspector
        ref={profileRef}
        bot={selectedBot}
        mobileOpen={mobilePanel === "profile"}
        onBotUpdated={updateBot}
        onError={setError}
        onMobileClose={() => void closeMobilePanel()}
      />
      {mobilePanel ? (
        <button className="drawer-backdrop" type="button" aria-label="关闭侧边面板" onClick={() => void closeMobilePanel()} />
      ) : null}
      <ModelSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {newBotOpen ? (
        <NewBotChooser
          bots={bots}
          creating={creatingBot}
          error={createError}
          onClose={closeNewBotChooser}
          onCreate={() => void createBot()}
          onSelect={selectBotFromChooser}
        />
      ) : null}
    </div>
  );
}
