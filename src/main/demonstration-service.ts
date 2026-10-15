import type { BrowserScope } from "@shared/browser-contracts";
import type { DemonstrationCapture, DemonstrationDraft, DemonstrationDraftInput, DemonstrationPublishInput, DemonstrationRecordInput, DemonstrationUpdateInput } from "@shared/demonstration-contracts";
import type { LibraryContent } from "@shared/library-contracts";
import { demonstrationDeleteSchema, demonstrationCaptureSchema, demonstrationDraftInputSchema, demonstrationPublishSchema, demonstrationRecordSchema, demonstrationSnapshotSchema, demonstrationUpdateSchema } from "@shared/demonstration-schemas";
import type { AppRepository } from "./database";
import type { BrowserService, BrowserCallContext } from "./browser-service";
import type { LibraryService } from "./library-service";
import { AevorenBotError } from "./errors";
export class DemonstrationService {
  constructor(private readonly repository: AppRepository, private readonly browser: Pick<BrowserService, "demonstrationRequest">, private readonly library: LibraryService) {}
  private current(input: BrowserScope, context: BrowserCallContext): void { context.signal?.throwIfAborted(); this.repository.assertSessionExecutor(input.sessionId, input.executorBotId); if (context.runtimeRunId) { const run = this.repository.getRuntimeRun(context.runtimeRunId); if (run.sessionId !== input.sessionId || run.executorBotId !== input.executorBotId || !["running", "streaming", "dispatching"].includes(run.state)) throw new AevorenBotError("TOOL_EXECUTION_CANCELLED"); } }
  async status(input: BrowserScope, context: BrowserCallContext = {}): Promise<DemonstrationCapture | null> { this.current(input, context); const result = await this.browser.demonstrationRequest(input, "status", undefined, context); this.current(input, context); if (result === null) return null; const capture = demonstrationCaptureSchema.parse(result); if (capture.browserSessionId !== this.repository.browsers.get(input)?.id) throw new AevorenBotError("BROWSER_SCOPE_INVALID"); return capture; }
  async start(input: DemonstrationRecordInput & { id: string }, context: BrowserCallContext = {}): Promise<DemonstrationCapture> { const p = demonstrationRecordSchema.parse(input); this.current(p, context); if (context.actor === "ai") throw new AevorenBotError("UNTRUSTED_RENDERER"); const result = await this.browser.demonstrationRequest(p, "start", p, context); this.current(p, context); return demonstrationCaptureSchema.parse(result); }
  async stop(input: DemonstrationRecordInput & { id: string }, context: BrowserCallContext = {}): Promise<DemonstrationDraft> { const p = demonstrationRecordSchema.parse(input); this.current(p, context); if (context.actor === "ai") throw new AevorenBotError("UNTRUSTED_RENDERER"); const raw = await this.browser.demonstrationRequest(p, "stop", p, context); this.current(p, context); const snapshot = demonstrationSnapshotSchema.parse(raw); const browser = this.repository.browsers.get(p); if (snapshot.id !== p.id || snapshot.browserSessionId !== browser?.id || snapshot.epoch > p.expectedEpoch) throw new AevorenBotError("BROWSER_SCOPE_INVALID"); return this.repository.demonstrations.create(p, snapshot); }
  async discard(input: DemonstrationRecordInput & { id: string }, context: BrowserCallContext = {}): Promise<boolean> { const p = demonstrationRecordSchema.parse(input); this.current(p, context); if (context.actor === "ai") throw new AevorenBotError("UNTRUSTED_RENDERER"); const result = await this.browser.demonstrationRequest(p, "discard", p, context); this.current(p, context); return result === true; }
  drafts(input: BrowserScope, context: BrowserCallContext = {}): DemonstrationDraft[] { this.current(input, context); return this.repository.demonstrations.list(input); }
  readDraft(input: DemonstrationDraftInput, context: BrowserCallContext = {}): DemonstrationDraft { const p = demonstrationDraftInputSchema.parse(input); this.current(p, context); return this.repository.demonstrations.read(p, p.id); }
  deleteDraft(input: BrowserScope & { id: string; expectedVersion: number }, context: BrowserCallContext = {}): boolean { const p = demonstrationDeleteSchema.parse(input); this.current(p, context); return this.repository.demonstrations.delete(p); }
  updateDraft(input: DemonstrationUpdateInput, context: BrowserCallContext = {}): DemonstrationDraft { const p = demonstrationUpdateSchema.parse(input); this.current(p, context); return this.repository.demonstrations.update(p); }
  publish(input: DemonstrationPublishInput, context: BrowserCallContext = {}): LibraryContent {
    const p = demonstrationPublishSchema.parse(input); this.current(p, context);
    return this.repository.demonstrationsTransaction(() => {
      const draft = this.repository.demonstrations.assertPublish(p);
      if (draft.publishedResourceId) return this.repository.library.read({ sessionId: p.sessionId, id: draft.publishedResourceId, includeDisabled: true });
      const created = this.library.create({ sessionId: p.sessionId, kind: "skill", name: draft.name, description: "用户示范生成，已审阅后发布；初始停用，需明确启用。", body: draft.body }, context.signal, p.executorBotId);
      this.repository.library.setEnabled({ sessionId: p.sessionId, id: created.resource.id, expectedVersion: created.resource.version, enabled: false }, p.executorBotId);
      this.repository.demonstrations.published(p, created.resource.id);
      return this.repository.library.read({ sessionId: p.sessionId, id: created.resource.id, includeDisabled: true });
    });
  }
}
