import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ConversationSummary, MemoryItem, Session, TranscriptEntry, Workspace, ToolRequest } from "@shared/contracts";
import type { TaskCreateInput, TaskDetail, TaskExecutorSelection, TaskMemorySnapshot, TaskMcpSelection, TaskSelectionUpdateInput, TaskUpdateInput } from "@shared/task-session-contracts";
import { taskCreateSchema, taskExecutorSelectionSchema, taskSelectionUpdateSchema, taskUpdateSchema } from "@shared/task-session-schemas";
import type { LibraryRepository } from "./library-repository";
import { MEDIA_MIGRATION, type MediaRepository } from "./media-repository";
import { AevorenBotError } from "./errors";

const mainMediaCapture = MEDIA_MIGRATION.sql.match(/CREATE TRIGGER capture_runtime_media[\s\S]*?END;/u)![0]
  .replace("AFTER INSERT ON runtime_runs BEGIN", "AFTER INSERT ON runtime_runs WHEN (SELECT kind FROM sessions WHERE id=NEW.session_id)='MAIN' BEGIN");
const taskSelectionVersionSql = `CASE WHEN EXISTS(SELECT 1 FROM runtime_runs r WHERE r.client_nonce=NEW.client_nonce AND r.id<>NEW.id AND r.executor_bot_id=COALESCE(NEW.executor_bot_id,s.bot_id))
  THEN (SELECT p.task_selection_version FROM runtime_runs r LEFT JOIN runtime_session_scopes p ON p.runtime_run_id=r.id WHERE r.client_nonce=NEW.client_nonce AND r.id<>NEW.id AND r.executor_bot_id=COALESCE(NEW.executor_bot_id,s.bot_id) ORDER BY r.rowid LIMIT 1)
  ELSE (SELECT MAX(version) FROM task_context_selections WHERE session_id=s.id AND executor_bot_id=COALESCE(NEW.executor_bot_id,s.bot_id)) END`;
