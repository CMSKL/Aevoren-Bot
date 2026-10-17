import { createHash,randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { McpScopedTool,McpToolGrant,McpToolGrantInput,McpWriteIdInput,McpWriteIntent,McpWritePrepareInput,McpWriteReview } from "@shared/mcp-write-contracts";
import { environmentScopeSchema } from "@shared/environment-schemas";
import { mcpToolGrantSchema,mcpWriteIdSchema,mcpWritePrepareSchema,mcpWriteReviewSchema } from "@shared/mcp-write-schemas";
import { AevorenBotError } from "./errors";
export const MCP_WRITE_MIGRATION={version:41,foreignKeysOff:true,sql:`
      CREATE TABLE runtime_runs_v41 (
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
        route TEXT NOT NULL CHECK (route IN ('fake', 'openai-compatible', 'codex-cli', 'claude-cli', 'ollama-cli', 'acp-cli','host-outbound','host-mcp')),
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
      INSERT INTO runtime_runs_v41
      SELECT id, session_id, client_nonce, execution_key, executor_bot_id, attempt_no, state, route,
             provider_instance_id, provider_model_id, input_generation, input_seq, prompt_cutoff_seq,
             assistant_entry_id, provider_request_id, prompt_manifest_json, version, last_error_code,
             created_at, accepted_at, last_activity_at, finished_at
      FROM runtime_runs;
      DROP TABLE runtime_runs;
      ALTER TABLE runtime_runs_v41 RENAME TO runtime_runs;

  CREATE UNIQUE INDEX runtime_one_active_per_executor ON runtime_runs(session_id,executor_bot_id)
    WHERE state IN ('created','dispatching','running','streaming','cancel-requested');
  CREATE TRIGGER initialize_runtime_scope AFTER INSERT ON runtime_runs BEGIN
    INSERT INTO runtime_session_scopes(runtime_run_id,scope_version)
      SELECT NEW.id,version FROM conversation_scope_versions WHERE session_id=NEW.session_id;
  END;


 CREATE TABLE mcp_tool_grants(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,executor_bot_id TEXT NOT NULL,server_id TEXT NOT NULL,server_version INTEGER NOT NULL,
 tool_name TEXT NOT NULL,schema_digest TEXT NOT NULL,credential_digest TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT,
 UNIQUE(session_id,executor_bot_id,server_id,tool_name));
 CREATE TABLE mcp_write_intents(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,executor_bot_id TEXT NOT NULL,client_nonce TEXT NOT NULL,input_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('prepared','dispatching','confirmed','rejected','unknown')),version INTEGER NOT NULL,review_json TEXT NOT NULL,review_digest TEXT NOT NULL,
 credential_digest TEXT NOT NULL,result_json TEXT,result_digest TEXT,error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,retired_at TEXT,
 UNIQUE(session_id,executor_bot_id,client_nonce));
 CREATE INDEX mcp_write_scope ON mcp_write_intents(session_id,executor_bot_id,created_at);
 CREATE TRIGGER mcp_write_member_removed AFTER DELETE ON room_members BEGIN
 UPDATE mcp_tool_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1 WHERE executor_bot_id=OLD.bot_id
 AND session_id IN(SELECT id FROM sessions WHERE room_id=OLD.room_id) AND revoked_at IS NULL;
 UPDATE mcp_write_intents SET retired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE executor_bot_id=OLD.bot_id
 AND session_id IN(SELECT id FROM sessions WHERE room_id=OLD.room_id) AND retired_at IS NULL;
 END;`} as const;
export function canonicalMcpJson(value:unknown):string{if(value===null||typeof value!=="object")return JSON.stringify(value);
 if(Array.isArray(value))return `[${value.map(canonicalMcpJson).join(",")}]`;return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalMcpJson((value as Record<string,unknown>)[key])}`).join(",")}}`;}
