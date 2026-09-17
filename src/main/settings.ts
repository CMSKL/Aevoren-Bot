import type { GeneralSettings } from "@shared/contracts";
import type { AppRepository } from "./database";

const APPEARANCE_THEME_KEY = "appearance.theme";

export class GeneralSettingsService {
  constructor(private readonly repository: AppRepository) {}

  getConfiguration(): GeneralSettings {
    const theme = this.repository.getSetting(APPEARANCE_THEME_KEY)?.value;
    return { theme: theme === "light" || theme === "dark" ? theme : "system" };
  }

  saveConfiguration(input: GeneralSettings): GeneralSettings {
    this.repository.setSetting(APPEARANCE_THEME_KEY, input.theme, false);
    return this.getConfiguration();
  }
}

export interface SecretCodec {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}
