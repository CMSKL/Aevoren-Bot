import { mkdir, readdir, readFile, copyFile, writeFile, rm } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { build, defineConfig } from "vite";
import { parserAssets, parserName, parserVersion, sha256 } from "./scripts/media-parser-assets.mjs";

const root = resolve("out/media-parser");
const mimeTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".ttf": "font/ttf" };

export default defineConfig({
  root: resolve("src/media-parser"), base: "./",
  build: { target: "chrome152", outDir: join(root, "public"), emptyOutDir: true, minify: false, sourcemap: false },
  plugins: [{ name: "owned-media-parser-assets", async closeBundle() {
    await build({ configFile: false, build: {
      target: "node24", ssr: true, outDir: join(root, "private"), emptyOutDir: true, minify: false,
      rollupOptions: { input: resolve("src/media-parser/preload.ts"), external: ["electron"], output: { format: "cjs", entryFileNames: "preload.cjs", inlineDynamicImports: true } },
    } });
    await rm(join(root, "licenses"), { recursive: true, force: true });
    for (const asset of parserAssets()) { const target = join(root, asset.path); await mkdir(dirname(target), { recursive: true }); await copyFile(asset.source, target); }
    const paths: string[] = [];
    async function scan(directory: string): Promise<void> { for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Parser output must not contain links");
      if (entry.isDirectory()) await scan(join(directory, entry.name)); else paths.push(relative(root, join(directory, entry.name)).replaceAll("\\", "/"));
    } }
    for (const directory of ["public", "private", "licenses"]) await scan(join(root, directory));
    const files = await Promise.all(paths.sort().map(async path => { const bytes = await readFile(join(root, path)); return {
      path, route: path.startsWith("public/") ? path.slice(7) : null, mimeType: mimeTypes[extname(path)] ?? "application/octet-stream", size: bytes.length, sha256: sha256(bytes),
    }; }));
    const application = JSON.parse(await readFile(resolve("package.json"), "utf8"));
    await writeFile(join(root, "manifest.json"), `${JSON.stringify({ protocolVersion: 1, parserName, parserVersion, applicationVersion: application.version, entry: "index.html", preload: "private/preload.cjs", files }, null, 2)}\n`);
  } }],
});
