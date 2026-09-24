import { UPDATE_CHECK_INTERVAL_MINUTES, type GeneralSettings, type LoginItemStatus, type SaveGeneralSettings, type UpdateCheckIntervalMinutes } from "@shared/contracts";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";

const APPEARANCE_THEME_KEY = "appearance.theme";
const MEMORY_CAPTURE_ENABLED_KEY = "memory.capture.enabled";
const AUTO_APPROVE_PUBLIC_READ_TOOLS_KEY = "tools.autoApprovePublicRead";
const UPDATE_CHECK_INTERVAL_KEY = "updates.checkIntervalMinutes";
const DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES: UpdateCheckIntervalMinutes = 360;

function readUpdateCheckInterval(value: string | undefined): UpdateCheckIntervalMinutes {
  const minutes = Number(value);
  return UPDATE_CHECK_INTERVAL_MINUTES.find((candidate) => candidate === minutes) ?? DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES;
}

export type LoginItemController = {
  supported: boolean;
  get(): { openAtLogin: boolean; status: Exclude<LoginItemStatus, "unsupported"> };
  set(openAtLogin: boolean): void;
};

export class GeneralSettingsService {
  constructor(
    private readonly repository: AppRepository,
    private readonly loginItem?: LoginItemController,
  ) {}

  getConfiguration(): GeneralSettings {
    const theme = this.repository.getSetting(APPEARANCE_THEME_KEY)?.value;
    const appearance = theme === "light" || theme === "dark" ? theme : "system";
    const memoryCaptureEnabled = this.repository.getSetting(MEMORY_CAPTURE_ENABLED_KEY)?.value !== "false";
    const autoApprovePublicReadTools = this.repository.getSetting(AUTO_APPROVE_PUBLIC_READ_TOOLS_KEY)?.value === "true";
    const updateCheckIntervalMinutes = readUpdateCheckInterval(this.repository.getSetting(UPDATE_CHECK_INTERVAL_KEY)?.value);
    if (!this.loginItem?.supported) {
      return { theme: appearance, memoryCaptureEnabled, autoApprovePublicReadTools, updateCheckIntervalMinutes, launchAtLogin: false, launchAtLoginSupported: false, launchAtLoginStatus: "unsupported" };
    }
    try {
      const current = this.loginItem.get();
      const status: Exclude<LoginItemStatus, "unsupported"> = ["not-registered", "enabled", "requires-approval", "not-found"].includes(current.status)
        ? current.status
        : "not-found";
      return {
        theme: appearance,
        memoryCaptureEnabled,
        autoApprovePublicReadTools,
        updateCheckIntervalMinutes,
        launchAtLogin: current.openAtLogin,
        launchAtLoginSupported: true,
        launchAtLoginStatus: status,
      };
    } catch {
      return { theme: appearance, memoryCaptureEnabled, autoApprovePublicReadTools, updateCheckIntervalMinutes, launchAtLogin: false, launchAtLoginSupported: true, launchAtLoginStatus: "not-found" };
    }
  }

  saveConfiguration(input: SaveGeneralSettings): GeneralSettings {
    if (input.theme !== undefined) this.repository.setSetting(APPEARANCE_THEME_KEY, input.theme, false);
    if (input.memoryCaptureEnabled !== undefined) {
      this.repository.setSetting(MEMORY_CAPTURE_ENABLED_KEY, String(input.memoryCaptureEnabled), false);
    }
    if (input.autoApprovePublicReadTools !== undefined) {
      this.repository.setSetting(AUTO_APPROVE_PUBLIC_READ_TOOLS_KEY, String(input.autoApprovePublicReadTools), false);
    }
    if (input.updateCheckIntervalMinutes !== undefined) {
      this.repository.setSetting(UPDATE_CHECK_INTERVAL_KEY, String(input.updateCheckIntervalMinutes), false);
    }
    if (input.launchAtLogin !== undefined) {
      if (!this.loginItem?.supported) throw new AevorenBotError("SYSTEM_SETTING_UNAVAILABLE");
      try {
        this.loginItem.set(input.launchAtLogin);
      } catch {
        throw new AevorenBotError("SYSTEM_SETTING_FAILED");
      }
    }
    return this.getConfiguration();
  }
}

export interface SecretCodec {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}
