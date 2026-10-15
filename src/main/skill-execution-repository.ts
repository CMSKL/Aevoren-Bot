import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EnvironmentScope, Execution } from "@shared/environment-contracts";
import type { LibraryContent, ResourceReference } from "@shared/library-contracts";
import type { SkillScriptReviewSnapshot, SkillExecutionGrant, SkillGrantInput, SkillGrantsInput, SkillRevokeInput, SkillScriptExecution } from "@shared/skill-execution-contracts";
import { environmentScopeSchema } from "@shared/environment-schemas";
import { approvalReviewSnapshotSchema, skillScriptReviewSnapshotSchema, skillGrantRecordSchema, skillGrantSchema, skillGrantsSchema, skillRevokeSchema } from "@shared/skill-execution-schemas";
import { AevorenBotError } from "./errors";

export const SKILL_EXECUTION_MIGRATION = { version: 37, sql: `
  ALTER TABLE approval_requests ADD COLUMN review_snapshot_json TEXT CHECK(review_snapshot_json IS NULL OR length(review_snapshot_json)<=400000);
  CREATE TABLE skill_execution_grants (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, executor_bot_id TEXT NOT NULL,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    image_digest TEXT NOT NULL, worker_version TEXT NOT NULL,
    resource_id TEXT NOT NULL REFERENCES library_resources(id), revision_id TEXT NOT NULL REFERENCES library_revisions(id),
    reference_digest TEXT NOT NULL, entry_path TEXT NOT NULL, entry_sha256 TEXT NOT NULL,
    interpreter TEXT NOT NULL CHECK(interpreter IN ('bash','python','node')),
    version INTEGER NOT NULL CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT,
    UNIQUE(environment_id,image_digest,worker_version,resource_id,revision_id,reference_digest,entry_path,interpreter)
  );
  CREATE TABLE skill_script_executions (
    execution_id TEXT PRIMARY KEY REFERENCES environment_executions(id) ON DELETE CASCADE,
    grant_id TEXT NOT NULL REFERENCES skill_execution_grants(id) ON DELETE CASCADE,
    review_json TEXT NOT NULL, input_digest TEXT NOT NULL
  );
  CREATE INDEX skill_execution_grants_scope ON skill_execution_grants(session_id,executor_bot_id,created_at,id);
  CREATE INDEX skill_script_executions_grant ON skill_script_executions(grant_id,execution_id);
` } as const;

type GrantRow = { id: string; session_id: string; executor_bot_id: string; environment_id: string; image_digest: string; worker_version: string;
  resource_id: string; revision_id: string; reference_digest: string; entry_path: string; entry_sha256: string; interpreter: SkillExecutionGrant["interpreter"];
  version: number; created_at: string; updated_at: string; revoked_at: string | null };
function grant(row: GrantRow): SkillExecutionGrant {
  return skillGrantRecordSchema.parse({ id: row.id, sessionId: row.session_id, executorBotId: row.executor_bot_id, environmentId: row.environment_id,
    imageDigest: row.image_digest, workerVersion: row.worker_version, reference: { resourceId: row.resource_id, revisionId: row.revision_id, digest: row.reference_digest },
    entryPath: row.entry_path, entrySha256: row.entry_sha256, interpreter: row.interpreter, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at, revokedAt: row.revoked_at });
}
export function approvalReviewDigest(snapshot: import("@shared/skill-execution-contracts").ApprovalReviewSnapshot): string {
  return createHash("sha256").update(JSON.stringify(approvalReviewSnapshotSchema.parse(snapshot))).digest("hex");
}

export class SkillExecutionRepository {
  private sequence = 0;
  constructor(private readonly database: DatabaseSync, private readonly assertScope: (scope: EnvironmentScope) => void,
    private readonly resolveReference: (scope: EnvironmentScope, reference: ResourceReference) => LibraryContent) {}

