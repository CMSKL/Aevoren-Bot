const ROOM_SPEAKER_ENVELOPE = /\[room-speaker id="(?:unknown|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})" name="(?:\\.|[^"\\\r\n])*"\][ \t]*(?:\r?\n)?/g;

const ROOM_SPEAKER_PREFIX = "[room-speaker";

export function sanitizeRoomSpeakerOutput(body: string, streaming = false): string {
  const visible = body.replace(ROOM_SPEAKER_ENVELOPE, "");
  if (!streaming) return visible;

  const bracketIndex = visible.lastIndexOf("[");
  if (bracketIndex < 0) return visible;
  const candidate = visible.slice(bracketIndex);
  if (ROOM_SPEAKER_PREFIX.startsWith(candidate)) return visible.slice(0, bracketIndex);
  if (candidate.startsWith(ROOM_SPEAKER_PREFIX) && !candidate.includes("]")) return visible.slice(0, bracketIndex);
  return visible;
}
