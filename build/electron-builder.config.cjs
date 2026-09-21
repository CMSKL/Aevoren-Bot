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
  electronLanguages: ["en", "zh_CN"],
  afterPack: "build/after-pack.cjs",
  directories: {
    output: process.env.AEVOREN_DIST_DIR || "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "package.json"],
  extraResources: [
    { from: "resources/icon.png", to: "icon.png" },
    { from: "THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" },
    { from: "NOTICE", to: "NOTICE" },
  ],
  artifactName: "Aevoren-Bot-${version}-${arch}.${ext}",
  // Never let electron-builder infer a GitHub provider from package metadata
  // for unsigned local packages. Only signed release builds embed the feed.
  publish: publishConfiguration ? [publishConfiguration] : null,
  mac: {
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
