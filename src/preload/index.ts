import {TEMPLATE_CHANNELS,EXPORT_CHANNELS} from "@shared/template-export-channels";
import { BOT_IMAGE_CHANNELS } from "@shared/bot-image-channels";
import { ORGANIZATION_CHANNELS,ORGANIZATION_CHANGED_CHANNEL } from "@shared/organization-channels";
import { SEARCH_CHANNELS } from "@shared/search-channels";
import type { TaskSessionChanged } from "@shared/task-session-contracts";
import { TASK_SESSION_CHANNELS, TASK_SESSION_CHANGED_CHANNEL } from "@shared/task-session-channels";
import { REALTIME_CHANNELS, REALTIME_CHANGED_CHANNEL } from "@shared/realtime-channels";
import type { RealtimeEvent } from "@shared/realtime-contracts";
import { VOICE_CHANNELS, VOICE_CHANGED_CHANNEL } from "@shared/voice-channels";
import type { VoiceEvent } from "@shared/voice-contracts";
import { MCP_WRITE_CHANNELS } from "@shared/mcp-write-channels";
import { NATIVE_OUTBOUND_CHANNELS, NATIVE_OUTBOUND_REQUEST_APPROVAL_CHANNEL } from "@shared/native-outbound-channels";
import { contextBridge, ipcRenderer } from "electron";
import { DEMONSTRATION_CHANNELS } from "@shared/demonstration-channels";
import { IPC } from "@shared/channels";
import { LIBRARY_CHANNELS } from "@shared/library-channels";
import { MEDIA_CHANNELS, MEDIA_CHANGED_CHANNEL } from "@shared/media-channels";
import type { MediaChangedEvent } from "@shared/media-contracts";
import { ENVIRONMENT_CHANNELS, EXECUTION_CHANNELS, PROCESS_CHANNELS, ENVIRONMENT_EVENTS } from "@shared/environment-channels";
import { BROWSER_CHANNELS, COMPUTER_CHANNELS, PREVIEW_CHANNELS, BROWSER_EVENTS } from "@shared/browser-channels";
import { SKILL_EXECUTION_CHANNELS, SKILL_EXECUTION_EVENTS } from "@shared/skill-execution-channels";
import { NATIVE_CONNECTOR_CHANNELS, CONNECTOR_DRAFT_CHANNELS } from "@shared/native-connector-channels";
import type { SkillExecutionChangedEvent } from "@shared/skill-execution-contracts";
import type { BrowserChangedEvent } from "@shared/browser-contracts";
import type { EnvironmentChangedEvent } from "@shared/environment-contracts";
import type { LibraryChangedEvent } from "@shared/library-contracts";
import type { AevorenBotApi, RoomRuntimeEvent, RuntimeEvent, SendStateEvent, ToolEvent, TranscriptEvent, UpdateEvent } from "@shared/contracts";

function onEnvironmentChanged(listener: (event: EnvironmentChangedEvent) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, data: EnvironmentChangedEvent): void => listener(data);
  ipcRenderer.on(ENVIRONMENT_EVENTS.changed, handler);
  return () => ipcRenderer.removeListener(ENVIRONMENT_EVENTS.changed, handler);
}

function onBrowserChanged(listener: (event: BrowserChangedEvent) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, data: BrowserChangedEvent): void => listener(data);
  ipcRenderer.on(BROWSER_EVENTS.changed, handler);
  return () => ipcRenderer.removeListener(BROWSER_EVENTS.changed, handler);
}

