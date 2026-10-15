import { describe, expect, it } from "vitest";
import type { DemonstrationEvent } from "@shared/demonstration-contracts";
import { RfbDemonstrationParser } from "./rfb-demonstration-parser";
function key(sym: number, down = true): Buffer { const b = Buffer.alloc(8); b[0] = 4; b[1] = Number(down); b.writeUInt32BE(sym, 4); return b; }
function pointer(buttons: number, x: number, y: number): Buffer { const b = Buffer.alloc(6); b[0] = 5; b[1] = buttons; b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4); return b; }
function fixture() { const events: DemonstrationEvent[] = []; let failed = 0; const parser = new RfbDemonstrationParser(event => events.push(event), () => failed++); return { events, parser, failed: () => failed }; }
describe("accepted RFB input sanitization", () => {
  it("parses fragmented handshake and messages, excludes motion and every printable keysym", () => {
    const f = fixture(); const wire = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1]), pointer(0, 10, 20), pointer(1, 11, 22), pointer(1, 12, 25), pointer(0, 12, 25), key(0x73), key(0x0101f511), key(0xff0d), key(0xff0d, false)]);
    for (const byte of wire) f.parser.accepted(Buffer.from([byte]));
    expect(f.failed()).toBe(0); expect(f.events).toEqual([{ kind: "pointer", x: 11, y: 22, buttons: 1 }, { kind: "pointer", x: 12, y: 25, buttons: 0 }, { kind: "redacted-text" }, { kind: "redacted-text" }, { kind: "key", key: "Enter", down: true }, { kind: "key", key: "Enter", down: false }]);
    expect(JSON.stringify(f.events)).not.toContain("128273");
  });
  it("streams clipboard payload without retaining content and resumes after large fragments", () => {
    const f = fixture(); f.parser.accepted(Buffer.concat([Buffer.from("RFB 003.003\n"), Buffer.from([1])]));
    const text = Buffer.from("https://user:secret@example.test/private?token=SECRET".repeat(3000)), header = Buffer.alloc(8); header[0] = 6; header.writeInt32BE(text.length, 4);
    f.parser.accepted(header); for (let i = 0; i < text.length; i += 60000) f.parser.accepted(text.subarray(i, i + 60000)); f.parser.accepted(pointer(8, 400, 300));
    expect(f.events).toEqual([{ kind: "redacted-text" }, { kind: "pointer", buttons: 8, x: 400, y: 300 }]); expect(f.failed()).toBe(0); expect(JSON.stringify(f.events)).not.toMatch(/SECRET|secret|example/);
  });
  it("supports bounded noVNC setup, fence and extended keyboard messages", () => {
    const f = fixture(); f.parser.accepted(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])]));
    const enc = Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]); const fence = Buffer.alloc(9); fence[0] = 248; const extended = Buffer.alloc(12); extended[0] = 255; extended.writeUInt16BE(1, 2); extended.writeUInt32BE(0xff09, 4);
    f.parser.accepted(Buffer.concat([Buffer.alloc(20), enc, fence, extended, Buffer.from([5, 0x80, 0, 40, 0, 30, 2])])); expect(f.events).toEqual([{ kind: "key", key: "Tab", down: true }, { kind: "pointer", x: 40, y: 30, buttons: 256 }]); expect(f.failed()).toBe(0);
  });
  it("seals unsupported or oversized input instead of guessing framing", () => {
    const f = fixture(); f.parser.accepted(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1, 90])])); f.parser.accepted(pointer(1, 0, 0)); expect(f.failed()).toBe(1); expect(f.events).toEqual([]);
    const other = fixture(); other.parser.accepted(Buffer.alloc(65537)); expect(other.failed()).toBe(1);
  });
});
