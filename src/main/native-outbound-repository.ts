import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { ExternalDraftReviewSnapshot, NativeOutboundIdInput, NativeOutboundIntent, NativeOutboundPrepareInput, NativeWriteGrant, NativeWriteGrantInput, NativeWriteRevokeInput } from "@shared/native-outbound-contracts";
import { externalDraftReviewSnapshotSchema, nativeOutboundIdSchema, nativeOutboundPrepareSchema, nativeWriteGrantSchema, nativeWriteRevokeSchema } from "@shared/native-outbound-schemas";
import { environmentScopeSchema } from "@shared/environment-schemas";
import type { NativeConnectorRepository } from "./native-connector-repository";
import { ConnectorStateError } from "./native-connector-repository";
import { NativeConnectorError } from "./native-connectors/types";
export const NATIVE_OUTBOUND_MIGRATION = { version: 39, foreignKeysOff: true, sql: `
      CREATE TABLE runtime_runs_v39 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        client_nonce TEXT NOT NULL REFERENCES send_journal(client_nonce) ON DELETE CASCADE,
        execution_key TEXT NOT NULL,
        executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        state TEXT NOT NULL CHECK (state IN (
          'created', 'dispatching', 'running', 'streaming', 'cancel-requested',
          'completed', 'failed', 'cancelled', 'interrupted'
        )),
        route TEXT NOT NULL CHECK (route IN ('fake', 'openai-compatible', 'codex-cli', 'claude-cli', 'ollama-cli', 'acp-cli','host-outbound')),
        provider_instance_id TEXT NOT NULL,
        provider_model_id TEXT NOT NULL,
        input_generation INTEGER NOT NULL,
        input_seq INTEGER NOT NULL,
        prompt_cutoff_seq INTEGER NOT NULL,
        assistant_entry_id TEXT REFERENCES transcript_entries(id) ON DELETE SET NULL,
        provider_request_id TEXT,
        prompt_manifest_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        last_activity_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (execution_key, attempt_no)
      );
      INSERT INTO runtime_runs_v39
      SELECT id, session_id, client_nonce, execution_key, executor_bot_id, attempt_no, state, route,
             provider_instance_id, provider_model_id, input_generation, input_seq, prompt_cutoff_seq,
             assistant_entry_id, provider_request_id, prompt_manifest_json, version, last_error_code,
             created_at, accepted_at, last_activity_at, finished_at
      FROM runtime_runs;
      DROP TABLE runtime_runs;
      ALTER TABLE runtime_runs_v39 RENAME TO runtime_runs;

  CREATE UNIQUE INDEX runtime_one_active_per_executor ON runtime_runs(session_id,executor_bot_id)
    WHERE state IN ('created','dispatching','running','streaming','cancel-requested');
  CREATE TRIGGER initialize_runtime_scope AFTER INSERT ON runtime_runs BEGIN
    INSERT INTO runtime_session_scopes(runtime_run_id,scope_version)
      SELECT NEW.id,version FROM conversation_scope_versions WHERE session_id=NEW.session_id;
  END;

  CREATE TABLE native_write_grants (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,executor_bot_id TEXT NOT NULL,connection_id TEXT NOT NULL,
    account_id TEXT NOT NULL,auth_version INTEGER NOT NULL,operation TEXT NOT NULL,target_ids_json TEXT NOT NULL,version INTEGER NOT NULL,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,revoked_at TEXT,UNIQUE(session_id,executor_bot_id,connection_id,operation,target_ids_json));
  CREATE TABLE native_outbound_intents (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,executor_bot_id TEXT NOT NULL,connection_id TEXT NOT NULL,
    provider TEXT NOT NULL,account_json TEXT NOT NULL,auth_version INTEGER NOT NULL,grant_id TEXT NOT NULL,grant_version INTEGER NOT NULL,
    draft_id TEXT NOT NULL,revision_id TEXT NOT NULL,revision_digest TEXT NOT NULL,operation TEXT NOT NULL,state TEXT NOT NULL
      CHECK(state IN ('prepared','dispatching','confirmed','rejected','unknown')),version INTEGER NOT NULL,
    review_json TEXT NOT NULL CHECK(length(review_json)<=400000),review_digest TEXT NOT NULL,dispatch_attempt_id TEXT,message_id TEXT,
    reserved_resource_id TEXT,result_resource_id TEXT,proof_digest TEXT,last_error_code TEXT,wire_digest TEXT,hint_json TEXT,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,retired_at TEXT,UNIQUE(revision_id,operation));
  CREATE INDEX native_outbound_scope ON native_outbound_intents(session_id,executor_bot_id,created_at);
  CREATE TRIGGER native_write_member_removed AFTER DELETE ON room_members BEGIN
    UPDATE native_write_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1
      WHERE executor_bot_id=OLD.bot_id AND session_id IN (SELECT id FROM sessions WHERE room_id=OLD.room_id) AND revoked_at IS NULL;
    UPDATE native_outbound_intents SET retired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE executor_bot_id=OLD.bot_id AND session_id IN (SELECT id FROM sessions WHERE room_id=OLD.room_id) AND retired_at IS NULL;
  END;
` } as const;
type GrantRow = {id:string;session_id:string;executor_bot_id:string;connection_id:string;account_id:string;auth_version:number;operation:NativeWriteGrant["operation"];target_ids_json:string;version:number;created_at:string;updated_at:string;revoked_at:string|null};
type IntentRow = {id:string;session_id:string;executor_bot_id:string;connection_id:string;provider:NativeOutboundIntent["provider"];account_json:string;auth_version:number;grant_id:string;grant_version:number;draft_id:string;revision_id:string;revision_digest:string;operation:NativeOutboundIntent["operation"];state:NativeOutboundIntent["state"];version:number;review_json:string;review_digest:string;dispatch_attempt_id:string|null;message_id:string|null;reserved_resource_id:string|null;result_resource_id:string|null;proof_digest:string|null;last_error_code:string|null;wire_digest:string|null;hint_json:string|null;created_at:string;updated_at:string;retired_at:string|null};
const hash=(value:unknown):string=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function grant(row:GrantRow):NativeWriteGrant{return {id:row.id,sessionId:row.session_id,executorBotId:row.executor_bot_id,connectionId:row.connection_id,accountId:row.account_id,authVersion:row.auth_version,operation:row.operation,targetIds:JSON.parse(row.target_ids_json) as string[],version:row.version,createdAt:row.created_at,updatedAt:row.updated_at,revokedAt:row.revoked_at};}
function intent(row:IntentRow):NativeOutboundIntent {const review=externalDraftReviewSnapshotSchema.parse(JSON.parse(row.review_json));if(hash(review)!==row.review_digest)throw new NativeConnectorError("RESPONSE_INVALID");return {id:row.id,sessionId:row.session_id,executorBotId:row.executor_bot_id,connectionId:row.connection_id,provider:row.provider,account:review.account,authVersion:row.auth_version,grantId:row.grant_id,grantVersion:row.grant_version,draftId:row.draft_id,revisionId:row.revision_id,revisionDigest:row.revision_digest,operation:row.operation,state:row.state,version:row.version,review,dispatchAttemptId:row.dispatch_attempt_id,messageId:row.message_id,reservedResourceId:row.reserved_resource_id,resultResourceId:row.result_resource_id,proofDigest:row.proof_digest,lastErrorCode:row.last_error_code,createdAt:row.created_at,updatedAt:row.updated_at};}
export class NativeOutboundRepository {
  constructor(private readonly database:DatabaseSync,private readonly connectors:NativeConnectorRepository,private readonly assertScope:(scope:EnvironmentScope)=>void){}
  private scope(input:EnvironmentScope):EnvironmentScope{const scope=environmentScopeSchema.parse({sessionId:input.sessionId,executorBotId:input.executorBotId});this.assertScope(scope);return scope;}
  grants(input:EnvironmentScope):NativeWriteGrant[]{const scope=this.scope(input);return (this.database.prepare("SELECT * FROM native_write_grants WHERE session_id=? AND executor_bot_id=? ORDER BY created_at,id").all(scope.sessionId,scope.executorBotId) as GrantRow[]).map(grant);}
  grant(input:NativeWriteGrantInput):NativeWriteGrant {const value=nativeWriteGrantSchema.parse(input),scope=this.scope(value),connection=this.connectors.get(value.connectionId);
    if(connection.state!=="connected"||connection.authVersion!==value.expectedAuthVersion||!connection.account)throw new ConnectorStateError("CONNECTOR_AUTH_CHANGED");
    if(value.operation==="gmail-send"&&(connection.provider!=="gmail"||!connection.scopes.includes("https://www.googleapis.com/auth/gmail.send")))throw new NativeConnectorError("AUTH_REQUIRED");
    if(value.operation.startsWith("drive-")&&connection.provider!=="drive"||value.operation==="notion-create-page"&&connection.provider!=="notion")throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    const targets=[...new Set(value.targetIds)].sort();
    if(value.operation==="gmail-send"?targets.length===0||targets.some(id=>!/^\S+@\S+\.\S+$/u.test(id)):value.operation==="drive-create-text"?targets.length!==0:targets.length===0)throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    if(value.operation==="drive-update-text"&&targets.some(id=>![...connection.selectedFileIds,...connection.createdFileIds].includes(id)))throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    const previous=this.database.prepare("SELECT * FROM native_write_grants WHERE session_id=? AND executor_bot_id=? AND connection_id=? AND operation=? AND target_ids_json=?")
      .get(scope.sessionId,scope.executorBotId,connection.id,value.operation,JSON.stringify(targets)) as GrantRow|undefined;const at=new Date().toISOString();
    if(previous){if(previous.version!==value.expectedVersion)throw new ConnectorStateError("CONNECTOR_VERSION_CONFLICT",previous.version);this.database.prepare("UPDATE native_write_grants SET account_id=?,auth_version=?,version=version+1,updated_at=?,revoked_at=NULL WHERE id=?").run(connection.account.accountId,connection.authVersion,at,previous.id);return this.grants(scope).find(item=>item.id===previous.id)!;}
    if(value.expectedVersion!==undefined)throw new ConnectorStateError("CONNECTOR_VERSION_CONFLICT");const id=randomUUID();this.database.prepare("INSERT INTO native_write_grants VALUES(?,?,?,?,?,?,?,?,1,?,?,NULL)").run(id,scope.sessionId,scope.executorBotId,connection.id,connection.account.accountId,connection.authVersion,value.operation,JSON.stringify(targets),at,at);return this.grants(scope).find(item=>item.id===id)!;
  }
  revoke(input:NativeWriteRevokeInput):NativeWriteGrant{const value=nativeWriteRevokeSchema.parse(input),scope=this.scope(value),current=this.grants(scope).find(item=>item.id===value.id);if(!current)throw new ConnectorStateError("CONNECTOR_NOT_GRANTED");if(current.version!==value.expectedVersion)throw new ConnectorStateError("CONNECTOR_VERSION_CONFLICT",current.version);const at=new Date().toISOString();if(!current.revokedAt)this.database.prepare("UPDATE native_write_grants SET version=version+1,updated_at=?,revoked_at=? WHERE id=?").run(at,at,current.id);return this.grants(scope).find(item=>item.id===current.id)!;}
  assertGrant(scope:EnvironmentScope,id:string,expectedVersion:number):NativeWriteGrant{const current=this.grants(scope).find(item=>item.id===id);if(!current||current.revokedAt||current.version!==expectedVersion)throw new ConnectorStateError("CONNECTOR_NOT_GRANTED");const connection=this.connectors.get(current.connectionId);if(connection.state!=="connected"||connection.authVersion!==current.authVersion||connection.account?.accountId!==current.accountId)throw new ConnectorStateError("CONNECTOR_AUTH_CHANGED");return current;}
  prepare(input:NativeOutboundPrepareInput,identity:{id:string;reservedResourceId?:string;observedTargetVersion?:string},targetDigest:(review:Omit<ExternalDraftReviewSnapshot,"targetDigest">)=>string):NativeOutboundIntent{
    const parsed=nativeOutboundPrepareSchema.parse(input),scope=this.scope(parsed),permission=this.assertGrant(scope,parsed.grantId,parsed.expectedGrantVersion),draft=this.connectors.readDraft({...scope,id:parsed.draftId,revisionId:parsed.revisionId});
    if(draft.draft.version!==parsed.expectedDraftVersion||draft.draft.latestRevisionId!==parsed.revisionId)throw new ConnectorStateError("CONNECTOR_DRAFT_VERSION_CONFLICT",draft.draft.version);
    if(draft.draft.connectionId!==permission.connectionId||draft.draft.authVersion!==permission.authVersion||draft.draft.accountId!==permission.accountId)throw new ConnectorStateError("CONNECTOR_AUTH_CHANGED");
    const content=draft.revision.content;const operation=content.kind==="gmail-message"?"gmail-send":content.kind==="notion-page"?"notion-create-page":content.targetFileId?"drive-update-text":"drive-create-text";
    if(operation!==permission.operation)throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");const targets=content.kind==="gmail-message"?[...new Set([...content.to,...content.cc])].sort():content.kind==="notion-page"?[content.parentPageId]:content.targetFileId?[content.targetFileId]:[];
    if(targets.some(id=>!permission.targetIds.includes(id)))throw new NativeConnectorError("RESOURCE_NOT_ALLOWED");
    const existing=this.database.prepare("SELECT * FROM native_outbound_intents WHERE revision_id=? AND operation=?").get(parsed.revisionId,operation) as IntentRow|undefined;if(existing){const old=intent(existing);if(old.sessionId!==scope.sessionId||old.executorBotId!==scope.executorBotId||old.revisionDigest!==draft.revision.digest)throw new ConnectorStateError("CONNECTOR_DRAFT_CONFLICT");return old;}
    const connection=this.connectors.get(permission.connectionId),id=identity.id,at=new Date().toISOString();const base:Omit<ExternalDraftReviewSnapshot,"targetDigest">={kind:"external-draft",connectionName:connection.name,provider:connection.provider,account:connection.account!,connectionId:connection.id,authVersion:connection.authVersion,grantId:permission.id,grantVersion:permission.version,draftId:draft.draft.id,revisionId:draft.revision.id,revisionNumber:draft.revision.number,revisionDigest:draft.revision.digest,operation,targetIds:targets,content,intentId:id,expectedIntentVersion:1,...(identity.observedTargetVersion?{observedTargetVersion:identity.observedTargetVersion}:{})};
    const review=externalDraftReviewSnapshotSchema.parse({...base,targetDigest:targetDigest(base)});
    this.database.prepare(`INSERT INTO native_outbound_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',1,?,?,NULL,?,?,NULL,NULL,NULL,NULL,NULL,?,?,NULL)`).run(id,scope.sessionId,scope.executorBotId,connection.id,connection.provider,JSON.stringify(connection.account),connection.authVersion,permission.id,permission.version,draft.draft.id,draft.revision.id,draft.revision.digest,operation,JSON.stringify(review),hash(review),operation==="gmail-send"?`<${id}@aevoren.local>`:null,identity.reservedResourceId??null,at,at);return this.get({...scope,id,expectedVersion:1});
  }
  private row(id:string):IntentRow{const row=this.database.prepare("SELECT * FROM native_outbound_intents WHERE id=?").get(id) as IntentRow|undefined;if(!row)throw new ConnectorStateError("CONNECTOR_DRAFT_NOT_FOUND");return row;}
  get(input:NativeOutboundIdInput):NativeOutboundIntent{const parsed=nativeOutboundIdSchema.parse(input),scope=this.scope(parsed),value=this.current(scope,parsed.id);if(value.version!==parsed.expectedVersion)throw new ConnectorStateError("CONNECTOR_VERSION_CONFLICT",value.version);return value;}
  current(scope:EnvironmentScope,id:string):NativeOutboundIntent{const row=this.row(id);this.scope(scope);if(row.retired_at||row.session_id!==scope.sessionId||row.executor_bot_id!==scope.executorBotId)throw new ConnectorStateError("CONNECTOR_NOT_GRANTED");return intent(row);}
  list(input:EnvironmentScope):NativeOutboundIntent[]{const scope=this.scope(input);return (this.database.prepare("SELECT * FROM native_outbound_intents WHERE session_id=? AND executor_bot_id=? AND retired_at IS NULL ORDER BY created_at DESC,id LIMIT 500").all(scope.sessionId,scope.executorBotId) as IntentRow[]).map(intent);}
  assertReview(input:EnvironmentScope,review:ExternalDraftReviewSnapshot):NativeOutboundIntent{const scope=this.scope(input),parsed=externalDraftReviewSnapshotSchema.parse(review),value=this.current(scope,parsed.intentId);if(hash(value.review)!==hash(parsed))throw new NativeConnectorError("RESPONSE_INVALID");this.assertGrant(scope,value.grantId,value.grantVersion);const draft=this.connectors.readDraft({...scope,id:value.draftId,revisionId:value.revisionId});if(draft.draft.latestRevisionId!==value.revisionId||draft.revision.digest!==value.revisionDigest)throw new ConnectorStateError("CONNECTOR_DRAFT_VERSION_CONFLICT",draft.draft.version);return value;}
  reserve(scope:EnvironmentScope,id:string,resourceId:string):NativeOutboundIntent{const value=this.current(scope,id);if(value.state!=="prepared")throw new ConnectorStateError("CONNECTOR_DRAFT_CONFLICT");if(value.reservedResourceId&&value.reservedResourceId!==resourceId)throw new ConnectorStateError("CONNECTOR_DRAFT_CONFLICT");this.database.prepare("UPDATE native_outbound_intents SET reserved_resource_id=? WHERE id=?").run(resourceId,id);return this.current(scope,id);}
  dispatch(scope:EnvironmentScope,id:string,expectedVersion:number,wireDigest:string,attempt:string):NativeOutboundIntent{const value=this.get({...scope,id,expectedVersion});this.assertReview(scope,value.review);if(value.state!=="prepared")throw new ConnectorStateError("CONNECTOR_DRAFT_CONFLICT");const at=new Date().toISOString();const changed=this.database.prepare("UPDATE native_outbound_intents SET state='dispatching',version=version+1,dispatch_attempt_id=?,wire_digest=?,updated_at=? WHERE id=? AND state='prepared' AND version=?").run(attempt,wireDigest,at,id,expectedVersion);if(Number(changed.changes)!==1)throw new ConnectorStateError("CONNECTOR_DRAFT_CONFLICT");return this.current(scope,id);}
  settle(id:string,state:"confirmed"|"rejected"|"unknown",result:{resourceId?:string;proofDigest?:string;code?:string;hint?:unknown}={}):NativeOutboundIntent{const old=intent(this.row(id));if(old.state!=="dispatching"&&!(old.state==="unknown"&&state==="confirmed")&&!(old.state==="prepared"&&state==="rejected"))return old;const at=new Date().toISOString();this.database.prepare("UPDATE native_outbound_intents SET state=?,version=version+1,result_resource_id=?,proof_digest=?,last_error_code=?,hint_json=?,updated_at=? WHERE id=?").run(state,result.resourceId??old.resultResourceId,result.proofDigest??old.proofDigest,result.code??null,result.hint?JSON.stringify(result.hint):null,at,id);return intent(this.row(id));}
  reject(input:NativeOutboundIdInput):NativeOutboundIntent{const value=this.get(input);if(value.state!=="prepared")throw new ConnectorStateError("CONNECTOR_DRAFT_CONFLICT");return this.settle(value.id,"rejected",{code:"USER_REJECTED"});}
  byRevision(scope:EnvironmentScope,revisionId:string):NativeOutboundIntent|null{this.scope(scope);const row=this.database.prepare("SELECT * FROM native_outbound_intents WHERE revision_id=? AND session_id=? AND executor_bot_id=? AND retired_at IS NULL").get(revisionId,scope.sessionId,scope.executorBotId) as IntentRow|undefined;return row?intent(row):null;}
  /** Host-only durable receipt lookup, including retired Scopes. */
  listInternal(id:string):NativeOutboundIntent{return intent(this.row(id));}
  hint(id:string):unknown{const row=this.row(id);return row.hint_json?JSON.parse(row.hint_json):undefined;}
  recover():void{this.database.prepare("UPDATE native_outbound_intents SET state='unknown',version=version+1,last_error_code='INTERRUPTED_AFTER_DISPATCH',updated_at=? WHERE state='dispatching'").run(new Date().toISOString());}
}
