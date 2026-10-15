import type { DemonstrationEvent } from "@shared/demonstration-contracts";
const keys: Record<number, Extract<DemonstrationEvent, { kind: "key" }>["key"]> = { 0xff0d: "Enter", 0xff09: "Tab", 0xff1b: "Escape", 0xff08: "Backspace", 0xffff: "Delete", 0xff51: "ArrowLeft", 0xff53: "ArrowRight", 0xff52: "ArrowUp", 0xff54: "ArrowDown", 0xff50: "Home", 0xff57: "End", 0xff55: "PageUp", 0xff56: "PageDown" };
/** Inspect only accepted client traffic. Text and clipboard bytes are consumed without retaining them. */
export class RfbDemonstrationParser {
  private buffer = Buffer.alloc(0);
  private phase: "version" | "security" | "init" | "messages" = "version";
  private skip = 0;
  private buttons = 0;
  failed = false;
  constructor(private readonly emit: (event: DemonstrationEvent) => void, private readonly unsupported: () => void) {}
  private fail(): void { this.failed = true; this.buffer = Buffer.alloc(0); this.unsupported(); }
  private text(): void { this.emit({ kind: "redacted-text" }); }
  accepted(bytes: Buffer): void {
    if (this.failed) return;
    let incoming = bytes;
    if (this.skip) { const consumed = Math.min(this.skip, incoming.length); this.skip -= consumed; incoming = incoming.subarray(consumed); if (!incoming.length) return; }
    if (incoming.length + this.buffer.length > 65536) { this.fail(); return; }
    this.buffer = Buffer.concat([this.buffer, incoming]);
    while (this.buffer.length && !this.failed) {
      if (this.phase === "version") {
        if (this.buffer.length < 12) return;
        const version = this.buffer.subarray(0, 12).toString("ascii");
        if (!["RFB 003.008\n", "RFB 003.007\n", "RFB 003.003\n"].includes(version)) { this.fail(); return; }
        this.buffer = this.buffer.subarray(12); this.phase = version === "RFB 003.003\n" ? "init" : "security"; continue;
      }
      if (this.phase === "security") { if (this.buffer[0] !== 1) { this.fail(); return; } this.buffer = this.buffer.subarray(1); this.phase = "init"; continue; }
      if (this.phase === "init") { if (this.buffer[0]! > 1) { this.fail(); return; } this.buffer = this.buffer.subarray(1); this.phase = "messages"; continue; }
      const type = this.buffer[0]; let length: number;
      if (type === 0) length = 20;
      else if (type === 2) { if (this.buffer.length < 4) return; const count = this.buffer.readUInt16BE(2); if (count > 1024) { this.fail(); return; } length = 4 + count * 4; }
      else if (type === 3) length = 10;
      else if (type === 4) length = 8;
      else if (type === 5) { if (this.buffer.length < 2) return; length = this.buffer[1]! & 0x80 ? 7 : 6; }
      else if (type === 6) {
        if (this.buffer.length < 8) return;
        const size = this.buffer.readInt32BE(4); const amount = Math.abs(size);
        if (amount > 1048576) { this.fail(); return; }
        this.text(); this.buffer = this.buffer.subarray(8);
        const consumed = Math.min(amount, this.buffer.length); this.buffer = this.buffer.subarray(consumed); this.skip = amount - consumed;
        if (this.skip) return; continue;
      }
      else if (type === 150) length = 10;
      else if (type === 248) { if (this.buffer.length < 9) return; if (this.buffer[8]! > 64) { this.fail(); return; } length = 9 + this.buffer[8]!; }
      else if (type === 251) { if (this.buffer.length < 8) return; if (this.buffer[6]! > 16) { this.fail(); return; } length = 8 + this.buffer[6]! * 16; }
      else if (type === 255 && this.buffer.length >= 2 && this.buffer[1] === 0) length = 12;
      else if (type === 255 && this.buffer.length < 2) return;
      else { this.fail(); return; }
      if (this.buffer.length < length) return;
      if (type === 4 || type === 255) {
        const key = keys[this.buffer.readUInt32BE(4)]; const down = type === 4 ? this.buffer[1] === 1 : this.buffer.readUInt16BE(2) === 1;
        if (key) { this.emit({ kind: "key", key, down }); }
        else this.text();
      }
      if (type === 5) { if (length === 7 && this.buffer[6]! > 3) { this.fail(); return; } const buttons = (this.buffer[1]! & 0x7f) | (length === 7 ? this.buffer[6]! << 7 : 0); if (buttons !== this.buttons) { this.emit({ kind: "pointer", x: this.buffer.readUInt16BE(2), y: this.buffer.readUInt16BE(4), buttons }); } this.buttons = buttons; }
      this.buffer = this.buffer.subarray(length);
    }
  }
}
