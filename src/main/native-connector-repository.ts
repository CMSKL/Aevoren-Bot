import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { ConnectorAccessInput, ConnectorBindInput, ConnectorBinding, ConnectorBindingsInput, ConnectorConfigureInput, ConnectorDraft, ConnectorDraftContent,
  ConnectorDraftCreateInput, ConnectorDraftDeleteInput, ConnectorDraftReadInput, ConnectorDraftResult, ConnectorDraftRevision, ConnectorDraftUpdateInput,
  ConnectorIdInput, ConnectorIdentity, ConnectorListInput, ConnectorUnbindInput, NativeConnection } from "@shared/native-connector-contracts";
import { environmentScopeSchema } from "@shared/environment-schemas";
import { connectorAccessSchema, connectorBindSchema, connectorBindingsSchema, connectorConfigureSchema, connectorDraftContentSchema, connectorDraftCreateSchema,
  connectorDraftDeleteSchema, connectorDraftReadSchema, connectorDraftUpdateSchema, connectorIdSchema, connectorIdentitySchema, connectorListSchema, connectorUnbindSchema } from "@shared/native-connector-schemas";
import { NativeConnectorError } from "./native-connectors/types";

export class ConnectorStateError extends Error {
  constructor(public readonly code: "CONNECTOR_NOT_FOUND" | "CONNECTOR_VERSION_CONFLICT" | "CONNECTOR_NOT_GRANTED" | "CONNECTOR_AUTH_CHANGED" | "CONNECTOR_DRAFT_NOT_FOUND" | "CONNECTOR_DRAFT_VERSION_CONFLICT" | "CONNECTOR_DRAFT_CONFLICT", public readonly currentVersion?: number) {
    super(code); this.name = "ConnectorStateError";
  }
}
export const NATIVE_CONNECTOR_MIGRATION = { version: 38, sql: `
  CREATE TABLE native_connections (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('gmail','drive','notion')), name TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('configured','authorizing','connected','revoked','auth-required')),
    version INTEGER NOT NULL CHECK(version>0), auth_version INTEGER NOT NULL CHECK(auth_version>0), account_json TEXT,
    scopes_json TEXT NOT NULL, selected_file_ids_json TEXT NOT NULL, created_file_ids_json TEXT NOT NULL,
    encrypted_config TEXT NOT NULL, encrypted_credentials TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE native_connector_bindings (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES native_connections(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    auth_version INTEGER NOT NULL CHECK(auth_version>0), version INTEGER NOT NULL CHECK(version>0), allowed_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT, UNIQUE(connection_id,session_id,executor_bot_id)
  );
  CREATE TABLE native_connector_drafts (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES native_connections(id), session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, account_id TEXT NOT NULL, auth_version INTEGER NOT NULL,
    client_nonce TEXT NOT NULL, input_digest TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version>0), latest_revision_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    UNIQUE(session_id,executor_bot_id,client_nonce)
  );
  CREATE TABLE native_connector_draft_revisions (
    id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES native_connector_drafts(id) ON DELETE CASCADE, number INTEGER NOT NULL CHECK(number>0),
    digest TEXT NOT NULL, content_json TEXT NOT NULL CHECK(length(content_json)<=1000000), created_at TEXT NOT NULL, UNIQUE(draft_id,number)
  );
  CREATE TRIGGER native_connector_member_removed AFTER DELETE ON room_members
  BEGIN
    UPDATE native_connector_bindings SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1
      WHERE executor_bot_id=OLD.bot_id AND session_id IN (SELECT id FROM sessions WHERE room_id=OLD.room_id) AND revoked_at IS NULL;
    UPDATE native_connector_drafts SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1
      WHERE executor_bot_id=OLD.bot_id AND session_id IN (SELECT id FROM sessions WHERE room_id=OLD.room_id) AND deleted_at IS NULL;
  END;
  CREATE INDEX native_connector_bindings_scope ON native_connector_bindings(session_id,executor_bot_id);
  CREATE INDEX native_connector_drafts_scope ON native_connector_drafts(session_id,executor_bot_id,updated_at);
` } as const;
type ConnectionRow = { id: string; provider: NativeConnection["provider"]; name: string; state: NativeConnection["state"]; version: number; auth_version: number;
  account_json: string | null; scopes_json: string; selected_file_ids_json: string; created_file_ids_json: string; encrypted_config: string;
  encrypted_credentials: string | null; created_at: string; updated_at: string };
