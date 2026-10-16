import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
import { inflateSync } from "node:zlib";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { build } from "vite";
import type { MediaParserAdapter } from "../../src/main/media-parser-types";
import type { SupportedMediaMime } from "../../src/shared/media-contracts";
import { cmapPdf, docxEntries, encryptedPdf, imagePdf, tinyPdf, zipFixture } from "../fixtures/media-parser-data";
import { removeTestDirectory } from "./test-cleanup";

type ParserGlobals = typeof globalThis & { mediaParserReady: Promise<void>; mediaParserHost: MediaParserAdapter };
let directory: string, modulePath: string;
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "aevoren-parser-tests-"));
  await build({ configFile: false, resolve: { alias: { "@shared": resolve("src/shared") } }, ssr: { noExternal: true }, build: {
    target: "node24", ssr: true, minify: false, outDir: directory,
    rollupOptions: { input: resolve("src/main/media-parser-host.ts"), external: ["electron", ...builtinModules, ...builtinModules.map(name => `node:${name}`)], output: { format: "cjs", entryFileNames: "host.cjs", inlineDynamicImports: true } },
  } });
  modulePath = join(directory, "host.cjs");
});
test.afterAll(() => { if (directory) removeTestDirectory(directory); });
async function withParser(callback: (application: ElectronApplication) => Promise<void>, assets = resolve("out/media-parser")): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), "aevoren-parser-profile-"));
  const application = await electron.launch({ args: [resolve("tests/fixtures/media-parser-host.mjs"), `--user-data-dir=${data}`], cwd: process.cwd(), env: {
    ...process.env, AEVOREN_PARSER_TEST_MODULE: modulePath, AEVOREN_PARSER_TEST_ASSETS: assets,
  } });
  try { await application.evaluate(async () => { await (globalThis as ParserGlobals).mediaParserReady; }); await callback(application);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally { await application.evaluate(async () => { await (globalThis as ParserGlobals).mediaParserHost?.shutdown(); }).catch(() => {}); await application.close(); removeTestDirectory(data); }
}
async function parse(application: ElectronApplication, bytes: Uint8Array, mimeType: SupportedMediaMime): Promise<{ ok: boolean; code?: string; result?: Awaited<ReturnType<MediaParserAdapter["parse"]>> }> {
  return application.evaluate(async (_electron, input) => {
    try { return { ok: true, result: await (globalThis as ParserGlobals).mediaParserHost.parse({ ...input, bytes: new Uint8Array(input.bytes) }, new AbortController().signal) }; }
    catch (error) { return { ok: false, code: (error as { code?: string }).code ?? (error as Error).name }; }
  }, { bytes: [...bytes], sha256: createHash("sha256").update(bytes).digest("hex"), mimeType });
}
const pdf = "application/pdf", docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** Independent byte-only reference decoder for the bounded Canvas PNG fixtures. */
function pngPixels(bytes: number[]): { pixels: Uint8Array; width: number; height: number; channels: number } {
  const input = Buffer.from(bytes), width = input.readUInt32BE(16), height = input.readUInt32BE(20), channels = input[25] === 6 ? 4 : 3;
  expect(input[24]).toBe(8); expect([2, 6]).toContain(input[25]);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= input.length;) { const size = input.readUInt32BE(offset); if (input.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(input.subarray(offset + 8, offset + 8 + size)); offset += size + 12; }
  const stride = width * channels, scanlines = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height }), pixels = new Uint8Array(stride * height);
  const paeth = (a: number, b: number, c: number): number => { const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c); return x <= y && x <= z ? a : y <= z ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = scanlines[y * (stride + 1)]!; expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, left = x >= channels ? pixels[i - channels]! : 0, up = y ? pixels[i - stride]! : 0, corner = y && x >= channels ? pixels[i - stride - channels]! : 0;
      pixels[i] = (scanlines[y * (stride + 1) + 1 + x]! + (filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, corner) : 0)) & 255;
    }
  }
  return { pixels, width, height, channels };
}
async function preview(application: ElectronApplication, bytes: Uint8Array): Promise<{ bytes: number[]; width: number; height: number; mimeType: "image/png" | "image/jpeg" }> {
  return application.evaluate(async (_electron, input) => {
    const value = await (globalThis as ParserGlobals).mediaParserHost.renderPdfPage({ bytes: new Uint8Array(input.bytes), sha256: input.sha256, mimeType: "application/pdf", pageIndex: 0 }, new AbortController().signal);
    return { ...value, bytes: [...value.bytes] };
  }, { bytes: [...bytes], sha256: createHash("sha256").update(bytes).digest("hex") });
}
function adversarialAssets(script: string): string {
  const target = mkdtempSync(join(directory, "probe-")); cpSync(resolve("out/media-parser"), target, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
  const html = Buffer.from('<!doctype html><meta charset="utf-8"><script type="module" src="./probe.js"></script>');
  writeFileSync(join(target, "public/index.html"), html); writeFileSync(join(target, "public/probe.js"), script);
  const entry = manifest.files.find((file: { path: string }) => file.path === "public/index.html"); entry.size = html.length; entry.sha256 = createHash("sha256").update(html).digest("hex");
  manifest.files.push({ path: "public/probe.js", route: "probe.js", mimeType: "text/javascript", size: Buffer.byteLength(script), sha256: createHash("sha256").update(script).digest("hex") });
  writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest)); return target;
}

