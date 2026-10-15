import { createHash } from "node:crypto";
import type { ConversationSummary } from "@shared/contracts";
import type { SearchExecutionContext, SearchItem, SearchKind, SearchOpenInput, SearchOpenResult, SearchPage, SearchQueryInput, SearchSourceReference } from "@shared/search-contracts";
import { SEARCH_KINDS } from "@shared/search-contracts";
import { searchOpenSchema, searchQuerySchema } from "@shared/search-schemas";
import type { AppRepository } from "./database";
import type { VoiceService } from "./voice-service";
import { SearchRepository } from "./search-repository";
import { AevorenBotError } from "./errors";

export type { SearchExecutionContext } from "@shared/search-contracts";
const MAX_MATCHES = 5_000;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",") + "}";
  return JSON.stringify(value);
}
const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const fold = (value: string): string => value.normalize("NFKC").toLocaleLowerCase();
const unavailable = () => new AevorenBotError("INVALID_REQUEST", "原内容已变更或授权已撤销，请重新搜索。");
type Candidate = { item: SearchItem; text: string };

export class SearchService {
  constructor(private readonly repository: AppRepository, private readonly sources: SearchRepository, private readonly voice?: Pick<VoiceService, "get">) {}

  private conversations(input: SearchQueryInput, context?: SearchExecutionContext): ConversationSummary[] {
    if (context) {
      if (input.scope && (input.scope.kind !== "session" || input.scope.sessionId !== context.sessionId)) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
      this.repository.assertSessionExecutor(context.sessionId, context.executorBotId);
      if (context.runtimeRunId) {
        const run = this.repository.getRuntimeRun(context.runtimeRunId);
        if (run.sessionId !== context.sessionId || run.executorBotId !== context.executorBotId || !["running", "streaming"].includes(run.state)) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
        this.repository.tasks.assertTaskRuntime(run.id);
      }
      return [this.repository.getConversation(context.sessionId)];
    }
    if (input.scope?.kind === "session") return [this.repository.getConversation(input.scope.sessionId)];
    return this.repository.listConversations().filter(item => input.scope?.kind !== "project" || item.projectId === input.scope.projectId);
  }

  private authority(sessionId: string, context?: SearchExecutionContext, sourceState?: unknown): string {
    const session = this.repository.getSession(sessionId);
    const policy = context ? context.runtimeRunId ? this.repository.tasks.runtimeTaskPolicy(context.runtimeRunId) : this.repository.tasks.taskSessionPolicy(sessionId, context.executorBotId) : null;
    return hash({ sessionId, generation: session.generation, scopeVersion: this.repository.tasks.scopeVersion(sessionId),
      ...(context ? { actor: context.executorBotId, runtime: context.runtimeRunId ?? null } : {}),
      ...(policy ? { selection: policy.selectionDigest, incarnation: policy.executorIncarnation } : {}), state: sourceState ?? null });
  }

  private candidate(kind: SearchKind, title: string, text: string, updatedAt: string, source: SearchSourceReference): Candidate {
    return { text, item: { id: hash(source), kind, title: title.slice(0, 240), snippet: "", updatedAt, source } };
  }

