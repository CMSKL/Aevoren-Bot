const { prerelease, valid } = require("semver");

const GITHUB_OWNER = "CMSKL";
const GITHUB_REPOSITORY = "Aevoren-Bot";

function resolveReleaseChannel(version) {
  if (!valid(version)) throw new Error(`Invalid release version: ${version}`);
  return prerelease(version) ? "beta" : "latest";
}

function createGitHubPublishConfiguration(version, releaseBuild) {
  if (!releaseBuild) return null;
  const channel = resolveReleaseChannel(version);
  return {
    provider: "github",
    owner: GITHUB_OWNER,
    repo: GITHUB_REPOSITORY,
    private: false,
    channel,
    releaseType: channel === "beta" ? "prerelease" : "release",
    publishAutoUpdate: true,
  };
}

module.exports = {
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  createGitHubPublishConfiguration,
  resolveReleaseChannel,
};
