import { systemPreferences, type BrowserWindow } from "electron";
import type { AppRepository } from "./database";
import { VoiceCaptureGate, type VoiceCaptureDependencies } from "./voice-capture";

export function installVoiceCaptureHost(repository: AppRepository, window: BrowserWindow, publish: VoiceCaptureDependencies["publish"]): VoiceCaptureGate {
  let epoch = 0;
  const contents = window.webContents;
  const gate = new VoiceCaptureGate(repository, {
    identity: () => ({ webContentsId: contents.id, processId: contents.mainFrame.processId, routingId: contents.mainFrame.routingId, url: contents.mainFrame.url, epoch }),
    hasUserActivation: async () => !contents.isDestroyed() && await contents.mainFrame.executeJavaScript("navigator.userActivation.isActive") === true,
    requestMicrophone: async () => {
      const state = systemPreferences.getMediaAccessStatus("microphone");
      if (state === "denied" || state === "restricted") return false;
      return process.platform === "darwin" && state !== "granted" ? systemPreferences.askForMediaAccess("microphone") : true;
    },
    publish,
  });
  const owned = contents.session;
  owned.setPermissionCheckHandler((requester, permission, _origin, details) => gate.allows(requester?.id ?? null, permission, details));
  owned.setPermissionRequestHandler((requester, permission, callback, details) => {
    const media = details as Electron.MediaAccessPermissionRequest;
    callback(gate.allows(requester.id, permission, { isMainFrame: media.isMainFrame, requestingUrl: media.requestingUrl, mediaTypes: media.mediaTypes }));
  });
  owned.setDevicePermissionHandler(() => false);
  owned.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  contents.on("did-navigate", () => { epoch += 1; gate.invalidate(); });
  contents.on("render-process-gone", () => { epoch += 1; gate.invalidate(); });
  contents.on("destroyed", () => gate.invalidate());
  return gate;
}
