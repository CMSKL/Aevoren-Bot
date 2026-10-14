import { defineConfig } from "@playwright/test";

process.env.AEVOREN_BOT_TEST_HIDDEN = "1";

export default defineConfig({
  testDir: ".",
  testMatch: ["environment.spec.ts", "browser.spec.ts"],
  timeout: 180_000,
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
