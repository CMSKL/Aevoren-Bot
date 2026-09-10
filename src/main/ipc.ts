import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { IPC } from "@shared/channels";
import { botIdSchema, botUpdateSchema, modelConfigurationSchema, nonceSchema, sendCommandSchema, sessionIdSchema } from "@shared/schemas";
import { apiResult, MsBotError } from "./errors";
import type { AppRepository } from "./database";
import { OpenAiCompatibleProvider } from "./model";
import type { ModelSettingsService } from "./settings";
import type { SendWorker } from "./send-worker";

type IpcDependencies = {
  window: BrowserWindow;
  repository: AppRepository;
  settings: ModelSettingsService;
  sendWorker: SendWorker;
  forceFakeProvider: boolean;
  confirmClose(canClose: boolean): void;
};

function assertTrusted(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new MsBotError("UNTRUSTED_RENDERER", "请求来源不受信任。", false);
  }
}

export function registerIpc(dependencies: IpcDependencies): void {
  const { window, repository, settings, sendWorker } = dependencies;

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
  handle(IPC.sessionsGetMain, (_event, botId: unknown) => repository.getMainSession(botIdSchema.parse(botId)));
  handle(IPC.transcriptList, (_event, sessionId: unknown) => repository.listTranscript(sessionIdSchema.parse(sessionId)));
  handle(IPC.messagesSend, (_event, command: unknown) => sendWorker.send(sendCommandSchema.parse(command)));
  handle(IPC.messagesRetry, (_event, clientNonce: unknown) => sendWorker.retry(nonceSchema.parse(clientNonce)));
  handle(IPC.messagesCancel, (_event, clientNonce: unknown) => sendWorker.cancel(nonceSchema.parse(clientNonce)));
  handle(IPC.messagesGetStatus, (_event, clientNonce: unknown) =>
    repository.getSendOrThrow(nonceSchema.parse(clientNonce)),
  );
  handle(IPC.settingsGetModel, () => settings.getConfiguration());
  handle(IPC.settingsSaveModel, (_event, input: unknown) => {
    const parsed = modelConfigurationSchema.parse(input);
    return settings.saveConfiguration(parsed);
  });
  handle(IPC.settingsTestModel, async () => {
    if (dependencies.forceFakeProvider) return;
    const configuration = settings.getConfiguration();
    if (!configuration.modelId || !configuration.apiKeyConfigured) {
      throw new MsBotError("MODEL_NOT_CONFIGURED", "请先保存 Base URL、Model ID 和 API Key。", false);
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
    } finally {
      clearTimeout(timer);
    }
  });

  ipcMain.on(IPC.appConfirmClose, (event, canClose: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    dependencies.confirmClose(canClose === true);
  });
}
