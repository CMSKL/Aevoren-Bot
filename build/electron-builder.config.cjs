const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
const releaseBuild = process.env.AEVOREN_RELEASE_BUILD === "1";
const prerelease = packageJson.version.includes("-");
const channel = prerelease ? "beta" : "latest";

function updateUrl() {
  if (!releaseBuild) return null;
  const raw = process.env.AEVOREN_UPDATE_BASE_URL?.trim();
  if (!raw) throw new Error("AEVOREN_UPDATE_BASE_URL is required for a release build");
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("AEVOREN_UPDATE_BASE_URL must be a credential-free HTTPS base URL");
  }
  return parsed.toString().replace(/\/$/, "");
}

const publishUrl = updateUrl();

module.exports = {
  appId: "com.cmskl.aevorenbot",
  productName: "Aevoren Bot",
  asar: true,
  compression: "maximum",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "package.json"],
  extraResources: [{ from: "resources/icon.png", to: "icon.png" }],
  artifactName: "Aevoren-Bot-${version}-${arch}.${ext}",
  ...(publishUrl
    ? {
        publish: [{ provider: "generic", url: publishUrl, channel }],
      }
    : {}),
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
};