export const mcpDigest=(value:unknown)=>createHash("sha256").update(canonicalMcpJson(value)).digest("hex");
export const mcpReviewApprovalDigest=(value:McpWriteReview)=>createHash("sha256").update(JSON.stringify(mcpWriteReviewSchema.parse(value))).digest("hex");
type GrantRow={id:string;session_id:string;executor_bot_id:string;server_id:string;server_version:number;tool_name:string;schema_digest:string;credential_digest:string;version:number;created_at:string;revoked_at:string|null};
type IntentRow={id:string;session_id:string;executor_bot_id:string;client_nonce:string;input_digest:string;state:McpWriteIntent["state"];version:number;review_json:string;review_digest:string;credential_digest:string;result_json:string|null;result_digest:string|null;error_code:string|null;created_at:string;updated_at:string;retired_at:string|null};
const grant=(row:GrantRow):McpToolGrant=>({id:row.id,sessionId:row.session_id,executorBotId:row.executor_bot_id,serverId:row.server_id,serverVersion:row.server_version,toolName:row.tool_name,
 schemaDigest:row.schema_digest,version:row.version,createdAt:row.created_at,revokedAt:row.revoked_at});
function privateResult(row:IntentRow):unknown {
 const result:unknown=row.result_json?JSON.parse(row.result_json):null;
 if((result===null?null:mcpDigest(result))!==row.result_digest)throw new AevorenBotError("MCP_RESULT_INVALID");
 return result;
}
function publicResult(value:unknown):unknown {
 if(!value||typeof value!=="object"||Array.isArray(value))return value;
 const wrapper=value as Record<string,unknown>,response=wrapper.response;
 if(!response||typeof response!=="object"||Array.isArray(response))return value;
 // CallToolResult._meta belongs to the App view. Nested user data is not protocol metadata.
 const projected={...response as Record<string,unknown>};delete projected._meta;
 return {...wrapper,response:projected};
}
function intent(row:IntentRow):McpWriteIntent{const review=mcpWriteReviewSchema.parse(JSON.parse(row.review_json));if(mcpDigest(review)!==row.review_digest)throw new AevorenBotError("MCP_RESULT_INVALID");
 const result=publicResult(privateResult(row));return {id:row.id,sessionId:row.session_id,executorBotId:row.executor_bot_id,state:row.state,version:row.version,review,result,
 resultDigest:result===null?null:mcpDigest(result),errorCode:row.error_code,createdAt:row.created_at,updatedAt:row.updated_at};}
