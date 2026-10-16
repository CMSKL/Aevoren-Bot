import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
export const parserName = "aevoren-browser-media";
export const parserVersion = "1.0.0/pdfjs-6.4.299/mammoth-1.13.0/zip-2.23.0/fonts-2.1.5";
const pins = { "pdfjs-dist": "6.4.299", mammoth: "1.13.0", "@zip.js/zip.js": "2.23.0" };
const roots = Object.fromEntries(Object.entries(pins).map(([name, version]) => {
  const manifest = require.resolve(`${name}/package.json`);
  if (JSON.parse(readFileSync(manifest, "utf8")).version !== version) throw new Error(`Unexpected parser dependency version: ${name}`);
  return [name, dirname(manifest)];
}));
const pdf = roots["pdfjs-dist"];
const jszip = dirname(createRequire(join(roots.mammoth, "package.json")).resolve("jszip/package.json"));
const jszipManifest = JSON.parse(readFileSync(join(jszip, "package.json"), "utf8"));
if (jszipManifest.version !== "3.10.2" || jszipManifest.license !== "(MIT OR GPL-3.0-or-later)"
  || sha256(readFileSync(join(jszip, "LICENSE.markdown"))) !== "566c953c6090b1218ca6217dd7359d45dde46581968586dc607d59a78af6a9c4") throw new Error("JSZip MIT license selection requires review");
export function selectedParserLicense(name, version, declared) {
  return name === "jszip" && version === "3.10.2" && declared === "(MIT OR GPL-3.0-or-later)" ? "MIT" : declared;
}
const fonts = resolve("resources/media-parser-fonts/2.1.5");
const fontProvenance = JSON.parse(readFileSync(join(fonts, "SOURCE.json"), "utf8"));
const expectedFonts = {
  "LiberationSans-Regular.ttf": "76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8",
  "LiberationSans-Bold.ttf": "788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173",
  "LiberationSans-Italic.ttf": "e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0",
  "LiberationSans-BoldItalic.ttf": "698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee",
};
export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
for (const [name, digest] of Object.entries({ ...expectedFonts, LICENSE: "93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b" })) {
  if (sha256(readFileSync(join(fonts, name))) !== digest) throw new Error(`Changed OFL font asset: ${name}`);
}
if (fontProvenance.version !== "2.1.5" || fontProvenance.license !== "OFL-1.1") throw new Error("Invalid font provenance");

export const parserAssetComponents = [
  { name: "PDF.js Adobe CMaps", version: pins["pdfjs-dist"], license: "BSD-3-Clause", source: "https://github.com/mozilla/pdf.js", licensePaths: [join(pdf, "cmaps/LICENSE")] },
  { name: "PDF.js Foxit standard fonts", version: pins["pdfjs-dist"], license: "BSD-3-Clause", source: "https://github.com/mozilla/pdf.js", licensePaths: [join(pdf, "standard_fonts/LICENSE_FOXIT")] },
  { name: "Liberation Sans", version: "2.1.5", license: "OFL-1.1", source: fontProvenance.source, licensePaths: [join(fonts, "LICENSE")] },
  { name: "PDF.js ICC profile", version: pins["pdfjs-dist"], license: "CC0-1.0", source: "https://github.com/mozilla/pdf.js", licensePaths: [join(pdf, "iccs/LICENSE")] },
  { name: "PDF.js OpenJPEG", version: pins["pdfjs-dist"], license: "BSD-2-Clause", source: "https://github.com/mozilla/pdf.js", licensePaths: [join(pdf, "wasm/LICENSE_OPENJPEG"), join(pdf, "wasm/LICENSE_PDFJS_OPENJPEG")] },
  { name: "PDF.js JBIG2", version: pins["pdfjs-dist"], license: "BSD-3-Clause AND Apache-2.0", source: "https://github.com/mozilla/pdf.js", licensePaths: [join(pdf, "wasm/LICENSE_JBIG2"), join(pdf, "wasm/LICENSE_PDFJS_JBIG2")] },
  { name: "PDF.js QCMS", version: pins["pdfjs-dist"], license: "MIT", source: "https://github.com/mozilla/pdf.js", licensePaths: [join(pdf, "wasm/LICENSE_QCMS"), join(pdf, "wasm/LICENSE_PDFJS_QCMS")] },
];

export function parserAssets() {
  const assets = [{ source: join(pdf, "build/pdf.worker.mjs"), path: "public/pdfjs/pdf.worker.mjs" }];
  for (const name of readdirSync(join(pdf, "cmaps")).filter(name => name.endsWith(".bcmap")).sort()) assets.push({ source: join(pdf, "cmaps", name), path: `public/pdfjs/cmaps/${name}` });
  for (const name of readdirSync(join(pdf, "standard_fonts")).filter(name => name.startsWith("Foxit") && name.endsWith(".pfb")).sort()) assets.push({ source: join(pdf, "standard_fonts", name), path: `public/pdfjs/standard_fonts/${name}` });
  for (const name of Object.keys(expectedFonts)) assets.push({ source: join(fonts, name), path: `public/pdfjs/standard_fonts/${name}` });
  assets.push({ source: join(pdf, "iccs/CGATS001Compat-v2-micro.icc"), path: "public/pdfjs/iccs/CGATS001Compat-v2-micro.icc" });
  for (const name of ["openjpeg.wasm", "openjpeg_nowasm_fallback.js", "jbig2.wasm", "jbig2_nowasm_fallback.js", "qcms_bg.wasm"]) assets.push({ source: join(pdf, "wasm", name), path: `public/pdfjs/wasm/${name}` });
  for (const [name, root] of Object.entries(roots)) assets.push({ source: join(root, "LICENSE"), path: `licenses/${name.replaceAll(/[^A-Za-z0-9._-]/gu, "_")}-LICENSE` });
  assets.push({ source: join(jszip, "LICENSE.markdown"), path: "licenses/jszip-LICENSE.markdown" });
  for (const component of parserAssetComponents) for (const [index, source] of component.licensePaths.entries()) assets.push({ source, path: `licenses/${component.name.replaceAll(/[^A-Za-z0-9]/gu, "-")}-${index}.txt` });
  assets.push({ source: join(fonts, "SOURCE.json"), path: "licenses/liberation-SOURCE.json" });
  return assets;
}
