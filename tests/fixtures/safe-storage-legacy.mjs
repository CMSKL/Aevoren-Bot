import { writeFileSync } from "node:fs";
import process from "node:process";
import { app, safeStorage } from "electron";

app.setName("ms-bot");

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) process.exitCode = 2;
  else {
    const outputPath = process.env.MS_BOT_SAFE_STORAGE_FIXTURE_PATH;
    if (!outputPath) process.exitCode = 3;
    else {
      const ciphertext = safeStorage.encryptString("safe-storage-compatibility-token").toString("base64");
      writeFileSync(outputPath, ciphertext, { encoding: "utf8", mode: 0o600 });
    }
  }
});