export const TASK_SESSION_MIGRATION = { version: 45, foreignKeysOff: true, sql: `
  PRAGMA legacy_alter_table=ON;
  CREATE TABLE sessions_v45 (
    id TEXT PRIMARY KEY, bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE, room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN('MAIN','TASK')),generation INTEGER NOT NULL CHECK(generation>0),transcript_cursor INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,task_title TEXT NOT NULL DEFAULT '',task_parent_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    task_version INTEGER NOT NULL DEFAULT 1 CHECK(task_version>0),task_client_nonce TEXT,task_request_digest TEXT,
    CHECK((bot_id IS NOT NULL AND room_id IS NULL) OR (bot_id IS NULL AND room_id IS NOT NULL))
  );
  INSERT INTO sessions_v45(id,bot_id,room_id,kind,generation,transcript_cursor,created_at,updated_at)
    SELECT id,bot_id,room_id,kind,generation,transcript_cursor,created_at,updated_at FROM sessions;
  DROP TABLE sessions;
  ALTER TABLE sessions_v45 RENAME TO sessions;
  CREATE UNIQUE INDEX sessions_one_main_per_bot ON sessions(bot_id) WHERE bot_id IS NOT NULL AND kind='MAIN';
  CREATE UNIQUE INDEX sessions_one_main_per_room ON sessions(room_id) WHERE room_id IS NOT NULL AND kind='MAIN';
  CREATE UNIQUE INDEX task_session_nonce ON sessions(task_client_nonce) WHERE task_client_nonce IS NOT NULL;
  CREATE TRIGGER initialize_conversation AFTER INSERT ON sessions WHEN NEW.kind='MAIN' BEGIN
    INSERT INTO conversation_metadata(session_id,project_id,pinned_at,hidden_at,has_unread,last_activity_at)
    VALUES(NEW.id,(SELECT project_id FROM legacy_session_scopes WHERE owner_kind=CASE WHEN NEW.bot_id IS NULL THEN 'room' ELSE 'bot' END AND owner_id=COALESCE(NEW.bot_id,NEW.room_id)),
      COALESCE((SELECT pinned_at FROM bots WHERE id=NEW.bot_id),(SELECT pinned_at FROM rooms WHERE id=NEW.room_id)),
      COALESCE((SELECT hidden_at FROM bots WHERE id=NEW.bot_id),(SELECT hidden_at FROM rooms WHERE id=NEW.room_id)),
      COALESCE((SELECT has_unread FROM bots WHERE id=NEW.bot_id),(SELECT has_unread FROM rooms WHERE id=NEW.room_id),0),NEW.created_at);
    INSERT INTO conversation_scope_versions(session_id) VALUES(NEW.id);
    INSERT INTO session_workspace_grants(session_id,workspace_id)
      SELECT NEW.id,workspaces.id FROM legacy_session_scopes,json_each(workspace_ids_json) JOIN workspaces ON workspaces.id=json_each.value AND workspaces.removed_at IS NULL
      WHERE owner_kind=CASE WHEN NEW.bot_id IS NULL THEN 'room' ELSE 'bot' END AND owner_id=COALESCE(NEW.bot_id,NEW.room_id);
    INSERT INTO memory_session_visibility(session_id,executor_bot_id,memory_id)
      SELECT NEW.id,memory_items.bot_id,memory_items.id FROM legacy_session_scopes,json_each(memory_visibility_json)
      JOIN memory_items ON memory_items.id=json_extract(json_each.value,'$.memoryId') AND memory_items.bot_id=json_extract(json_each.value,'$.executorBotId')
      WHERE owner_kind=CASE WHEN NEW.bot_id IS NULL THEN 'room' ELSE 'bot' END AND owner_id=COALESCE(NEW.bot_id,NEW.room_id);
    DELETE FROM legacy_session_scopes WHERE owner_kind=CASE WHEN NEW.bot_id IS NULL THEN 'room' ELSE 'bot' END AND owner_id=COALESCE(NEW.bot_id,NEW.room_id);
  END;
  CREATE TRIGGER initialize_task_conversation AFTER INSERT ON sessions WHEN NEW.kind='TASK' BEGIN
    INSERT INTO conversation_metadata(session_id,project_id,pinned_at,hidden_at,has_unread,last_activity_at) VALUES(NEW.id,NULL,NULL,NULL,0,NEW.created_at);
    INSERT INTO conversation_scope_versions(session_id) VALUES(NEW.id);
  END;
  CREATE TABLE task_creation_receipts (
    client_nonce TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE,request_digest TEXT NOT NULL CHECK(length(request_digest)=64),created_at TEXT NOT NULL
  );
  CREATE TABLE task_executor_admissions (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    incarnation TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN(0,1)),
    PRIMARY KEY(session_id,executor_bot_id,incarnation)
  );
  CREATE UNIQUE INDEX task_active_executor ON task_executor_admissions(session_id,executor_bot_id) WHERE revoked=0;
  CREATE TABLE task_context_selections (
    session_id TEXT NOT NULL,executor_bot_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),executor_incarnation TEXT NOT NULL,
    digest TEXT NOT NULL CHECK(length(digest)=64),snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
    revoked_memories_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(revoked_memories_json)),revoked_resources_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(revoked_resources_json)),
    revoked_media_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(revoked_media_json)),created_at TEXT NOT NULL,
    PRIMARY KEY(session_id,executor_bot_id,version),FOREIGN KEY(session_id,executor_bot_id,executor_incarnation) REFERENCES task_executor_admissions(session_id,executor_bot_id,incarnation) ON DELETE CASCADE
  );
  CREATE TABLE task_workspace_limits (
    session_id TEXT NOT NULL,executor_bot_id TEXT NOT NULL,selection_version INTEGER NOT NULL,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    read_allowed INTEGER NOT NULL CHECK(read_allowed IN(0,1)),write_allowed INTEGER NOT NULL CHECK(write_allowed IN(0,1)),automation_allowed INTEGER NOT NULL CHECK(automation_allowed IN(0,1)),
    PRIMARY KEY(session_id,executor_bot_id,selection_version,workspace_id),FOREIGN KEY(session_id,executor_bot_id,selection_version) REFERENCES task_context_selections(session_id,executor_bot_id,version) ON DELETE CASCADE
  );
  CREATE TABLE task_mcp_limits (
    session_id TEXT NOT NULL,executor_bot_id TEXT NOT NULL,selection_version INTEGER NOT NULL,server_id TEXT NOT NULL,
    server_version INTEGER NOT NULL,identity_digest TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN(0,1)),PRIMARY KEY(session_id,executor_bot_id,selection_version,server_id),
    FOREIGN KEY(session_id,executor_bot_id,selection_version) REFERENCES task_context_selections(session_id,executor_bot_id,version) ON DELETE CASCADE
  );
  ALTER TABLE runtime_session_scopes ADD COLUMN task_selection_version INTEGER;
  ALTER TABLE runtime_session_scopes ADD COLUMN task_selection_digest TEXT;
  ALTER TABLE runtime_session_scopes ADD COLUMN task_executor_incarnation TEXT;
  DROP TRIGGER initialize_runtime_scope;
  CREATE TRIGGER initialize_runtime_scope AFTER INSERT ON runtime_runs BEGIN
    INSERT INTO runtime_session_scopes(runtime_run_id,scope_version,task_selection_version,task_selection_digest,task_executor_incarnation)
      SELECT NEW.id,v.version,c.version,c.digest,c.executor_incarnation FROM conversation_scope_versions v JOIN sessions s ON s.id=v.session_id
      LEFT JOIN task_context_selections c ON c.session_id=s.id AND c.executor_bot_id=COALESCE(NEW.executor_bot_id,s.bot_id) AND c.version=${taskSelectionVersionSql}
      WHERE v.session_id=NEW.session_id;
  END;
  DROP TRIGGER capture_runtime_media;
  ${mainMediaCapture}
  CREATE TRIGGER capture_task_runtime_media AFTER INSERT ON runtime_runs WHEN (SELECT kind FROM sessions WHERE id=NEW.session_id)='TASK' BEGIN
    INSERT INTO runtime_media_snapshots(runtime_run_id) VALUES(NEW.id);
    INSERT INTO runtime_media_admissions(runtime_run_id,media_id,incarnation,reference_json)
      SELECT NEW.id,b.media_id,b.incarnation,json_extract(selected.value,'$.reference')
      FROM sessions s JOIN task_context_selections c ON c.session_id=s.id AND c.executor_bot_id=COALESCE(NEW.executor_bot_id,s.bot_id)
      JOIN task_executor_admissions a ON a.session_id=c.session_id AND a.executor_bot_id=c.executor_bot_id AND a.incarnation=c.executor_incarnation AND a.revoked=0,
        json_each(c.snapshot_json,'$.mediaBindings') selected
      JOIN session_media_bindings b ON b.session_id=s.id AND b.media_id=json_extract(selected.value,'$.reference.mediaId') AND b.incarnation=json_extract(selected.value,'$.incarnation') AND b.revoked_at IS NULL
      JOIN media_assets media ON media.id=b.media_id AND media.enabled=1 AND media.deleted_at IS NULL AND media.sha256=json_extract(selected.value,'$.reference.sha256')
      WHERE s.id=NEW.session_id AND c.version=${taskSelectionVersionSql};
  END;
  CREATE TRIGGER retire_task_member AFTER DELETE ON room_members BEGIN
    UPDATE task_executor_admissions SET revoked=1,version=version+1 WHERE executor_bot_id=OLD.bot_id AND session_id IN(SELECT id FROM sessions WHERE kind='TASK' AND room_id=OLD.room_id);
  END;
  CREATE TRIGGER retire_task_mcp_membership AFTER UPDATE OF mcp_server_ids_json ON bots WHEN NEW.mcp_server_ids_json IS NOT NULL BEGIN
    UPDATE task_mcp_limits SET revoked=1 WHERE executor_bot_id=NEW.id
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.mcp_server_ids_json) WHERE value=task_mcp_limits.server_id);
  END;
  CREATE TRIGGER retire_task_bot AFTER UPDATE OF deleted_at ON bots WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL BEGIN
    UPDATE task_executor_admissions SET revoked=1,version=version+1 WHERE executor_bot_id=NEW.id;
  END;
  CREATE TRIGGER retire_task_memory AFTER UPDATE OF deleted_at ON memory_items WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL BEGIN
    UPDATE task_context_selections SET revoked_memories_json=json_insert(revoked_memories_json,'$[#]',NEW.id)
      WHERE EXISTS(SELECT 1 FROM json_each(snapshot_json,'$.selection.memories') WHERE json_extract(value,'$.id')=NEW.id);
  END;
  CREATE TRIGGER retire_task_resource AFTER UPDATE OF enabled,deleted_at ON library_resources WHEN (OLD.enabled=1 AND NEW.enabled=0) OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) BEGIN
    UPDATE task_context_selections SET revoked_resources_json=json_insert(revoked_resources_json,'$[#]',NEW.id)
      WHERE EXISTS(SELECT 1 FROM json_each(snapshot_json,'$.selection.resourceRefs') WHERE json_extract(value,'$.resourceId')=NEW.id);
  END;
  CREATE TRIGGER retire_task_media AFTER UPDATE OF enabled,deleted_at ON media_assets WHEN (OLD.enabled=1 AND NEW.enabled=0) OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) BEGIN
    UPDATE task_context_selections SET revoked_media_json=json_insert(revoked_media_json,'$[#]',NEW.id)
      WHERE EXISTS(SELECT 1 FROM json_each(snapshot_json,'$.selection.mediaRefs') WHERE json_extract(value,'$.mediaId')=NEW.id);
  END;
  CREATE TRIGGER retire_task_workspace_binding AFTER DELETE ON session_workspace_grants BEGIN
    UPDATE task_workspace_limits SET read_allowed=0,write_allowed=0,automation_allowed=0 WHERE session_id=OLD.session_id AND workspace_id=OLD.workspace_id;
  END;
  CREATE TRIGGER retire_task_workspace AFTER UPDATE OF removed_at,write_enabled,automation_enabled ON workspaces BEGIN
    UPDATE task_workspace_limits SET read_allowed=CASE WHEN NEW.removed_at IS NOT NULL THEN 0 ELSE read_allowed END,
      write_allowed=CASE WHEN NEW.removed_at IS NOT NULL OR NEW.write_enabled=0 THEN 0 ELSE write_allowed END,
      automation_allowed=CASE WHEN NEW.removed_at IS NOT NULL OR NEW.write_enabled=0 OR NEW.automation_enabled=0 THEN 0 ELSE automation_allowed END WHERE workspace_id=NEW.id;
  END;
` } as const;

