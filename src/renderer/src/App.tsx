import { useCallback, useEffect, useRef, useState } from "react";
import type { AppError, Bot, SendState, Session, TranscriptEntry } from "@shared/contracts";
import { Conversation } from "./components/Conversation";
import { ModelSettingsDialog } from "./components/ModelSettingsDialog";
import { ProfileInspector, type ProfileInspectorHandle } from "./components/ProfileInspector";
import { Sidebar } from "./components/Sidebar";

function sortEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.toSorted((left, right) => left.generation - right.generation || left.seq - right.seq);
}

export function App(): React.JSX.Element {
  const [bots, setBots] = useState<Bot[]>([]);
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [activeNonce, setActiveNonce] = useState<string | null>(null);
  const [activeState, setActiveState] = useState<SendState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const profileRef = useRef<ProfileInspectorHandle>(null);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribeTranscript = window.msBot.events.subscribeTranscript((event) => {
      if (event.sessionId !== sessionIdRef.current) return;
      setEntries((current) => {
        const index = current.findIndex((entry) => entry.id === event.entry.id);
        if (index === -1) return sortEntries([...current, event.entry]);
        const next = [...current];
        next[index] = event.entry;
        return sortEntries(next);
      });
      if (event.entry.role === "assistant" && ["completed", "failed", "cancelled"].includes(event.entry.status)) {
        setActiveNonce(null);
        setActiveState(null);
      }
    });
    const unsubscribeSend = window.msBot.events.subscribeSendState((event) => {
      if (event.sessionId !== sessionIdRef.current) return;
      setActiveNonce(event.clientNonce);
      setActiveState(event.state);
      if (event.error) setError(event.error);
      if (["failed-before-acceptance", "refused", "conflict", "cancelled", "interrupted-unknown"].includes(event.state)) {
        setActiveNonce(null);
      }
    });
    const unsubscribeClose = window.msBot.app.subscribeBeforeClose(() => {
      void profileRef.current?.flush().then((saved) => window.msBot.app.confirmClose(saved));
      if (!profileRef.current) window.msBot.app.confirmClose(true);
    });
    window.msBot.app.ready();
    return () => {
      unsubscribeTranscript();
      unsubscribeSend();
      unsubscribeClose();
    };
  }, []);

  const openBot = useCallback(async (bot: Bot, flushCurrent = true): Promise<void> => {
    if (flushCurrent && profileRef.current && !(await profileRef.current.flush())) return;
    setLoading(true);
    setError(null);
    const sessionResult = await window.msBot.sessions.getMain(bot.id);
    if (!sessionResult.ok) {
      setError(sessionResult.error);
      setLoading(false);
      return;
    }
    const transcriptResult = await window.msBot.transcript.list(sessionResult.data.id);
    if (!transcriptResult.ok) {
      setError(transcriptResult.error);
      setLoading(false);
      return;
    }
    sessionIdRef.current = sessionResult.data.id;
    setSelectedBot(bot);
    setSession(sessionResult.data);
    setEntries(sortEntries(transcriptResult.data));
    setActiveNonce(null);
    setActiveState(null);
    setLoading(false);
  }, []);

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
    if (profileRef.current && !(await profileRef.current.flush())) return;
    setError(null);
    const result = await window.msBot.bots.create();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBots((current) => [...current, result.data.bot]);
    sessionIdRef.current = result.data.session.id;
    setSelectedBot(result.data.bot);
    setSession(result.data.session);
    setEntries([]);
    setActiveNonce(null);
    setActiveState(null);
  }

  function updateBot(bot: Bot): void {
    setBots((current) => current.map((item) => (item.id === bot.id ? bot : item)));
    setSelectedBot((current) => (current?.id === bot.id ? bot : current));
  }

  async function sendMessage(text: string): Promise<boolean> {
    if (!session) return false;
    setError(null);
    const clientNonce = crypto.randomUUID();
    setActiveNonce(clientNonce);
    setActiveState("prepared");
    const result = await window.msBot.messages.send({ sessionId: session.id, clientNonce, text });
    if (!result.ok) {
      setError(result.error);
      setActiveNonce(null);
      setActiveState(null);
      return false;
    }
    return true;
  }

  function retryMessage(clientNonce: string): void {
    setError(null);
    setActiveNonce(clientNonce);
    setActiveState("queued");
    void window.msBot.messages.retry(clientNonce).then((result) => {
      if (result.ok) return;
      setError(result.error);
      setActiveNonce(null);
      setActiveState(null);
    });
  }

  function cancelMessage(clientNonce: string): void {
    void window.msBot.messages.cancel(clientNonce).then((result) => {
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="app-shell">
      <Sidebar
        bots={bots}
        selectedBotId={selectedBot?.id ?? null}
        busy={loading}
        onCreate={() => void createBot()}
        onSelect={(bot) => void openBot(bot)}
      />
      <Conversation
        bot={selectedBot}
        entries={entries}
        loading={loading}
        activeNonce={activeNonce}
        activeState={activeState}
        error={error}
        onOpenSettings={() => setSettingsOpen(true)}
        onSend={sendMessage}
        onRetry={retryMessage}
        onCancel={cancelMessage}
      />
      <ProfileInspector ref={profileRef} bot={selectedBot} onBotUpdated={updateBot} onError={setError} />
      <ModelSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