  private *candidates(conversations: ConversationSummary[], kinds: ReadonlySet<SearchKind>, context?: SearchExecutionContext, query?: string, expected?: SearchSourceReference): Iterable<Candidate> {
    const repo = this.repository, actor = context?.executorBotId, runtimeId = context?.runtimeRunId;
    for (const conversation of conversations) {
      const sessionId = conversation.sessionId, session = repo.getSession(sessionId);
      const title = conversation.title || (session.botId ? repo.getBot(session.botId).name : repo.getRoom(session.roomId!).name);
      const authorityDigest = this.authority(sessionId, context);
      if (kinds.has("message")) for (const id of (expected?.type === "message" ? [expected.id] : this.sources.messages(sessionId, query))) {
        const entry = repo.getTranscriptEntry(id);
        if (entry.sessionId !== sessionId || entry.generation !== session.generation || entry.status !== "completed") continue;
        yield this.candidate("message", title, entry.body, entry.updatedAt, { type: "message", sessionId, id, generation: entry.generation, seq: entry.seq, digest: hash(entry.body), authorityDigest });
      }
      if (session.kind === "TASK" && kinds.has("task") && (!expected || expected.id === sessionId)) {
        const task = repo.tasks.get(sessionId, actor);
        yield this.candidate("task", task.title, task.title, task.session.updatedAt, { type: "task", sessionId, id: sessionId, version: task.version, digest: hash(task.title), authorityDigest });
      }
      if (kinds.has("document") || kinds.has("skill")) for (const resource of repo.library.list({ sessionId }, actor, runtimeId)) {
        if (!kinds.has(resource.kind) || expected && resource.id !== expected.id) continue;
        const content = repo.library.read({ sessionId, id: resource.id, ...(expected && (expected.type === "document" || expected.type === "skill") ? { revisionId: expected.revisionId } : {}) }, actor, runtimeId);
        yield this.candidate(resource.kind, content.revision.name, `${content.revision.name}\n${content.revision.description}\n${content.revision.body}`, content.revision.createdAt,
          { type: resource.kind, sessionId, id: resource.id, revisionId: content.reference.revisionId, digest: content.reference.digest,
            authorityDigest: this.authority(sessionId, context, { binding: this.sources.libraryBinding(sessionId, resource.id) }) });
      }
      if (kinds.has("media")) {
        const media = context?.runtimeRunId ? repo.media.listRuntimeItems({ sessionId, executorBotId: actor!, runtimeRunId: context.runtimeRunId }) : repo.media.list({ sessionId }, actor);
        for (const item of media) {
          if (expected && (expected.type !== "media" || expected.id !== item.asset.reference.id)) continue;
          const reference = expected?.type === "media" ? expected.reference : item.reference;
          const read = context?.runtimeRunId ? repo.media.resolveRuntimeRead({ sessionId, executorBotId: actor!, runtimeRunId: context.runtimeRunId }, item.asset.reference.id, reference)
            : repo.media.resolveUiLease(repo.media.captureUiLease({ sessionId, id: item.asset.reference.id, reference }, actor));
          const text = `${item.asset.reference.name}\n${read.extraction?.text ?? ""}`;
          yield this.candidate("media", item.asset.reference.name, text, read.extraction?.createdAt ?? item.asset.createdAt,
            { type: "media", sessionId, id: item.asset.reference.id, reference, digest: hash(text),
              authorityDigest: this.authority(sessionId, context, { binding: this.sources.mediaBinding(sessionId, item.asset.reference.id) }) });
        }
        if (this.voice && (!expected || expected.type === "voice-transcript")) for (const id of expected?.type === "voice-transcript" ? [expected.id] : this.sources.voiceTasks(sessionId, query, runtimeId)) {
          try {
            const task = this.voice.get({ sessionId, id }, context ? { executorBotId: actor, runtimeRunId: runtimeId } : {});
            if (!task.transcript) continue;
            yield this.candidate("media", `${title} · 语音转写`, task.transcript, task.updatedAt,
              { type: "voice-transcript", sessionId, id, generation: task.inputGeneration, digest: hash(task.transcript), authorityDigest });
          } catch { /* The voice service checks the original source lease. */ }
        }
        if (!expected || expected.type === "realtime-transcript") for (const id of expected?.type === "realtime-transcript" ? [expected.voiceSessionId] : this.sources.realtimeSessions(sessionId, query, runtimeId)) {
          try {
            const snapshot = repo.realtime.snapshot({ sessionId, id }, context ? { executorBotId: actor, runtimeRunId: runtimeId } : {});
            for (const turn of snapshot.turns) if (turn.transcript && (!expected || turn.id === expected.id)) yield this.candidate("media", `${title} · 实时语音转录`, turn.transcript, turn.updatedAt,
              { type: "realtime-transcript", sessionId, id: turn.id, voiceSessionId: id, generation: snapshot.session.inputGeneration, digest: hash(turn.transcript), authorityDigest });
          } catch { /* Revoked/rebound voice admissions do not return text. */ }
        }
      }
      const executors = actor ? [actor] : session.botId ? [session.botId] : repo.getRoomDetail(session.roomId!, sessionId).members.map(member => member.botId);
      if (kinds.has("local-draft")) for (const executorBotId of executors) for (const draft of repo.connectors.listDrafts({ sessionId, executorBotId })) {
        if (expected && (expected.type !== "local-draft" || expected.id !== draft.id)) continue;
        const content = repo.connectors.readDraft({ sessionId, executorBotId, id: draft.id, ...(expected?.type === "local-draft" ? { revisionId: expected.revisionId } : {}) });
        if (!content.authorized) continue;
        const connection = repo.connectors.get(draft.connectionId), binding = repo.connectors.bindings({ sessionId, executorBotId }).find(value => value.connectionId === draft.connectionId);
        const text = JSON.stringify(content.revision.content);
        yield this.candidate("local-draft", `${connection.name} · 草稿`, text, draft.updatedAt,
          { type: "local-draft", sessionId, id: draft.id, revisionId: content.revision.id, executorBotId, digest: content.revision.digest,
            authorityDigest: this.authority(sessionId, context, { bindingId: binding?.id, bindingVersion: binding?.version, authVersion: connection.authVersion }) });
      }
      if (kinds.has("routine") && session.kind === "MAIN" && session.botId) for (const routine of repo.listRoutines().filter(value => value.botId === session.botId && (!expected || value.id === expected.id))) {
        yield this.candidate("routine", routine.name, `${routine.name}\n${routine.prompt}`, routine.updatedAt,
          { type: "routine", sessionId, id: routine.id, version: routine.version, digest: hash([routine.name, routine.prompt, routine.schedule]), authorityDigest });
      }
    }
  }

