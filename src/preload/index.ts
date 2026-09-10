import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@shared/channels";
import type { MsBotApi, SendStateEvent, TranscriptEvent } from "@shared/contracts";

const api: MsBotApi = {
  bots: {
    list: () => ipcRenderer.invoke(IPC.botsList),
    create: () => ipcRenderer.invoke(IPC.botsCreate),
    update: (input) => ipcRenderer.invoke(IPC.botsUpdate, input),
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
  settings: {
    getModelConfiguration: () => ipcRenderer.invoke(IPC.settingsGetModel),
    saveModelConfiguration: (input) => ipcRenderer.invoke(IPC.settingsSaveModel, input),
    testModelConnection: () => ipcRenderer.invoke(IPC.settingsTestModel),
  },
  events: {
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
  },
  app: {
    subscribeBeforeClose(listener) {
      const wrapped = (): void => listener();
      ipcRenderer.on(IPC.appBeforeClose, wrapped);
      return () => ipcRenderer.removeListener(IPC.appBeforeClose, wrapped);
    },
    confirmClose: (canClose) => ipcRenderer.send(IPC.appConfirmClose, canClose),
  },
};

contextBridge.exposeInMainWorld("msBot", api);
