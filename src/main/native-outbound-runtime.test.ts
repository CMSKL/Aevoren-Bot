import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach,describe,expect,it } from "vitest";
import { AppRepository,MIGRATIONS } from "./database";
const repositories:AppRepository[]=[],folders:string[]=[];afterEach(()=>{for(const repository of repositories.splice(0))repository.close();for(const folder of folders.splice(0))rmSync(folder,{recursive:true,force:true});});
function run(repository:AppRepository,sessionId:string,botId:string,route:"host-outbound"|"fake"="host-outbound") {const nonce=randomUUID();if(route==="host-outbound")repository.prepareHostOutboundMessage({sessionId,clientNonce:nonce,text:"Approve fixed local draft"},botId);else repository.prepareMessage({sessionId,clientNonce:nonce,text:"Model task"});const message=repository.getUserMessage(nonce),session=repository.getSession(sessionId);const runtime=repository.createRuntimeRun(nonce,route,{schemaVersion:1,botId,profileVersion:1,sessionId,generation:session.generation,inputSeq:message.seq,blocks:[],digest:"host-outbound-fixture"},{executorBotId:botId});repository.transitionRuntimeRun(runtime.id,"dispatching");return repository.transitionRuntimeRun(runtime.id,"running",{providerRequestId:`host-owned:${runtime.id}`});}
describe("owned host outbound Runtime",()=>{
 it("six different group members all start before completion and one member stop does not affect siblings",()=>{const repository=new AppRepository(":memory:");repositories.push(repository);const bots=Array.from({length:6},()=>repository.createBot().bot),room=repository.createRoom({memberBotIds:bots.map(bot=>bot.id)});const runs=bots.map(bot=>run(repository,room.session.id,bot.id));expect(runs).toHaveLength(6);expect(runs.every(value=>value.route==="host-outbound"&&value.providerInstanceId==="host-outbound")).toBe(true);expect(()=>run(repository,room.session.id,bots[0]!.id)).toThrow();repository.transitionRuntimeRun(runs[0]!.id,"cancel-requested");repository.transitionRuntimeRun(runs[0]!.id,"cancelled");expect(runs.slice(1).map(value=>repository.getRuntimeRun(value.id).state)).toEqual(Array(5).fill("running"));});
 it("host action cannot run alongside an ordinary model task or bypass a private Bot's active task",()=>{const repository=new AppRepository(":memory:");repositories.push(repository);const owner=repository.createBot(),second=repository.createBot(),room=repository.createRoom({memberBotIds:[owner.bot.id,second.bot.id]});run(repository,room.session.id,owner.bot.id,"fake");expect(()=>run(repository,room.session.id,second.bot.id)).toThrow();const privateOwner=repository.createBot();run(repository,privateOwner.session.id,privateOwner.bot.id);expect(()=>run(repository,privateOwner.session.id,privateOwner.bot.id)).toThrow();});
 it("migration39 preserves real legacy Runtime rows, scope trigger and foreign-key integrity",()=>{const folder=mkdtempSync(join(tmpdir(),"aevoren-native-route-migration-"));folders.push(folder);const filename=join(folder,"old.sqlite"),db=new DatabaseSync(filename);db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)");for(const migration of MIGRATIONS.filter(value=>value.version<=38)){if("foreignKeysOff"in migration&&migration.foreignKeysOff)db.exec("PRAGMA foreign_keys=OFF");db.exec(migration.sql);db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(migration.version,"2026-10-14T00:00:00Z");db.exec("PRAGMA foreign_keys=ON");}const legacyBot=randomUUID(),legacySession=randomUUID(),legacyNonce=randomUUID(),legacyRun=randomUUID();
 db.prepare("INSERT INTO bots(id,project_id,name,label,description,instructions,version,created_at,updated_at) VALUES(?,(SELECT id FROM projects WHERE is_default=1),'Legacy','','','',1,'t','t')").run(legacyBot);
 db.prepare("INSERT INTO sessions(id,bot_id,kind,generation,created_at,updated_at) VALUES(?,?,'MAIN',1,'t','t')").run(legacySession,legacyBot);
 db.prepare("INSERT INTO send_journal(client_nonce,session_id,body_digest,state,attempt_count,created_at,updated_at) VALUES(?,?,'digest','acked',0,'t','t')").run(legacyNonce,legacySession);
 const manifest=JSON.stringify({schemaVersion:1,botId:legacyBot,profileVersion:1,sessionId:legacySession,generation:1,inputSeq:1,blocks:[],digest:'legacy'});
 db.prepare("INSERT INTO runtime_runs VALUES(?,?,?,?,?,1,'running','fake','fake','',1,1,1,NULL,'legacy-request',?,1,NULL,'t','t','t',NULL)").run(legacyRun,legacySession,legacyNonce,legacyNonce,legacyBot,manifest);
 const toolId=randomUUID(),approvalId=randomUUID(),environmentId=randomUUID(),executionSessionId=randomUUID(),executionId=randomUUID();
 db.exec("BEGIN");
 db.prepare(`INSERT INTO tool_invocations(id,runtime_run_id,session_id,executor_bot_id,tool_call_id,idempotency_key,command_digest,
 tool_kind,effect_class,target_path,arguments_json,state,attempt_count,approval_request_id,version,created_at,updated_at)
 VALUES(?,?,?,?,?,? ,?,'text-measure','pure','measure',?,'awaiting-approval',0,?,1,'t','t')`)
 .run(toolId,legacyRun,legacySession,legacyBot,"legacy-tool",randomUUID(),"a".repeat(64),JSON.stringify({kind:"text-measure",text:"Legacy words"}),approvalId);
 db.prepare(`INSERT INTO approval_requests(id,tool_invocation_id,runtime_run_id,session_id,executor_bot_id,action_kind,effect_class,
 target_path,target_digest,arguments_digest,requested_scope,state,policy_version,version,expires_at,created_at,updated_at)
 VALUES(?,?,?,?,?,'text-measure','pure','measure',?,?,'once','pending',1,1,?,'t','t')`)
 .run(approvalId,toolId,legacyRun,legacySession,legacyBot,"a".repeat(64),"a".repeat(64),new Date(Date.now()+300000).toISOString());
 db.prepare(`INSERT INTO environments(id,session_id,executor_bot_id,version,state,worker_version,image_ref,image_digest,platform,created_at,updated_at)
 VALUES(?,?,?,1,'running','1.2.0','fixture',?,'linux/arm64','t','t')`).run(environmentId,legacySession,legacyBot,`sha256:${"b".repeat(64)}`);
 db.prepare("INSERT INTO execution_sessions VALUES(?,?,?,'t')").run(executionSessionId,environmentId,legacyRun);
 db.prepare(`INSERT INTO environment_executions(id,environment_id,execution_session_id,runtime_run_id,client_nonce,version,kind,command,cwd,state,created_at)
 VALUES(?,?,?,?,?,1,'background','node server.js','.','running','t')`).run(executionId,environmentId,executionSessionId,legacyRun,randomUUID());
 db.prepare("INSERT INTO environment_logs VALUES(?,1,'stdout','legacy output',NULL,'t')").run(executionId);
 db.prepare("INSERT INTO environment_ports VALUES(?,?,?,3000,'Legacy server','listening','t')").run(randomUUID(),environmentId,executionId);
 db.exec("COMMIT");
 const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all() as{name:string}[]).map(value=>value.name);
 const tableRows=(database:DatabaseSync,name:string)=>database.prepare(`SELECT * FROM "${name}"`).all().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const rows=new Map(tables.map(name=>[name,tableRows(db,name)]));
 const foreignKeys=new Map(tables.map(name=>[name,db.prepare(`PRAGMA foreign_key_list("${name}")`).all()]));
 const indexes=db.prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
 const before=db.prepare("SELECT * FROM runtime_runs WHERE id=?").get(legacyRun);db.close();
 const repository=new AppRepository(filename);repositories.push(repository);const database=(repository as unknown as{database:DatabaseSync}).database;
 expect(database.prepare("SELECT * FROM runtime_runs WHERE id=?").get(legacyRun)).toEqual(before);
 expect(database.prepare("SELECT scope_version FROM runtime_session_scopes WHERE runtime_run_id=?").get(legacyRun)).toEqual({scope_version:1});
 for(const name of tables){expect(tableRows(database,name),name).toEqual(rows.get(name));expect(database.prepare(`PRAGMA foreign_key_list("${name}")`).all(),`${name} FKs`).toEqual(foreignKeys.get(name));}
 const migratedIndexes=database.prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
 expect(migratedIndexes).toEqual(expect.arrayContaining(indexes));
 expect(repository.getApprovalRequest(approvalId)).toMatchObject({state:"pending",runtimeRunId:legacyRun});
 expect(repository.getToolInvocation(toolId)).toMatchObject({state:"awaiting-approval",runtimeRunId:legacyRun});
 expect(repository.environments.listRuntimeExecutions(legacyRun)[0]).toMatchObject({id:executionId,runtimeRunId:legacyRun,state:"running"});
 const bot=repository.createBot(),runtime=run(repository,bot.session.id,bot.bot.id);expect(repository.getRuntimeRun(runtime.id)).toEqual(runtime);
 expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);expect(database.prepare("SELECT scope_version FROM runtime_session_scopes WHERE runtime_run_id=?").get(runtime.id)).toEqual({scope_version:1});});
});