  transaction<T>(work: () => T): T {
    const name = `aevoren_skill_${++this.sequence}`; this.database.exec(`SAVEPOINT ${name};`);
    try { const result = work(); this.database.exec(`RELEASE SAVEPOINT ${name};`); return result; }
    catch (error) { this.database.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`); throw error; }
  }
  private scope(input: EnvironmentScope): EnvironmentScope {
    const scope = environmentScopeSchema.parse({ sessionId: input.sessionId, executorBotId: input.executorBotId }); this.assertScope(scope); return scope;
  }
  list(input: SkillGrantsInput): SkillExecutionGrant[] {
    const parsed = skillGrantsSchema.parse(input), scope = this.scope(parsed);
    return (this.database.prepare(`SELECT * FROM skill_execution_grants WHERE session_id=? AND executor_bot_id=?
      AND (? IS NULL OR resource_id=?) AND (?=1 OR revoked_at IS NULL) ORDER BY created_at,id LIMIT 500`)
      .all(scope.sessionId, scope.executorBotId, parsed.resourceId ?? null, parsed.resourceId ?? null, Number(parsed.includeRevoked ?? false)) as GrantRow[]).map(grant);
  }
  get(input: EnvironmentScope, id: string): SkillExecutionGrant {
    const scope = this.scope(input);
    const row = this.database.prepare("SELECT * FROM skill_execution_grants WHERE id=? AND session_id=? AND executor_bot_id=?").get(id, scope.sessionId, scope.executorBotId) as GrantRow | undefined;
    if (!row) throw new AevorenBotError("SKILL_GRANT_NOT_FOUND"); return grant(row);
  }
  assertGranted(input: EnvironmentScope, id: string, expectedVersion: number): { grant: SkillExecutionGrant; content: LibraryContent } {
    const value = this.get(input, id);
    if (value.revokedAt) throw new AevorenBotError("SKILL_GRANT_REVOKED");
    if (value.version !== expectedVersion) throw new AevorenBotError("SKILL_GRANT_VERSION_CONFLICT");
    const environment = this.database.prepare("SELECT id,image_digest,worker_version,state FROM environments WHERE session_id=? AND executor_bot_id=?")
      .get(value.sessionId, value.executorBotId) as { id: string; image_digest: string; worker_version: string; state: string } | undefined;
    if (!environment || environment.id !== value.environmentId || environment.image_digest !== value.imageDigest || environment.worker_version !== value.workerVersion) throw new AevorenBotError("SKILL_ENVIRONMENT_CHANGED");
    if (environment.state !== "running") throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
    const content = this.resolveReference(value, value.reference);
    const entry = content.revision.files.find(file => file.relativePath === value.entryPath);
    if (content.resource.kind !== "skill" || entry?.sha256 !== value.entrySha256) throw new AevorenBotError("SKILL_SCRIPT_NOT_FOUND");
    return { grant: value, content };
  }
  grant(input: SkillGrantInput, entrySha256: string): SkillExecutionGrant {
    const parsed = skillGrantSchema.parse(input), scope = this.scope(parsed);
    return this.transaction(() => {
      const content = this.resolveReference(scope, parsed.reference), entry = content.revision.files.find(file => file.relativePath === parsed.entryPath);
      if (content.resource.kind !== "skill" || entry?.sha256 !== entrySha256) throw new AevorenBotError("SKILL_SCRIPT_NOT_FOUND");
      const environment = this.database.prepare("SELECT id,image_digest,worker_version FROM environments WHERE session_id=? AND executor_bot_id=?")
        .get(scope.sessionId, scope.executorBotId) as { id: string; image_digest: string; worker_version: string } | undefined;
      if (!environment || environment.id !== parsed.environmentId || environment.image_digest !== parsed.expectedImageDigest || environment.worker_version !== parsed.expectedWorkerVersion) throw new AevorenBotError("SKILL_ENVIRONMENT_CHANGED");
      const values = [parsed.environmentId, parsed.expectedImageDigest, parsed.expectedWorkerVersion, parsed.reference.resourceId, parsed.reference.revisionId,
        parsed.reference.digest, parsed.entryPath, parsed.interpreter];
      const previous = this.database.prepare(`SELECT * FROM skill_execution_grants WHERE environment_id=? AND image_digest=? AND worker_version=?
        AND resource_id=? AND revision_id=? AND reference_digest=? AND entry_path=? AND interpreter=?`).get(...values) as GrantRow | undefined;
      if (previous) {
        if (previous.entry_sha256 !== entrySha256) throw new AevorenBotError("SKILL_PACKAGE_INVALID");
        if (parsed.expectedVersion !== undefined && parsed.expectedVersion !== previous.version) throw new AevorenBotError("SKILL_GRANT_VERSION_CONFLICT");
        if (!previous.revoked_at) return grant(previous);
        if (parsed.expectedVersion !== previous.version) throw new AevorenBotError("SKILL_GRANT_VERSION_CONFLICT");
        this.database.prepare("UPDATE skill_execution_grants SET revoked_at=NULL,version=version+1,updated_at=? WHERE id=?").run(new Date().toISOString(), previous.id);
        return this.get(scope, previous.id);
      }
      if (parsed.expectedVersion !== undefined) throw new AevorenBotError("SKILL_GRANT_VERSION_CONFLICT");
      const id = randomUUID(), at = new Date().toISOString();
      this.database.prepare(`INSERT INTO skill_execution_grants(id,session_id,executor_bot_id,environment_id,image_digest,worker_version,
        resource_id,revision_id,reference_digest,entry_path,entry_sha256,interpreter,version,created_at,updated_at,revoked_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,NULL)`).run(id, scope.sessionId, scope.executorBotId, parsed.environmentId, parsed.expectedImageDigest,
        parsed.expectedWorkerVersion, parsed.reference.resourceId, parsed.reference.revisionId, parsed.reference.digest, parsed.entryPath, entrySha256, parsed.interpreter, at, at);
      return this.get(scope, id);
    });
  }
  revoke(input: SkillRevokeInput): SkillExecutionGrant {
    const parsed = skillRevokeSchema.parse(input);
    return this.transaction(() => {
      const value = this.get(parsed, parsed.id);
      if (value.version !== parsed.expectedVersion) throw new AevorenBotError("SKILL_GRANT_VERSION_CONFLICT");
      if (!value.revokedAt) this.database.prepare("UPDATE skill_execution_grants SET revoked_at=?,updated_at=?,version=version+1 WHERE id=?")
        .run(new Date().toISOString(), new Date().toISOString(), value.id);
      return this.get(parsed, value.id);
    });
  }
  recordExecution(scope: EnvironmentScope, execution: Execution, snapshot: SkillScriptReviewSnapshot): void {
    const review = skillScriptReviewSnapshotSchema.parse(snapshot); this.assertGranted(scope, review.target.grantId, review.target.grantVersion);
    const row = this.database.prepare("SELECT environment_id FROM environment_executions WHERE id=?").get(execution.id) as { environment_id: string } | undefined;
    if (!row || row.environment_id !== review.target.environmentId || execution.environmentId !== row.environment_id) throw new AevorenBotError("ENVIRONMENT_SCOPE_INVALID");
    const digest = approvalReviewDigest(review), previous = this.database.prepare("SELECT input_digest FROM skill_script_executions WHERE execution_id=?")
      .get(execution.id) as { input_digest: string } | undefined;
    if (previous) { if (previous.input_digest !== digest) throw new AevorenBotError("SKILL_EXECUTION_CONFLICT"); return; }
    this.database.prepare("INSERT INTO skill_script_executions(execution_id,grant_id,review_json,input_digest) VALUES(?,?,?,?)")
      .run(execution.id, review.target.grantId, JSON.stringify(review), digest);
  }
  execution(input: EnvironmentScope, execution: Execution): SkillScriptExecution {
    const scope = this.scope(input);
    const row = this.database.prepare(`SELECT s.review_json,s.input_digest FROM skill_script_executions s
      JOIN environment_executions e ON e.id=s.execution_id JOIN environments env ON env.id=e.environment_id
      WHERE s.execution_id=? AND env.session_id=? AND env.executor_bot_id=?`).get(execution.id, scope.sessionId, scope.executorBotId) as { review_json: string; input_digest: string } | undefined;
    if (!row) throw new AevorenBotError("ENVIRONMENT_EXECUTION_NOT_FOUND");
    const review = skillScriptReviewSnapshotSchema.parse(JSON.parse(row.review_json));
    if (approvalReviewDigest(review) !== row.input_digest) throw new AevorenBotError("SKILL_EXECUTION_CONFLICT");
    return { ...review.target, execution };
  }
  executionIds(input: EnvironmentScope, grantId: string): string[] {
    this.get(input, grantId);
    return (this.database.prepare("SELECT execution_id FROM skill_script_executions WHERE grant_id=?").all(grantId) as { execution_id: string }[]).map(row => row.execution_id);
  }
  /** Host-only invalidation inventory. Every subsequent access still verifies its own Scope. */
  grantsForResource(resourceId: string, sessionId?: string): SkillExecutionGrant[] {
    return (this.database.prepare("SELECT * FROM skill_execution_grants WHERE resource_id=? AND (? IS NULL OR session_id=?)")
      .all(resourceId, sessionId ?? null, sessionId ?? null) as GrantRow[]).map(grant);
  }
}
