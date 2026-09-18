import type { GeneralSettings, LoginItemStatus, SaveGeneralSettings } from "@shared/contracts";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";

const APPEARANCE_THEME_KEY = "appearance.theme";

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
    if (!this.loginItem?.supported) {
      return { theme: appearance, launchAtLogin: false, launchAtLoginSupported: false, launchAtLoginStatus: "unsupported" };
    }
    try {
      const current = this.loginItem.get();
      return {
        theme: appearance,
        launchAtLogin: current.openAtLogin,
        launchAtLoginSupported: true,
        launchAtLoginStatus: current.status,
      };
    } catch {
      return { theme: appearance, launchAtLogin: false, launchAtLoginSupported: true, launchAtLoginStatus: "not-found" };
    }
  }

  saveConfiguration(input: SaveGeneralSettings): GeneralSettings {
    if (input.theme !== undefined) this.repository.setSetting(APPEARANCE_THEME_KEY, input.theme, false);
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
