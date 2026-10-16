/** Preload-safe constants. Secret writes and capture are excluded from AI operations. */
export const VOICE_CHANNELS = {
  configurations: "voice:configurations", saveConfiguration: "voice:save-configuration",
  beginCapture: "voice:begin-capture", commitCapture: "voice:commit-capture", cancelCapture: "voice:cancel-capture",
  transcribe: "voice:transcribe", speak: "voice:speak", get: "voice:get", list: "voice:list", stop: "voice:stop", audio: "voice:audio",
} as const;
export const VOICE_CHANGED_CHANNEL = "voice:changed";

export const VOICE_CAPTURE_MAX_DURATION_MS = 120_000;
