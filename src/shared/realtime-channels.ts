export const REALTIME_CHANNELS = {
  start: "voice:realtime:start", append: "voice:realtime:append", commitTurn: "voice:realtime:commit-turn",
  playbackAck: "voice:realtime:playback-ack", interrupt: "voice:realtime:interrupt", stop: "voice:realtime:stop",
  snapshot: "voice:realtime:snapshot", stopTask: "voice:realtime:stop-task",
} as const;
export const REALTIME_CHANGED_CHANNEL = "voice:realtime:changed";
export const REALTIME_CAPTURE_MAX_DURATION_MS = 15 * 60_000;
export const REALTIME_SAMPLE_RATE = 24_000;
