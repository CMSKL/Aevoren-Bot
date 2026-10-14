import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@shared/channels";
import { LIBRARY_CHANNELS } from "@shared/library-channels";
import { ENVIRONMENT_CHANNELS, EXECUTION_CHANNELS, PROCESS_CHANNELS, ENVIRONMENT_EVENTS } from "@shared/environment-channels";
import type { EnvironmentChangedEvent } from "@shared/environment-contracts";
import type { LibraryChangedEvent } from "@shared/library-contracts";
import type { AevorenBotApi, RoomRuntimeEvent, RuntimeEvent, SendStateEvent, ToolEvent, TranscriptEvent, UpdateEvent } from "@shared/contracts";

function onEnvironmentChanged(listener: (event: EnvironmentChangedEvent) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, data: EnvironmentChangedEvent): void => listener(data);
  ipcRenderer.on(ENVIRONMENT_EVENTS.changed, handler);
  return () => ipcRenderer.removeListener(ENVIRONMENT_EVENTS.changed, handler);
}

const api: AevorenBotApi = {
  environments: {
    probe: () => ipcRenderer.invoke(ENVIRONMENT_CHANNELS.probe),
    initialize: () => ipcRenderer.invoke(ENVIRONMENT_CHANNELS.initialize),
    list: (input) => ipcRenderer.invoke(ENVIRONMENT_CHANNELS.list, input),
    get: (input) => ipcRenderer.invoke(ENVIRONMENT_CHANNELS.get, input),
    start: (input) => ipcRenderer.invoke(ENVIRONMENT_CHANNELS.start, input),
    stop: (input) => ipcRenderer.invoke(ENVIRONMENT_CHANNELS.stop, input),
    rebuild: (input) => ipcRenderer.invoke(ENVIRONMENT_CHANNELS.rebuild, input),
    onChanged: onEnvironmentChanged,
  },
  execution: {
    list: (input) => ipcRenderer.invoke(EXECUTION_CHANNELS.list, input),
    get: (input) => ipcRenderer.invoke(EXECUTION_CHANNELS.get, input),
    run: (input) => ipcRenderer.invoke(EXECUTION_CHANNELS.run, input),
    cancel: (input) => ipcRenderer.invoke(EXECUTION_CHANNELS.cancel, input),
    logs: (input) => ipcRenderer.invoke(EXECUTION_CHANNELS.logs, input),
    listFiles: (input) => ipcRenderer.invoke(EXECUTION_CHANNELS.listFiles, input),
    readFile: (input) => ipcRenderer.invoke(EXECUTION_CHANNELS.readFile, input),
    writeFile: (input) => ipcRenderer.invoke(EXECUTION_CHANNELS.writeFile, input),
    pickUpload: (input) => ipcRenderer.invoke(EXECUTION_CHANNELS.pickUpload, input),
    downloadFile: (input) => ipcRenderer.invoke(EXECUTION_CHANNELS.downloadFile, input),
    onChanged: onEnvironmentChanged,
  },
  processes: {
    list: (input) => ipcRenderer.invoke(PROCESS_CHANNELS.list, input),
    start: (input) => ipcRenderer.invoke(PROCESS_CHANNELS.start, input),
    stop: (input) => ipcRenderer.invoke(PROCESS_CHANNELS.stop, input),
    registerPort: (input) => ipcRenderer.invoke(PROCESS_CHANNELS.registerPort, input),
    listPorts: (input) => ipcRenderer.invoke(PROCESS_CHANNELS.listPorts, input),
    onChanged: onEnvironmentChanged,
  },
  library: {
    list: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.list, input),
    available: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.available, input),
    read: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.read, input),
    create: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.create, input),
    importText: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.importText, input),
    update: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.update, input),
    setEnabled: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.setEnabled, input),
    delete: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.delete, input),
    restore: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.restore, input),
    versions: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.versions, input),
    restoreVersion: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.restoreVersion, input),
    bind: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.bind, input),
    unbind: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.unbind, input),
    pickImport: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.pickImport, input),
    importPath: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.importPath, input),
    export: (input) => ipcRenderer.invoke(LIBRARY_CHANNELS.export, input),
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: LibraryChangedEvent): void => listener(value);
      ipcRenderer.on(IPC.libraryEvent, handler);
      return () => ipcRenderer.removeListener(IPC.libraryEvent, handler);
    },
  },
  userProfile: {
    get: () => ipcRenderer.invoke(IPC.userProfileGet),
    update: (input) => ipcRenderer.invoke(IPC.userProfileUpdate, input),
  },
  attachments: {
    pick: () => ipcRenderer.invoke(IPC.attachmentsPick),
  },
  artifacts: {
    save: (input) => ipcRenderer.invoke(IPC.artifactsSave, input),
    reveal: (path) => ipcRenderer.invoke(IPC.artifactsReveal, path),
  },
  capabilities: {
    getSnapshot: (input) => ipcRenderer.invoke(IPC.capabilitiesGetSnapshot, input),
  },
  mcp: {
    list: () => ipcRenderer.invoke(IPC.mcpList),
    save: (input) => ipcRenderer.invoke(IPC.mcpSave, input),
    setEnabled: (input) => ipcRenderer.invoke(IPC.mcpSetEnabled, input),
    probe: (id) => ipcRenderer.invoke(IPC.mcpProbe, id),
    authorize: (id) => ipcRenderer.invoke(IPC.mcpAuthorize, id),
    cancelAuthorization: (id) => ipcRenderer.invoke(IPC.mcpCancelAuthorization, id),
    clearAuthorization: (input) => ipcRenderer.invoke(IPC.mcpClearAuthorization, input),
    delete: (input) => ipcRenderer.invoke(IPC.mcpDelete, input),
  },
  routines: {
    list: () => ipcRenderer.invoke(IPC.routinesList),
    listRuns: (routineId) => ipcRenderer.invoke(IPC.routinesListRuns, routineId),
    create: (input) => ipcRenderer.invoke(IPC.routinesCreate, input),
    update: (input) => ipcRenderer.invoke(IPC.routinesUpdate, input),
    setEnabled: (input) => ipcRenderer.invoke(IPC.routinesSetEnabled, input),
    runNow: (id) => ipcRenderer.invoke(IPC.routinesRunNow, id),
    delete: (input) => ipcRenderer.invoke(IPC.routinesDelete, input),
  },
  conversations: {
    list: () => ipcRenderer.invoke(IPC.conversationsList),
    setPinned: (input) => ipcRenderer.invoke(IPC.conversationsSetPinned, input),
    setUnread: (input) => ipcRenderer.invoke(IPC.conversationsSetUnread, input),
    setHidden: (input) => ipcRenderer.invoke(IPC.conversationsSetHidden, input),
    clear: (sessionId) => ipcRenderer.invoke(IPC.conversationsClear, sessionId),
    setProject: (input) => ipcRenderer.invoke(IPC.conversationsSetProject, input),
    deleteBatch: (input) => ipcRenderer.invoke(IPC.conversationsDeleteBatch, input),
  },
  teams: {
    createContentTeam: (input) => input
      ? ipcRenderer.invoke(IPC.teamsCreateContentTeam, input)
      : ipcRenderer.invoke(IPC.teamsCreateContentTeam),
  },
  bots: {
    list: () => ipcRenderer.invoke(IPC.botsList),
    create: (input) => input ? ipcRenderer.invoke(IPC.botsCreate, input) : ipcRenderer.invoke(IPC.botsCreate),
    update: (input) => ipcRenderer.invoke(IPC.botsUpdate, input),
    setPinned: (input) => ipcRenderer.invoke(IPC.botsSetPinned, input),
    setUnread: (input) => ipcRenderer.invoke(IPC.botsSetUnread, input),
    setHidden: (input) => ipcRenderer.invoke(IPC.botsSetHidden, input),
    duplicate: (id) => ipcRenderer.invoke(IPC.botsDuplicate, id),
    delete: (id) => ipcRenderer.invoke(IPC.botsDelete, id),
    copyConversationId: (id) => ipcRenderer.invoke(IPC.botsCopyConversationId, id),
  },
  memories: {
    list: (input) => ipcRenderer.invoke(IPC.memoriesList, input),
    create: (input) => ipcRenderer.invoke(IPC.memoriesCreate, input),
    update: (input) => ipcRenderer.invoke(IPC.memoriesUpdate, input),
    delete: (input) => ipcRenderer.invoke(IPC.memoriesDelete, input),
    restore: (input) => ipcRenderer.invoke(IPC.memoriesRestore, input),
    listProposals: (input) => ipcRenderer.invoke(IPC.memoriesListProposals, input),
    acceptProposal: (input) => ipcRenderer.invoke(IPC.memoriesAcceptProposal, input),
    rejectProposal: (input) => ipcRenderer.invoke(IPC.memoriesRejectProposal, input),
  },
  workspaces: {
    list: () => ipcRenderer.invoke(IPC.workspacesList),
    add: (input) => ipcRenderer.invoke(IPC.workspacesAdd, input),
    updatePermissions: (input) => ipcRenderer.invoke(IPC.workspacesUpdatePermissions, input),
    reveal: (input) => ipcRenderer.invoke(IPC.workspacesReveal, input),
    remove: (input) => ipcRenderer.invoke(IPC.workspacesRemove, input),
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    create: (input) => ipcRenderer.invoke(IPC.projectsCreate, input),
  },
  tools: {
    list: (input) => ipcRenderer.invoke(IPC.toolsList, input),
  },
  approvals: {
    listPending: (input) => ipcRenderer.invoke(IPC.approvalsListPending, input),
    resolve: (input) => ipcRenderer.invoke(IPC.approvalsResolve, input),
  },
  rooms: {
    getBriefApproval: (input) => ipcRenderer.invoke(IPC.roomsGetBriefApproval, input),
    approveBrief: (input) => ipcRenderer.invoke(IPC.roomsApproveBrief, input),
    list: (input) => ipcRenderer.invoke(IPC.roomsList, input),
    create: (input) => ipcRenderer.invoke(IPC.roomsCreate, input),
    get: (id) => ipcRenderer.invoke(IPC.roomsGet, id),
    update: (input) => ipcRenderer.invoke(IPC.roomsUpdate, input),
    archive: (input) => ipcRenderer.invoke(IPC.roomsArchive, input),
    setPinned: (input) => ipcRenderer.invoke(IPC.roomsSetPinned, input),
    setUnread: (input) => ipcRenderer.invoke(IPC.roomsSetUnread, input),
    setHidden: (input) => ipcRenderer.invoke(IPC.roomsSetHidden, input),
    copyConversationId: (id) => ipcRenderer.invoke(IPC.roomsCopyConversationId, id),
    delete: (id) => ipcRenderer.invoke(IPC.roomsDelete, id),
    addMember: (input) => ipcRenderer.invoke(IPC.roomsAddMember, input),
    removeMember: (input) => ipcRenderer.invoke(IPC.roomsRemoveMember, input),
  },
  sessions: {
    getMain: (botId) => ipcRenderer.invoke(IPC.sessionsGetMain, botId),
  },
  transcript: {
    list: (sessionId) => ipcRenderer.invoke(IPC.transcriptList, sessionId),
  },
  messages: {
    send: (command) => ipcRenderer.invoke(IPC.messagesSend, command),
    retry: (clientNonce) => ipcRenderer.invoke(IPC.messagesRetry, clientNonce),
    cancel: (clientNonce) => ipcRenderer.invoke(IPC.messagesCancel, clientNonce),
    getStatus: (clientNonce) => ipcRenderer.invoke(IPC.messagesGetStatus, clientNonce),
  },
  runtime: {
    getSessionSnapshot: (sessionId) => ipcRenderer.invoke(IPC.runtimeGetSessionSnapshot, sessionId),
    cancel: (runId) => ipcRenderer.invoke(IPC.runtimeCancel, runId),
    retry: (runId) => ipcRenderer.invoke(IPC.runtimeRetry, runId),
  },
  roomRuntime: {
    getSnapshot: (roomId) => ipcRenderer.invoke(IPC.roomRuntimeSnapshot, roomId),
    send: (command) => ipcRenderer.invoke(IPC.roomRuntimeSend, command),
    cancel: (batchId) => ipcRenderer.invoke(IPC.roomRuntimeCancel, batchId),
    continue: (batchId) => ipcRenderer.invoke(IPC.roomRuntimeContinue, batchId),
    retryTurn: (turnId) => ipcRenderer.invoke(IPC.roomRuntimeRetryTurn, turnId),
  },
  settings: {
    getGeneral: () => ipcRenderer.invoke(IPC.settingsGetGeneral),
    saveGeneral: (input) => ipcRenderer.invoke(IPC.settingsSaveGeneral, input),
  },
  providers: {
    list: () => ipcRenderer.invoke(IPC.providersList),
    scan: () => ipcRenderer.invoke(IPC.providersScan),
    saveOpenAiCompatible: (input) => ipcRenderer.invoke(IPC.providersSaveOpenAiCompatible, input),
    saveCli: (input) => ipcRenderer.invoke(IPC.providersSaveCli, input),
    test: (instanceId) => ipcRenderer.invoke(IPC.providersTest, instanceId),
    refresh: (instanceId) => ipcRenderer.invoke(IPC.providersRefresh, instanceId),
  },
  updates: {
    getState: () => ipcRenderer.invoke(IPC.updatesGetState),
    check: () => ipcRenderer.invoke(IPC.updatesCheck),
    retry: () => ipcRenderer.invoke(IPC.updatesRetry),
    installAndRestart: () => ipcRenderer.invoke(IPC.updatesInstallAndRestart),
  },
  productUI: { respond: (id, result) => ipcRenderer.invoke(IPC.productViewReply, id, result) },
  events: {
    subscribeProductView: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, request: import("@shared/product-view").ProductViewRequest) => listener(request);
      ipcRenderer.on(IPC.productViewEvent, handler);
      return () => ipcRenderer.removeListener(IPC.productViewEvent, handler);
    },
    subscribeTranscript(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: TranscriptEvent): void => listener(value);
      ipcRenderer.on(IPC.transcriptEvent, wrapped);
      return () => ipcRenderer.removeListener(IPC.transcriptEvent, wrapped);
    },
    subscribeSendState(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: SendStateEvent): void => listener(value);
      ipcRenderer.on(IPC.sendStateEvent, wrapped);
      return () => ipcRenderer.removeListener(IPC.sendStateEvent, wrapped);
    },
    subscribeRuntime(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: RuntimeEvent): void => listener(value);
      ipcRenderer.on(IPC.runtimeEvent, wrapped);
      return () => ipcRenderer.removeListener(IPC.runtimeEvent, wrapped);
    },
    subscribeRoomRuntime(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: RoomRuntimeEvent): void => listener(value);
      ipcRenderer.on(IPC.roomRuntimeEvent, wrapped);
      return () => ipcRenderer.removeListener(IPC.roomRuntimeEvent, wrapped);
    },
    subscribeTool(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: ToolEvent): void => listener(value);
      ipcRenderer.on(IPC.toolEvent, wrapped);
      return () => ipcRenderer.removeListener(IPC.toolEvent, wrapped);
    },
    subscribeUpdate(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: UpdateEvent): void => listener(value);
      ipcRenderer.on(IPC.updateEvent, wrapped);
      return () => ipcRenderer.removeListener(IPC.updateEvent, wrapped);
    },
  },
  app: {
    ready: () => ipcRenderer.send(IPC.appRendererReady),
    subscribeBeforeClose(listener) {
      const wrapped = (): void => listener();
      ipcRenderer.on(IPC.appBeforeClose, wrapped);
      return () => ipcRenderer.removeListener(IPC.appBeforeClose, wrapped);
    },
    subscribeCloseBlocked(listener) {
      const wrapped = (): void => listener();
      ipcRenderer.on(IPC.appCloseBlocked, wrapped);
      return () => ipcRenderer.removeListener(IPC.appCloseBlocked, wrapped);
    },
    confirmClose: (canClose) => ipcRenderer.send(IPC.appConfirmClose, canClose),
  },
};

contextBridge.exposeInMainWorld("aevorenBot", api);