export type TaskMcpIdentity={version:number;identityDigest:string};
export type TaskHistorySnapshot={entryId:string;generation:number;digest:string;role:TranscriptEntry["role"];body:string};
type Snapshot={selection:TaskExecutorSelection;memories:TaskMemorySnapshot[];history:TaskHistorySnapshot[];
  resourceBindings:Array<{reference:TaskExecutorSelection["resourceRefs"][number];bindingVersion:number}>;
  mediaBindings:Array<{reference:TaskExecutorSelection["mediaRefs"][number];incarnation:string}>};
type SelectionRow={session_id:string;executor_bot_id:string;version:number;executor_incarnation:string;digest:string;snapshot_json:string;revoked_memories_json:string;revoked_resources_json:string;revoked_media_json:string};
export type TaskSessionPolicy={sessionId:string;executorBotId:string;selectionVersion:number;selectionDigest:string;executorIncarnation:string;selection:TaskExecutorSelection;
  memories:TaskMemorySnapshot[];history:TaskHistorySnapshot[];mcpIdentities:Record<string,TaskMcpIdentity>};
type Host={getSession(id:string):Session;getConversation(id:string):ConversationSummary;assertSessionExecutor(id:string,executor:string):void;assertTaskSessionIdle(sessionId:string):void;
  listRuntimeMemories(executor:string,session:string):MemoryItem[];getMemory(id:string):MemoryItem;getTranscriptEntry(id:string):TranscriptEntry;
  listSessionWorkspaces(session:string,executor:string):Workspace[];assertSessionWorkspaceAccess(session:string,executor:string,workspace:string,operation?:string):void;library:LibraryRepository;media:MediaRepository};
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value&&typeof value==="object")return "{"+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")+"}";
  return JSON.stringify(value);
}
const denied=()=>new AevorenBotError("APPROVAL_SCOPE_INVALID");

