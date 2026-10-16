import { describe, expect, it } from "vitest";
import { mediaReadSchema, mediaTextSchema, messageMediaReferencesSchema } from "./media-schemas";
import { roomSendCommandSchema, sendCommandSchema } from "./schemas";

const reference = () => ({ mediaId: crypto.randomUUID(), sha256: "a".repeat(64), extraction: { id: crypto.randomUUID(), digest: "b".repeat(64) } });
describe("fixed media message contracts", () => {
  it("accepts pure-media private and six-member Room messages while rejecting entirely empty input", () => {
    const command = { sessionId: crypto.randomUUID(), clientNonce: crypto.randomUUID(), text: "", mediaRefs: [reference()] };
    expect(sendCommandSchema.parse(command).mediaRefs).toEqual(command.mediaRefs);
    expect(roomSendCommandSchema.parse({ ...command, roomId: crypto.randomUUID(), routingMode: "everyone", targetBotIds: Array.from({ length: 6 }, () => crypto.randomUUID()) }).text).toBe("");
    expect(sendCommandSchema.safeParse({ ...command, mediaRefs: [] }).success).toBe(false);
  });
  it("rejects partial extraction pairs, duplicate IDs and cross-media read references", () => {
    const selected = reference();
    expect(messageMediaReferencesSchema.safeParse([{ ...selected, extraction: { id: selected.extraction.id } }]).success).toBe(false);
    expect(messageMediaReferencesSchema.safeParse([selected, { ...selected, sha256: "c".repeat(64) }]).success).toBe(false);
    expect(mediaReadSchema.safeParse({ sessionId: crypto.randomUUID(), id: crypto.randomUUID(), reference: selected }).success).toBe(false);
    expect(mediaReadSchema.safeParse({ sessionId: crypto.randomUUID(), id: selected.mediaId, reference: selected, maxCharacters: 32_001 }).success).toBe(false);
  });
  it("enforces actual UTF-8 byte size and rejects malformed Unicode without rewriting extraction text", () => {
    expect(mediaTextSchema.parse("资料\n🙂")).toBe("资料\n🙂");
    expect(mediaTextSchema.safeParse("中".repeat(180_000)).success).toBe(false);
    expect(mediaTextSchema.safeParse("\ud800").success).toBe(false);
  });
});
