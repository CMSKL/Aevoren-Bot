import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { build, defineConfig } from "vite";

const external = [...builtinModules, ...builtinModules.map(name => `node:${name}`), "playwright-core", "ws"];

export default defineConfig({
  resolve: { alias: { "@shared": resolve("src/shared") } }, ssr: { noExternal: true, external: ["playwright-core", "ws"] },
  build: { target: "node24", ssr: true, outDir: "out/browser-worker", emptyOutDir: true, minify: false,
    rollupOptions: { input: resolve("src/browser-worker/index.ts"), external,
      output: { format: "es", entryFileNames: "index.mjs", inlineDynamicImports: true } } },
  plugins: [{ name: "browser-worker-context", async closeBundle() {
    const { copyFile, writeFile } = await import("node:fs/promises");
    await build({ configFile: false, resolve: { alias: { "@shared": resolve("src/shared") } }, ssr: { noExternal: true, external: ["playwright-core", "ws"] },
      build: { target: "node24", ssr: true, outDir: "out/browser-worker", emptyOutDir: false, minify: false,
        rollupOptions: { input: resolve("src/browser-worker/engine-entry.ts"), external,
          output: { format: "es", entryFileNames: "engine.mjs", inlineDynamicImports: true } } } });
    await copyFile(resolve("workers/browser/Dockerfile"), resolve("out/browser-worker/Dockerfile"));
    await writeFile(resolve("out/browser-worker/package.json"), JSON.stringify({ name: "aevoren-browser-worker", version: "1.0.0", type: "module", license: "Apache-2.0",
      dependencies: { "playwright-core": "1.63.0", ws: "8.22.0" } }));
  } }],
});
