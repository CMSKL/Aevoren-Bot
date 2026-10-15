import type { VoiceConfiguration, VoiceConfigurationKind, VoiceConfigurationSave } from "@shared/voice-contracts";
import { voiceConfigurationSaveSchema } from "@shared/voice-schemas";
import type { SecretCodec } from "./settings";
import type { VoiceRepository } from "./voice-repository";
import { AevorenBotError } from "./errors";

export class VoiceSettings {
  constructor(private readonly repository:VoiceRepository,private readonly codec:SecretCodec){}
  configurations():VoiceConfiguration[]{return this.repository.configurations();}
  save(input:VoiceConfigurationSave):VoiceConfiguration {
    const parsed=voiceConfigurationSaveSchema.parse(input),current=this.repository.configuration(parsed.kind);
    if(current.configuration.version!==parsed.expectedVersion)throw new AevorenBotError("VOICE_CONFIGURATION_CONFLICT");
    let encrypted=current.encryptedKey;
    if(parsed.clearApiKey)encrypted=null;
    if(parsed.apiKey){if(!this.codec.isAvailable()||/[\r\n\0]/u.test(parsed.apiKey))throw new AevorenBotError("VOICE_CONFIGURATION_REQUIRED");
      try{encrypted=this.codec.encrypt(parsed.apiKey);}catch{throw new AevorenBotError("VOICE_CONFIGURATION_REQUIRED");}}
    if(parsed.enabled&&!encrypted)throw new AevorenBotError("VOICE_CONFIGURATION_REQUIRED");
    return this.repository.saveConfiguration(parsed,encrypted);
  }
  credentials(kind:VoiceConfigurationKind,expectedVersion:number):{configuration:VoiceConfiguration;apiKey:string}{
    const current=this.repository.configuration(kind);
    if(current.configuration.version!==expectedVersion)throw new AevorenBotError("VOICE_CONFIGURATION_CONFLICT");
    if(!current.configuration.enabled||!current.encryptedKey||!this.codec.isAvailable())throw new AevorenBotError("VOICE_CONFIGURATION_REQUIRED");
    let apiKey:string;try{apiKey=this.codec.decrypt(current.encryptedKey);}catch{throw new AevorenBotError("VOICE_CONFIGURATION_REQUIRED");}
    if(!apiKey||/[\r\n\0]/u.test(apiKey))throw new AevorenBotError("VOICE_CONFIGURATION_REQUIRED");return {configuration:current.configuration,apiKey};
  }
}
