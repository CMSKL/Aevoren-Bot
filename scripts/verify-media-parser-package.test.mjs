import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { verifyMediaParserPackage } from "./verify-media-parser-package.mjs";

const require = createRequire(import.meta.url), asar = createRequire(require.resolve("app-builder-lib"))("@electron/asar");
async function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "aevoren-parser-package-check-")), resources = join(root, "resources"), source = join(root, "source");
  mkdirSync(resources); mkdirSync(source);
  const manifest = JSON.parse(readFileSync(resolve("out/media-parser/manifest.json")));
  cpSync(resolve("out/media-parser"), join(resources, "media-parser"), { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ version: manifest.applicationVersion }));
  await asar.createPackage(source, join(resources, "app.asar"));
  try { await callback({ resources, source }); } finally { rmSync(root, { recursive: true, force: true }); }
}
test("accepts a complete frozen parser resource fixture and exact font/license digests", () => fixture(async f => {
  assert.ok(verifyMediaParserPackage(f.resources).assets > 190);
}));
test("rejects an introduced QuickJS asset anywhere in extraResources", () => fixture(async f => {
  writeFileSync(join(f.resources, "quickjs-eval.wasm"), "fixture");
  assert.throws(() => verifyMediaParserPackage(f.resources), /Forbidden/);
}));
test("rejects a native canvas dependency inside the whole ASAR", () => fixture(async f => {
  const target = join(f.source, "node_modules/@napi-rs/canvas/index.js"); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, "fixture");
  await asar.createPackage(f.source, join(f.resources, "app.asar"));
  assert.throws(() => verifyMediaParserPackage(f.resources), /Forbidden/);
}));
test("rejects a substituted original GPL font even with its original filename", () => fixture(async f => {
  const original = join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts/LiberationSans-Regular.ttf");
  cpSync(original, join(f.resources, "media-parser/public/pdfjs/standard_fonts/LiberationSans-Regular.ttf"));
  assert.throws(() => verifyMediaParserPackage(f.resources), /Forbidden GPL/);
}));
test("rejects a changed embedded license", () => fixture(async f => {
  const target = join(f.resources, "media-parser/licenses/pdfjs-dist-LICENSE"); writeFileSync(target, "changed fixture license");
  assert.throws(() => verifyMediaParserPackage(f.resources), /digest mismatch/);
}));
