import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // Windows CI runs SQLite migration fixtures under Defender and can take
    // several times longer than macOS/Linux. Keep the default tight locally,
    // but give those real filesystem migrations enough time to finish.
    testTimeout: process.platform === "win32" ? 60_000 : 5_000,
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