export class TaskSessionRepository {
  private sequence=0;
  private mcpReader:((sessionId:string,executorBotId:string,selection:TaskMcpSelection)=>TaskMcpIdentity)|null=null;
  constructor(private readonly database:DatabaseSync,private readonly host:Host){}
  setMcpIdentityReader(reader:(sessionId:string,executorBotId:string,selection:TaskMcpSelection)=>TaskMcpIdentity):void{this.mcpReader=reader;}
  private transaction<T>(work:()=>T):T{const name=`task_session_${++this.sequence}`;this.database.exec(`SAVEPOINT ${name}`);try{const result=work();this.database.exec(`RELEASE SAVEPOINT ${name}`);return result;}catch(error){this.database.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);throw error;}}
  scopeVersion(sessionId:string):number{this.host.getSession(sessionId);return (this.database.prepare("SELECT version FROM conversation_scope_versions WHERE session_id=?").get(sessionId) as {version:number}).version;}
  private selectionVersion(sessionId:string,executor:string):number{return (this.database.prepare("SELECT MAX(version) AS version FROM task_context_selections WHERE session_id=? AND executor_bot_id=?").get(sessionId,executor) as {version:number|null}).version??0;}
  private version(sessionId:string):number{return (this.database.prepare("SELECT task_version FROM sessions WHERE id=? AND kind='TASK'").get(sessionId) as {task_version:number}|undefined)?.task_version??0;}
  private checkVersion(sessionId:string,expected:number):void{if(!expected||this.version(sessionId)!==expected)throw new AevorenBotError("CONVERSATION_VERSION_CONFLICT");}
  get(input:string|{sessionId:string},actor?:string):TaskDetail{
    const sessionId=typeof input==="string"?input:input.sessionId;if(actor)this.host.assertSessionExecutor(sessionId,actor);
    const session=this.host.getSession(sessionId);if(session.kind!=="TASK")throw new AevorenBotError("INVALID_REQUEST");
    const row=this.database.prepare("SELECT task_title,task_parent_id,task_version FROM sessions WHERE id=?").get(sessionId) as {task_title:string;task_parent_id:string|null;task_version:number};
    return {session,conversation:{...this.host.getConversation(sessionId),kind:"TASK",title:row.task_title,parentSessionId:row.task_parent_id},title:row.task_title,parentSessionId:row.task_parent_id,version:row.task_version,scopeVersion:this.scopeVersion(sessionId),
      admittedExecutorBotIds:(this.database.prepare("SELECT executor_bot_id FROM task_executor_admissions WHERE session_id=? AND revoked=0 ORDER BY executor_bot_id").all(sessionId) as {executor_bot_id:string}[]).map(value=>value.executor_bot_id),
      selectionDigests:(this.database.prepare("SELECT executor_bot_id,version,digest FROM task_context_selections WHERE session_id=? AND version=(SELECT MAX(version) FROM task_context_selections WHERE session_id=?) ORDER BY executor_bot_id").all(sessionId,sessionId) as {executor_bot_id:string;version:number;digest:string}[]).map(value=>({executorBotId:value.executor_bot_id,version:value.version,digest:value.digest}))};
  }
  list(input:{parentSessionId:string;limit?:number},actor?:string):TaskDetail[]{this.host.getSession(input.parentSessionId);if(actor)this.host.assertSessionExecutor(input.parentSessionId,actor);return (this.database.prepare("SELECT id FROM sessions WHERE kind='TASK' AND task_parent_id=? ORDER BY created_at DESC,id LIMIT ?").all(input.parentSessionId,Math.max(1,Math.min(100,input.limit??100))) as {id:string}[]).flatMap(value=>{if(actor&&!this.database.prepare("SELECT 1 FROM task_executor_admissions WHERE session_id=? AND executor_bot_id=? AND revoked=0").get(value.id,actor))return [];return [this.get(value.id,actor)];});}
  create(input:TaskCreateInput,actor?:string):TaskDetail{if(actor)this.host.assertSessionExecutor(input.parentSessionId,actor);if(actor&&input.selections.some(item=>item.executorBotId!==actor))throw denied();return this.createAtomic(input);}
  createAtomic(input:TaskCreateInput):TaskDetail{const parsed=taskCreateSchema.parse(input),digest=hash(canonical(parsed));return this.transaction(()=>{
    const previous=this.database.prepare("SELECT session_id AS id,request_digest AS task_request_digest FROM task_creation_receipts WHERE client_nonce=?").get(parsed.clientNonce) as {id:string;task_request_digest:string}|undefined;
    if(previous){if(previous.task_request_digest!==digest)throw new AevorenBotError("MESSAGE_NONCE_CONFLICT");return this.get(previous.id);}
    const parent=this.host.getSession(parsed.parentSessionId);if(this.scopeVersion(parent.id)!==parsed.expectedScopeVersion)throw denied();
    const snapshots=parsed.selections.map(selection=>this.capture(parent.id,selection));
    const id=randomUUID(),timestamp=new Date().toISOString();
    this.database.prepare("INSERT INTO sessions(id,bot_id,room_id,kind,generation,created_at,updated_at,task_title,task_parent_id,task_client_nonce,task_request_digest) VALUES(?,?,?,'TASK',1,?,?,?,?,?,?)")
      .run(id,parent.botId,parent.roomId,timestamp,timestamp,parsed.title,parent.id,parsed.clientNonce,digest);
    snapshots.forEach(snapshot=>this.install(id,1,snapshot));this.database.prepare("INSERT INTO task_creation_receipts VALUES(?,?,?,?)").run(parsed.clientNonce,id,digest,timestamp);return this.get(id);
  });}
  update(input:TaskUpdateInput,actor?:string):TaskDetail{if(actor)this.host.assertSessionExecutor(input.sessionId,actor);const parsed=taskUpdateSchema.parse(input);return this.transaction(()=>{this.checkVersion(parsed.sessionId,parsed.expectedVersion);
    this.database.prepare("UPDATE sessions SET task_title=?,task_version=task_version+1,updated_at=? WHERE id=?").run(parsed.title,new Date().toISOString(),parsed.sessionId);
    this.database.prepare("UPDATE conversation_metadata SET version=version+1 WHERE session_id=?").run(parsed.sessionId);return this.get(parsed.sessionId);});}
  reviseSelection(input:TaskSelectionUpdateInput,actor?:string):TaskDetail{if(actor)throw denied();const parsed=taskSelectionUpdateSchema.parse(input);return this.transaction(()=>{this.checkVersion(parsed.sessionId,parsed.expectedVersion);
    const current=this.get(parsed.sessionId);if(!current.parentSessionId)throw denied();const snapshots=parsed.selections.map(selection=>this.capture(current.parentSessionId!,selection));
    const ids=parsed.selections.map(selection=>selection.executorBotId);
    for(const id of current.admittedExecutorBotIds)if(!ids.includes(id))this.database.prepare("UPDATE task_executor_admissions SET revoked=1,version=version+1 WHERE session_id=? AND executor_bot_id=? AND revoked=0").run(parsed.sessionId,id);
    const version=this.version(parsed.sessionId)+1;this.database.prepare("UPDATE sessions SET task_version=?,updated_at=? WHERE id=?").run(version,new Date().toISOString(),parsed.sessionId);
    snapshots.forEach(snapshot=>this.install(parsed.sessionId,version,snapshot));this.database.prepare("UPDATE conversation_metadata SET version=version+1 WHERE session_id=?").run(parsed.sessionId);return this.get(parsed.sessionId);
  });}
  cancel(input:{sessionId:string;expectedVersion:number},actor?:string):TaskDetail{if(actor)this.host.assertSessionExecutor(input.sessionId,actor);this.checkVersion(input.sessionId,input.expectedVersion);return this.get(input.sessionId);}
  delete(input:{sessionId:string;expectedVersion:number},actor?:string):void{if(actor)this.host.assertSessionExecutor(input.sessionId,actor);this.transaction(()=>{this.checkVersion(input.sessionId,input.expectedVersion);
    this.host.assertTaskSessionIdle(input.sessionId);
    this.database.prepare("DELETE FROM sessions WHERE id=? AND kind='TASK'").run(input.sessionId);});}
  assertExecutor(sessionId:string,executorBotId:string):void{if(this.host.getSession(sessionId).kind!=="TASK")return;
    if(!this.database.prepare("SELECT 1 FROM task_executor_admissions WHERE session_id=? AND executor_bot_id=? AND revoked=0").get(sessionId,executorBotId))throw denied();}
  private capture(parentSessionId:string,selection:TaskExecutorSelection):Snapshot{
    this.host.assertSessionExecutor(parentSessionId,selection.executorBotId);
    const available=this.host.listRuntimeMemories(selection.executorBotId,parentSessionId);
    const memories=selection.memories.map(source=>{const memory=available.find(item=>item.id===source.id);if(!memory||memory.version!==source.version||memory.contentDigest!==source.digest)throw denied();return {source:structuredClone(source),memory:structuredClone(memory)};});
    const parent=this.host.getSession(parentSessionId);
    const history=selection.history.map(reference=>{const entry=this.host.getTranscriptEntry(reference.entryId);
      if(entry.sessionId!==parentSessionId||entry.generation!==parent.generation||entry.generation!==reference.generation||hash(entry.body)!==reference.digest)throw denied();
      return {...reference,role:entry.role,body:entry.body};});
    const workspaces=this.host.listSessionWorkspaces(parentSessionId,selection.executorBotId);
    for(const requested of selection.workspaces){const workspace=workspaces.find(item=>item.id===requested.id);if(!workspace||requested.write&&!workspace.writeEnabled||requested.automation&&!workspace.automationEnabled)throw denied();}
    this.host.library.assertReferences(parentSessionId,selection.resourceRefs,selection.executorBotId);
    this.host.media.captureSendReferences(parentSessionId,selection.mediaRefs,selection.executorBotId);
    for(const item of selection.mcp)if(!this.mcpReader||this.mcpReader(parentSessionId,selection.executorBotId,item).version!==item.expectedVersion)throw denied();
    const parentPolicy=this.taskSessionPolicy(parentSessionId,selection.executorBotId);
    if(parentPolicy&&(selection.network&&!parentPolicy.selection.network||selection.clipboard&&!parentPolicy.selection.clipboard||selection.productOperations.some(operation=>!parentPolicy.selection.productOperations.includes(operation))))throw denied();
    if(parentPolicy){
      if(selection.resourceRefs.some(ref=>!parentPolicy.selection.resourceRefs.some(value=>canonical(value)===canonical(ref)))||selection.mediaRefs.some(ref=>!parentPolicy.selection.mediaRefs.some(value=>canonical(value)===canonical(ref))))throw denied();
      for(const requested of selection.mcp){const ceiling=parentPolicy.selection.mcp.find(item=>item.serverId===requested.serverId&&item.expectedVersion===requested.expectedVersion);if(!ceiling||requested.toolNames.some(name=>!ceiling.toolNames.includes(name)))throw denied();}
    }
    return {selection:structuredClone(selection),memories,history,resourceBindings:[],mediaBindings:[]};
  }
  private install(sessionId:string,version:number,snapshot:Snapshot):void{
    const executor=snapshot.selection.executorBotId;
    let admission=this.database.prepare("SELECT incarnation FROM task_executor_admissions WHERE session_id=? AND executor_bot_id=? AND revoked=0").get(sessionId,executor) as {incarnation:string}|undefined;
    if(!admission){admission={incarnation:randomUUID()};this.database.prepare("INSERT INTO task_executor_admissions VALUES(?,?,?,1,0)").run(sessionId,executor,admission.incarnation);}
    for(const reference of snapshot.selection.resourceRefs)this.host.library.bind({sessionId,id:reference.resourceId});
    for(const reference of snapshot.selection.mediaRefs)this.host.media.bind({sessionId,id:reference.mediaId});
    snapshot.resourceBindings=this.host.library.captureReferenceBindings(sessionId,snapshot.selection.resourceRefs);
    snapshot.mediaBindings=this.host.media.captureSendReferences(sessionId,snapshot.selection.mediaRefs);
    const json=canonical(snapshot),digest=hash(json);
    this.database.prepare("INSERT INTO task_context_selections(session_id,executor_bot_id,version,executor_incarnation,digest,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?)").run(sessionId,executor,version,admission.incarnation,digest,json,new Date().toISOString());
    for(const workspace of snapshot.selection.workspaces){this.database.prepare("INSERT OR IGNORE INTO session_workspace_grants(session_id,workspace_id) VALUES(?,?)").run(sessionId,workspace.id);
      this.database.prepare("INSERT INTO task_workspace_limits VALUES(?,?,?,?,?,?,?)").run(sessionId,executor,version,workspace.id,Number(workspace.read),Number(workspace.write),Number(workspace.automation));}
    for(const item of snapshot.selection.mcp){if(!this.mcpReader)throw denied();const identity=this.mcpReader(sessionId,executor,item);
      this.database.prepare("INSERT INTO task_mcp_limits(session_id,executor_bot_id,selection_version,server_id,server_version,identity_digest) VALUES(?,?,?,?,?,?)").run(sessionId,executor,version,item.serverId,identity.version,identity.identityDigest);}
  }
  taskSessionPolicy(sessionId:string,executorBotId:string):TaskSessionPolicy|null{if(this.host.getSession(sessionId).kind!=="TASK")return null;this.host.assertSessionExecutor(sessionId,executorBotId);
    return this.policy(sessionId,executorBotId,this.selectionVersion(sessionId,executorBotId));}
  runtimeTaskPolicy(runtimeId:string):TaskSessionPolicy|null{
    const run=this.database.prepare("SELECT r.session_id,COALESCE(r.executor_bot_id,s.bot_id) AS executor_bot_id,s.kind,p.task_selection_version,p.task_selection_digest,p.task_executor_incarnation FROM runtime_runs r JOIN sessions s ON s.id=r.session_id LEFT JOIN runtime_session_scopes p ON p.runtime_run_id=r.id WHERE r.id=?").get(runtimeId) as {session_id:string;executor_bot_id:string;kind:string;task_selection_version:number|null;task_selection_digest:string|null;task_executor_incarnation:string|null}|undefined;
    if(!run)throw denied();if(run.kind!=="TASK")return null;if(!run.task_selection_version||!run.task_selection_digest||!run.task_executor_incarnation)throw denied();
    this.host.assertSessionExecutor(run.session_id,run.executor_bot_id);const result=this.policy(run.session_id,run.executor_bot_id,run.task_selection_version);
    if(result.selectionDigest!==run.task_selection_digest||result.executorIncarnation!==run.task_executor_incarnation)throw denied();return result;
  }
  assertTaskRuntime(runtimeId:string):void{this.runtimeTaskPolicy(runtimeId);}
  retireMcpSelections(serverId:string):void{this.database.prepare("UPDATE task_mcp_limits SET revoked=1 WHERE server_id=?").run(serverId);}
  assertToolAllowed(runtimeId:string,tool:ToolRequest):void{
    const policy=this.runtimeTaskPolicy(runtimeId);if(!policy)return;const selected=policy.selection;
    if(["web-search","web-fetch","weather-current","time-now"].includes(tool.kind)&&!selected.network)throw denied();
    if(tool.kind==="clipboard-read"&&!selected.clipboard)throw denied();
    if(tool.kind==="mcp-call"&&!selected.mcp.some(item=>item.serverId===tool.serverId&&item.toolNames.includes(tool.toolName)))throw denied();
    if("workspaceId" in tool){const limit=selected.workspaces.find(item=>item.id===tool.workspaceId);if(!limit?.read||tool.kind==="workspace-write"&&!limit.write)throw denied();
      this.host.assertSessionWorkspaceAccess(policy.sessionId,policy.executorBotId,tool.workspaceId,tool.kind);}
    if(tool.kind==="bot-create"||tool.kind==="room-create")throw denied();
    if(tool.kind==="project-bots"&&!selected.productOperations.includes("bots.list"))throw denied();
    if(tool.kind==="product-call"&&tool.action==="execute"){
      if(!selected.productOperations.includes(tool.operation)||["messages.send","roomRuntime.send","bots.create","bots.duplicate","teams.createContentTeam","rooms.create","approvals.resolve"].includes(tool.operation))throw denied();
    }
  }
  listTaskMemories(runtimeId:string):MemoryItem[];
  listTaskMemories(sessionId:string,executorBotId:string):MemoryItem[];
  listTaskMemories(id:string,executor?:string):MemoryItem[]{const policy=executor?this.taskSessionPolicy(id,executor):this.runtimeTaskPolicy(id);return policy?.memories.map(item=>structuredClone(item.memory))??[];}
  private policy(sessionId:string,executor:string,version:number):TaskSessionPolicy{
    const row=this.database.prepare("SELECT * FROM task_context_selections WHERE session_id=? AND executor_bot_id=? AND version=?").get(sessionId,executor,version) as SelectionRow|undefined;
    if(!row||hash(row.snapshot_json)!==row.digest)throw denied();
    const snapshot=JSON.parse(row.snapshot_json) as Snapshot;taskExecutorSelectionSchema.parse(snapshot.selection);
    if(!this.database.prepare("SELECT 1 FROM task_executor_admissions WHERE session_id=? AND executor_bot_id=? AND incarnation=? AND revoked=0").get(sessionId,executor,row.executor_incarnation))throw denied();
    if(JSON.parse(row.revoked_memories_json).length||JSON.parse(row.revoked_resources_json).length||JSON.parse(row.revoked_media_json).length)throw denied();
    for(const item of snapshot.memories){const current=this.host.getMemory(item.source.id);if(current.deletedAt||item.memory.expiresAt&&item.memory.expiresAt<=new Date().toISOString())throw denied();}
    this.host.library.assertReferenceBindings(sessionId,snapshot.resourceBindings);
    const media=this.host.media.captureSendReferences(sessionId,snapshot.selection.mediaRefs);
    if(media.some((value,index)=>value.incarnation!==snapshot.mediaBindings[index]?.incarnation))throw denied();
    const selection=structuredClone(snapshot.selection);
    const limits=this.database.prepare("SELECT workspace_id,read_allowed,write_allowed,automation_allowed FROM task_workspace_limits WHERE session_id=? AND executor_bot_id=? AND selection_version=?").all(sessionId,executor,version) as {workspace_id:string;read_allowed:number;write_allowed:number;automation_allowed:number}[];
    selection.workspaces=selection.workspaces.map(item=>{const limit=limits.find(value=>value.workspace_id===item.id);return {...item,read:Boolean(limit?.read_allowed),write:Boolean(limit?.write_allowed),automation:Boolean(limit?.automation_allowed)};});
    const mcpIdentities:Record<string,TaskMcpIdentity>={};
    for(const item of selection.mcp){const captured=this.database.prepare("SELECT server_version,identity_digest FROM task_mcp_limits WHERE revoked=0 AND session_id=? AND executor_bot_id=? AND selection_version=? AND server_id=?").get(sessionId,executor,version,item.serverId) as {server_version:number;identity_digest:string}|undefined;
      if(!captured||!this.mcpReader)throw denied();const current=this.mcpReader(sessionId,executor,item);if(current.version!==captured.server_version||current.identityDigest!==captured.identity_digest)throw denied();mcpIdentities[item.serverId]=current;}
    return {sessionId,executorBotId:executor,selectionVersion:version,selectionDigest:row.digest,executorIncarnation:row.executor_incarnation,selection,memories:structuredClone(snapshot.memories),history:structuredClone(snapshot.history),mcpIdentities};
  }
  /** Raw authority reader: never calls Library/Media or the full policy recursively. */
  private referenceSnapshot(sessionId:string,executor:string,runtimeId?:string):Snapshot|null{
    const session=this.host.getSession(sessionId);
    if(runtimeId&&!this.database.prepare("SELECT 1 FROM runtime_runs WHERE id=? AND session_id=? AND executor_bot_id=? AND input_generation=?").get(runtimeId,sessionId,executor,session.generation))throw denied();
    if(session.kind!=="TASK")return null;this.host.assertSessionExecutor(sessionId,executor);
    let version=this.selectionVersion(sessionId,executor),expectedDigest:string|undefined,incarnation:string|undefined;
    if(runtimeId){const pin=this.database.prepare("SELECT r.input_generation,p.task_selection_version,p.task_selection_digest,p.task_executor_incarnation FROM runtime_runs r JOIN runtime_session_scopes p ON p.runtime_run_id=r.id WHERE r.id=? AND r.session_id=? AND r.executor_bot_id=?").get(runtimeId,sessionId,executor) as {input_generation:number;task_selection_version:number|null;task_selection_digest:string|null;task_executor_incarnation:string|null}|undefined;
      if(!pin||pin.input_generation!==session.generation||!pin.task_selection_version||!pin.task_selection_digest||!pin.task_executor_incarnation)throw denied();
      version=pin.task_selection_version;expectedDigest=pin.task_selection_digest;incarnation=pin.task_executor_incarnation;
    }
    const row=this.database.prepare("SELECT * FROM task_context_selections WHERE session_id=? AND executor_bot_id=? AND version=?").get(sessionId,executor,version) as SelectionRow|undefined;
    if(!row||hash(row.snapshot_json)!==row.digest||expectedDigest&&row.digest!==expectedDigest||incarnation&&row.executor_incarnation!==incarnation)throw denied();
    if(!this.database.prepare("SELECT 1 FROM task_executor_admissions WHERE session_id=? AND executor_bot_id=? AND incarnation=? AND revoked=0").get(sessionId,executor,row.executor_incarnation))throw denied();
    if(JSON.parse(row.revoked_memories_json).length||JSON.parse(row.revoked_resources_json).length||JSON.parse(row.revoked_media_json).length)throw denied();
    const snapshot=JSON.parse(row.snapshot_json) as Snapshot;taskExecutorSelectionSchema.parse(snapshot.selection);
    for(const item of snapshot.resourceBindings){const binding=this.database.prepare("SELECT b.version FROM session_resource_bindings b JOIN library_resources r ON r.id=b.resource_id JOIN library_revisions v ON v.resource_id=r.id AND v.id=? AND v.digest=? WHERE b.session_id=? AND b.resource_id=? AND b.revoked_at IS NULL AND r.enabled=1 AND r.deleted_at IS NULL").get(item.reference.revisionId,item.reference.digest,sessionId,item.reference.resourceId) as {version:number}|undefined;if(!binding||binding.version!==item.bindingVersion)throw denied();}
    for(const item of snapshot.mediaBindings){const binding=this.database.prepare("SELECT b.incarnation FROM session_media_bindings b JOIN media_assets a ON a.id=b.media_id WHERE b.session_id=? AND b.media_id=? AND b.revoked_at IS NULL AND a.enabled=1 AND a.deleted_at IS NULL AND a.sha256=?").get(sessionId,item.reference.mediaId,item.reference.sha256) as {incarnation:string}|undefined;if(!binding||binding.incarnation!==item.incarnation)throw denied();}
    return snapshot;
  }
  libraryReferences(sessionId:string,executor:string,runtimeId?:string):Snapshot["resourceBindings"]|null{return this.referenceSnapshot(sessionId,executor,runtimeId)?.resourceBindings??null;}
  mediaReferences(sessionId:string,executor:string,runtimeId?:string):TaskExecutorSelection["mediaRefs"]|null{return this.referenceSnapshot(sessionId,executor,runtimeId)?.selection.mediaRefs??null;}
  getSelections(sessionId:string):TaskExecutorSelection[]{const detail=this.get(sessionId);return detail.admittedExecutorBotIds.map(executor=>{const row=this.database.prepare("SELECT snapshot_json FROM task_context_selections WHERE session_id=? AND executor_bot_id=? ORDER BY version DESC LIMIT 1").get(sessionId,executor) as {snapshot_json:string};return taskExecutorSelectionSchema.parse(JSON.parse(row.snapshot_json).selection);});}
  workspaceLimits(sessionId:string,executor:string):TaskExecutorSelection["workspaces"]|null{
    if(this.host.getSession(sessionId).kind!=="TASK")return null;this.assertExecutor(sessionId,executor);
    return (this.database.prepare("SELECT workspace_id,read_allowed,write_allowed,automation_allowed FROM task_workspace_limits WHERE session_id=? AND executor_bot_id=? AND selection_version=?").all(sessionId,executor,this.selectionVersion(sessionId,executor)) as {workspace_id:string;read_allowed:number;write_allowed:number;automation_allowed:number}[]).map(row=>({id:row.workspace_id,read:Boolean(row.read_allowed),write:Boolean(row.write_allowed),automation:Boolean(row.automation_allowed)}));
  }
}
