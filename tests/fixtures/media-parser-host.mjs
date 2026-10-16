import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { app } = require("electron");
const { MediaParserHost, registerMediaParserScheme } = require(process.env.AEVOREN_PARSER_TEST_MODULE);
registerMediaParserScheme();
app.on("window-all-closed", () => {});
globalThis.mediaParserReady = app.whenReady().then(() => {
  app.dock?.hide();
  globalThis.mediaParserHost = new MediaParserHost({ directory: process.env.AEVOREN_PARSER_TEST_ASSETS });
});
