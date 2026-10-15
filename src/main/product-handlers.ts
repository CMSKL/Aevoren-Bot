import { ORGANIZATION_PRODUCT_OPERATIONS } from "@shared/organization-product";
import type { OrganizationChanged } from "@shared/organization-contracts";
import type { OrganizationService } from "./organization-service";
import type { SearchService } from "./search-service";
import { SEARCH_CHANNELS } from "@shared/search-channels";
import { searchOpenSchema, searchQuerySchema } from "@shared/search-schemas";
import { z } from "zod";
import { TASK_SESSION_PRODUCT_OPERATIONS } from "@shared/task-session-product";
import type { TaskSessionService } from "./task-session-service";
import { REALTIME_PRODUCT_OPERATIONS } from "@shared/realtime-product";
import { realtimeInputSchema } from "@shared/realtime-schemas";
import type { RealtimeService } from "./realtime-service";
import { addVoiceProductHandlers, type VoiceProductDependencies } from "./voice-product-handlers";
import { addMediaProductHandlers, type MediaProductDependencies } from "./media-product-handlers";
import { addMcpWriteProductHandlers, type McpWriteProductDependencies } from "./mcp-write-product-handlers";
import { addNativeOutboundProductHandlers } from "./native-outbound-product-handlers";
import type { NativeOutboundService } from "./native-outbound-service";
import { clipboard } from "electron";
import { IPC } from "@shared/channels";
import {
  approvalResolutionSchema,
  artifactSaveSchema,
  artifactRevealSchema,
  batchIdSchema,
  briefApprovalReadSchema,
  briefApprovalCommandSchema,
  botHiddenSchema,
  botIdSchema,
  botPinnedSchema,
  botUnreadSchema,
  botUpdateSchema,
  capabilitySnapshotInputSchema,
  conversationBatchDeleteSchema,
  conversationPinnedSchema,
  conversationUnreadSchema,
  conversationHiddenSchema,
  conversationProjectSchema,
  generalSettingsSchema,
  memoryCreateSchema,
  memoryListSchema,
  memoryMutationSchema,
  memoryProposalAcceptSchema,
  memoryProposalListSchema,
  memoryUpdateSchema,
  mcpServerEnabledSchema,
  mcpServerIdSchema,
  mcpServerMutationIdSchema,
  mcpServerMutationSchema,
  nonceSchema,
  roomArchiveSchema,
  roomCreateSchema,
  roomHiddenSchema,
  roomIdSchema,
  roomListSchema,
  roomMembershipSchema,
  roomPinnedSchema,
  roomSendCommandSchema,
  roomUnreadSchema,
  roomUpdateSchema,
  routineCreateSchema,
  routineEnabledSchema,
  routineIdSchema,
  routineMutationSchema,
  routineUpdateSchema,
  runIdSchema,
  sendCommandSchema,
  providerInstanceIdInputSchema,
  projectContextSchema,
  projectCreateSchema,
  saveCliProviderSchema,
  saveOpenAiCompatibleProviderSchema,
  sessionIdSchema,
  toolSessionScopeSchema,
  turnIdSchema,
  workspaceMutationSchema,
  workspacePermissionsSchema,
  workspaceRevealSchema,
} from "@shared/schemas";
import { AevorenBotError } from "./errors";
import type { AppRepository } from "./database";
import type { GeneralSettingsService } from "./settings";
import type { ProviderService } from "./provider-service";
import type { SendWorker } from "./send-worker";
import type { RoomCoordinator } from "./room-coordinator";
import type { WorkspaceService } from "./workspace-service";
import type { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import type { UpdateService } from "./update-service";
import type { CapabilityRegistry } from "./capability-registry";
import type { McpService } from "./mcp-service";
import type { RoutineService } from "./routine-service";
import { UserProfileService } from "./user-profile-service";
import { addLibraryProductHandlers, type LibraryExecutionContext } from "./library-product-handlers";
import type { LibraryService } from "./library-service";
import type { LibraryChangedEvent, LibraryExportResult, LibraryResourceKind } from "@shared/library-contracts";
import { addEnvironmentProductHandlers, type EnvironmentProductDependencies } from "./environment-product-handlers";
import { addDemonstrationProductHandlers, type DemonstrationProductDependencies } from "./demonstration-product-handlers";
import { addBrowserProductHandlers, type BrowserProductDependencies } from "./browser-product-handlers";
import { addSkillExecutionProductHandlers, type SkillExecutionProductDependencies } from "./skill-execution-product-handlers";
import { addNativeConnectorProductHandlers, type NativeConnectorProductDependencies } from "./native-connector-product-handlers";
import { approvalReviewInputSchema } from "@shared/skill-execution-schemas";

export type ProductDependencies = VoiceProductDependencies & MediaProductDependencies & McpWriteProductDependencies & EnvironmentProductDependencies & BrowserProductDependencies & DemonstrationProductDependencies & SkillExecutionProductDependencies & NativeConnectorProductDependencies & {
  nativeOutboundService?: NativeOutboundService;
  libraryService?: LibraryService;
  libraryChanged?(event: LibraryChangedEvent): void;
  pickLibraryPaths?(input: { sessionId: string; kind: LibraryResourceKind; directory?: boolean }, signal?: AbortSignal): Promise<string[] | null>;
  exportLibraryResource?(input: { sessionId: string; id: string; revisionId?: string }, signal?: AbortSignal): Promise<LibraryExportResult | null>;
  realtimeService?: RealtimeService;
  taskSessionService?: TaskSessionService;
  searchService?: SearchService;
  organizationService?:OrganizationService;
  organizationChanged?(event:OrganizationChanged):void;
  productChanged?(): void;
  sessionChanged?(session: import("@shared/contracts").Session): void;
  requestUpdateAfterRun?(runId: string): import("@shared/product-view").ProductViewResult;
  requestExitAfterRun?(runId: string): import("@shared/product-view").ProductViewResult;
  requestView?(input: import("@shared/product-view").ProductViewInput): Promise<import("@shared/product-view").ProductViewResult>;
  repository: AppRepository;
  providers: ProviderService;
  generalSettings: GeneralSettingsService;
  sendWorker: SendWorker;
  roomCoordinator: RoomCoordinator;
  workspaceService: WorkspaceService;
  workspaceToolCoordinator: WorkspaceToolCoordinator;
  capabilityRegistry: CapabilityRegistry;
  mcpService: McpService;
  routineService: RoutineService;
  updateService: UpdateService;
  pickWorkspaceRoot(): Promise<string | null>;
  pickAttachments(): Promise<import("@shared/contracts").AttachmentDraft[]>;
  saveArtifact(input: import("@shared/contracts").ArtifactSaveInput): Promise<import("@shared/contracts").ArtifactSaveResult | null>;
  revealArtifact(path: string): boolean;
  revealWorkspaceTarget(input: { workspaceId: string; path: string }): Promise<boolean>;
  forceFakeProvider: boolean;
  prepareUpdateInstall(): void;
  cancelUpdateInstall(): void;
};

export function createProductHandlers(dependencies: ProductDependencies, commit: <T>(operation: () => T) => T = (operation) => operation(), memorySourceEntryId?: string, libraryContext?: LibraryExecutionContext): Map<string, (input?: unknown) => unknown> {
  const { repository, providers, generalSettings, sendWorker, roomCoordinator, workspaceService, workspaceToolCoordinator } = dependencies;
  const userProfile = new UserProfileService(repository);

  const roomLead = async (memberBotIds: string[], requested: string | null | undefined): Promise<string | null> => {
    if (requested === null) return null;
    if (requested !== undefined && !memberBotIds.includes(requested)) throw new AevorenBotError("ROOM_LEAD_UNAVAILABLE");
    const available = await providers.list();
    const eligible = memberBotIds.filter((id) => {
      const selection = repository.getBot(id).modelSelection;
      const provider = available.find((candidate) => candidate.id === selection.providerInstanceId);
      return provider?.enabled && provider.status === "available" && provider.capabilities.handoff &&
        Boolean(selection.modelId) && provider.models.options.some((model) => model.id === selection.modelId);
    });
    const leadBotId = requested === undefined ? eligible[0] ?? null : requested;
    if (leadBotId) {
      if (!eligible.includes(leadBotId)) throw new AevorenBotError("ROOM_LEAD_UNAVAILABLE");
      roomCoordinator.assertLeadAvailable(memberBotIds, leadBotId);
    }
    return leadBotId;
  };

  const handlers = new Map<string, (input?: unknown) => unknown>();
  for(const definition of ORGANIZATION_PRODUCT_OPERATIONS)handlers.set(definition.channel,input=>{
    const service=dependencies.organizationService;if(!service)throw new AevorenBotError("INVALID_REQUEST");
    if(definition.name==="organization.snapshot")return service.snapshot(libraryContext);
    const result=commit(()=>{switch(definition.name){
      case "organization.createSection":return service.createSection(input as import("@shared/organization-contracts").OrganizationCreateSection,libraryContext);
      case "organization.renameSection":return service.renameSection(input as import("@shared/organization-contracts").OrganizationRenameSection,libraryContext);
      case "organization.deleteSection":return service.deleteSection(input as import("@shared/organization-contracts").OrganizationDeleteSection,libraryContext);
      case "organization.reorderSections":return service.reorderSections(input as import("@shared/organization-contracts").OrganizationReorderSections,libraryContext);
      case "organization.moveSession":return service.moveSession(input as import("@shared/organization-contracts").OrganizationMoveSession,libraryContext);
      case "organization.savePreferences":return service.savePreferences(input as import("@shared/organization-contracts").OrganizationSavePreferences,libraryContext);
      default:throw new AevorenBotError("INVALID_REQUEST");
    }});dependencies.organizationChanged?.({version:result.version});return result;
  });
  handlers.set(SEARCH_CHANNELS.query,input=>{if(!dependencies.searchService)throw new AevorenBotError("INVALID_REQUEST");return dependencies.searchService.query(searchQuerySchema.parse(input),libraryContext);});
  handlers.set(SEARCH_CHANNELS.open,input=>{if(!dependencies.searchService)throw new AevorenBotError("INVALID_REQUEST");return dependencies.searchService.open(searchOpenSchema.parse(input),libraryContext);});
  addLibraryProductHandlers(handlers, dependencies, commit, libraryContext);
  addMediaProductHandlers(handlers, dependencies, commit, libraryContext);
  addVoiceProductHandlers(handlers, dependencies, commit);
  for (const definition of TASK_SESSION_PRODUCT_OPERATIONS) handlers.set(definition.channel,input=>{
    const service=dependencies.taskSessionService;if(!service)throw new AevorenBotError("INVALID_REQUEST");
    switch(definition.name){
      case "sessions.taskOptions":return service.options(input as import("@shared/task-session-contracts").TaskScopeInput);
      case "sessions.createTask":return commit(()=>service.create(input as import("@shared/task-session-contracts").TaskCreateInput));
      case "sessions.listTasks":return service.list(input as import("@shared/task-session-contracts").TaskListInput);
      case "sessions.getTask":return service.get(input as import("@shared/task-session-contracts").TaskScopeInput);
      case "sessions.updateTask":return commit(()=>service.update(input as import("@shared/task-session-contracts").TaskUpdateInput));
      case "sessions.reviseTaskSelection":return commit(()=>service.revise(input as import("@shared/task-session-contracts").TaskSelectionUpdateInput));
      case "sessions.cancelTask":return service.cancel(input as import("@shared/task-session-contracts").TaskCancelInput);
      case "sessions.deleteTask":return service.delete(input as import("@shared/task-session-contracts").TaskCancelInput);
      default:throw new AevorenBotError("INVALID_REQUEST");
    }
  });
  for (const definition of REALTIME_PRODUCT_OPERATIONS) handlers.set(definition.channel, input => {
    const service = dependencies.realtimeService;
    if (!service) throw new AevorenBotError("VOICE_UNSUPPORTED");
    const parsed = realtimeInputSchema.parse(input);
    return definition.name.endsWith("snapshot") ? service.snapshot(parsed) : definition.name.endsWith("stopTask") ? service.stopTask(parsed) : service.stop(parsed);
  });
  addEnvironmentProductHandlers(handlers, dependencies, commit, libraryContext);
  addBrowserProductHandlers(handlers, dependencies, commit, libraryContext);
  addDemonstrationProductHandlers(handlers, dependencies, commit, libraryContext);
  addSkillExecutionProductHandlers(handlers, dependencies, commit, libraryContext);
  addNativeConnectorProductHandlers(handlers, dependencies, commit, libraryContext);
  addNativeOutboundProductHandlers(handlers, dependencies, libraryContext);
  addMcpWriteProductHandlers(handlers, dependencies, libraryContext);
  const handle = (channel: string, operation: (input?: unknown) => unknown): void => { handlers.set(channel, operation); };
  handle(IPC.roomRuntimeCancelMember, (input: unknown) => {
    const runId = runIdSchema.parse(input);
    if (libraryContext && repository.getRuntimeRun(runId).sessionId !== libraryContext.sessionId) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    return roomCoordinator.cancelMember(runId);
  });
  handle(IPC.approvalsReview, (input: unknown) => {
    const parsed = approvalReviewInputSchema.parse(input);
    if (libraryContext && (parsed.sessionId !== libraryContext.sessionId || parsed.executorBotId !== libraryContext.executorBotId)) throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
    const result = repository.getApprovalReview(parsed);
    if (!result.snapshot || !result.executable) return result;
    try {
      if (result.snapshot.kind === "demonstration-skill") {
        dependencies.repository.demonstrations.assertApprovalReview(result.snapshot, { sessionId: parsed.sessionId, executorBotId: parsed.executorBotId });
      } else if (result.snapshot.kind === "skill-script") {
        if (!dependencies.skillExecutionService) throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
        dependencies.skillExecutionService.assertApprovalReview(result.snapshot, { sessionId: parsed.sessionId, executorBotId: parsed.executorBotId },repository.getApprovalRequest(parsed.id).runtimeRunId);
      } else if (result.snapshot.kind === "mcp-write") {
        if (!dependencies.mcpWriteService) throw new AevorenBotError("MCP_SERVER_UNAVAILABLE");
        dependencies.mcpWriteService.assertApprovalReview(result.snapshot, { sessionId: parsed.sessionId, executorBotId: parsed.executorBotId });
      } else {
        if (!dependencies.nativeOutboundService) throw new AevorenBotError("CONNECTOR_UNAVAILABLE");
        dependencies.nativeOutboundService.assertApprovalReview(result.snapshot, { sessionId: parsed.sessionId, executorBotId: parsed.executorBotId });
      }
      return result;
    } catch (error) {
      return { ...result, executable: false, reason: error instanceof AevorenBotError ? error.message : "授权或环境已改变，请重新准备操作。" };
    }
  });

  handle(IPC.userProfileGet, () => userProfile.get());
  handle(IPC.userProfileUpdate, (input: unknown) => commit(() => userProfile.update(input)));
  handle(IPC.attachmentsPick, () => dependencies.pickAttachments());
  handle(IPC.artifactsSave, (input: unknown) => dependencies.saveArtifact(artifactSaveSchema.parse(input)));
  handle(IPC.artifactsReveal, (path: unknown) => dependencies.revealArtifact(artifactRevealSchema.parse(path)));
  handle(IPC.capabilitiesGetSnapshot, (input: unknown) =>
    dependencies.capabilityRegistry.getSnapshot(capabilitySnapshotInputSchema.parse(input)),
  );
  handle(IPC.mcpList, () => dependencies.mcpService.list());
  handle(IPC.mcpSave, (input: unknown) => dependencies.mcpService.save(mcpServerMutationSchema.parse(input)));
  handle(IPC.mcpSetEnabled, (input: unknown) => {
    const parsed = mcpServerEnabledSchema.parse(input);
    return dependencies.mcpService.setEnabled(parsed.id, parsed.expectedVersion, parsed.enabled);
  });
  handle(IPC.mcpProbe, (id: unknown) => dependencies.mcpService.probe(mcpServerIdSchema.parse(id)));
  handle(IPC.mcpAuthorize, (id: unknown) => dependencies.mcpService.authorize(mcpServerIdSchema.parse(id)));
  handle(IPC.mcpCancelAuthorization, (id: unknown) => dependencies.mcpService.cancelAuthorization(mcpServerIdSchema.parse(id)));
  handle(IPC.mcpClearAuthorization, (input: unknown) => {
    const parsed = mcpServerMutationIdSchema.parse(input);
    return dependencies.mcpService.clearAuthorization(parsed.id, parsed.expectedVersion);
  });
  handle(IPC.mcpDelete, (input: unknown) => {
    const parsed = mcpServerMutationIdSchema.parse(input);
    return dependencies.mcpService.delete(parsed.id, parsed.expectedVersion);
  });
  handle(IPC.routinesList, () => dependencies.routineService.list());
  handle(IPC.routinesListRuns, (routineId: unknown) =>
    dependencies.routineService.listRuns(routineId === undefined ? undefined : routineIdSchema.parse(routineId)),
  );
  handle(IPC.routinesCreate, (input: unknown) => dependencies.routineService.create(routineCreateSchema.parse(input)));
  handle(IPC.routinesUpdate, (input: unknown) => {
    const parsed = routineUpdateSchema.parse(input);
    return dependencies.routineService.update(parsed.id, parsed.expectedVersion, parsed.patch);
  });
  handle(IPC.routinesSetEnabled, (input: unknown) => {
    const parsed = routineEnabledSchema.parse(input);
    return dependencies.routineService.setEnabled(parsed.id, parsed.expectedVersion, parsed.enabled);
  });
  handle(IPC.routinesRunNow, (id: unknown) => dependencies.routineService.runNow(routineIdSchema.parse(id)));
  handle(IPC.routinesDelete, (input: unknown) => {
    const parsed = routineMutationSchema.parse(input);
    return dependencies.routineService.delete(parsed.id, parsed.expectedVersion);
  });
  handle(IPC.conversationsList, () => repository.listConversations());
  handle(IPC.conversationsSetPinned, (input: unknown) => {
    const parsed = conversationPinnedSchema.parse(input);
    return commit(() => repository.setConversationPinned(parsed.sessionId, parsed.pinned));
  });
  handle(IPC.conversationsSetUnread, (input: unknown) => {
    const parsed = conversationUnreadSchema.parse(input);
    return commit(() => repository.setConversationUnread(parsed.sessionId, parsed.unread));
  });
  handle(IPC.conversationsSetHidden, (input: unknown) => {
    const parsed = conversationHiddenSchema.parse(input);
    return commit(() => repository.setConversationHidden(parsed.sessionId, parsed.hidden));
  });
  handle(IPC.conversationsClear, (input: unknown) => {
    const sessionId = sessionIdSchema.parse(input);
    let changed: import("@shared/contracts").Session | undefined;
    const result = commit(() => { const value = repository.clearConversation(sessionId); changed = repository.getSession(sessionId); return value; });
    if (changed) dependencies.sessionChanged?.(changed);
    return result;
  });
  handle(IPC.conversationsSetProject, (input: unknown) => {
    const parsed = conversationProjectSchema.parse(input);
    return commit(() => repository.setConversationProject(parsed.sessionId, parsed.projectId, parsed.expectedVersion));
  });
  handle(IPC.conversationsDeleteBatch, (input: unknown) => {
    const parsed = conversationBatchDeleteSchema.parse(input);
    const remove = () => commit(() => repository.deleteConversations(parsed));
    return dependencies.environmentService ? dependencies.environmentService.retire(
      repository.listConversations().filter(item=>item.roomId&&parsed.roomIds.includes(item.roomId)).map(item=>item.sessionId), parsed.botIds,
      () => repository.assertConversationsDeletable(parsed), remove) : remove();
  });
  handle(IPC.teamsCreateContentTeam, (input: unknown) => {
    const parsed = projectContextSchema.parse(input ?? {});
    return commit(() => repository.createContentTeamTemplate(parsed.projectId));
  });
  handle(IPC.projectsCreate, (input: unknown) => commit(() => repository.createProject(projectCreateSchema.parse(input).name)));
  handle(IPC.roomsGetBriefApproval, (input: unknown) => roomCoordinator.getBriefApproval(briefApprovalReadSchema.parse(input)));
  handle(IPC.roomsApproveBrief, (input: unknown) => roomCoordinator.approveBrief(briefApprovalCommandSchema.parse(input)));
  handle(IPC.botsList, () => repository.listBots());
  handle(IPC.botsCreate, (input: unknown) => commit(() => repository.createBot(projectContextSchema.parse(input ?? {}).projectId)));
  handle(IPC.botsUpdate, (input: unknown) => {
    const parsed = botUpdateSchema.parse(input);
    if (parsed.patch.modelSelection && !providers.isSupported(parsed.patch.modelSelection.providerInstanceId)) {
      throw new AevorenBotError("MODEL_PROVIDER_NOT_FOUND");
    }
    return commit(() => repository.updateBot(parsed.id, parsed.expectedVersion, parsed.patch));
  });
  handle(IPC.botsSetPinned, (input: unknown) => {
    const parsed = botPinnedSchema.parse(input);
    return commit(() => repository.setBotPinned(parsed.id, parsed.pinned));
  });
  handle(IPC.botsSetUnread, (input: unknown) => {
    const parsed = botUnreadSchema.parse(input);
    return commit(() => repository.setBotUnread(parsed.id, parsed.unread));
  });
  handle(IPC.botsSetHidden, (input: unknown) => {
    const parsed = botHiddenSchema.parse(input);
    return commit(() => repository.setBotHidden(parsed.id, parsed.hidden));
  });
  handle(IPC.botsDuplicate, (id: unknown) => commit(() => repository.duplicateBot(botIdSchema.parse(id))));
  handle(IPC.botsDelete, (id: unknown) => {
    const parsed = botIdSchema.parse(id), remove = () => commit(() => repository.deleteBot(parsed));
    return dependencies.environmentService ? dependencies.environmentService.retire([], [parsed], () => repository.assertBotDeletable(parsed), remove) : remove();
  });
  handle(IPC.botsCopyConversationId, (id: unknown) => {
    const parsed = botIdSchema.parse(id);
    repository.getBot(parsed);
    clipboard.writeText(parsed);
  });
  handle(IPC.memoriesList, (input: unknown) => {
    const parsed = memoryListSchema.parse(input);
    return "botId" in parsed
      ? repository.listMemories(parsed.botId, parsed.includeDeleted ?? false)
      : repository.listScopedMemories({ scope: parsed.scope, scopeKey: parsed.scopeKey }, parsed.includeDeleted ?? false);
  });
  handle(IPC.memoriesCreate, (input: unknown) => {
    const parsed = memoryCreateSchema.parse(input);
    return "botId" in parsed
      ? commit(() => repository.createMemory(parsed.botId, parsed.content, { kind: parsed.kind, expiresAt: parsed.expiresAt, sourceEntryId: memorySourceEntryId }))
      : commit(() => repository.createScopedMemory(
          { scope: parsed.scope, scopeKey: parsed.scopeKey },
          parsed.content,
          { kind: parsed.kind, expiresAt: parsed.expiresAt, sourceEntryId: memorySourceEntryId },
        ));
  });
  handle(IPC.memoriesUpdate, (input: unknown) => {
    const parsed = memoryUpdateSchema.parse(input);
    return commit(() => repository.updateMemory(parsed.id, parsed.expectedVersion, parsed.content, {
      kind: parsed.kind,
      expiresAt: parsed.expiresAt,
    }));
  });
  handle(IPC.memoriesDelete, (input: unknown) => {
    const parsed = memoryMutationSchema.parse(input);
    return commit(() => repository.deleteMemory(parsed.id, parsed.expectedVersion));
  });
  handle(IPC.memoriesRestore, (input: unknown) => {
    const parsed = memoryMutationSchema.parse(input);
    return commit(() => repository.restoreMemory(parsed.id, parsed.expectedVersion));
  });
  handle(IPC.memoriesListProposals, (input: unknown) => {
    const parsed = memoryProposalListSchema.parse(input) ?? {};
    return repository.listMemoryProposals(parsed);
  });
  handle(IPC.memoriesAcceptProposal, (input: unknown) => {
    const parsed = memoryProposalAcceptSchema.parse(input);
    return commit(() => repository.acceptMemoryProposal(parsed.id, parsed.expectedVersion, {
      content: parsed.content,
      kind: parsed.kind,
      expiresAt: parsed.expiresAt,
    }));
  });
  handle(IPC.memoriesRejectProposal, (input: unknown) => {
    const parsed = memoryMutationSchema.parse(input);
    return commit(() => repository.rejectMemoryProposal(parsed.id, parsed.expectedVersion));
  });
  handle(IPC.workspacesList, () => repository.listWorkspaces());
  handle(IPC.workspacesAdd, async (input: unknown) => {
    const parsed = projectContextSchema.parse(input ?? {});
    const rootPath = await dependencies.pickWorkspaceRoot();
    return rootPath ? workspaceService.registerRoot(rootPath, parsed.projectId) : null;
  });
  handle(IPC.workspacesUpdatePermissions, (input: unknown) => {
    const parsed = workspacePermissionsSchema.parse(input);
    return commit(() => repository.updateWorkspacePermissions(parsed.id, parsed.expectedVersion, parsed));
  });
  handle(IPC.workspacesReveal, (input: unknown) => dependencies.revealWorkspaceTarget(workspaceRevealSchema.parse(input)));
  handle(IPC.workspacesRemove, (input: unknown) => {
    const parsed = workspaceMutationSchema.parse(input);
    return commit(() => repository.removeWorkspace(parsed.id, parsed.expectedVersion));
  });
  handle(IPC.projectsList, () => repository.listProjects());
  handle(IPC.toolsList, (input: unknown) => {
    const parsed = toolSessionScopeSchema.parse(input);
    return repository.listToolInvocations(parsed.sessionId);
  });
  handle(IPC.approvalsListPending, (input: unknown) => {
    const parsed = toolSessionScopeSchema.parse(input);
    return repository.listPendingApprovalRequests(parsed.sessionId);
  });
  handle(IPC.approvalsResolve, async (input: unknown) => {
    const parsed = approvalResolutionSchema.parse(input);
    return workspaceToolCoordinator.resolve(parsed.sessionId, parsed.id, parsed.expectedVersion, parsed.resolution);
  });
  handle(IPC.roomsList, (input: unknown) => repository.listRooms(roomListSchema.parse(input)?.includeArchived ?? false));
  handle(IPC.roomsCreate, async (input: unknown) => {
    const parsed = roomCreateSchema.parse(input);
    const leadBotId = await roomLead(parsed.memberBotIds, parsed.leadBotId);
    return commit(() => repository.createRoom({ ...parsed, leadBotId }));
  });
  handle(IPC.roomsGet, (id: unknown) => repository.getRoomDetail(roomIdSchema.parse(id)));
  handle(IPC.roomsUpdate, async (input: unknown) => {
    const parsed = roomUpdateSchema.parse(input);
    if (parsed.patch.leadBotId !== undefined) {
      await roomLead(repository.listRoomMembers(parsed.id).map((member) => member.botId), parsed.patch.leadBotId);
    }
    return commit(() => repository.updateRoom(parsed.id, parsed.expectedVersion, parsed.patch));
  });
  handle(IPC.roomsArchive, (input: unknown) => {
    const parsed = roomArchiveSchema.parse(input);
    return commit(() => repository.archiveRoom(parsed.id, parsed.archived));
  });
  handle(IPC.roomsSetPinned, (input: unknown) => {
    const parsed = roomPinnedSchema.parse(input);
    return commit(() => repository.setRoomPinned(parsed.id, parsed.pinned));
  });
  handle(IPC.roomsSetUnread, (input: unknown) => {
    const parsed = roomUnreadSchema.parse(input);
    return commit(() => repository.setRoomUnread(parsed.id, parsed.unread));
  });
  handle(IPC.roomsSetHidden, (input: unknown) => {
    const parsed = roomHiddenSchema.parse(input);
    return commit(() => repository.setRoomHidden(parsed.id, parsed.hidden));
  });
  handle(IPC.roomsCopyConversationId, (id: unknown) => {
    const parsed = roomIdSchema.parse(id);
    repository.getRoom(parsed);
    clipboard.writeText(parsed);
  });
  handle(IPC.roomsDelete, (id: unknown) => {
    const parsed = roomIdSchema.parse(id), remove = () => commit(() => repository.deleteRoom(parsed));
    return dependencies.environmentService ? dependencies.environmentService.retire(repository.listConversations().filter(item=>item.roomId===parsed).map(item=>item.sessionId), [], () => repository.assertRoomDeletable(parsed), remove) : remove();
  });
  handle(IPC.roomsAddMember, (input: unknown) => {
    const parsed = roomMembershipSchema.parse(input);
    return commit(() => repository.addRoomMember(parsed.roomId, parsed.botId, parsed.expectedMembershipVersion));
  });
  handle(IPC.roomsRemoveMember, (input: unknown) => {
    const parsed = roomMembershipSchema.parse(input);
    const remove = () => commit(() => repository.removeRoomMember(parsed.roomId, parsed.botId, parsed.expectedMembershipVersion));
    return dependencies.environmentService ? dependencies.environmentService.retire([], [],
      () => repository.assertRoomMemberRemovable(parsed.roomId, parsed.botId, parsed.expectedMembershipVersion), remove,
      repository.listConversations().filter(item=>item.roomId===parsed.roomId).map(item=>({sessionId:item.sessionId,executorBotId:parsed.botId}))) : remove();
  });
  handle(IPC.sessionsGetMain, (botId: unknown) => repository.getMainSession(botIdSchema.parse(botId)));
  handle(IPC.transcriptList, (sessionId: unknown) => repository.listTranscript(sessionIdSchema.parse(sessionId)));
  handle(IPC.messagesSend, (command: unknown) => sendWorker.send(sendCommandSchema.parse(command)));
  handle(IPC.messagesRetry, (clientNonce: unknown) => sendWorker.retry(nonceSchema.parse(clientNonce)));
  handle(IPC.messagesCancel, (clientNonce: unknown) => sendWorker.cancel(nonceSchema.parse(clientNonce)));
  handle(IPC.messagesGetStatus, (clientNonce: unknown) =>
    repository.getSendOrThrow(nonceSchema.parse(clientNonce)),
  );
  handle(IPC.runtimeGetSessionSnapshot, (sessionId: unknown) =>
    sendWorker.getSessionSnapshot(sessionIdSchema.parse(sessionId)),
  );
  handle(IPC.runtimeCancel, (input: unknown) => {
    const runId = runIdSchema.parse(input), run = repository.getRuntimeRun(runId);
    if (libraryContext && run.sessionId !== libraryContext.sessionId) throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    if (run.route === "host-mcp") {
      if (!dependencies.mcpWriteService) throw new AevorenBotError("MCP_SERVER_UNAVAILABLE");
      return dependencies.mcpWriteService.cancelRuntime(runId);
    }
    if (run.route === "host-outbound") {
      if (!dependencies.nativeOutboundService) throw new AevorenBotError("CONNECTOR_UNAVAILABLE");
      return dependencies.nativeOutboundService.cancelRuntime(runId);
    }
    return sendWorker.cancelRun(runId);
  });
  handle(IPC.runtimeRetry, (runId: unknown) => sendWorker.retryRun(runIdSchema.parse(runId)));
  handle(IPC.roomRuntimeSnapshot, (input: unknown) => roomCoordinator.getSnapshot(z.union([roomIdSchema,z.object({roomId:roomIdSchema,sessionId:z.string().uuid()}).strict()]).parse(input)));
  handle(IPC.roomRuntimeSend, (command: unknown) => roomCoordinator.routeAndSend(roomSendCommandSchema.parse(command)));
  handle(IPC.roomRuntimeCancel, (batchId: unknown) => roomCoordinator.cancel(batchIdSchema.parse(batchId)));
  handle(IPC.roomRuntimeContinue, (batchId: unknown) => roomCoordinator.continue(batchIdSchema.parse(batchId)));
  handle(IPC.roomRuntimeRetryTurn, (turnId: unknown) => roomCoordinator.retryTurn(turnIdSchema.parse(turnId)));
  handle(IPC.settingsGetGeneral, () => generalSettings.getConfiguration());
  handle(IPC.settingsSaveGeneral, (input: unknown) => {
    const parsed = generalSettingsSchema.parse(input);
    const saved = generalSettings.saveConfiguration(parsed);
    if (parsed.updateCheckIntervalMinutes !== undefined) {
      dependencies.updateService.setCheckIntervalMinutes(saved.updateCheckIntervalMinutes);
    }
    return saved;
  });
  handle(IPC.providersList, () => providers.list());
  handle(IPC.providersScan, () => providers.scan());
  handle(IPC.providersSaveOpenAiCompatible, async (input: unknown) => {
    const parsed = saveOpenAiCompatibleProviderSchema.parse(input);
    if (repository.hasActiveRuntimeForProvider(parsed.instanceId)) throw new AevorenBotError("MODEL_PROVIDER_BUSY");
    return providers.saveOpenAiCompatible(parsed);
  });
  handle(IPC.providersSaveCli, async (input: unknown) => {
    const parsed = saveCliProviderSchema.parse(input);
    if (repository.hasActiveRuntimeForProvider(parsed.instanceId)) throw new AevorenBotError("MODEL_PROVIDER_BUSY");
    return providers.saveCli(parsed);
  });
  handle(IPC.providersTest, async (instanceId: unknown) => {
    if (dependencies.forceFakeProvider) return;
    await providers.test(providerInstanceIdInputSchema.parse(instanceId));
  });
  handle(IPC.providersRefresh, (instanceId: unknown) =>
    providers.refresh(providerInstanceIdInputSchema.parse(instanceId)),
  );
  handle(IPC.updatesGetState, () => dependencies.updateService.getState());
  handle(IPC.updatesCheck, () => dependencies.updateService.check());
  handle(IPC.updatesRetry, () => dependencies.updateService.retry());
  handle(IPC.updatesInstallAndRestart, () => {
    dependencies.prepareUpdateInstall();
    try {
      return dependencies.updateService.installAndRestart();
    } catch (error) {
      dependencies.cancelUpdateInstall();
      throw error;
    }
  });

  handle("product:bots-get", (input) => repository.getBot((input as { botId: string }).botId));
  handle("product:transcript-page", (input) => {
    const parsed = input as { sessionId: string; afterSeq: number; limit: number };
    const entries = repository.listTranscript(parsed.sessionId).filter((entry) => entry.seq > parsed.afterSeq);
    const page = entries.slice(0, parsed.limit);
    return { entries: page, nextSeq: page.at(-1)?.seq ?? parsed.afterSeq, hasMore: entries.length > page.length };
  });
  handle("product:task-result", (input) => {
    const run = repository.getRuntimeRun((input as { runId: string }).runId);
    return { runId: run.id, state: run.state, errorCode: run.lastErrorCode, response: run.assistantEntryId ? repository.getTranscriptEntry(run.assistantEntryId) : null };
  });
  handle("product:room-task-result", (input) => {
    const batch = repository.getRoomBatch((input as { batchId: string }).batchId);
    return { batchId: batch.id, state: batch.state, replies: repository.listRoomTurns(batch.id).map((turn) => {
      const run = turn.runtimeRunId ? repository.getRuntimeRun(turn.runtimeRunId) : null;
      return { botId: turn.agentId, name: turn.memberNameSnapshot, state: turn.state, errorCode: turn.lastErrorCode, response: run?.assistantEntryId ? repository.getTranscriptEntry(run.assistantEntryId) : null };
    }) };
  });
  handle("product:room-task-wait", () => { throw new AevorenBotError("INVALID_REQUEST"); });
  handle("product:task-wait", () => { throw new AevorenBotError("INVALID_REQUEST"); });
  handle("product:view-request", (input) => dependencies.requestView?.(input as import("@shared/product-view").ProductViewInput) ?? { status: "waiting_user", reason: "界面尚未就绪。" });
  return handlers;
}
