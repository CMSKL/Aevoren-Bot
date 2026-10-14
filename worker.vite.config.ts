import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { build, defineConfig } from "vite";

export default defineConfig({
  resolve: { alias: { "@shared": resolve("src/shared") } },
  ssr: { noExternal: true },
  build: {
    target: "node24", ssr: true, outDir: "out/worker", emptyOutDir: true, minify: false,
    rollupOptions: {
      input: resolve("src/worker/index.ts"),
      external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)],
      output: { format: "es", entryFileNames: "index.mjs", inlineDynamicImports: true },
    },
  },
  plugins: [{ name: "worker-docker-context", async closeBundle() {
    const { copyFile, writeFile } = await import("node:fs/promises");
    await build({ configFile: false, resolve: { alias: { "@shared": resolve("src/shared") } }, ssr: { noExternal: true }, build: {
      target: "node24", ssr: true, outDir: "out/worker", emptyOutDir: false, minify: false,
      rollupOptions: { input: resolve("src/worker/file-helper-entry.ts"), external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)],
        output: { format: "es", entryFileNames: "file-helper.mjs", inlineDynamicImports: true } },
    } });
    await copyFile(resolve("workers/execution/Dockerfile"), resolve("out/worker/Dockerfile"));
    await writeFile(resolve("out/worker/package.json"), JSON.stringify({ name: "aevoren-execution-worker", version: "1.0.0", type: "module", license: "Apache-2.0" }));
  } }],
});
