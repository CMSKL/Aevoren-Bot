import type { RuntimeEvent, RuntimeRun, TranscriptEntry, TranscriptEvent } from "@shared/contracts";

export function sortEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.toSorted((left, right) => left.generation - right.generation || left.seq - right.seq);
}

export function mergeTranscriptEntry(current: TranscriptEntry[], incoming: TranscriptEntry): TranscriptEntry[] {
  const index = current.findIndex((entry) => entry.id === incoming.id);
  if (index === -1) return sortEntries([...current, incoming]);
  if (current[index]!.updatedSeq >= incoming.updatedSeq) return current;
  const next = [...current];
  next[index] = incoming;
  return sortEntries(next);
}

export function mergeRuntimeRun(current: RuntimeRun[], incoming: RuntimeRun): RuntimeRun[] {
  const index = current.findIndex((run) => run.id === incoming.id);
  if (index === -1) return [...current, incoming].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.attemptNo - right.attemptNo,
  );
  if (current[index]!.version >= incoming.version) return current;
  const next = [...current];
  next[index] = incoming;
  return next;
}

export function mergeBufferedEvents(
  entries: TranscriptEntry[],
  runs: RuntimeRun[],
  transcriptEvents: readonly TranscriptEvent[],
  runtimeEvents: readonly RuntimeEvent[],
): { entries: TranscriptEntry[]; runs: RuntimeRun[]; lastRuntimeEvent: RuntimeEvent | null } {
  let mergedEntries = entries;
  let mergedRuns = runs;
  for (const event of transcriptEvents) mergedEntries = mergeTranscriptEntry(mergedEntries, event.entry);
  let lastRuntimeEvent: RuntimeEvent | null = null;
  for (const event of runtimeEvents) {
    const before = mergedRuns.find((run) => run.id === event.run.id);
    mergedRuns = mergeRuntimeRun(mergedRuns, event.run);
    if (!before || event.run.version > before.version) lastRuntimeEvent = event;
  }
  return { entries: mergedEntries, runs: mergedRuns, lastRuntimeEvent };
}
