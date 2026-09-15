import { app } from "electron";

if (process.env.AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE === "1") {
  app.commandLine.removeSwitch("use-mock-keychain");
}
app.setName("Aevoren Bot");
