import { createHash } from "node:crypto";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { LibraryChangedEvent, ResourceReference } from "@shared/library-contracts";
import { environmentScopeSchema } from "@shared/environment-schemas";
import { skillScriptReviewSnapshotSchema, skillExecutionInputSchema, skillGrantSchema, skillGrantsSchema, skillRevokeSchema, skillRunSchema,
  skillScriptsSchema, workerSkillInstallSchema } from "@shared/skill-execution-schemas";
import { skillPackageDescriptor, type SkillScriptReviewSnapshot, type SkillExecutionChangedEvent, type SkillExecutionGrant, type SkillGrantInput,
  type SkillGrantsInput, type SkillRevokeInput, type SkillScriptDescriptor, type SkillScriptExecution, type SkillScriptExecutionInput,
  type SkillScriptInterpreter, type SkillScriptRunInput, type SkillScriptsInput, type WorkerSkillInstallRequest } from "@shared/skill-execution-contracts";
import type { AppRepository } from "./database";
import type { LibraryService } from "./library-service";
import type { EnvironmentService } from "./environment-service";
import { approvalReviewDigest } from "./skill-execution-repository";
import { AevorenBotError } from "./errors";

type Commit = <T>(operation: () => T) => T;
function identifier(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function interpreter(path: string): SkillScriptInterpreter | null {
  if (/\.(?:sh|bash)$/i.test(path)) return "bash";
  if (/\.py$/i.test(path)) return "python";
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return "node";
  return null;
}

/** One business path for trusted UI and approval-bound AI calls. No host shell execution. */
export class SkillExecutionService {
  private readonly preparing = new Map<string, Set<AbortController>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly closeController = new AbortController();
  private closing = false;
  constructor(private readonly repository: AppRepository, private readonly library: LibraryService, private readonly environments: EnvironmentService,
    private readonly changed: (event: SkillExecutionChangedEvent) => void = () => undefined) {}

  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new AevorenBotError("TOOL_EXECUTION_CANCELLED"));
    const promise = work(); this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise)); return promise;
  }
  async shutdown(): Promise<void> {
    this.closing = true; this.closeController.abort(new DOMException("Host is closing", "AbortError"));
    for (const grantId of this.preparing.keys()) this.abortPreparing(grantId);
    await Promise.allSettled([...this.pending]);
  }

  private content(scope: EnvironmentScope, reference: ResourceReference) {
    this.repository.assertSessionExecutor(scope.sessionId, scope.executorBotId);
    const content = this.repository.library.resolveReferences(scope.sessionId, [reference], scope.executorBotId)[0]!;
    if (content.resource.kind !== "skill") throw new AevorenBotError("SKILL_SCRIPT_NOT_FOUND"); return content;
  }
  async scripts(input: SkillScriptsInput, signal?: AbortSignal): Promise<SkillScriptDescriptor[]> {
    const parsed = skillScriptsSchema.parse(input), content = this.content(parsed, parsed.reference), result: SkillScriptDescriptor[] = [];
    for (const file of content.revision.files) {
      const kind = file.relativePath.startsWith("scripts/") ? interpreter(file.relativePath) : null;
      if (!kind) continue;
      signal?.throwIfAborted();
      const value = await this.library.readResourceBytes({ sessionId: parsed.sessionId, id: parsed.reference.resourceId, revisionId: parsed.reference.revisionId, path: file.relativePath }, signal, parsed.executorBotId);
      this.content(parsed, parsed.reference); signal?.throwIfAborted();
      if (value.file.sha256 !== file.sha256 || value.bytes.length !== file.size || createHash("sha256").update(value.bytes).digest("hex") !== file.sha256) throw new AevorenBotError("SKILL_PACKAGE_INVALID");
      result.push({ reference: parsed.reference, entryPath: file.relativePath, entrySha256: file.sha256, interpreter: kind, size: file.size, mimeType: file.mimeType });
    }
    return result;
  }
  executionGrants(input: SkillGrantsInput): SkillExecutionGrant[] { return this.repository.skillExecutions.list(skillGrantsSchema.parse(input)); }

  grantExecution(input: SkillGrantInput, signal?: AbortSignal, commit: Commit = work => work()): Promise<SkillExecutionGrant> {
    return this.track(() => this.grant(input, AbortSignal.any([this.closeController.signal, ...(signal ? [signal] : [])]), commit));
  }
  private async grant(input: SkillGrantInput, signal: AbortSignal, commit: Commit): Promise<SkillExecutionGrant> {
    const parsed = skillGrantSchema.parse(input);
    const entries = await this.scripts({ sessionId: parsed.sessionId, executorBotId: parsed.executorBotId, reference: parsed.reference }, signal);
    const entry = entries.find(value => value.entryPath === parsed.entryPath && value.interpreter === parsed.interpreter);
    if (!entry) throw new AevorenBotError("SKILL_SCRIPT_NOT_FOUND");
    await this.environments.assertSkillCapability(parsed, { environmentId: parsed.environmentId, imageDigest: parsed.expectedImageDigest, workerVersion: parsed.expectedWorkerVersion }, signal);
    this.content(parsed, parsed.reference); signal?.throwIfAborted();
    const value = commit(() => this.repository.skillExecutions.grant(parsed, entry.entrySha256));
    this.changed({ sessionId: parsed.sessionId, executorBotId: parsed.executorBotId, grantId: value.id, type: "granted" }); return value;
  }
  async revokeExecution(input: SkillRevokeInput, signal?: AbortSignal, commit: Commit = work => work()): Promise<SkillExecutionGrant> {
    const parsed = skillRevokeSchema.parse(input); signal?.throwIfAborted();
    const value = commit(() => this.repository.skillExecutions.revoke(parsed));
    this.changed({ sessionId: parsed.sessionId, executorBotId: parsed.executorBotId, grantId: value.id, type: "revoked" });
    await this.cancelGrant(value); return value;
  }
  private async cancelGrant(value: SkillExecutionGrant): Promise<void> {
    this.abortPreparing(value.id);
    const scope = { sessionId: value.sessionId, executorBotId: value.executorBotId };
    await Promise.allSettled(this.repository.skillExecutions.executionIds(scope, value.id).map(async id => {
      const execution = this.repository.environments.getExecution(scope, id);
      if (["running", "unknown"].includes(execution.state)) {
        try { await this.environments.cancel({ ...scope, id }); }
        catch {
          const current = this.repository.environments.getExecution(scope, id);
          if (["running", "unknown"].includes(current.state)) this.repository.environments.updateExecution(scope, id, current.version, { state: "unknown", errorCode: "SKILL_CANCEL_UNCONFIRMED" });
          this.changed({ ...scope, grantId: value.id, type: "execution", executionId: id });
        }
      }
    }));
  }
  private abortPreparing(grantId: string): void {
    for (const controller of this.preparing.get(grantId) ?? []) controller.abort(new DOMException("Skill grant revoked", "AbortError"));
  }
  /** Library edits preserve fixed jobs; revocation affects only scripts using that authorization. */
  async libraryChanged(event: LibraryChangedEvent): Promise<void> {
    if (!["unbound", "enabled", "deleted"].includes(event.action)) return;
    const grants = this.repository.skillExecutions.grantsForResource(event.resourceId, event.action === "unbound" ? event.sessionId : undefined);
    const affected = grants.filter(value => {
      try { this.content(value, value.reference); return false; }
      catch { return true; }
    });
    affected.forEach(value => this.abortPreparing(value.id));
    await Promise.allSettled(affected.map(value => this.cancelGrant(value)));
  }

  approvalReview(input: unknown, scope: EnvironmentScope): SkillScriptReviewSnapshot {
    const identity = environmentScopeSchema.parse(scope);
    const supplied = (input ?? {}) as Partial<SkillScriptRunInput>;
    if (supplied.sessionId !== undefined && supplied.sessionId !== identity.sessionId || supplied.executorBotId !== undefined && supplied.executorBotId !== identity.executorBotId) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
    const fields = { ...supplied, ...identity } as Partial<SkillScriptRunInput>; delete fields.clientNonce;
    const parsed = skillRunSchema.omit({ clientNonce: true }).parse(fields);
    const { grant, content } = this.repository.skillExecutions.assertGranted(identity, parsed.grantId, parsed.expectedGrantVersion);
    return skillScriptReviewSnapshotSchema.parse({ kind: "skill-script", resourceName: content.revision.name, revisionNumber: content.revision.number,
      target: { grantId: grant.id, grantVersion: grant.version, environmentId: grant.environmentId, imageDigest: grant.imageDigest, workerVersion: grant.workerVersion,
        reference: grant.reference, entryPath: grant.entryPath, entrySha256: grant.entrySha256, interpreter: grant.interpreter,
        args: parsed.args, cwd: parsed.cwd, timeoutMs: parsed.timeoutMs } });
  }
  assertApprovalReview(snapshot: SkillScriptReviewSnapshot, scope: EnvironmentScope): void {
    const parsed = skillScriptReviewSnapshotSchema.parse(snapshot);
    const current = this.approvalReview({ grantId: parsed.target.grantId, expectedGrantVersion: parsed.target.grantVersion,
      args: parsed.target.args, cwd: parsed.target.cwd, timeoutMs: parsed.target.timeoutMs }, scope);
    if (approvalReviewDigest(current) !== approvalReviewDigest(parsed)) throw new AevorenBotError("APPROVAL_REVIEW_INVALID");
  }

  runScript(input: SkillScriptRunInput, context: { runtimeRunId?: string; signal?: AbortSignal } = {}): Promise<SkillScriptExecution> {
    return this.track(() => this.run(input, { ...context, signal: AbortSignal.any([this.closeController.signal, ...(context.signal ? [context.signal] : [])]) }));
  }
  private async run(input: SkillScriptRunInput, context: { runtimeRunId?: string; signal?: AbortSignal }): Promise<SkillScriptExecution> {
    const parsed = skillRunSchema.parse(input), scope = { sessionId: parsed.sessionId, executorBotId: parsed.executorBotId };
    const review = this.approvalReview(parsed, scope);
    const previous = this.repository.environments.findExecutionByNonce(scope, parsed.clientNonce);
    if (previous) {
      const receipt = this.repository.skillExecutions.execution(scope, previous);
      if (approvalReviewDigest({ ...review, target: { ...review.target, args: receipt.args, cwd: receipt.cwd, timeoutMs: receipt.timeoutMs } }) !== approvalReviewDigest(review)
          || receipt.grantId !== review.target.grantId || receipt.grantVersion !== review.target.grantVersion) throw new AevorenBotError("SKILL_EXECUTION_CONFLICT");
      const result = await this.scriptExecution({ ...scope, id: previous.id }); this.assertApprovalReview(review, scope); context.signal?.throwIfAborted(); return result;
    }
    const controller = new AbortController(), controllers = this.preparing.get(parsed.grantId) ?? new Set<AbortController>();
    controllers.add(controller); this.preparing.set(parsed.grantId, controllers);
    const signal = AbortSignal.any([controller.signal, ...(context.signal ? [context.signal] : [])]);
    const check = (): void => { signal.throwIfAborted(); this.assertApprovalReview(review, scope); };
    try {
      const content = this.content(scope, review.target.reference), files: WorkerSkillInstallRequest["files"] = [];
      for (const path of ["SKILL.md", ...content.revision.files.map(file => file.relativePath)]) {
        check();
        const value = await this.library.readResourceBytes({ sessionId: scope.sessionId, id: review.target.reference.resourceId,
          revisionId: review.target.reference.revisionId, path }, signal, scope.executorBotId); check();
        if (createHash("sha256").update(value.bytes).digest("hex") !== value.file.sha256 || value.bytes.length !== value.file.size) throw new AevorenBotError("SKILL_PACKAGE_INVALID");
        files.push({ ...value.file, dataBase64: value.bytes.toString("base64") });
      }
      const raw = { id: identifier(`skill-package:${JSON.stringify(review.target.reference)}`), reference: review.target.reference, files };
      const install = workerSkillInstallSchema.parse(raw), packageDigest = createHash("sha256").update(skillPackageDescriptor(install)).digest("hex");
      const execution = await this.environments.runSkill(scope, { clientNonce: parsed.clientNonce, install, packageDigest,
        environmentId: review.target.environmentId, imageDigest: review.target.imageDigest, workerVersion: review.target.workerVersion,
        interpreter: review.target.interpreter, entryPath: review.target.entryPath, args: parsed.args, cwd: parsed.cwd, timeoutMs: parsed.timeoutMs },
      { runtimeRunId: context.runtimeRunId ?? null, signal, assertAuthorized: check,
        recordExecution: execution => this.repository.skillExecutions.recordExecution(scope, execution, review) });
      check();
      this.changed({ ...scope, grantId: parsed.grantId, type: "execution", executionId: execution.id });
      return this.repository.skillExecutions.execution(scope, execution);
    } finally {
      controllers.delete(controller); if (!controllers.size) this.preparing.delete(parsed.grantId);
    }
  }
  async scriptExecution(input: SkillScriptExecutionInput): Promise<SkillScriptExecution> {
    const parsed = skillExecutionInputSchema.parse(input);
    const execution = this.repository.environments.getExecution(parsed, parsed.id);
    this.repository.skillExecutions.execution(parsed, execution);
    const actual = await this.environments.getExecution(parsed);
    return this.repository.skillExecutions.execution(parsed, actual);
  }
}