type BindingRow = { id: string; connection_id: string; session_id: string; executor_bot_id: string; auth_version: number; version: number;
  allowed_ids_json: string; created_at: string; updated_at: string; revoked_at: string | null };
type DraftRow = { id: string; connection_id: string; session_id: string; executor_bot_id: string; account_id: string; auth_version: number;
  version: number; latest_revision_id: string; created_at: string; updated_at: string; deleted_at: string | null };
type RevisionRow = { id: string; draft_id: string; number: number; digest: string; content_json: string; created_at: string };
function connection(row: ConnectionRow): NativeConnection {
  return { id: row.id, provider: row.provider, name: row.name, state: row.state, version: row.version, authVersion: row.auth_version,
    account: row.account_json ? connectorIdentitySchema.parse(JSON.parse(row.account_json)) : null, scopes: JSON.parse(row.scopes_json) as string[],
    selectedFileIds: JSON.parse(row.selected_file_ids_json) as string[], createdFileIds: JSON.parse(row.created_file_ids_json) as string[], createdAt: row.created_at, updatedAt: row.updated_at };
}
function binding(row: BindingRow): ConnectorBinding {
  return { id: row.id, connectionId: row.connection_id, sessionId: row.session_id, executorBotId: row.executor_bot_id,
    authVersion: row.auth_version, version: row.version, allowedResourceIds: JSON.parse(row.allowed_ids_json) as string[], createdAt: row.created_at, updatedAt: row.updated_at, revokedAt: row.revoked_at };
}
function draft(row: DraftRow): ConnectorDraft { return { id: row.id, connectionId: row.connection_id, sessionId: row.session_id, executorBotId: row.executor_bot_id,
  accountId: row.account_id, authVersion: row.auth_version, version: row.version, latestRevisionId: row.latest_revision_id, createdAt: row.created_at,
  updatedAt: row.updated_at, deletedAt: row.deleted_at, state: "local-draft" }; }
