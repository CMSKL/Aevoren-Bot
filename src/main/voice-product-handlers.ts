import { VOICE_PRODUCT_OPERATIONS } from "@shared/voice-product";
import { voiceSpeechSchema, voiceTaskListSchema, voiceTaskSchema, voiceTranscribeSchema } from "@shared/voice-schemas";
import type { VoiceService } from "./voice-service";
import { AevorenBotError } from "./errors";
export type VoiceProductDependencies = { voiceService?: VoiceService };
/** UI methods return authorized data; model dispatch uses the revocable transport boundary. */
export function addVoiceProductHandlers(handlers: Map<string, (input?: unknown) => unknown>, dependencies: VoiceProductDependencies): void {
  for (const definition of VOICE_PRODUCT_OPERATIONS) handlers.set(definition.channel, input => {
    const service = dependencies.voiceService; if (!service) throw new AevorenBotError("VOICE_UNSUPPORTED");
    switch (definition.name) {
      case "voice.configurations": return service.configurations();
      case "voice.transcribe": return service.transcribe(voiceTranscribeSchema.parse(input));
      case "voice.speak": return service.speak(voiceSpeechSchema.parse(input));
      case "voice.get": return service.get(voiceTaskSchema.parse(input));
      case "voice.list": return service.list(voiceTaskListSchema.parse(input));
      case "voice.stop": return service.stop(voiceTaskSchema.parse(input));
      case "voice.audio": return service.audio(voiceTaskSchema.parse(input));
      default: throw new AevorenBotError("INVALID_REQUEST");
    }
  });
}
