import type { MediaParseResult } from "../main/media-parser-types";
import { avMime, inspectAvHeader } from "../shared/media-av-format";
import { MEDIA_PARSER_NAME, MEDIA_PARSER_VERSION, PARSER_LIMITS, type ParserRequest } from "../shared/media-parser-protocol";

function fail(code = "MEDIA_CODEC_UNSUPPORTED"): never { throw new Error(code); }
function ready(media: HTMLMediaElement, condition: () => boolean, action?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const events = ["loadedmetadata", "loadeddata", "canplay", "durationchange", "seeked", "progress", "timeupdate", "error"];
    const cleanup = (): void => { for (const event of events) media.removeEventListener(event, check); };
    const check = (): void => {
      if (media.error) { cleanup(); reject(new Error("MEDIA_CODEC_UNSUPPORTED")); }
      else if (condition()) { cleanup(); resolve(); }
    };
    for (const event of events) media.addEventListener(event, check);
    try { action?.(); check(); } catch { cleanup(); reject(new Error("MEDIA_CODEC_UNSUPPORTED")); }
  });
}

/** Uses only this job's immutable Blob. No media is played or sent to a model. */
export async function parseAv(request: ParserRequest): Promise<MediaParseResult> {
  if (request.bytes.length > PARSER_LIMITS.avBytes) fail("MEDIA_IMPORT_TOO_LARGE");
  const header = inspectAvHeader(request.bytes); if (!header) fail("MEDIA_CONTENT_INVALID");
  const mimeType = avMime(header, header.video ? "video" : "audio"), media = document.createElement("video");
  if (!media.canPlayType(mimeType)) fail();
  const url = URL.createObjectURL(new Blob([new Uint8Array(request.bytes)], { type: mimeType }));
  if (!url.startsWith(`blob:${location.protocol}//${location.host}/`)) { URL.revokeObjectURL(url); fail("MEDIA_CONTENT_INVALID"); }
  media.muted = true; media.volume = 0; media.preload = "auto"; media.playsInline = true;
  try {
    await ready(media, () => media.readyState >= HTMLMediaElement.HAVE_METADATA, () => { media.src = url; media.load(); });
    if (media.videoWidth * media.videoHeight > PARSER_LIMITS.pixels) fail("MEDIA_IMPORT_TOO_LARGE");
    if (!Number.isFinite(media.duration)) {
      // Streaming MediaRecorder WebM may omit Duration. Seeking the immutable
      // complete Blob forces Chromium to observe the last actual timestamp.
      await ready(media, () => Number.isFinite(media.duration) && media.duration > 0, () => { media.currentTime = Number.MAX_SAFE_INTEGER; });
    }
    const durationMs = Math.ceil(media.duration * 1000);
    if (!Number.isSafeInteger(durationMs) || durationMs < 1) fail();
    if (durationMs > PARSER_LIMITS.durationMs) fail("MEDIA_IMPORT_TOO_LARGE");
    await ready(media, () => media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !media.seeking, () => { media.currentTime = 0; });
    const hasVideo = media.videoWidth > 0 && media.videoHeight > 0;
    if (header.video !== hasVideo || (!hasVideo && !header.audio)) fail();
    if (hasVideo && (!Number.isSafeInteger(media.videoWidth) || !Number.isSafeInteger(media.videoHeight) || media.videoWidth * media.videoHeight > PARSER_LIMITS.pixels)) fail("MEDIA_IMPORT_TOO_LARGE");
    return { kind: hasVideo ? "video" : "audio", width: hasVideo ? media.videoWidth : null, height: hasVideo ? media.videoHeight : null,
      durationMs, extraction: null, parserName: MEDIA_PARSER_NAME, parserVersion: MEDIA_PARSER_VERSION };
  } finally { media.pause(); media.removeAttribute("src"); media.load(); URL.revokeObjectURL(url); }
}
