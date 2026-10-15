import type { TaskSessionChanged, TaskCancelInput, TaskCreateInput, TaskListInput, TaskOptions, TaskScopeInput, TaskSelectionUpdateInput, TaskUpdateInput } from "@shared/task-session-contracts";
import { taskCreateSchema, taskListSchema, taskScopeSchema, taskUpdateSchema, taskSelectionUpdateSchema, taskCancelSchema } from "@shared/task-session-schemas";
import { PRODUCT_OPERATIONS } from "@shared/product-operations";
import { digestMessage, type AppRepository } from "./database";
import type { SendWorker } from "./send-worker";
import type { RoomCoordinator } from "./room-coordinator";
import type { EnvironmentService } from "./environment-service";
import type { McpService } from "./mcp-service";
import { AevorenBotError } from "./errors";

export class TaskSessionService {
  constructor(private readonly repository:AppRepository,private readonly worker:SendWorker,private readonly rooms:RoomCoordinator,private readonly mcp:Pick<McpService,"availableTools">,private readonly changed:(event:TaskSessionChanged)=>void=()=>{},private readonly environments?:Pick<EnvironmentService,"retire">){}
  options(input:TaskScopeInput,actor?:string,runtimeRunId?:string):TaskOptions {
    const {sessionId}=taskScopeSchema.parse(input),repo=this.repository,session=repo.getSession(sessionId);
    if(actor)repo.assertSessionExecutor(sessionId,actor);
    const botIds=session.botId?[session.botId]:repo.getRoomDetail(session.roomId!,sessionId).members.map(item=>item.botId);
    const runtimePolicy=runtimeRunId?repo.tasks.runtimeTaskPolicy(runtimeRunId):null;
    if(runtimePolicy&&(runtimePolicy.sessionId!==sessionId||runtimePolicy.executorBotId!==actor))throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    const selected=session.kind==="TASK"?(runtimePolicy?[runtimePolicy.selection]:repo.tasks.getSelections(sessionId)):null;
    const policies=new Map(botIds.filter(id=>!actor||id===actor).map(id=>[id,selected?.find(item=>item.executorBotId===id)??null]));
    if(actor&&session.kind==="TASK"&&!runtimePolicy)repo.tasks.taskSessionPolicy(sessionId,actor);
    const executors=botIds.filter(id=>!actor||id===actor).map(id=>({id,name:repo.getBot(id).name,
      memories:runtimePolicy?runtimePolicy.memories.map(item=>item.memory):repo.listRuntimeMemories(id,sessionId),workspaces:repo.listSessionWorkspaces(sessionId,id).flatMap(workspace=>{const limit=runtimePolicy?.selection.workspaces.find(item=>item.id===workspace.id);return runtimePolicy&&!limit?.read?[]:[{...workspace,writeEnabled:workspace.writeEnabled&&(!runtimePolicy||limit!.write),automationEnabled:workspace.automationEnabled&&(!runtimePolicy||limit!.automation)}];}),
      mcpTools:this.mcp.availableTools(id).filter(tool=>tool.readOnly&&(!policies.get(id)||policies.get(id)!.mcp.some(item=>item.serverId===tool.serverId&&item.toolNames.includes(tool.name)))).map(tool=>({serverId:tool.serverId,serverVersion:repo.getMcpServerConfig(tool.serverId).version,serverName:tool.serverName,name:tool.name})),
    }));
    const visibleSelections=selected?.filter(item=>!actor||item.executorBotId===actor)??null;
    const allowedResources=visibleSelections?.flatMap(item=>item.resourceRefs);
    const resources=repo.library.list({sessionId},actor,runtimeRunId).filter(item=>!allowedResources||allowedResources.some(ref=>ref.resourceId===item.id)).flatMap(resource=>{
      try {const pinned=allowedResources?.find(ref=>ref.resourceId===resource.id);
        const content=repo.library.read({sessionId,id:resource.id,...(pinned?{revisionId:pinned.revisionId}:{})},actor,runtimeRunId);
        return [{reference:content.reference,name:content.revision.name,kind:resource.kind}];
      }catch{return [];}
    });
    return {session,scopeVersion:repo.tasks.scopeVersion(sessionId),executors,
      history:repo.listTranscript(sessionId).filter(entry=>entry.generation===session.generation&&entry.status==="completed").slice(-100)
        .map(entry=>({entryId:entry.id,generation:entry.generation,digest:digestMessage(entry.body),role:entry.role,body:entry.body})),
      resources,media:(runtimeRunId?repo.media.listRuntimeItems({sessionId,executorBotId:actor!,runtimeRunId}):repo.media.list({sessionId},actor)).filter(item=>!visibleSelections||visibleSelections.some(selection=>selection.mediaRefs.some(ref=>ref.mediaId===item.reference.mediaId))),productOperations:PRODUCT_OPERATIONS.filter(item=>!visibleSelections||visibleSelections.some(selection=>selection.productOperations.includes(item.name))).map(({name,description})=>({name,description})),
      currentSelections:selected?.filter(item=>!actor||item.executorBotId===actor)??null};
  }
  create(input:TaskCreateInput,actor?:string){const result=this.repository.tasks.create(taskCreateSchema.parse(input),actor);this.changed({sessionId:result.session.id,...(result.parentSessionId?{parentSessionId:result.parentSessionId}:{})});return result;}
  list(input:TaskListInput,actor?:string){return this.repository.tasks.list(taskListSchema.parse(input),actor);}
  get(input:TaskScopeInput,actor?:string){return this.repository.tasks.get(taskScopeSchema.parse(input),actor);}
  update(input:TaskUpdateInput,actor?:string){const result=this.repository.tasks.update(taskUpdateSchema.parse(input),actor);this.changed({sessionId:result.session.id,...(result.parentSessionId?{parentSessionId:result.parentSessionId}:{})});return result;}
  revise(input:TaskSelectionUpdateInput,actor?:string){const result=this.repository.tasks.reviseSelection(taskSelectionUpdateSchema.parse(input),actor);this.changed({sessionId:result.session.id,...(result.parentSessionId?{parentSessionId:result.parentSessionId}:{})});return result;}
  cancel(input:TaskCancelInput,actor?:string){
    const parsed=taskCancelSchema.parse(input),result=this.repository.tasks.cancel(parsed,actor);
    for(const run of this.repository.listRuntimeRuns(parsed.sessionId))if(["created","dispatching","running","streaming","cancel-requested"].includes(run.state))this.worker.executor.cancelRun(run.id);
    const session=this.repository.getSession(parsed.sessionId);
    if(session.roomId)for(const batch of this.repository.listRoomBatches(session.roomId))if(batch.sessionId===session.id&&["queued","running"].includes(batch.state))this.rooms.cancel(batch.id);
    this.changed({sessionId:result.session.id,...(result.parentSessionId?{parentSessionId:result.parentSessionId}:{})});return result;
  }
  async delete(input:TaskCancelInput,actor?:string):Promise<void>{
    const parsed=taskCancelSchema.parse(input);
    const check=():void=>{const current=this.repository.tasks.get({sessionId:parsed.sessionId},actor);if(current.version!==parsed.expectedVersion)throw new AevorenBotError("CONVERSATION_VERSION_CONFLICT");this.repository.assertTaskSessionIdle(parsed.sessionId);};
    const remove=():void=>{check();this.repository.tasks.delete(parsed,actor);this.changed({sessionId:parsed.sessionId,deleted:true});};
    if(this.environments)await this.environments.retire([parsed.sessionId],[],check,remove);else remove();
  }
}
