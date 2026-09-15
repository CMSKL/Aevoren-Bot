import { app } from "electron";

if (process.env.MS_BOT_USE_SYSTEM_SAFE_STORAGE === "1") {
  app.commandLine.removeSwitch("use-mock-keychain");
}
// Keep the established storage identity so existing safeStorage ciphertext and userData remain readable after rebranding.
app.setName("ms-bot");
