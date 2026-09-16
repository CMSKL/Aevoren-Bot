/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { prerelease, valid } = require("semver");

function verifyReleaseVersion(version, tag) {
  if (!valid(version)) throw new Error(`package.json version is not valid SemVer: ${version}`);
  if (version.includes("+")) throw new Error("release versions must not contain SemVer build metadata");
  if (tag !== `v${version}`) {
    throw new Error(`release tag ${tag || "<missing>"} must exactly match package version v${version}`);
  }

  const identifiers = prerelease(version);
  if (!identifiers) {
    return { version, tag, channel: "latest", releaseType: "release", expectedBranch: "master" };
  }
  if (identifiers.length !== 2 || identifiers[0] !== "beta" || !Number.isInteger(identifiers[1]) || identifiers[1] < 1) {
    throw new Error("prerelease versions must use the form X.Y.Z-beta.N with N >= 1");
  }
  return { version, tag, channel: "beta", releaseType: "prerelease", expectedBranch: "beta" };
}

module.exports = { verifyReleaseVersion };
