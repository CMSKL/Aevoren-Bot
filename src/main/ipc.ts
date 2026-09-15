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
  modelConfigurationSchema,
  memoryCreateSchema,
  memoryListSchema,
  memoryMutationSchema,
  memoryUpdateSchema,
  nonceSchema,
  roomArchiveSchema,
  roomCreateSchema,
  roomIdSchema,
  roomListSchema,
  roomMembershipSchema,
  roomSendCommandSchema,
  roomUpdateSchema,
  runIdSchema,
  sendCommandSchema,
  sessionIdSchema,
  toolSessionScopeSchema,
  turnIdSchema,
} from "@shared/schemas";
import { apiResult, AevorenBotError } from "./errors";
import type { AppRepository } from "./database";
import { OpenAiCompatibleProvider } from "./model";
import type { ModelSettingsService } from "./settings";
import type { SendWorker } from "./send-worker";
import type { RoomCoordinator } from "./room-coordinator";

type IpcDependencies = {
  window: BrowserWindow;
  repository: AppRepository;
  settings: ModelSettingsService;
  sendWorker: SendWorker;
  roomCoordinator: RoomCoordinator;
  forceFakeProvider: boolean;
  rendererReady(): void;
  confirmClose(canClose: boolean): void;
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
  const { window, repository, settings, sendWorker, roomCoordinator } = dependencies;

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
    return repository.listMemories(parsed.botId, parsed.includeDeleted ?? false);
  });
  handle(IPC.memoriesCreate, (_event, input: unknown) => {
    const parsed = memoryCreateSchema.parse(input);
    return repository.createMemory(parsed.botId, parsed.content);
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
  handle(IPC.toolsList, (_event, input: unknown) => {
    const parsed = toolSessionScopeSchema.parse(input);
    return repository.listToolInvocations(parsed.sessionId);
  });
  handle(IPC.approvalsListPending, (_event, input: unknown) => {
    const parsed = toolSessionScopeSchema.parse(input);
    return repository.listPendingApprovalRequests(parsed.sessionId);
  });
  handle(IPC.approvalsResolve, (_event, input: unknown) => {
    const parsed = approvalResolutionSchema.parse(input);
    const approval = repository.getApprovalRequest(parsed.id);
    if (approval.sessionId !== parsed.sessionId) throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
    return repository.resolveToolApproval(parsed.id, parsed.expectedVersion, parsed.resolution);
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
  handle(IPC.settingsGetModel, () => settings.getConfiguration());
  handle(IPC.settingsSaveModel, (_event, input: unknown) => {
    const parsed = modelConfigurationSchema.parse(input);
    return settings.saveConfiguration(parsed);
  });
  handle(IPC.settingsTestModel, async () => {
    if (dependencies.forceFakeProvider) return;
    const configuration = settings.getConfiguration();
    if (!configuration.modelId || !configuration.apiKeyConfigured) {
      throw new AevorenBotError("MODEL_NOT_CONFIGURED", "请先保存 Base URL、Model ID 和 API Key。", false);
    }
    const provider = new OpenAiCompatibleProvider(
      configuration.baseUrl,
      configuration.modelId,
      settings.getApiKey(),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      await provider.testConnection(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new AevorenBotError("MODEL_CONNECTION_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
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
