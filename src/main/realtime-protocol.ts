import { AevorenBotError } from "./errors";

export const REALTIME_PROTOCOL = "realtime-v1" as const;
export const REALTIME_SAMPLE_RATE = 24_000;
export const REALTIME_MAX_MESSAGE_BYTES = 1_048_576;
export const REALTIME_MAX_TEXT = 20_000;
export const REALTIME_MAX_ARGUMENTS = 8_192;
export const REALTIME_MAX_OUTPUT_SAMPLES = 8_388_608;
export const REALTIME_DELEGATE_NAME = "delegate_to_runtime";

type WireObject = Record<string, unknown>;
export type RealtimeFunctionCall = { itemId: string; callId: string; name: string; arguments: string; status: string };
export type RealtimeWireEvent =
  | { type: "session.created" | "session.updated"; sessionId: string; model: string; voice: string; configured: boolean }
  | { type: "input_audio_buffer.committed"; itemId: string; previousItemId: string | null }
  | { type: "conversation.item.input_audio_transcription.delta"; itemId: string; delta: string }
  | { type: "conversation.item.input_audio_transcription.completed"; itemId: string; transcript: string }
  | { type: "conversation.item.input_audio_transcription.failed"; itemId: string }
  | { type: "response.created"; responseId: string; turnId: string | null }
  | { type: "response.function_call_arguments.delta"; responseId: string; itemId: string; callId: string; delta: string }
  | { type: "response.function_call_arguments.done"; responseId: string; itemId: string; callId: string; name: string; arguments: string }
  | { type: "response.done"; responseId: string; status: string; calls: RealtimeFunctionCall[] }
  | { type: "response.output_audio.delta"; responseId: string; itemId: string; contentIndex: number; pcm: Buffer }
  | { type: "response.output_audio_transcript.delta" | "response.output_audio_transcript.done"; responseId: string; itemId: string; text: string }
  | { type: "conversation.item.truncated"; itemId: string; contentIndex: number; audioEndMs: number }
  | { type: "error"; clientEventId: string | null }
  | { type: "ignored" };

function invalid(): never { throw new AevorenBotError("VOICE_RESPONSE_INVALID"); }
function object(value: unknown): WireObject { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as WireObject; }
function string(value: unknown, max = REALTIME_MAX_TEXT): string { if (typeof value !== "string" || value.length > max) invalid(); return value; }
function id(value: unknown): string { const text = string(value, 256); if (!/^[A-Za-z0-9_-]+$/u.test(text)) invalid(); return text; }
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) invalid(); return Number(value); }
function ordered(value:unknown):unknown{return Array.isArray(value)?value.map(ordered):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>[key,ordered(item)])):value;}
export function decodeRealtimePcm(value: unknown, maxBytes: number): Buffer {
  const encoded = string(value, Math.ceil(maxBytes / 3) * 4);
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) invalid();
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > maxBytes || bytes.length % 2 || bytes.toString("base64") !== encoded) invalid();
  return bytes;
}