const api: AevorenBotApi = {
  botImages:{cancel:requestId=>ipcRenderer.invoke(BOT_IMAGE_CHANNELS.cancel,requestId),set:input=>ipcRenderer.invoke(BOT_IMAGE_CHANNELS.set,input),clear:input=>ipcRenderer.invoke(BOT_IMAGE_CHANNELS.clear,input),read:input=>ipcRenderer.invoke(BOT_IMAGE_CHANNELS.read,input)},
  organization:{snapshot:()=>ipcRenderer.invoke(ORGANIZATION_CHANNELS.snapshot),createSection:input=>ipcRenderer.invoke(ORGANIZATION_CHANNELS.createSection,input),renameSection:input=>ipcRenderer.invoke(ORGANIZATION_CHANNELS.renameSection,input),deleteSection:input=>ipcRenderer.invoke(ORGANIZATION_CHANNELS.deleteSection,input),reorderSections:input=>ipcRenderer.invoke(ORGANIZATION_CHANNELS.reorderSections,input),moveSession:input=>ipcRenderer.invoke(ORGANIZATION_CHANNELS.moveSession,input),savePreferences:input=>ipcRenderer.invoke(ORGANIZATION_CHANNELS.savePreferences,input),onChanged:listener=>{const handler=(_event:Electron.IpcRendererEvent,payload:import("@shared/organization-contracts").OrganizationChanged):void=>listener(payload);ipcRenderer.on(ORGANIZATION_CHANGED_CHANNEL,handler);return()=>ipcRenderer.removeListener(ORGANIZATION_CHANGED_CHANNEL,handler);}},
  templates:{list:()=>ipcRenderer.invoke(TEMPLATE_CHANNELS.list),read:input=>ipcRenderer.invoke(TEMPLATE_CHANNELS.read,input),versions:id=>ipcRenderer.invoke(TEMPLATE_CHANNELS.versions,id),prepareCapture:input=>ipcRenderer.invoke(TEMPLATE_CHANNELS.prepareCapture,input),commitCapture:input=>ipcRenderer.invoke(TEMPLATE_CHANNELS.commitCapture,input),prepareImport:input=>ipcRenderer.invoke(TEMPLATE_CHANNELS.prepareImport,input),pickImport:()=>ipcRenderer.invoke(TEMPLATE_CHANNELS.pickImport),reviewPrepared:input=>ipcRenderer.invoke(TEMPLATE_CHANNELS.reviewPrepared,input),commitImport:input=>ipcRenderer.invoke(TEMPLATE_CHANNELS.commitImport,input),export:input=>ipcRenderer.invoke(TEMPLATE_CHANNELS.export,input)},
  exports:{save:input=>ipcRenderer.invoke(EXPORT_CHANNELS.save,input)},
  search: {query: input=>ipcRenderer.invoke(SEARCH_CHANNELS.query,input),open: input=>ipcRenderer.invoke(SEARCH_CHANNELS.open,input)},
  mcpWrites: {
    toolCatalog: input => ipcRenderer.invoke(MCP_WRITE_CHANNELS.toolCatalog, input),
    toolGrants: input => ipcRenderer.invoke(MCP_WRITE_CHANNELS.toolGrants, input),
    grantTool: input => ipcRenderer.invoke(MCP_WRITE_CHANNELS.grantTool, input),
    revokeTool: input => ipcRenderer.invoke(MCP_WRITE_CHANNELS.revokeTool, input),
    prepareTool: input => ipcRenderer.invoke(MCP_WRITE_CHANNELS.prepareTool, input),
    toolResult: input => ipcRenderer.invoke(MCP_WRITE_CHANNELS.toolResult, input),
    listToolIntents: input => ipcRenderer.invoke(MCP_WRITE_CHANNELS.listToolIntents, input),
    cancelTool: input => ipcRenderer.invoke(MCP_WRITE_CHANNELS.cancelTool, input),
    requestToolApproval: input => ipcRenderer.invoke(MCP_WRITE_CHANNELS.requestToolApproval, input),
    openApp: input => ipcRenderer.invoke(MCP_WRITE_CHANNELS.openApp, input),
    closeApp: input => ipcRenderer.invoke(MCP_WRITE_CHANNELS.closeApp, input),
  },
  demonstrations: {
    status: input => ipcRenderer.invoke(DEMONSTRATION_CHANNELS.status, input),
    start: input => ipcRenderer.invoke(DEMONSTRATION_CHANNELS.start, input),
    stop: input => ipcRenderer.invoke(DEMONSTRATION_CHANNELS.stop, input),
    discard: input => ipcRenderer.invoke(DEMONSTRATION_CHANNELS.discard, input),
    drafts: input => ipcRenderer.invoke(DEMONSTRATION_CHANNELS.drafts, input),
    readDraft: input => ipcRenderer.invoke(DEMONSTRATION_CHANNELS.readDraft, input),
    deleteDraft: input => ipcRenderer.invoke(DEMONSTRATION_CHANNELS.deleteDraft, input),
    updateDraft: input => ipcRenderer.invoke(DEMONSTRATION_CHANNELS.updateDraft, input),
    publish: input => ipcRenderer.invoke(DEMONSTRATION_CHANNELS.publish, input),
  },
  outbound: {
    writeGrants: input => ipcRenderer.invoke(NATIVE_OUTBOUND_CHANNELS.writeGrants,input),
    grantWrite: input => ipcRenderer.invoke(NATIVE_OUTBOUND_CHANNELS.grantWrite,input),
    revokeWrite: input => ipcRenderer.invoke(NATIVE_OUTBOUND_CHANNELS.revokeWrite,input),
    enableSend: input => ipcRenderer.invoke(NATIVE_OUTBOUND_CHANNELS.enableSend,input),
    prepare: input => ipcRenderer.invoke(NATIVE_OUTBOUND_CHANNELS.prepare,input),
    get: input => ipcRenderer.invoke(NATIVE_OUTBOUND_CHANNELS.get,input),
    list: input => ipcRenderer.invoke(NATIVE_OUTBOUND_CHANNELS.list,input),
    requestApproval: input => ipcRenderer.invoke(NATIVE_OUTBOUND_REQUEST_APPROVAL_CHANNEL,input),
    reconcile: input => ipcRenderer.invoke(NATIVE_OUTBOUND_CHANNELS.reconcile,input),
    cancel: input => ipcRenderer.invoke(NATIVE_OUTBOUND_CHANNELS.cancel,input),
    reject: input => ipcRenderer.invoke(NATIVE_OUTBOUND_CHANNELS.reject,input),
  },
  connectors: {
    list: input => ipcRenderer.invoke(NATIVE_CONNECTOR_CHANNELS.list, input),
    configure: input => ipcRenderer.invoke(NATIVE_CONNECTOR_CHANNELS.configure, input),
    authorize: input => ipcRenderer.invoke(NATIVE_CONNECTOR_CHANNELS.authorize, input),
    cancelAuthorization: input => ipcRenderer.invoke(NATIVE_CONNECTOR_CHANNELS.cancelAuthorization, input),
    revoke: input => ipcRenderer.invoke(NATIVE_CONNECTOR_CHANNELS.revoke, input),
    bindings: input => ipcRenderer.invoke(NATIVE_CONNECTOR_CHANNELS.bindings, input),
    bind: input => ipcRenderer.invoke(NATIVE_CONNECTOR_CHANNELS.bind, input),
    unbind: input => ipcRenderer.invoke(NATIVE_CONNECTOR_CHANNELS.unbind, input),
    search: input => ipcRenderer.invoke(NATIVE_CONNECTOR_CHANNELS.search, input),
    read: input => ipcRenderer.invoke(NATIVE_CONNECTOR_CHANNELS.read, input),
  },
  drafts: {
    list: input => ipcRenderer.invoke(CONNECTOR_DRAFT_CHANNELS.list, input),
    create: input => ipcRenderer.invoke(CONNECTOR_DRAFT_CHANNELS.create, input),
    update: input => ipcRenderer.invoke(CONNECTOR_DRAFT_CHANNELS.update, input),
    read: input => ipcRenderer.invoke(CONNECTOR_DRAFT_CHANNELS.read, input),
    versions: input => ipcRenderer.invoke(CONNECTOR_DRAFT_CHANNELS.versions, input),
    delete: input => ipcRenderer.invoke(CONNECTOR_DRAFT_CHANNELS.delete, input),
  },
  skillsExecution: {
    scripts: input => ipcRenderer.invoke(SKILL_EXECUTION_CHANNELS.scripts, input),
    executionGrants: input => ipcRenderer.invoke(SKILL_EXECUTION_CHANNELS.executionGrants, input),
    grantExecution: input => ipcRenderer.invoke(SKILL_EXECUTION_CHANNELS.grantExecution, input),
    revokeExecution: input => ipcRenderer.invoke(SKILL_EXECUTION_CHANNELS.revokeExecution, input),
    runScript: input => ipcRenderer.invoke(SKILL_EXECUTION_CHANNELS.runScript, input),
    scriptExecution: input => ipcRenderer.invoke(SKILL_EXECUTION_CHANNELS.scriptExecution, input),
    onChanged: listener => {
      const handler = (_event: Electron.IpcRendererEvent, value: SkillExecutionChangedEvent): void => listener(value);
      ipcRenderer.on(SKILL_EXECUTION_EVENTS.changed, handler);
      return () => ipcRenderer.removeListener(SKILL_EXECUTION_EVENTS.changed, handler);
    },
  },
  browser: {
    get: input => ipcRenderer.invoke(BROWSER_CHANNELS.get, input),
    start: input => ipcRenderer.invoke(BROWSER_CHANNELS.start, input),
    stop: input => ipcRenderer.invoke(BROWSER_CHANNELS.stop, input),
    tabs: input => ipcRenderer.invoke(BROWSER_CHANNELS.tabs, input),
    newTab: input => ipcRenderer.invoke(BROWSER_CHANNELS.newTab, input),
    closeTab: input => ipcRenderer.invoke(BROWSER_CHANNELS.closeTab, input),
    navigate: input => ipcRenderer.invoke(BROWSER_CHANNELS.navigate, input),
    read: input => ipcRenderer.invoke(BROWSER_CHANNELS.read, input),
    observe: input => ipcRenderer.invoke(BROWSER_CHANNELS.observe, input),
    click: input => ipcRenderer.invoke(BROWSER_CHANNELS.click, input),
    type: input => ipcRenderer.invoke(BROWSER_CHANNELS.type, input),
    key: input => ipcRenderer.invoke(BROWSER_CHANNELS.key, input),
    scroll: input => ipcRenderer.invoke(BROWSER_CHANNELS.scroll, input),
    downloads: input => ipcRenderer.invoke(BROWSER_CHANNELS.downloads, input),
    download: input => ipcRenderer.invoke(BROWSER_CHANNELS.download, input),
    onChanged: onBrowserChanged,
  },
  computer: {
    view: input => ipcRenderer.invoke(COMPUTER_CHANNELS.view, input),
    screenshot: input => ipcRenderer.invoke(COMPUTER_CHANNELS.screenshot, input),
    click: input => ipcRenderer.invoke(COMPUTER_CHANNELS.click, input),
    type: input => ipcRenderer.invoke(COMPUTER_CHANNELS.type, input),
    key: input => ipcRenderer.invoke(COMPUTER_CHANNELS.key, input),
    scroll: input => ipcRenderer.invoke(COMPUTER_CHANNELS.scroll, input),
    takeover: input => ipcRenderer.invoke(COMPUTER_CHANNELS.takeover, input),
    returnControl: input => ipcRenderer.invoke(COMPUTER_CHANNELS.returnControl, input),
    vncTicket: input => ipcRenderer.invoke(COMPUTER_CHANNELS.vncTicket, input),
    onChanged: onBrowserChanged,
  },
  preview: {
    list: input => ipcRenderer.invoke(PREVIEW_CHANNELS.list, input),
    open: input => ipcRenderer.invoke(PREVIEW_CHANNELS.open, input),
    close: input => ipcRenderer.invoke(PREVIEW_CHANNELS.close, input),
    onChanged: onBrowserChanged,
  },
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
    readFile: input => ipcRenderer.invoke(LIBRARY_CHANNELS.readFile, input),
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
  voice: {
    realtime: {
      start: input => ipcRenderer.invoke(REALTIME_CHANNELS.start, input),
      append: input => ipcRenderer.invoke(REALTIME_CHANNELS.append, input),
      commitTurn: input => ipcRenderer.invoke(REALTIME_CHANNELS.commitTurn, input),
      playbackAck: input => ipcRenderer.invoke(REALTIME_CHANNELS.playbackAck, input),
      interrupt: input => ipcRenderer.invoke(REALTIME_CHANNELS.interrupt, input),
      stop: input => ipcRenderer.invoke(REALTIME_CHANNELS.stop, input),
      snapshot: input => ipcRenderer.invoke(REALTIME_CHANNELS.snapshot, input),
      stopTask: input => ipcRenderer.invoke(REALTIME_CHANNELS.stopTask, input),
      onChanged: listener => {
        const handler = (_event: Electron.IpcRendererEvent, event: RealtimeEvent): void => listener(event);
        ipcRenderer.on(REALTIME_CHANGED_CHANNEL, handler);
        return () => ipcRenderer.removeListener(REALTIME_CHANGED_CHANNEL, handler);
      },
    },
    configurations: () => ipcRenderer.invoke(VOICE_CHANNELS.configurations),
    saveConfiguration: input => ipcRenderer.invoke(VOICE_CHANNELS.saveConfiguration, input),
    beginCapture: input => ipcRenderer.invoke(VOICE_CHANNELS.beginCapture, input),
    commitCapture: input => ipcRenderer.invoke(VOICE_CHANNELS.commitCapture, input),
    cancelCapture: input => ipcRenderer.invoke(VOICE_CHANNELS.cancelCapture, input),
    transcribe: input => ipcRenderer.invoke(VOICE_CHANNELS.transcribe, input),
    speak: input => ipcRenderer.invoke(VOICE_CHANNELS.speak, input),
    get: input => ipcRenderer.invoke(VOICE_CHANNELS.get, input),
    list: input => ipcRenderer.invoke(VOICE_CHANNELS.list, input),
    stop: input => ipcRenderer.invoke(VOICE_CHANNELS.stop, input),
    audio: input => ipcRenderer.invoke(VOICE_CHANNELS.audio, input),
    onChanged: listener => {
      const handler = (_event: Electron.IpcRendererEvent, event: VoiceEvent): void => listener(event);
      ipcRenderer.on(VOICE_CHANGED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(VOICE_CHANGED_CHANNEL, handler);
    },
  },
  media: {
    list: input => ipcRenderer.invoke(MEDIA_CHANNELS.list, input),
    available: input => ipcRenderer.invoke(MEDIA_CHANNELS.available, input),
    metadata: input => ipcRenderer.invoke(MEDIA_CHANNELS.metadata, input),
    read: input => ipcRenderer.invoke(MEDIA_CHANNELS.read, input),
    preview: input => ipcRenderer.invoke(MEDIA_CHANNELS.preview, input),
    pickImport: input => ipcRenderer.invoke(MEDIA_CHANNELS.pickImport, input),
    importPath: input => ipcRenderer.invoke(MEDIA_CHANNELS.importPath, input),
    bind: input => ipcRenderer.invoke(MEDIA_CHANNELS.bind, input),
    unbind: input => ipcRenderer.invoke(MEDIA_CHANNELS.unbind, input),
    setEnabled: input => ipcRenderer.invoke(MEDIA_CHANNELS.setEnabled, input),
    delete: input => ipcRenderer.invoke(MEDIA_CHANNELS.delete, input),
    restore: input => ipcRenderer.invoke(MEDIA_CHANNELS.restore, input),
    onChanged: listener => {
      const handler = (_event: Electron.IpcRendererEvent, value: MediaChangedEvent): void => listener(value);
      ipcRenderer.on(MEDIA_CHANGED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(MEDIA_CHANGED_CHANNEL, handler);
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
    runNow: (input) => ipcRenderer.invoke(IPC.routinesRunNow, input),
    cancelRun: (input) => ipcRenderer.invoke(IPC.routinesCancelRun, input),
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
    review: input => ipcRenderer.invoke(IPC.approvalsReview, input),
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
    onTasksChanged: listener => {
      const handler=(_event:Electron.IpcRendererEvent,event:TaskSessionChanged):void=>listener(event);
      ipcRenderer.on(TASK_SESSION_CHANGED_CHANNEL,handler);
      return ()=>ipcRenderer.removeListener(TASK_SESSION_CHANGED_CHANNEL,handler);
    },
    taskOptions: input => ipcRenderer.invoke(TASK_SESSION_CHANNELS.taskOptions, input),
    createTask: input => ipcRenderer.invoke(TASK_SESSION_CHANNELS.createTask, input),
    listTasks: input => ipcRenderer.invoke(TASK_SESSION_CHANNELS.listTasks, input),
    getTask: input => ipcRenderer.invoke(TASK_SESSION_CHANNELS.getTask, input),
    updateTask: input => ipcRenderer.invoke(TASK_SESSION_CHANNELS.updateTask, input),
    reviseTaskSelection: input => ipcRenderer.invoke(TASK_SESSION_CHANNELS.reviseTaskSelection, input),
    cancelTask: input => ipcRenderer.invoke(TASK_SESSION_CHANNELS.cancelTask, input),
    deleteTask: input => ipcRenderer.invoke(TASK_SESSION_CHANNELS.deleteTask, input),
    onChanged: listener => {
      const handler = (_event: Electron.IpcRendererEvent, event: { session: import("@shared/contracts").Session }): void => listener(event);
      ipcRenderer.on(IPC.sessionChangedEvent, handler);
      return () => ipcRenderer.removeListener(IPC.sessionChangedEvent, handler);
    },
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
    cancelMember: runId => ipcRenderer.invoke(IPC.roomRuntimeCancelMember, runId),
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
