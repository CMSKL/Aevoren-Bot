import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

/** Deterministic self-authored PDF bytes; no third-party documents or user data. */
export function pdfObjects(objects: (string | Uint8Array)[], trailer = ""): Uint8Array {
  let output = Buffer.from("%PDF-1.7\n"); const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(output.length); output = Buffer.concat([output, Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from("\nendobj\n")]); }
  const start = output.length;
  return Buffer.concat([output, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${start}\n%%EOF\n`)]);
}
export function tinyPdf(pages: string[]): Uint8Array {
  const font = pages.length * 2 + 3;
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] >>`];
  for (const [index, text] of pages.entries()) {
    const content = text ? `BT /F1 24 Tf 30 100 Td (${text.replaceAll(/[\\()]/gu, value => `\\${value}`)}) Tj ET` : "q Q";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  return pdfObjects(objects);
}
function crc32(bytes: Uint8Array): number { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
export type ZipFixtureEntry = { name: string; bytes: Uint8Array; deflate?: boolean; declaredSize?: number; corruptCrc?: boolean; flags?: number; attributes?: number };
export function zipFixture(entries: ZipFixtureEntry[]): Uint8Array {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), payload = entry.deflate ? deflateRawSync(entry.bytes) : Buffer.from(entry.bytes);
    const header = Buffer.alloc(30), directory = Buffer.alloc(46), checksum = crc32(entry.bytes) ^ (entry.corruptCrc ? 1 : 0);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(entry.flags ?? 0x800, 6); header.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    header.writeUInt32LE(checksum >>> 0, 14); header.writeUInt32LE(payload.length, 18); header.writeUInt32LE(entry.declaredSize ?? entry.bytes.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(entry.flags ?? 0x800, 8); directory.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    directory.writeUInt32LE(checksum >>> 0, 16); directory.writeUInt32LE(payload.length, 20); directory.writeUInt32LE(entry.declaredSize ?? entry.bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(entry.attributes ?? 0, 38); directory.writeUInt32LE(offset, 42);
    locals.push(header, name, payload); central.push(directory, name); offset += header.length + name.length + payload.length;
  }
  const directories = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directories.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directories, end]);
}
export function docxEntries(text: string): ZipFixtureEntry[] {
  const encoded = (value: string): Uint8Array => Buffer.from(value);
  return [
    { name: "[Content_Types].xml", bytes: encoded('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: "_rels/.rels", bytes: encoded('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: "word/document.xml", bytes: encoded(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</w:t></w:r></w:p></w:body></w:document>`) },
  ];
}
export async function tinyDocx(text: string): Promise<Uint8Array> { return zipFixture(docxEntries(text)); }

export function cmapPdf(): Uint8Array {
  const content = "BT /F1 24 Tf 30 100 Td <65e5672c> Tj ET";
  return pdfObjects([
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UTF16-H /DescendantFonts [5 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 6 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /HeiseiMin-W3 /Flags 6 /FontBBox [-123 -257 1001 910] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}
export function imagePdf(bytes: Uint8Array, colorSpace: "DeviceRGB" | "DeviceCMYK", filter = ""): Uint8Array {
  const content = "q 300 0 0 200 0 0 cm /Im1 Do Q";
  return pdfObjects(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /${colorSpace} /BitsPerComponent 8 ${filter ? `/Filter /${filter}` : ""} /Length ${bytes.length} >>\nstream\n`), Buffer.from(bytes), Buffer.from("\nendstream")]),
  ]);
}
function rc4(key: Uint8Array, bytes: Uint8Array): Uint8Array {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index); let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i]! + key[i % key.length]!) & 255; [state[i], state[j]] = [state[j]!, state[i]!]; }
  let i = 0; j = 0;
  return bytes.map(byte => { i = (i + 1) & 255; j = (j + state[i]!) & 255; [state[i], state[j]] = [state[j]!, state[i]!]; return byte ^ state[(state[i]! + state[j]!) & 255]!; });
}
export function encryptedPdf(): Uint8Array {
  const padding = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
  const pad = (value: string): Buffer => Buffer.concat([Buffer.from(value), padding]).subarray(0, 32);
  const md5 = (bytes: Uint8Array): Buffer => createHash("md5").update(bytes).digest();
  const id = md5(Buffer.from("self-authored-encrypted-parser-fixture")), owner = rc4(md5(pad("fixture-owner")).subarray(0, 5), pad("fixture-password"));
  const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
  const key = md5(Buffer.concat([pad("fixture-password"), owner, permissions, id])).subarray(0, 5), user = rc4(key, padding);
  const stream = rc4(md5(Buffer.concat([key, Buffer.from([4, 0, 0, 0, 0])])).subarray(0, 10), Buffer.from("BT /F1 12 Tf (Secret fixture) Tj ET"));
  return pdfObjects(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${Buffer.from(owner).toString("hex")}> /U <${Buffer.from(user).toString("hex")}> /P -4 >>`,
  ], `/Encrypt 6 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>]`);
}
