const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createGitHubPublishConfiguration } = require("./release-provider.cjs");

const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
const releaseBuild = process.env.AEVOREN_RELEASE_BUILD === "1";
const publishConfiguration = createGitHubPublishConfiguration(packageJson.version, releaseBuild);

module.exports = {
  appId: "com.cmskl.aevorenbot",
  productName: "Aevoren Bot",
  asar: true,
  compression: "maximum",
  afterPack: "build/after-pack.cjs",
  directories: {
    output: process.env.AEVOREN_DIST_DIR || "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "!out/worker/**/*", "!out/browser-worker/**/*", "!out/media-parser/**/*", "!**/node_modules/pdfjs-dist/**/*", "!**/node_modules/mammoth/**/*", "!**/node_modules/@zip.js/zip.js/**/*", "package.json"],
  extraResources: [
    { from: "resources/icon.png", to: "icon.png" },
    { from: "THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" },
    { from: "docs/EXECUTION_ENVIRONMENT.md", to: "docs/EXECUTION_ENVIRONMENT.md" },
    { from: "docs/BROWSER_COMPUTER.md", to: "docs/BROWSER_COMPUTER.md" },
    { from: "docs/SCRIPT_SKILLS.md", to: "docs/SCRIPT_SKILLS.md" },
    { from: "docs/SKILL_DEMONSTRATIONS.md", to: "docs/SKILL_DEMONSTRATIONS.md" },
    { from: "docs/NATIVE_CONNECTORS.md", to: "docs/NATIVE_CONNECTORS.md" },
    { from: "docs/NATIVE_OUTBOUND.md", to: "docs/NATIVE_OUTBOUND.md" },
    { from: "docs/MCP_APPS.md", to: "docs/MCP_APPS.md" },
    { from: "docs/MEDIA.md", to: "docs/MEDIA.md" },
    { from: "docs/VOICE.md", to: "docs/VOICE.md" },
    { from: "docs/REALTIME_VOICE.md", to: "docs/REALTIME_VOICE.md" },
    { from: "docs/TASK_THREADS.md", to: "docs/TASK_THREADS.md" },
    { from: "docs/SEARCH.md", to: "docs/SEARCH.md" },
    { from: "docs/GROUP_ROUTINES.md", to: "docs/GROUP_ROUTINES.md" },
    { from: "docs/ORGANIZATION.md", to: "docs/ORGANIZATION.md" },
    { from: "NOTICE", to: "NOTICE" },
    { from: "out/worker", to: "environment-worker" },
    { from: "out/browser-worker", to: "browser-worker" },
    { from: "out/media-parser", to: "media-parser" },
  ],
  artifactName: "Aevoren-Bot-${version}-${arch}.${ext}",
  // Never let electron-builder infer a GitHub provider from package metadata
  // for unsigned local packages. Only signed release builds embed the feed.
  publish: publishConfiguration ? [publishConfiguration] : null,
  mac: {
    // macOS locale names differ from Windows/Linux .pak names. Keep those
    // platforms' complete locale sets so native inputs cannot crash Electron.
    electronLanguages: ["en", "zh_CN"],
    target: ["dmg", "zip"],
    category: "public.app-category.productivity",
    icon: "resources/icon.icns",
    minimumSystemVersion: "13.0",
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    ...(releaseBuild
      ? { hardenedRuntime: true, notarize: true }
      : { identity: null, hardenedRuntime: false, notarize: false }),
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "resources/icon.ico",
    ...(releaseBuild
      ? {
          forceCodeSigning: true,
        }
      : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Aevoren Bot",
    deleteAppDataOnUninstall: false,
  },
  dmg: {
    sign: releaseBuild,
  },
};
