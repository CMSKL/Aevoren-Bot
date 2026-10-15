import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const asar = createRequire(require.resolve("app-builder-lib"))("@electron/asar");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const oldFontHashes = new Set([
  "361c61b82d575c5c35fd9157fda8b0194bcfcd0d88ea8521a4fb5dd53d33dddc", "a224075ac17495ad0a3af3bc0a419ac0704a8b3fd1095456201fb9b095fc281d",
  "832b4406dbef23628800d3aaad21048534ac84d7e3ad955be83b8172ed8ef512", "f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f",
]);
const forbidden = /(?:^|\/)node_modules\/(?:pdfjs-dist|mammoth|@zip\.js\/zip\.js|@napi-rs\/canvas[^/]*)(?:\/|$)|(?:^|\/)(?:pdf\.sandbox(?:\.min)?\.mjs|quickjs-eval\.(?:js|wasm)|LICENSE_LIBERATION|(?:skia|canvas)[^/]*\.node)$/iu;

/** Verifies a real installed resource tree against this build's immutable parser manifest. */
export function verifyMediaParserPackage(target, expectedManifestPath = resolve("out/media-parser/manifest.json")) {
  let resources = resolve(target);
  if (resources.endsWith(".app")) resources = join(resources, "Contents/Resources");
  resources = realpathSync(resources);
  const archive = join(resources, "app.asar"), parserRoot = join(resources, "media-parser");
  const expectedBytes = readFileSync(expectedManifestPath), actualBytes = readFileSync(join(parserRoot, "manifest.json"));
  if (!actualBytes.equals(expectedBytes)) throw new Error("Installed parser manifest differs from the frozen source build");
  const manifest = JSON.parse(actualBytes);
  if (manifest.protocolVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("Invalid parser manifest");
  const packageJson = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  if (packageJson.version !== manifest.applicationVersion) throw new Error("Installed application/parser versions differ");
  let resourceFiles = 0, asarFiles = 0;
  const seen = new Set(["manifest.json"]);
  const checkForbidden = (path, bytes) => {
    if (forbidden.test(path)) throw new Error(`Forbidden parser/native asset: ${path}`);
    if (path.toLowerCase().endsWith(".ttf") && oldFontHashes.has(hash(bytes))) throw new Error(`Forbidden GPL Liberation font bytes: ${path}`);
  };
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), relative = path.slice(resources.length + 1).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Unexpected resource symlink: ${relative}`);
      if (entry.isDirectory()) { scan(path); continue; }
      resourceFiles += 1; checkForbidden(relative, relative.toLowerCase().endsWith(".ttf") ? readFileSync(path) : new Uint8Array());
    }
  }
  scan(resources);
  for (const path of asar.listPackage(archive)) {
    const normalized = path.replaceAll("\\", "/").replace(/^\/+/, ""), stat = asar.statFile(archive, normalized);
    checkForbidden(normalized, normalized.toLowerCase().endsWith(".ttf") ? asar.extractFile(archive, normalized) : new Uint8Array());
    if (stat.link) checkForbidden(stat.link.replaceAll("\\", "/"), new Uint8Array());
    if (!stat.files) asarFiles += 1;
  }
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || file.path.split("/").some(part => !part || part === "." || part === "..") || seen.has(file.path)) throw new Error("Invalid or duplicate parser asset path");
    seen.add(file.path);
    const path = join(parserRoot, file.path), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || hash(readFileSync(path)) !== file.sha256) throw new Error(`Installed parser asset digest mismatch: ${file.path}`);
  }
  function checkInventory(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) checkInventory(path);
      else if (!seen.has(path.slice(parserRoot.length + 1).split(sep).join("/"))) throw new Error("Undeclared file in installed parser resources");
    }
  }
  checkInventory(parserRoot);
  const preload = readFileSync(join(parserRoot, manifest.preload), "utf8");
  for (const call of preload.matchAll(/\brequire\(["']([^"']+)["']\)/gu)) if (call[1] !== "electron") throw new Error("Parser Preload has an unexpected runtime dependency");
  return { applicationVersion: packageJson.version, parserVersion: manifest.parserVersion, manifestSha256: hash(actualBytes), assets: manifest.files.length, resourceFiles, asarFiles };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/verify-media-parser-package.mjs <Mac.app|Windows resources directory>");
  process.stdout.write(`${JSON.stringify(verifyMediaParserPackage(process.argv[2]))}\n`);
}