function revision(row: RevisionRow): ConnectorDraftRevision {
  const content = connectorDraftContentSchema.parse(JSON.parse(row.content_json));
  if (createHash("sha256").update(JSON.stringify(content)).digest("hex") !== row.digest) throw new NativeConnectorError("RESPONSE_INVALID");
  return { id: row.id, draftId: row.draft_id, number: row.number, digest: row.digest, content, createdAt: row.created_at };
}
export class NativeConnectorRepository {
  private sequence = 0;
  constructor(private readonly database: DatabaseSync, private readonly assertScope: (scope: EnvironmentScope) => void) {}
  transaction<T>(work: () => T): T {
    const name = `native_connector_${++this.sequence}`; this.database.exec(`SAVEPOINT ${name}`);
    try { const result = work(); this.database.exec(`RELEASE SAVEPOINT ${name}`); return result; }
    catch (error) { this.database.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); throw error; }
  }
  private scope(input: EnvironmentScope): EnvironmentScope {
    const value = environmentScopeSchema.parse({ sessionId: input.sessionId, executorBotId: input.executorBotId }); this.assertScope(value); return value;
  }
  private row(id: string): ConnectionRow {
    const value = this.database.prepare("SELECT * FROM native_connections WHERE id=?").get(id) as ConnectionRow | undefined;
    if (!value) throw new ConnectorStateError("CONNECTOR_NOT_FOUND"); return value;
  }
  assertRuntimeCurrent(runtimeRunId: string, input: EnvironmentScope): void {
    const scope = this.scope(input);
    const current = this.database.prepare(`SELECT r.session_id,r.executor_bot_id,r.state,s.scope_version,c.version FROM runtime_runs r
      JOIN runtime_session_scopes s ON s.runtime_run_id=r.id JOIN conversation_scope_versions c ON c.session_id=r.session_id WHERE r.id=?`)
      .get(runtimeRunId) as { session_id: string; executor_bot_id: string; state: string; scope_version: number; version: number } | undefined;
    if (!current || current.session_id !== scope.sessionId || current.executor_bot_id !== scope.executorBotId || current.scope_version !== current.version
      || !["created", "dispatching", "running", "streaming"].includes(current.state)) throw new ConnectorStateError("CONNECTOR_NOT_GRANTED");
  }
  get(id: string): NativeConnection { return connection(this.row(id)); }
  list(input: ConnectorListInput = {}): NativeConnection[] {
    const parsed = connectorListSchema.parse(input);
    return (this.database.prepare("SELECT * FROM native_connections WHERE (? IS NULL OR provider=?) ORDER BY created_at,id LIMIT 500")
      .all(parsed.provider ?? null, parsed.provider ?? null) as ConnectionRow[]).map(connection);
  }
  /** Main-process only. Never return this record from IPC or product handlers. */
  secrets(id: string): { config: string; credentials: string | null } {
    const value = this.row(id); return { config: value.encrypted_config, credentials: value.encrypted_credentials };
  }
  configure(input: ConnectorConfigureInput, encryptedConfig: string): NativeConnection {
    const parsed = connectorConfigureSchema.parse(input);
    return this.transaction(() => {
      const at = new Date().toISOString();
      if (parsed.id) {
        const previous = this.row(parsed.id);
        if (previous.version !== parsed.expectedVersion) throw new ConnectorStateError("CONNECTOR_VERSION_CONFLICT", previous.version);
        if (previous.provider !== parsed.provider) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
        this.database.prepare(`UPDATE native_connections SET name=?,state='configured',version=version+1,auth_version=auth_version+1,
          account_json=NULL,scopes_json='[]',selected_file_ids_json='[]',created_file_ids_json='[]',encrypted_config=?,encrypted_credentials=NULL,updated_at=? WHERE id=?`)
          .run(parsed.name, encryptedConfig, at, parsed.id);
        return this.get(parsed.id);
      }
      const id = randomUUID();
      this.database.prepare(`INSERT INTO native_connections VALUES(?,?,?,'configured',1,1,NULL,'[]','[]','[]',?,NULL,?,?)`)
        .run(id, parsed.provider, parsed.name, encryptedConfig, at, at); return this.get(id);
    });
  }
  beginAuthorization(input: ConnectorIdInput): NativeConnection {
    const parsed = connectorIdSchema.parse(input), previous = this.row(parsed.id);
    if (previous.version !== parsed.expectedVersion) throw new ConnectorStateError("CONNECTOR_VERSION_CONFLICT", previous.version);
    this.database.prepare(`UPDATE native_connections SET state='authorizing',version=version+1,auth_version=auth_version+1,
      account_json=NULL,scopes_json='[]',selected_file_ids_json='[]',created_file_ids_json='[]',encrypted_credentials=NULL,updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), parsed.id); return this.get(parsed.id);
  }
  completeAuthorization(id: string, expectedAuthVersion: number, identity: ConnectorIdentity, scopes: string[], selectedIds: string[], encryptedCredentials: string): NativeConnection {
    identity = connectorIdentitySchema.parse(identity);
    const value = this.row(id);
    if (value.state !== "authorizing" || value.auth_version !== expectedAuthVersion) throw new ConnectorStateError("CONNECTOR_AUTH_CHANGED");
    this.database.prepare(`UPDATE native_connections SET state='connected',version=version+1,account_json=?,scopes_json=?,
      selected_file_ids_json=?,encrypted_credentials=?,updated_at=? WHERE id=?`)
      .run(JSON.stringify(identity), JSON.stringify(scopes), JSON.stringify(selectedIds), encryptedCredentials, new Date().toISOString(), id);
    return this.get(id);
  }
  endAuthorization(id: string, expectedAuthVersion: number): NativeConnection {
    const value = this.row(id);
    if (value.auth_version === expectedAuthVersion && value.state === "authorizing") this.database.prepare("UPDATE native_connections SET state='auth-required',version=version+1,updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id); return this.get(id);
  }
  revoke(input: ConnectorIdInput): NativeConnection {
    const parsed = connectorIdSchema.parse(input), value = this.row(parsed.id);
    if (value.version !== parsed.expectedVersion) throw new ConnectorStateError("CONNECTOR_VERSION_CONFLICT", value.version);
    this.database.prepare(`UPDATE native_connections SET state='revoked',version=version+1,auth_version=auth_version+1,encrypted_credentials=NULL,updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), parsed.id); return this.get(parsed.id);
  }
  refreshCredentials(id: string, expectedAuthVersion: number, encryptedCredentials: string): void {
    const value = this.row(id); this.assertConnected(value, expectedAuthVersion);
    this.database.prepare("UPDATE native_connections SET encrypted_credentials=? WHERE id=?").run(encryptedCredentials, id);
  }
  requireAuthentication(id: string, expectedAuthVersion: number): void {
    const value = this.row(id);
    if (value.auth_version !== expectedAuthVersion) return;
    this.database.prepare("UPDATE native_connections SET state='auth-required',version=version+1,auth_version=auth_version+1,encrypted_credentials=NULL,updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
  }
  private assertConnected(value: ConnectionRow, expectedAuthVersion: number): void {
    if (value.auth_version !== expectedAuthVersion) throw new ConnectorStateError("CONNECTOR_AUTH_CHANGED");
    if (value.state !== "connected" || !value.account_json || !value.encrypted_credentials) throw new NativeConnectorError("AUTH_REQUIRED");
  }
  bindings(input: ConnectorBindingsInput): ConnectorBinding[] {
    const parsed = connectorBindingsSchema.parse(input), scope = this.scope(parsed);
    return (this.database.prepare(`SELECT * FROM native_connector_bindings WHERE session_id=? AND executor_bot_id=? AND (?=1 OR revoked_at IS NULL) ORDER BY created_at,id`)
      .all(scope.sessionId, scope.executorBotId, Number(parsed.includeRevoked ?? false)) as BindingRow[]).map(binding);
  }
  bind(input: ConnectorBindInput): ConnectorBinding {
    const parsed = connectorBindSchema.parse(input), scope = this.scope(parsed);
    return this.transaction(() => {
      const value = this.row(parsed.connectionId); this.assertConnected(value, parsed.expectedAuthVersion);
      const available = new Set([...JSON.parse(value.selected_file_ids_json) as string[], ...JSON.parse(value.created_file_ids_json) as string[]]);
      const allowed = [...new Set(parsed.allowedResourceIds ?? [])].sort();
      if (value.provider === "drive" ? allowed.some(id => !available.has(id)) : allowed.length > 0) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
      const previous = this.database.prepare("SELECT * FROM native_connector_bindings WHERE connection_id=? AND session_id=? AND executor_bot_id=?")
        .get(value.id, scope.sessionId, scope.executorBotId) as BindingRow | undefined;
      const at = new Date().toISOString();
      if (previous) {
        if (parsed.expectedVersion !== previous.version) throw new ConnectorStateError("CONNECTOR_VERSION_CONFLICT", previous.version);
        this.database.prepare("UPDATE native_connector_bindings SET auth_version=?,version=version+1,allowed_ids_json=?,updated_at=?,revoked_at=NULL WHERE id=?")
          .run(value.auth_version, JSON.stringify(allowed), at, previous.id);
      } else {
        if (parsed.expectedVersion !== undefined) throw new ConnectorStateError("CONNECTOR_VERSION_CONFLICT");
        this.database.prepare("INSERT INTO native_connector_bindings VALUES(?,?,?,?,?,1,?,?,?,NULL)")
          .run(randomUUID(), value.id, scope.sessionId, scope.executorBotId, value.auth_version, JSON.stringify(allowed), at, at);
      }
      return this.bindings({ ...scope, includeRevoked: true }).find(item => item.connectionId === value.id)!;
    });
  }
  unbind(input: ConnectorUnbindInput): ConnectorBinding {
    const parsed = connectorUnbindSchema.parse(input), scope = this.scope(parsed);
    const value = this.database.prepare("SELECT * FROM native_connector_bindings WHERE id=? AND session_id=? AND executor_bot_id=?")
      .get(parsed.id, scope.sessionId, scope.executorBotId) as BindingRow | undefined;
    if (!value) throw new ConnectorStateError("CONNECTOR_NOT_GRANTED");
    if (value.version !== parsed.expectedVersion) throw new ConnectorStateError("CONNECTOR_VERSION_CONFLICT", value.version);
    if (!value.revoked_at) this.database.prepare("UPDATE native_connector_bindings SET version=version+1,updated_at=?,revoked_at=? WHERE id=?")
      .run(new Date().toISOString(), new Date().toISOString(), value.id);
    return this.bindings({ ...scope, includeRevoked: true }).find(item => item.id === value.id)!;
  }
  access(input: ConnectorAccessInput): { connection: NativeConnection; binding: ConnectorBinding } {
    const parsed = connectorAccessSchema.parse({ sessionId: input.sessionId, executorBotId: input.executorBotId, connectionId: input.connectionId,
      expectedAuthVersion: input.expectedAuthVersion, expectedBindingVersion: input.expectedBindingVersion }); const scope = this.scope(parsed);
    const value = this.row(parsed.connectionId); this.assertConnected(value, parsed.expectedAuthVersion);
    const granted = this.bindings(scope).find(item => item.connectionId === value.id);
    if (!granted || granted.authVersion !== value.auth_version || granted.version !== parsed.expectedBindingVersion) throw new ConnectorStateError("CONNECTOR_NOT_GRANTED");
    return { connection: connection(value), binding: granted };
  }
  private validateDraftContent(provider: NativeConnection["provider"], content: ConnectorDraftContent, allowed: string[]): void {
    if (provider !== ({ "gmail-message": "gmail", "drive-text": "drive", "notion-page": "notion" } as const)[content.kind]) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    if (content.kind === "drive-text" && content.targetFileId && !allowed.includes(content.targetFileId)) throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
  }
  private addRevision(draftId: string, number: number, content: ConnectorDraftContent, at: string): string {
    const id = randomUUID(), json = JSON.stringify(content), digest = createHash("sha256").update(json).digest("hex");
    this.database.prepare("INSERT INTO native_connector_draft_revisions VALUES(?,?,?,?,?,?)").run(id, draftId, number, digest, json, at); return id;
  }
  createDraft(input: ConnectorDraftCreateInput): ConnectorDraftResult {
    const parsed = connectorDraftCreateSchema.parse(input);
    return this.transaction(() => {
      const access = this.access(parsed); this.validateDraftContent(access.connection.provider, parsed.content, access.binding.allowedResourceIds);
      const clientNonce = parsed.clientNonce ?? randomUUID();
      const inputDigest = createHash("sha256").update(JSON.stringify({ connectionId: parsed.connectionId, authVersion: parsed.expectedAuthVersion,
        bindingVersion: parsed.expectedBindingVersion, accountId: access.connection.account!.accountId, content: parsed.content })).digest("hex");
      const previous = this.database.prepare("SELECT id,input_digest,deleted_at FROM native_connector_drafts WHERE session_id=? AND executor_bot_id=? AND client_nonce=?")
        .get(parsed.sessionId, parsed.executorBotId, clientNonce) as { id: string; input_digest: string; deleted_at: string | null } | undefined;
      if (previous) {
        if (previous.input_digest !== inputDigest || previous.deleted_at) throw new ConnectorStateError("CONNECTOR_DRAFT_CONFLICT");
        const original = this.database.prepare("SELECT id FROM native_connector_draft_revisions WHERE draft_id=? AND number=1").get(previous.id) as { id: string };
        return this.readDraft({ ...this.scope(parsed), id: previous.id, revisionId: original.id });
      }
      const id = randomUUID(), at = new Date().toISOString(), revisionId = randomUUID();
      this.database.prepare("INSERT INTO native_connector_drafts VALUES(?,?,?,?,?,?,?,?,1,?,?,?,NULL)")
        .run(id, parsed.connectionId, parsed.sessionId, parsed.executorBotId, access.connection.account!.accountId, parsed.expectedAuthVersion, clientNonce, inputDigest, revisionId, at, at);
      const actualRevisionId = this.addRevision(id, 1, parsed.content, at);
      this.database.prepare("UPDATE native_connector_drafts SET latest_revision_id=? WHERE id=?").run(actualRevisionId, id);
      return this.readDraft({ ...this.scope(parsed), id });
    });
  }
  private draftRow(input: ConnectorDraftReadInput): DraftRow {
    const parsed = connectorDraftReadSchema.parse(input), scope = this.scope(parsed);
    const row = this.database.prepare("SELECT * FROM native_connector_drafts WHERE id=? AND session_id=? AND executor_bot_id=? AND deleted_at IS NULL")
      .get(parsed.id, scope.sessionId, scope.executorBotId) as DraftRow | undefined;
    if (!row) throw new ConnectorStateError("CONNECTOR_DRAFT_NOT_FOUND"); return row;
  }
  readDraft(input: ConnectorDraftReadInput): ConnectorDraftResult {
    const row = this.draftRow(input);
    const rev = this.database.prepare("SELECT * FROM native_connector_draft_revisions WHERE id=? AND draft_id=?").get(input.revisionId ?? row.latest_revision_id, row.id) as RevisionRow | undefined;
    if (!rev) throw new ConnectorStateError("CONNECTOR_DRAFT_NOT_FOUND");
    const target = this.get(row.connection_id), currentBinding = this.bindings(this.scope(input)).find(item => item.connectionId === row.connection_id);
    const authorized = target.state === "connected" && target.authVersion === row.auth_version && target.account?.accountId === row.account_id
      && Boolean(currentBinding && !currentBinding.revokedAt && currentBinding.authVersion === row.auth_version);
    return { draft: draft(row), revision: revision(rev), authorized };
  }
  listDrafts(input: EnvironmentScope): ConnectorDraft[] {
    const scope = this.scope(input);
    return (this.database.prepare("SELECT * FROM native_connector_drafts WHERE session_id=? AND executor_bot_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 500")
      .all(scope.sessionId, scope.executorBotId) as DraftRow[]).map(draft);
  }
  draftVersions(input: ConnectorDraftReadInput): Omit<ConnectorDraftRevision, "content">[] {
    const value = this.draftRow(input);
    return (this.database.prepare("SELECT * FROM native_connector_draft_revisions WHERE draft_id=? ORDER BY number DESC").all(value.id) as RevisionRow[])
      .map(row => { const value = revision(row); return { id: value.id, draftId: value.draftId, number: value.number, digest: value.digest, createdAt: value.createdAt }; });
  }
  updateDraft(input: ConnectorDraftUpdateInput): ConnectorDraftResult {
    const parsed = connectorDraftUpdateSchema.parse(input);
    return this.transaction(() => {
      const value = this.draftRow({ ...this.scope(parsed), id: parsed.id });
      if (value.version !== parsed.expectedVersion) throw new ConnectorStateError("CONNECTOR_DRAFT_VERSION_CONFLICT", value.version);
      const target = this.get(value.connection_id), previous = this.readDraft({ ...this.scope(parsed), id: value.id });
      // Local edits remain possible after revocation. They retain the original account
      // and authorization snapshot; they cannot expand a revoked Drive target.
      const allowed = previous.revision.content.kind === "drive-text" && previous.revision.content.targetFileId ? [previous.revision.content.targetFileId] : [];
      const currentBinding = this.bindings(this.scope(parsed)).find(item => item.connectionId === value.connection_id);
      this.validateDraftContent(target.provider, parsed.content, previous.authorized ? currentBinding!.allowedResourceIds : allowed);
      const at = new Date().toISOString(), revId = this.addRevision(value.id, value.version + 1, parsed.content, at);
      this.database.prepare("UPDATE native_connector_drafts SET version=version+1,latest_revision_id=?,updated_at=? WHERE id=?").run(revId, at, value.id);
      return this.readDraft({ ...this.scope(parsed), id: value.id });
    });
  }
  deleteDraft(input: ConnectorDraftDeleteInput): ConnectorDraft {
    const parsed = connectorDraftDeleteSchema.parse(input), value = this.draftRow({ ...this.scope(parsed), id: parsed.id });
    if (value.version !== parsed.expectedVersion) throw new ConnectorStateError("CONNECTOR_DRAFT_VERSION_CONFLICT", value.version);
    const at = new Date().toISOString(); this.database.prepare("UPDATE native_connector_drafts SET deleted_at=?,updated_at=?,version=version+1 WHERE id=?").run(at, at, value.id);
    return { ...draft(value), version: value.version + 1, deletedAt: at, updatedAt: at };
  }
  recoverAuthorizations(): void {
    this.database.prepare("UPDATE native_connections SET state='auth-required',version=version+1,auth_version=auth_version+1,encrypted_credentials=NULL,updated_at=? WHERE state='authorizing'")
      .run(new Date().toISOString());
  }
}