  query(input: SearchQueryInput, context?: SearchExecutionContext): SearchPage {
    const parsed = searchQuerySchema.parse(input), conversations = this.conversations(parsed, context), kinds = new Set(parsed.kinds ?? SEARCH_KINDS);
    const queryDigest = hash({ query: fold(parsed.query), kinds: [...kinds].sort(), scope: parsed.scope ?? (context ? { kind: "session", sessionId: context.sessionId } : { kind: "all" }), actor: context ?? null });
    const matches: SearchItem[] = [];
    for (const candidate of this.candidates(conversations, kinds, context, parsed.query)) {
      const position = fold(candidate.text).indexOf(fold(parsed.query));
      if (position < 0 && !fold(candidate.item.title).includes(fold(parsed.query))) continue;
      candidate.item.snippet = candidate.text.slice(Math.max(0, position - 80), Math.max(0, position - 80) + 320);
      matches.push(candidate.item);
      if (matches.length > MAX_MATCHES) throw new AevorenBotError("INVALID_REQUEST", "匹配内容过多，请缩小范围或使用更具体的搜索词。");
    }
    matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const snapshot = hash(matches.map(item => item.source));
    let offset = 0;
    if (parsed.cursor) {
      let cursor: unknown;
      try { const bytes = Buffer.from(parsed.cursor, "base64url"); if (bytes.toString("base64url") !== parsed.cursor) throw unavailable(); cursor = JSON.parse(bytes.toString("utf8")); } catch { throw unavailable(); }
      const value = cursor as { query?: unknown; snapshot?: unknown; offset?: unknown } | null;
      if (!value || Object.keys(value).sort().join(",") !== "offset,query,snapshot" || value.query !== queryDigest || value.snapshot !== snapshot || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0 || Number(value.offset) > matches.length) throw unavailable();
      offset = Number(value.offset);
    }
    const limit = parsed.limit ?? 50, items = matches.slice(offset, offset + limit), next = offset + items.length;
    return { items, queryDigest, nextCursor: next < matches.length ? Buffer.from(JSON.stringify({ query: queryDigest, snapshot, offset: next })).toString("base64url") : null };
  }

  open(input: SearchOpenInput, context?: SearchExecutionContext): SearchOpenResult {
    const { source } = searchOpenSchema.parse(input), conversations = this.conversations({ query: "", scope: { kind: "session", sessionId: source.sessionId } }, context);
    const kind: SearchKind = ["voice-transcript", "realtime-transcript"].includes(source.type) ? "media" : source.type as SearchKind;
    for (const candidate of this.candidates(conversations, new Set([kind]), context, undefined, source)) if (hash(candidate.item.source) === hash(source)) return { source: candidate.item.source };
    throw unavailable();
  }
}
