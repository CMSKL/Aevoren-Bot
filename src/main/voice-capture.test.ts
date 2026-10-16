import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { VoiceCaptureGate, type VoiceDocumentIdentity } from "./voice-capture";

const fixtures: { repository: AppRepository; gate: VoiceCaptureGate }[] = [];
function fixture() {
  const repository = new AppRepository(":memory:"), owner = repository.createBot();
  let now = 1_000, active = true, permission = true;
  let document: VoiceDocumentIdentity = { webContentsId: 1, processId: 2, routingId: 3, epoch: 1, url: "file:///app/out/renderer/index.html" };
  const publish = vi.fn(async (input: { bytes: Uint8Array }) => ({ mediaId: randomUUID(), sha256: createHash("sha256").update(input.bytes).digest("hex") }));
  const requestMicrophone = vi.fn(async () => permission);
  const gate = new VoiceCaptureGate(repository, { identity: () => document, hasUserActivation: async () => active, requestMicrophone,
    publish, now: () => now });
  fixtures.push({ repository, gate });
  const input = { sessionId: owner.session.id, draftVersion: 2, baseDigest: "a".repeat(64) };
  const details = { isMainFrame: true, requestingUrl: document.url, mediaType: "audio" };
  return { repository, owner, gate, input, details, publish, requestMicrophone, advance: (ms: number) => { now += ms; },
    deactivate: () => { active = false; }, deny: () => { permission = false; }, navigate: () => { document = { ...document, epoch: document.epoch + 1 }; } };
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.gate.shutdown(); f.repository.close(); } });

describe("explicit microphone capture gate", () => {
  it("allows only audio for the exact current main document after user intent", async () => {
    const f = fixture(); expect(f.gate.allows(1, "media", f.details)).toBe(false);
    const intent = await f.gate.begin(f.input);
    expect(f.gate.allows(1, "media", f.details)).toBe(true);
    expect(f.gate.allows(1, "media", { ...f.details, mediaType: undefined, mediaTypes: ["audio"] })).toBe(true);
    for (const details of [{ ...f.details, mediaType: "video" }, { ...f.details, mediaType: "unknown" },
      { ...f.details, isMainFrame: false }, { ...f.details, requestingUrl: "file:///other/index.html" },
      { ...f.details, requestingUrl: undefined }, { ...f.details, mediaTypes: ["audio", "video"] },
      { ...f.details, mediaTypes: [] }]) expect(f.gate.allows(1, "media", details)).toBe(false);
    expect(f.gate.allows(9, "media", f.details)).toBe(false); expect(f.gate.allows(null, "media", f.details)).toBe(false);
    expect(f.gate.allows(1, "display-capture", f.details)).toBe(false);
    f.gate.cancel({ sessionId: f.input.sessionId, captureId: intent.captureId });
    expect(f.gate.allows(1, "media", f.details)).toBe(false);
  });
  it("rejects stale documents, session generations and permission windows", async () => {
    const f = fixture(); await f.gate.begin(f.input); f.advance(30_001); expect(f.gate.allows(1, "media", f.details)).toBe(false);
    await f.gate.begin(f.input); f.navigate(); expect(f.gate.allows(1, "media", f.details)).toBe(false);
    await f.gate.begin(f.input); f.repository.clearConversation(f.input.sessionId); expect(f.gate.allows(1, "media", f.details)).toBe(false);
  });
  it("never asks the OS without activation and reports genuine OS denial", async () => {
    const f = fixture(); f.deactivate(); await expect(f.gate.begin(f.input)).rejects.toMatchObject({ code: "VOICE_CAPTURE_INVALID" });
    expect(f.requestMicrophone).not.toHaveBeenCalled();
    const other = fixture(); other.deny(); await expect(other.gate.begin(other.input)).rejects.toMatchObject({ code: "VOICE_PERMISSION_DENIED" });
    expect(other.gate.allows(1, "media", other.details)).toBe(false);
  });
  it("publishes one bounded recording with fixed origin and consumes that intent", async () => {
    const f = fixture(), intent = await f.gate.begin(f.input);
    const input = { ...f.input, captureId: intent.captureId, mimeType: "audio/webm;codecs=opus", dataBase64: Buffer.from("controlled unit bytes").toString("base64") };
    await expect(f.gate.commit({ ...input, draftVersion: 1 })).rejects.toMatchObject({ code: "VOICE_CAPTURE_INVALID" });
    await expect(f.gate.commit({ ...input, dataBase64: "invalid!" })).rejects.toMatchObject({ code: "VOICE_RESPONSE_INVALID" });
    await expect(f.gate.commit(input)).resolves.toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(f.publish).toHaveBeenCalledTimes(1); expect(f.publish.mock.calls[0]![0]).toMatchObject({ mimeType: "audio/webm" });
    await expect(f.gate.commit(input)).rejects.toMatchObject({ code: "VOICE_CAPTURE_INVALID" });
  });
  it("shutdown settles a pending OS prompt without waiting for a user to answer", async () => {
    const repository = new AppRepository(":memory:"), owner = repository.createBot(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new VoiceCaptureGate(repository, { identity: () => ({ webContentsId: 1, processId: 2, routingId: 3, epoch: 1, url: "file:///app" }),
      hasUserActivation: async () => true, requestMicrophone: () => { entered(); return new Promise<boolean>(() => {}); }, publish: async () => { throw new Error("not reached"); } });
    fixtures.push({ repository, gate });
    const pending = gate.begin({ sessionId: owner.session.id, baseDigest: "a".repeat(64), draftVersion: 0 });
    const rejected = expect(pending).rejects.toMatchObject({ code: "VOICE_CAPTURE_INVALID" });
    await started; await gate.shutdown(); await rejected;
  });
});
