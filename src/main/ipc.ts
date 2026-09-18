import { clipboard, ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { IPC } from "@shared/channels";
import {
  approvalResolutionSchema,
  batchIdSchema,
  botHiddenSchema,
  botIdSchema,
  botPinnedSchema,
  botUnreadSchema,
  botUpdateSchema,
  capabilitySnapshotInputSchema,
  conversationBatchDeleteSchema,
  generalSettingsSchema,
  memoryCreateSchema,
  memoryListSchema,
  memoryMutationSchema,
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
  saveCliProviderSchema,
  saveOpenAiCompatibleProviderSchema,
  sessionIdSchema,
  toolSessionScopeSchema,
  turnIdSchema,
  workspaceMutationSchema,
} from "@shared/schemas";
import { apiResult, AevorenBotError } from "./errors";
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

type IpcDependencies = {
  window: BrowserWindow;
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
  forceFakeProvider: boolean;
  rendererReady(): void;
  confirmClose(canClose: boolean): void;
  prepareUpdateInstall(): void;
  cancelUpdateInstall(): void;
};

function isTrusted(event: IpcMainEvent | IpcMainInvokeEvent, window: BrowserWindow): boolean {
  return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}

function assertTrusted(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (!isTrusted(event, window)) {
    throw new AevorenBotError("UNTRUSTED_RENDERER", "请求来源不受信任。", false);
  }
}

export function registerIpc(dependencies: IpcDependencies): void {
  const { window, repository, providers, generalSettings, sendWorker, roomCoordinator, workspaceService, workspaceToolCoordinator } = dependencies;

  const handle = <TArgs extends unknown[], TResult>(
    channel: string,
    operation: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>,
  ): void => {
    ipcMain.handle(channel, (event, ...args: TArgs) =>
      apiResult(() => {
        assertTrusted(event, window);
        return operation(event, ...args);
      }),
    );
  };

  handle(IPC.capabilitiesGetSnapshot, (_event, input: unknown) =>
    dependencies.capabilityRegistry.getSnapshot(capabilitySnapshotInputSchema.parse(input)),
  );
  handle(IPC.mcpList, () => dependencies.mcpService.list());
  handle(IPC.mcpSave, (_event, input: unknown) => dependencies.mcpService.save(mcpServerMutationSchema.parse(input)));
  handle(IPC.mcpSetEnabled, (_event, input: unknown) => {
    const parsed = mcpServerEnabledSchema.parse(input);
    return dependencies.mcpService.setEnabled(parsed.id, parsed.expectedVersion, parsed.enabled);
  });
  handle(IPC.mcpProbe, (_event, id: unknown) => dependencies.mcpService.probe(mcpServerIdSchema.parse(id)));
  handle(IPC.mcpAuthorize, (_event, id: unknown) => dependencies.mcpService.authorize(mcpServerIdSchema.parse(id)));
  handle(IPC.mcpCancelAuthorization, (_event, id: unknown) => dependencies.mcpService.cancelAuthorization(mcpServerIdSchema.parse(id)));
  handle(IPC.mcpClearAuthorization, (_event, input: unknown) => {
    const parsed = mcpServerMutationIdSchema.parse(input);
    return dependencies.mcpService.clearAuthorization(parsed.id, parsed.expectedVersion);
  });
  handle(IPC.mcpDelete, (_event, input: unknown) => {
    const parsed = mcpServerMutationIdSchema.parse(input);
    return dependencies.mcpService.delete(parsed.id, parsed.expectedVersion);
  });
  handle(IPC.routinesList, () => dependencies.routineService.list());
  handle(IPC.routinesListRuns, (_event, routineId: unknown) =>
    dependencies.routineService.listRuns(routineId === undefined ? undefined : routineIdSchema.parse(routineId)),
  );
  handle(IPC.routinesCreate, (_event, input: unknown) => dependencies.routineService.create(routineCreateSchema.parse(input)));
  handle(IPC.routinesUpdate, (_event, input: unknown) => {
    const parsed = routineUpdateSchema.parse(input);
    return dependencies.routineService.update(parsed.id, parsed.expectedVersion, parsed.patch);
  });
  handle(IPC.routinesSetEnabled, (_event, input: unknown) => {
    const parsed = routineEnabledSchema.parse(input);
    return dependencies.routineService.setEnabled(parsed.id, parsed.expectedVersion, parsed.enabled);
  });
  handle(IPC.routinesRunNow, (_event, id: unknown) => dependencies.routineService.runNow(routineIdSchema.parse(id)));
  handle(IPC.routinesDelete, (_event, input: unknown) => {
    const parsed = routineMutationSchema.parse(input);
    return dependencies.routineService.delete(parsed.id, parsed.expectedVersion);
  });
  handle(IPC.conversationsDeleteBatch, (_event, input: unknown) =>
    repository.deleteConversations(conversationBatchDeleteSchema.parse(input)),
  );
  handle(IPC.botsList, () => repository.listBots());
  handle(IPC.botsCreate, () => repository.createBot());
  handle(IPC.botsUpdate, (_event, input: unknown) => {
    const parsed = botUpdateSchema.parse(input);
    return repository.updateBot(parsed.id, parsed.expectedVersion, parsed.patch);
  });
  handle(IPC.botsSetPinned, (_event, input: unknown) => {
    const parsed = botPinnedSchema.parse(input);
    return repository.setBotPinned(parsed.id, parsed.pinned);
  });
  handle(IPC.botsSetUnread, (_event, input: unknown) => {
    const parsed = botUnreadSchema.parse(input);
    return repository.setBotUnread(parsed.id, parsed.unread);
  });
  handle(IPC.botsSetHidden, (_event, input: unknown) => {
    const parsed = botHiddenSchema.parse(input);
    return repository.setBotHidden(parsed.id, parsed.hidden);
  });
  handle(IPC.botsDuplicate, (_event, id: unknown) => repository.duplicateBot(botIdSchema.parse(id)));
  handle(IPC.botsDelete, (_event, id: unknown) => repository.deleteBot(botIdSchema.parse(id)));
  handle(IPC.botsCopyConversationId, (_event, id: unknown) => {
    const parsed = botIdSchema.parse(id);
    repository.getBot(parsed);
    clipboard.writeText(parsed);
  });
  handle(IPC.memoriesList, (_event, input: unknown) => {
    const parsed = memoryListSchema.parse(input);
    return "botId" in parsed
      ? repository.listMemories(parsed.botId, parsed.includeDeleted ?? false)
      : repository.listScopedMemories({ scope: parsed.scope, scopeKey: parsed.scopeKey }, parsed.includeDeleted ?? false);
  });
  handle(IPC.memoriesCreate, (_event, input: unknown) => {
    const parsed = memoryCreateSchema.parse(input);
    return "botId" in parsed
      ? repository.createMemory(parsed.botId, parsed.content)
      : repository.createScopedMemory({ scope: parsed.scope, scopeKey: parsed.scopeKey }, parsed.content);
  });
  handle(IPC.memoriesUpdate, (_event, input: unknown) => {
    const parsed = memoryUpdateSchema.parse(input);
    return repository.updateMemory(parsed.id, parsed.expectedVersion, parsed.content);
  });
  handle(IPC.memoriesDelete, (_event, input: unknown) => {
    const parsed = memoryMutationSchema.parse(input);
    return repository.deleteMemory(parsed.id, parsed.expectedVersion);
  });
  handle(IPC.memoriesRestore, (_event, input: unknown) => {
    const parsed = memoryMutationSchema.parse(input);
    return repository.restoreMemory(parsed.id, parsed.expectedVersion);
  });
  handle(IPC.workspacesList, () => repository.listWorkspaces());
  handle(IPC.workspacesAdd, async () => {
    const rootPath = await dependencies.pickWorkspaceRoot();
    return rootPath ? workspaceService.registerRoot(rootPath) : null;
  });
  handle(IPC.workspacesRemove, (_event, input: unknown) => {
    const parsed = workspaceMutationSchema.parse(input);
    return repository.removeWorkspace(parsed.id, parsed.expectedVersion);
  });
  handle(IPC.toolsList, (_event, input: unknown) => {
    const parsed = toolSessionScopeSchema.parse(input);
    return repository.listToolInvocations(parsed.sessionId);
  });
  handle(IPC.approvalsListPending, (_event, input: unknown) => {
    const parsed = toolSessionScopeSchema.parse(input);
    return repository.listPendingApprovalRequests(parsed.sessionId);
  });
  handle(IPC.approvalsResolve, async (_event, input: unknown) => {
    const parsed = approvalResolutionSchema.parse(input);
    return workspaceToolCoordinator.resolve(parsed.sessionId, parsed.id, parsed.expectedVersion, parsed.resolution);
  });
  handle(IPC.roomsList, (_event, input: unknown) => repository.listRooms(roomListSchema.parse(input)?.includeArchived ?? false));
  handle(IPC.roomsCreate, (_event, input: unknown) => repository.createRoom(roomCreateSchema.parse(input)));
  handle(IPC.roomsGet, (_event, id: unknown) => repository.getRoomDetail(roomIdSchema.parse(id)));
  handle(IPC.roomsUpdate, (_event, input: unknown) => {
    const parsed = roomUpdateSchema.parse(input);
    return repository.updateRoom(parsed.id, parsed.expectedVersion, parsed.patch);
  });
  handle(IPC.roomsArchive, (_event, input: unknown) => {
    const parsed = roomArchiveSchema.parse(input);
    return repository.archiveRoom(parsed.id, parsed.archived);
  });
  handle(IPC.roomsSetPinned, (_event, input: unknown) => {
    const parsed = roomPinnedSchema.parse(input);
    return repository.setRoomPinned(parsed.id, parsed.pinned);
  });
  handle(IPC.roomsSetUnread, (_event, input: unknown) => {
    const parsed = roomUnreadSchema.parse(input);
    return repository.setRoomUnread(parsed.id, parsed.unread);
  });
  handle(IPC.roomsSetHidden, (_event, input: unknown) => {
    const parsed = roomHiddenSchema.parse(input);
    return repository.setRoomHidden(parsed.id, parsed.hidden);
  });
  handle(IPC.roomsCopyConversationId, (_event, id: unknown) => {
    const parsed = roomIdSchema.parse(id);
    repository.getRoom(parsed);
    clipboard.writeText(parsed);
  });
  handle(IPC.roomsDelete, (_event, id: unknown) => repository.deleteRoom(roomIdSchema.parse(id)));
  handle(IPC.roomsAddMember, (_event, input: unknown) => {
    const parsed = roomMembershipSchema.parse(input);
    return repository.addRoomMember(parsed.roomId, parsed.botId, parsed.expectedMembershipVersion);
  });
  handle(IPC.roomsRemoveMember, (_event, input: unknown) => {
    const parsed = roomMembershipSchema.parse(input);
    return repository.removeRoomMember(parsed.roomId, parsed.botId, parsed.expectedMembershipVersion);
  });
  handle(IPC.sessionsGetMain, (_event, botId: unknown) => repository.getMainSession(botIdSchema.parse(botId)));
  handle(IPC.transcriptList, (_event, sessionId: unknown) => repository.listTranscript(sessionIdSchema.parse(sessionId)));
  handle(IPC.messagesSend, (_event, command: unknown) => sendWorker.send(sendCommandSchema.parse(command)));
  handle(IPC.messagesRetry, (_event, clientNonce: unknown) => sendWorker.retry(nonceSchema.parse(clientNonce)));
  handle(IPC.messagesCancel, (_event, clientNonce: unknown) => sendWorker.cancel(nonceSchema.parse(clientNonce)));
  handle(IPC.messagesGetStatus, (_event, clientNonce: unknown) =>
    repository.getSendOrThrow(nonceSchema.parse(clientNonce)),
  );
  handle(IPC.runtimeGetSessionSnapshot, (_event, sessionId: unknown) =>
    sendWorker.getSessionSnapshot(sessionIdSchema.parse(sessionId)),
  );
  handle(IPC.runtimeCancel, (_event, runId: unknown) => sendWorker.cancelRun(runIdSchema.parse(runId)));
  handle(IPC.runtimeRetry, (_event, runId: unknown) => sendWorker.retryRun(runIdSchema.parse(runId)));
  handle(IPC.roomRuntimeSnapshot, (_event, roomId: unknown) => roomCoordinator.getSnapshot(roomIdSchema.parse(roomId)));
  handle(IPC.roomRuntimeSend, (_event, command: unknown) => roomCoordinator.routeAndSend(roomSendCommandSchema.parse(command)));
  handle(IPC.roomRuntimeCancel, (_event, batchId: unknown) => roomCoordinator.cancel(batchIdSchema.parse(batchId)));
  handle(IPC.roomRuntimeContinue, (_event, batchId: unknown) => roomCoordinator.continue(batchIdSchema.parse(batchId)));
  handle(IPC.roomRuntimeRetryTurn, (_event, turnId: unknown) => roomCoordinator.retryTurn(turnIdSchema.parse(turnId)));
  handle(IPC.settingsGetGeneral, () => generalSettings.getConfiguration());
  handle(IPC.settingsSaveGeneral, (_event, input: unknown) =>
    generalSettings.saveConfiguration(generalSettingsSchema.parse(input)),
  );
  handle(IPC.providersList, () => providers.list());
  handle(IPC.providersScan, () => providers.scan());
  handle(IPC.providersSaveOpenAiCompatible, async (_event, input: unknown) => {
    const parsed = saveOpenAiCompatibleProviderSchema.parse(input);
    if (repository.hasActiveRuntimeForProvider(parsed.instanceId)) throw new AevorenBotError("MODEL_PROVIDER_BUSY");
    return providers.saveOpenAiCompatible(parsed);
  });
  handle(IPC.providersSaveCli, async (_event, input: unknown) => {
    const parsed = saveCliProviderSchema.parse(input);
    if (repository.hasActiveRuntimeForProvider(parsed.instanceId)) throw new AevorenBotError("MODEL_PROVIDER_BUSY");
    return providers.saveCli(parsed);
  });
  handle(IPC.providersTest, async (_event, instanceId: unknown) => {
    if (dependencies.forceFakeProvider) return;
    await providers.test(providerInstanceIdInputSchema.parse(instanceId));
  });
  handle(IPC.providersRefresh, (_event, instanceId: unknown) =>
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

  ipcMain.on(IPC.appRendererReady, (event) => {
    if (!isTrusted(event, window)) return;
    dependencies.rendererReady();
  });
  ipcMain.on(IPC.appConfirmClose, (event, canClose: unknown) => {
    if (!isTrusted(event, window)) return;
    dependencies.confirmClose(canClose === true);
  });
}
