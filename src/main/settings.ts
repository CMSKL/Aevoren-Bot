import type { ModelConfiguration, SaveModelConfigurationInput } from "@shared/contracts";
import { MsBotError } from "./errors";
import type { AppRepository } from "./database";

const BASE_URL_KEY = "model.baseUrl";
const MODEL_ID_KEY = "model.modelId";
const API_KEY_KEY = "model.apiKey";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface SecretCodec {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export class ModelSettingsService {
  constructor(
    private readonly repository: AppRepository,
    private readonly secretCodec: SecretCodec,
  ) {}

  getConfiguration(): ModelConfiguration {
    return {
      baseUrl: this.repository.getSetting(BASE_URL_KEY)?.value ?? DEFAULT_BASE_URL,
      modelId: this.repository.getSetting(MODEL_ID_KEY)?.value ?? "",
      apiKeyConfigured: this.repository.getSetting(API_KEY_KEY) !== null,
    };
  }

  saveConfiguration(input: SaveModelConfigurationInput): ModelConfiguration {
    this.repository.setSetting(BASE_URL_KEY, input.baseUrl.replace(/\/$/, ""), false);
    this.repository.setSetting(MODEL_ID_KEY, input.modelId, false);
    if (input.apiKey) {
      if (!this.secretCodec.isAvailable()) {
        throw new MsBotError(
          "SECURE_STORAGE_UNAVAILABLE",
          "系统安全存储当前不可用，API Key 未保存。",
          false,
        );
      }
      this.repository.setSetting(API_KEY_KEY, this.secretCodec.encrypt(input.apiKey), true);
    }
    return this.getConfiguration();
  }

  getApiKey(): string {
    const setting = this.repository.getSetting(API_KEY_KEY);
    if (!setting) throw new MsBotError("MODEL_NOT_CONFIGURED", "请先在模型设置中保存 API Key。", false);
    if (!setting.encrypted || !this.secretCodec.isAvailable()) {
      throw new MsBotError("SECURE_STORAGE_UNAVAILABLE", "无法安全读取模型 API Key。", false);
    }
    try {
      return this.secretCodec.decrypt(setting.value);
    } catch {
      throw new MsBotError("SECURE_STORAGE_UNAVAILABLE", "无法安全读取模型 API Key。", false);
    }
  }
}
