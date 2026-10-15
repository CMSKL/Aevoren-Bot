import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { build } from "vite";
import type { MediaParserAdapter } from "../../src/main/media-parser-types";
import type { SupportedMediaMime } from "../../src/shared/media-contracts";
import { recording } from "../fixtures/media-av-encoding";
import { wavFixture } from "../fixtures/media-av-data";
import { removeTestDirectory } from "./test-cleanup";

// This private adapter harness is source-only; media-av-ui verifies the real packaged parser.
test.skip(Boolean(process.env.AEVOREN_PACKAGED_APP_PATH), "Source-only parser harness; packaged playback is tested by media-av-ui.spec.ts");

type ParserGlobals = typeof globalThis & { mediaParserReady: Promise<void>; mediaParserHost: MediaParserAdapter };
let directory: string, modulePath: string;
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "aevoren-av-parser-tests-"));
  await build({ configFile: false, resolve: { alias: { "@shared": resolve("src/shared") } }, ssr: { noExternal: true }, build: {
    target: "node24", ssr: true, minify: false, outDir: directory,
    rollupOptions: { input: resolve("src/main/media-parser-host.ts"), external: ["electron", ...builtinModules, ...builtinModules.map(name => `node:${name}`)], output: { format: "cjs", entryFileNames: "host.cjs", inlineDynamicImports: true } },
  } }); modulePath = join(directory, "host.cjs");
});
test.afterAll(() => { if (directory) removeTestDirectory(directory); });
async function withParser(callback: (application: ElectronApplication) => Promise<void>): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), "aevoren-av-profile-"));
  const application = await electron.launch({ args: [resolve("tests/fixtures/media-parser-host.mjs"), `--user-data-dir=${data}`], cwd: process.cwd(), env: {
    ...process.env, AEVOREN_PARSER_TEST_MODULE: modulePath, AEVOREN_PARSER_TEST_ASSETS: resolve("out/media-parser"),
  } });
  try { await application.evaluate(async () => { await (globalThis as ParserGlobals).mediaParserReady; }); await callback(application);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally { await application.evaluate(async () => { await (globalThis as ParserGlobals).mediaParserHost?.shutdown(); }).catch(() => {}); await application.close(); removeTestDirectory(data); }
}
async function parse(application: ElectronApplication, bytes: Uint8Array, mimeType: SupportedMediaMime) {
  return application.evaluate(async (_electron, input) => {
    try { return { ok: true, result: await (globalThis as ParserGlobals).mediaParserHost.parse({ mimeType: input.mimeType, sha256: input.sha256, bytes: new Uint8Array(Buffer.from(input.dataBase64, "base64")) }, new AbortController().signal) }; }
    catch (error) { return { ok: false, code: (error as { code?: string }).code ?? (error as Error).name }; }
  }, { dataBase64: Buffer.from(bytes).toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), mimeType });
}

test("hidden production parser decodes actual WAV and bounds duration, size and unsupported codec", async () => {
  await withParser(async application => {
    expect(await parse(application, wavFixture(), "audio/wav")).toMatchObject({ ok: true, result: { kind: "audio", width: null, height: null, durationMs: 250, extraction: null } });
    expect(await parse(application, wavFixture(250, 65535), "audio/wav")).toMatchObject({ ok: false, code: "MEDIA_CODEC_UNSUPPORTED" });
    expect(await parse(application, wavFixture(600_001), "audio/wav")).toMatchObject({ ok: false, code: "MEDIA_IMPORT_TOO_LARGE" });
    expect(await parse(application, wavFixture().subarray(0, 100), "audio/wav")).toMatchObject({ ok: false, code: "MEDIA_CONTENT_INVALID" });
  });
});
test("own MediaRecorder WebM audio/video track identity and missing Duration use the actual isolated decoder", async () => {
  await withParser(async application => {
    const audio = await recording(application, false), video = await recording(application, true);
    for (const [bytes, kind] of [[audio, "audio"], [video, "video"]] as const) {
      const value = await parse(application, bytes, "video/webm");
      expect(value).toMatchObject({ ok: true, result: { kind, extraction: null } });
      expect(value.result!.durationMs).toBeGreaterThan(100); expect(value.result!.durationMs).toBeLessThan(2_000);
      if (kind === "video") expect(value.result).toMatchObject({ width: 32, height: 24 });
    }
  });
});
test("six actual WAV jobs run independently and cancellation settles without retaining windows", async () => {
  await withParser(async application => {
    const bytes = wavFixture(), hash = createHash("sha256").update(bytes).digest("hex");
    const results = await application.evaluate(async (_electron, input) => {
      const controllers = Array.from({ length: 6 }, () => new AbortController());
      const jobs = controllers.map(async controller => { try { await (globalThis as ParserGlobals).mediaParserHost.parse({ bytes: new Uint8Array(input.bytes), sha256: input.hash, mimeType: "audio/wav" }, controller.signal); return true; } catch { return false; } });
      controllers[2]!.abort(); return Promise.all(jobs);
    }, { bytes: [...bytes], hash });
    expect(results).toEqual([true, true, false, true, true, true]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  });
});