export class McpWriteRepository{
 constructor(private readonly database:DatabaseSync,private readonly assertScope:(scope:EnvironmentScope)=>void){}
 private scope(input:EnvironmentScope){const scope=environmentScopeSchema.parse({sessionId:input.sessionId,executorBotId:input.executorBotId});this.assertScope(scope);return scope;}
 scopeVersion(input:EnvironmentScope){const scope=this.scope(input);const row=this.database.prepare("SELECT version FROM conversation_scope_versions WHERE session_id=?").get(scope.sessionId) as {version:number}|undefined;if(!row)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");return row.version;}
 grants(input:EnvironmentScope){const scope=this.scope(input);return (this.database.prepare("SELECT * FROM mcp_tool_grants WHERE session_id=? AND executor_bot_id=? ORDER BY created_at,id").all(scope.sessionId,scope.executorBotId) as GrantRow[]).map(grant);}
 grant(input:McpToolGrantInput,credentialDigest:string):McpToolGrant{const parsed=mcpToolGrantSchema.parse(input),scope=this.scope(parsed),old=this.database.prepare("SELECT * FROM mcp_tool_grants WHERE session_id=? AND executor_bot_id=? AND server_id=? AND tool_name=?").get(scope.sessionId,scope.executorBotId,parsed.serverId,parsed.toolName) as GrantRow|undefined;
 if(old&&old.version!==parsed.expectedVersion||!old&&parsed.expectedVersion!==undefined)throw new AevorenBotError("INVALID_REQUEST","授权版本已变化。");
 const at=new Date().toISOString(),id=old?.id??randomUUID();if(old)this.database.prepare("UPDATE mcp_tool_grants SET server_version=?,schema_digest=?,credential_digest=?,version=version+1,revoked_at=NULL WHERE id=?").run(parsed.expectedServerVersion,parsed.schemaDigest,credentialDigest,id);
 else this.database.prepare("INSERT INTO mcp_tool_grants VALUES(?,?,?,?,?,?,?,?,1,?,NULL)").run(id,scope.sessionId,scope.executorBotId,parsed.serverId,parsed.expectedServerVersion,parsed.toolName,parsed.schemaDigest,credentialDigest,at);
 return this.grants(scope).find(value=>value.id===id)!;}
 revoke(input:McpWriteIdInput){const parsed=mcpWriteIdSchema.parse(input),scope=this.scope(parsed),old=this.grants(scope).find(value=>value.id===parsed.id);if(!old||old.version!==parsed.expectedVersion)throw new AevorenBotError("INVALID_REQUEST");
 if(!old.revokedAt)this.database.prepare("UPDATE mcp_tool_grants SET revoked_at=?,version=version+1 WHERE id=?").run(new Date().toISOString(),old.id);return this.grants(scope).find(value=>value.id===old.id)!;}
 assertGrant(scope:EnvironmentScope,id:string,version:number){const value=this.grants(scope).find(item=>item.id===id);if(!value||value.revokedAt||value.version!==version)throw new AevorenBotError("MCP_TOOL_NOT_FOUND","本会话未授予当前工具权限。");return value;}
 credentialForGrant(id:string){const row=this.database.prepare("SELECT credential_digest FROM mcp_tool_grants WHERE id=?").get(id) as{credential_digest:string}|undefined;if(!row)throw new AevorenBotError("MCP_TOOL_NOT_FOUND");return row.credential_digest;}
 prepare(input:McpWritePrepareInput,tool:McpScopedTool,transport:"stdio"|"streamable-http",credentialDigest:string){const parsed=mcpWritePrepareSchema.parse(input),scope=this.scope(parsed),permission=this.assertGrant(scope,parsed.grantId,parsed.expectedGrantVersion);
 if(permission.serverId!==tool.serverId||permission.serverVersion!==tool.serverVersion||permission.toolName!==tool.name||permission.schemaDigest!==tool.schemaDigest||this.credentialForGrant(permission.id)!==credentialDigest)throw new AevorenBotError("MCP_TOOL_NOT_FOUND");
 const inputDigest=mcpDigest({...parsed,arguments:parsed.arguments}),old=this.database.prepare("SELECT * FROM mcp_write_intents WHERE session_id=? AND executor_bot_id=? AND client_nonce=?").get(scope.sessionId,scope.executorBotId,parsed.clientNonce) as IntentRow|undefined;
 if(old){if(old.retired_at||old.input_digest!==inputDigest)throw new AevorenBotError("TOOL_IDEMPOTENCY_CONFLICT");return intent(old);}
 const id=randomUUID(),at=new Date().toISOString(),review:McpWriteReview=mcpWriteReviewSchema.parse({kind:"mcp-write",intentId:id,expectedIntentVersion:1,serverId:tool.serverId,serverName:tool.serverName,
 serverVersion:tool.serverVersion,transport,accountNotice:"MCP 服务器未提供可验证的账号身份；请核对所配置的连接。",toolName:tool.name,schemaDigest:tool.schemaDigest,grantId:permission.id,grantVersion:permission.version,
 arguments:parsed.arguments,argumentsDigest:mcpDigest(parsed.arguments),targetPreview:parsed.targetPreview});
 this.database.prepare("INSERT INTO mcp_write_intents VALUES(?,?,?,?,?,'prepared',1,?,?,?,NULL,NULL,NULL,?,?,NULL)").run(id,scope.sessionId,scope.executorBotId,parsed.clientNonce,inputDigest,JSON.stringify(review),mcpDigest(review),credentialDigest,at,at);return this.current(scope,id);}
 private row(id:string){const value=this.database.prepare("SELECT * FROM mcp_write_intents WHERE id=?").get(id) as IntentRow|undefined;if(!value)throw new AevorenBotError("MCP_TOOL_NOT_FOUND");return value;}
 current(input:EnvironmentScope,id:string){const scope=this.scope(input),row=this.row(id);if(row.retired_at||row.session_id!==scope.sessionId||row.executor_bot_id!==scope.executorBotId)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");return intent(row);}
 list(input:EnvironmentScope){const scope=this.scope(input);return (this.database.prepare("SELECT * FROM mcp_write_intents WHERE session_id=? AND executor_bot_id=? AND retired_at IS NULL ORDER BY created_at DESC,id LIMIT 500").all(scope.sessionId,scope.executorBotId) as IntentRow[]).map(intent);}
 get(input:McpWriteIdInput){const parsed=mcpWriteIdSchema.parse(input),value=this.current(parsed,parsed.id);if(value.version!==parsed.expectedVersion)throw new AevorenBotError("INVALID_REQUEST","任务版本已变化。");return value;}
 /** Host-only App channel. This response must never enter product results or tool journals. */
 appResponse(input:EnvironmentScope,id:string){const value=this.current(input,id);if(value.state!=="confirmed")throw new AevorenBotError("MCP_RESULT_INVALID");
 this.assertGrant(input,value.review.grantId,value.review.grantVersion);const raw=privateResult(this.row(id));
 if(!raw||typeof raw!=="object"||!("response" in raw))throw new AevorenBotError("MCP_RESULT_INVALID");return raw.response;}
 credentialForIntent(id:string){return this.row(id).credential_digest;}
 assertReview(input:EnvironmentScope,review:McpWriteReview){const scope=this.scope(input),value=this.current(scope,review.intentId);if(mcpDigest(value.review)!==mcpDigest(mcpWriteReviewSchema.parse(review)))throw new AevorenBotError("APPROVAL_REVIEW_INVALID");this.assertGrant(scope,review.grantId,review.grantVersion);return value;}
 dispatch(input:EnvironmentScope,id:string,expectedVersion:number){const value=this.get({...this.scope(input),id,expectedVersion});if(value.state!=="prepared")throw new AevorenBotError("TOOL_STATE_INVALID");this.assertReview(input,value.review);
 const changed=this.database.prepare("UPDATE mcp_write_intents SET state='dispatching',version=version+1,updated_at=? WHERE id=? AND state='prepared' AND version=?").run(new Date().toISOString(),id,expectedVersion);if(Number(changed.changes)!==1)throw new AevorenBotError("TOOL_STATE_INVALID");return this.current(input,id);}
 settle(id:string,state:"confirmed"|"unknown"|"rejected",result:unknown=null,errorCode:string|null=null){const old=this.row(id);if(old.state!=="dispatching"&&!(old.state==="prepared"&&state==="rejected"))return intent(old);
 const serialized=result===null?null:JSON.stringify(result);if(serialized&&Buffer.byteLength(serialized)>256000)throw new AevorenBotError("MCP_RESULT_INVALID");
 this.database.prepare("UPDATE mcp_write_intents SET state=?,version=version+1,result_json=?,result_digest=?,error_code=?,updated_at=? WHERE id=?").run(state,serialized,result===null?null:mcpDigest(result),errorCode,new Date().toISOString(),id);return intent(this.row(id));}
 recover(){this.database.prepare("UPDATE mcp_write_intents SET state='unknown',version=version+1,error_code='INTERRUPTED_AFTER_DISPATCH',updated_at=? WHERE state='dispatching'").run(new Date().toISOString());}
 assertRuntime(scope:EnvironmentScope,runId:string){this.scope(scope);const row=this.database.prepare(`SELECT r.session_id,r.executor_bot_id,r.state,s.scope_version,c.version
 FROM runtime_runs r JOIN runtime_session_scopes s ON s.runtime_run_id=r.id JOIN conversation_scope_versions c ON c.session_id=r.session_id WHERE r.id=?`).get(runId) as
 {session_id:string;executor_bot_id:string;state:string;scope_version:number;version:number}|undefined;
 if(!row||row.session_id!==scope.sessionId||row.executor_bot_id!==scope.executorBotId||row.scope_version!==row.version||!["running","streaming"].includes(row.state))throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");}
}