test("production hidden parser extracts every physical PDF page and returns actual bounded preview pixels", async () => {
  await withParser(async application => {
    const bytes = tinyPdf(["Parser actual text", "", "Third page"]);
    const parsed = await parse(application, bytes, pdf);
    expect(parsed, JSON.stringify(parsed)).toMatchObject({ ok: true }); expect(parsed.result?.extraction?.text).toContain("Parser actual text");
    expect(parsed.result?.extraction?.spans.map(span => [span.kind, span.index])).toEqual([["page", 0], ["page", 1], ["page", 2]]);
    const blank = parsed.result!.extraction!.spans[1]!; expect(blank.start).toBe(blank.end);
    const preview = await application.evaluate(async (_electron, input) => {
      const rendered = await (globalThis as ParserGlobals).mediaParserHost.renderPdfPage({ bytes: new Uint8Array(input.bytes), sha256: input.sha256, mimeType: "application/pdf", pageIndex: 0 }, new AbortController().signal);
      return { ...rendered, bytes: [...rendered.bytes] };
    }, { bytes: [...bytes], sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(preview.width).toBeGreaterThan(100); expect(preview.height).toBeGreaterThan(100); expect(preview.bytes.length).toBeGreaterThan(100);
    expect(preview.bytes.length).toBeLessThanOrEqual(2_097_152);
    const rendered = pngPixels(preview.bytes); let darkPixels = 0;
    for (let index = 0; index < rendered.pixels.length; index += rendered.channels) if (rendered.pixels[index]! < 100 && rendered.pixels[index + 1]! < 100 && rendered.pixels[index + 2]! < 100) darkPixels += 1;
    expect(darkPixels).toBeGreaterThan(100);
    const checked = await parse(application, Uint8Array.from(preview.bytes), preview.mimeType); expect(checked.ok).toBe(true); expect(checked.result?.width).toBe(preview.width);
    const manifest = JSON.parse(readFileSync(resolve("out/media-parser/manifest.json"), "utf8"));
    expect(manifest.files.some((file: { path: string }) => /quickjs|sandbox|LICENSE_LIBERATION/u.test(file.path))).toBe(false);
  });
});
test("real DOCX stored/deflated and UTF16 text normalize before Mammoth; CRC, DTD, paths and ZIP budgets fail closed", async () => {
  await withParser(async application => {
    const entries = docxEntries("Actual DOCX 中文");
    expect((await parse(application, zipFixture(entries), docx)).result?.extraction?.text).toContain("Actual DOCX 中文");
    expect((await parse(application, zipFixture(entries.map(entry => ({ ...entry, deflate: true }))), docx)).result?.extraction?.text).toContain("Actual DOCX 中文");
    const utf16 = entries.map(entry => entry.name !== "word/document.xml" ? entry : { ...entry, bytes: Buffer.concat([Buffer.from([255, 254]), Buffer.from(`<?xml version="1.0" encoding="UTF-16"?>${Buffer.from(entry.bytes).toString()}`, "utf16le")]) });
    expect((await parse(application, zipFixture(utf16), docx)).result?.extraction?.text).toContain("Actual DOCX 中文");
    const corrupt = entries.map(entry => ({ ...entry, corruptCrc: true })); expect((await parse(application, zipFixture(corrupt), docx)).ok).toBe(false);
    const forgedTypes = entries.map(entry => entry.name !== "[Content_Types].xml" ? entry : { ...entry, bytes: Buffer.from(Buffer.from(entry.bytes).toString().replace("http://schemas.openxmlformats.org/package/2006/content-types", "urn:forged-content-types")) });
    expect((await parse(application, zipFixture(forgedTypes), docx)).code).toBe("MEDIA_CONTENT_INVALID");
    const dtd = entries.map(entry => entry.name !== "word/document.xml" ? entry : { ...entry, bytes: Buffer.from('<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///not-a-real-user-file">]><x>&leak;</x>') });
    expect((await parse(application, zipFixture(dtd), docx)).code).toBe("MEDIA_CONTENT_INVALID");
    expect((await parse(application, zipFixture([...entries, { name: "../escape.xml", bytes: Buffer.from("x") }]), docx)).ok).toBe(false);
    expect((await parse(application, zipFixture(entries.map(entry => ({ ...entry, declaredSize: 20_000_000 }))), docx)).code).toBe("MEDIA_IMPORT_TOO_LARGE");
  });
});
test("six parser jobs are independent; cancelling one does not cancel siblings and shutdown leaves no windows", async () => {
  await withParser(async application => {
    const bytes = tinyPdf(["Parallel parser"]), hash = createHash("sha256").update(bytes).digest("hex");
    const results = await application.evaluate(async (_electron, input) => {
      const host = (globalThis as ParserGlobals).mediaParserHost, controllers = Array.from({ length: 6 }, () => new AbortController());
      const jobs = controllers.map(async controller => { try { return { ok: true, result: await host.parse({ bytes: new Uint8Array(input.bytes), sha256: input.hash, mimeType: "application/pdf" }, controller.signal) }; } catch (error) { return { ok: false, error: (error as Error).name }; } });
      controllers[2]!.abort(); return Promise.all(jobs);
    }, { bytes: [...bytes], hash });
    expect(results.filter(result => result.ok)).toHaveLength(5); expect(results[2]?.ok).toBe(false);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  });
});
test("CMap, CMYK and JPEG2000 use the real isolated decoder; JPEG and encrypted/budget failures are explicit", async () => {
  await withParser(async application => {
    expect((await parse(application, cmapPdf(), pdf)).result?.extraction?.text).toContain("日本");
    const cmyk = Uint8Array.from(Array.from({ length: 16 }, () => [0, 255, 255, 0]).flat());
    for (const bytes of [imagePdf(cmyk, "DeviceCMYK"), imagePdf(readFileSync(resolve("tests/fixtures/media-parser/red.jp2")), "DeviceRGB", "JPXDecode")]) {
      const image = await preview(application, bytes); expect(image.bytes.length).toBeGreaterThan(100);
      const rendered = pngPixels(image.bytes), center = (Math.floor(rendered.height / 2) * rendered.width + Math.floor(rendered.width / 2)) * rendered.channels;
      expect(rendered.pixels[center]).toBeGreaterThan(180); expect(rendered.pixels[center + 1]).toBeLessThan(100); expect(rendered.pixels[center + 2]).toBeLessThan(100);
      expect((await parse(application, Uint8Array.from(image.bytes), image.mimeType)).ok).toBe(true);
    }
    const jpeg = await parse(application, readFileSync(resolve("tests/fixtures/media-parser/red.jpg")), "image/jpeg");
    expect(jpeg.result).toMatchObject({ kind: "image", width: 4, height: 4, extraction: null });
    expect((await parse(application, encryptedPdf(), pdf)).code).toBe("MEDIA_ENCRYPTED");
    expect((await parse(application, tinyPdf(Array.from({ length: 201 }, () => "")), pdf)).code).toBe("MEDIA_IMPORT_TOO_LARGE");
    expect((await parse(application, zipFixture(docxEntries("x".repeat(524_289))), docx)).code).toBe("MEDIA_IMPORT_TOO_LARGE");
    expect((await parse(application, zipFixture(docxEntries("encrypted").map(entry => ({ ...entry, flags: 0x801 }))), docx)).code).toBe("MEDIA_ENCRYPTED");
  });
});
test("adversarial sandbox cannot read private assets/local/network or primary APIs; forged digest fails Main", async () => {
  let requests = 0; const server = createServer((_request, response) => { requests += 1; response.end("controlled fixture"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const script = `let complete;globalThis.probeReady=new Promise(r=>complete=r);window.mediaParser.onInput(async input=>{
    const blocked=[];for(const url of ['/manifest.json','/private/preload.cjs','file:///not-a-real-user-file','http://127.0.0.1:${port}/trap']){try{const r=await fetch(url);blocked.push(!r.ok);}catch{blocked.push(true);}}
    globalThis.release=()=>window.mediaParser.reply({type:'error',nonce:input.nonce,sha256:'0'.repeat(64),code:'MEDIA_PARSE_FAILED'});
    complete({blocked,node:typeof window.require,process:typeof window.process,primary:typeof window.aevorenBot,popup:window.open('http://127.0.0.1:${port}/popup')===null});
  });window.mediaParser.ready(location.hostname);`;
  try { await withParser(async application => {
    const report = await application.evaluate(async ({ app }, input) => {
      const state = globalThis as ParserGlobals & { pendingProbe?: Promise<string>; probeWindow?: Electron.BrowserWindow };
      const observed = new Promise<unknown>((resolve, reject) => app.once("browser-window-created", (_event, window) => {
        state.probeWindow = window;
        window.webContents.once("did-finish-load", () => {
          // Test-only inspection of the Electron44 binding; product policy uses constructor options.
          const preferences = (window.webContents as unknown as { getLastWebPreferences(): { sandbox: boolean; contextIsolation: boolean } }).getLastWebPreferences();
          void window.webContents.executeJavaScript("globalThis.probeReady").then(renderer => resolve({ renderer, hidden: !window.isVisible(), sandbox: preferences.sandbox, isolated: preferences.contextIsolation, backgroundThrottling: window.webContents.getBackgroundThrottling(), persistent: window.webContents.session.isPersistent() }), reject);
        });
      }));
      state.pendingProbe = state.mediaParserHost.parse({ ...input, bytes: new Uint8Array(input.bytes) }, new AbortController().signal).then(() => "unexpected-success", error => error.code ?? error.name);
      return observed;
    }, { bytes: [...tinyPdf(["guard probe"])], sha256: createHash("sha256").update(tinyPdf(["guard probe"])).digest("hex"), mimeType: pdf as SupportedMediaMime });
    expect(report).toMatchObject({ hidden: true, sandbox: true, isolated: true, backgroundThrottling: false, persistent: false, renderer: { blocked: [true, true, true, true], node: "undefined", process: "undefined", primary: "undefined", popup: true } });
    const rejected = await application.evaluate(async () => {
      const state = globalThis as ParserGlobals & { pendingProbe: Promise<string>; probeWindow: Electron.BrowserWindow };
      await state.probeWindow.webContents.executeJavaScript("globalThis.release()"); return state.pendingProbe;
    });
    expect(rejected).toBe("MEDIA_CONTENT_INVALID"); expect(requests).toBe(0);
  }, adversarialAssets(script)); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("nonresponding owned sandbox hits the real 30 second deadline and is destroyed without publishing", async () => {
  test.setTimeout(45_000);
  const assets = adversarialAssets("window.mediaParser.onInput(()=>{});window.mediaParser.ready(location.hostname);");
  await withParser(async application => {
    const started = Date.now(), result = await parse(application, tinyPdf(["deadline"]), pdf);
    expect(result).toEqual({ ok: false, code: "MEDIA_PARSE_TIMEOUT" }); expect(Date.now() - started).toBeGreaterThanOrEqual(29_000);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  }, assets);
});
