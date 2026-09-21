import { readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";

// ICO permits PNG-compressed entries. Reuse the approved product PNG exactly
// so the Windows installer does not introduce a second visual identity.
const source = readFileSync(resolve("resources/icon.png"));
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // icon type
header.writeUInt16LE(1, 4); // one PNG entry
header.writeUInt8(0, 6); // 256px (0 means 256)
header.writeUInt8(0, 7);
header.writeUInt8(0, 8); // palette
header.writeUInt8(0, 9);
header.writeUInt16LE(1, 10); // color planes
header.writeUInt16LE(32, 12);
header.writeUInt32LE(source.length, 14);
header.writeUInt32LE(22, 18);
writeFileSync(resolve("resources/icon.ico"), Buffer.concat([header, source]));