/** Parse only the bounded fields the host consumes; provider instructions/errors are discarded. */
export function parseRealtimeEvent(raw: string | Buffer): RealtimeWireEvent {
  if (Buffer.byteLength(raw) > REALTIME_MAX_MESSAGE_BYTES) invalid();
  let parsed: unknown; try { parsed = JSON.parse(typeof raw==="string"?raw:new TextDecoder("utf-8",{fatal:true}).decode(raw)); } catch { invalid(); }
  const event = object(parsed), type = string(event.type, 128);
  if (type === "session.started" || type === "session.start") invalid();
  if (type === "session.created" || type === "session.updated") {
    const session = object(event.session), audio = session.audio ? object(session.audio) : {}, input = audio.input ? object(audio.input) : {}, output = audio.output ? object(audio.output) : {};
    const inputFormat = input.format ? object(input.format) : {}, outputFormat = output.format ? object(output.format) : {};
    const transcription = input.transcription ? object(input.transcription) : {};
    const tools = Array.isArray(session.tools) ? session.tools : [];
    const expected=object(realtimeSessionUpdate(string(session.model??"",128),string(output.voice??"",80)).session);
    return { type, sessionId: id(session.id), model: string(session.model ?? "", 128), voice: string(output.voice ?? "", 80),
      configured: session.type === "realtime" && inputFormat.type === "audio/pcm" && inputFormat.rate === REALTIME_SAMPLE_RATE
        && outputFormat.type === "audio/pcm" && outputFormat.rate === REALTIME_SAMPLE_RATE && transcription.model === "gpt-transcribe"
        && input.turn_detection === null && JSON.stringify(session.output_modalities)==='["audio"]' && session.tool_choice==="auto" && session.parallel_tool_calls===false
        && tools.length === 1 && JSON.stringify(ordered(tools))===JSON.stringify(ordered(expected.tools)) };
  }
  if (type === "input_audio_buffer.committed") return { type, itemId: id(event.item_id), previousItemId: event.previous_item_id == null ? null : id(event.previous_item_id) };
  if (type === "conversation.item.input_audio_transcription.delta") return { type, itemId: id(event.item_id), delta: string(event.delta) };
  if (type === "conversation.item.input_audio_transcription.completed") return { type, itemId: id(event.item_id), transcript: string(event.transcript) };
  if (type === "conversation.item.input_audio_transcription.failed") return { type, itemId: id(event.item_id) };
  if (type === "response.created") {
    const response = object(event.response), metadata = response.metadata ? object(response.metadata) : {};
    return { type, responseId: id(response.id), turnId: metadata.aevoren_turn_id == null ? null : id(metadata.aevoren_turn_id) };
  }
  if (type === "response.function_call_arguments.delta") return { type, responseId: id(event.response_id), itemId: id(event.item_id), callId: id(event.call_id), delta: string(event.delta, REALTIME_MAX_ARGUMENTS) };
  if (type === "response.function_call_arguments.done") return { type, responseId: id(event.response_id), itemId: id(event.item_id), callId: id(event.call_id), name: string(event.name, 80), arguments: string(event.arguments, REALTIME_MAX_ARGUMENTS) };
  if (type === "response.done") {
    const response = object(event.response); if (!Array.isArray(response.output) || response.output.length > 16) invalid();
    const calls = response.output.flatMap(value => { const item = object(value); return item.type !== "function_call" ? [] : [{ itemId: id(item.id), callId: id(item.call_id),
      name: string(item.name, 80), arguments: string(item.arguments, REALTIME_MAX_ARGUMENTS), status: string(item.status, 40) }]; });
    return { type, responseId: id(response.id), status: string(response.status, 40), calls };
  }
  if (type === "response.output_audio.delta") return { type, responseId: id(event.response_id), itemId: id(event.item_id), contentIndex: integer(event.content_index, 0), pcm: decodeRealtimePcm(event.delta, 524_288) };
  if (type === "response.output_audio_transcript.delta" || type === "response.output_audio_transcript.done") return { type, responseId: id(event.response_id), itemId: id(event.item_id), text: string(type.endsWith(".done") ? event.transcript : event.delta) };
  if (type === "conversation.item.truncated") return { type, itemId: id(event.item_id), contentIndex: integer(event.content_index, 0), audioEndMs: integer(event.audio_end_ms, Math.floor(REALTIME_MAX_OUTPUT_SAMPLES * 1000 / REALTIME_SAMPLE_RATE)) };
  if (type === "error") return { type, clientEventId: event.error && object(event.error).event_id != null ? id(object(event.error).event_id) : null };
  return { type: "ignored" };
}

export function realtimeSessionUpdate(model: string, voice: string): WireObject {
  return { type: "session.update", session: { type: "realtime", model, output_modalities: ["audio"], audio: {
    input: { format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE }, transcription: { model: "gpt-transcribe" }, turn_detection: null },
    output: { format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE }, voice },
  }, tools: [{ type: "function", name: REALTIME_DELEGATE_NAME, description: "Delegate this human voice turn to the current Aevoren Bot Runtime. Arguments are untrusted audit hints and never permissions or the human request.",
    parameters: { type: "object", properties: { task: { type: "string", maxLength: 4_000 } }, required: ["task"], additionalProperties: false } }], tool_choice: "auto", parallel_tool_calls: false } };
}
