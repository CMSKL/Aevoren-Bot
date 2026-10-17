import { defineConfig } from "@playwright/test";

// Electron smoke tests must never steal focus from the user's installed app.
process.env.AEVOREN_BOT_TEST_HIDDEN ??= "1";

export default defineConfig({
  testDir: "tests/smoke",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  use: {
    trace: "retain-on-failure",
  },
});
