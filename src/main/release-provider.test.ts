import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type ReleaseProviderModule = {
  GITHUB_OWNER: string;
  GITHUB_REPOSITORY: string;
  resolveReleaseChannel(version: string): "latest" | "beta";
  createGitHubPublishConfiguration(version: string, releaseBuild: boolean): Record<string, unknown> | null;
};

type ReleaseVersionPolicyModule = {
  verifyReleaseVersion(version: string, tag: string): {
    version: string;
    tag: string;
    channel: "latest" | "beta";
    releaseType: "release" | "prerelease";
    expectedBranch: "master" | "beta";
  };
};

const require = createRequire(import.meta.url);
const provider = require("../../build/release-provider.cjs") as ReleaseProviderModule;
const versionPolicy = require("../../scripts/release-version-policy.cjs") as ReleaseVersionPolicyModule;

describe("GitHub release provider", () => {
  it("keeps development packages completely disconnected from an update provider", () => {
    expect(provider.createGitHubPublishConfiguration("1.0.0", false)).toBeNull();
  });

  it("pins stable releases to the public Aevoren Bot repository", () => {
    expect(provider.createGitHubPublishConfiguration("1.2.3", true)).toEqual({
      provider: "github",
      owner: "CMSKL",
      repo: "Aevoren-Bot",
      private: false,
      channel: "latest",
      releaseType: "release",
      publishAutoUpdate: true,
    });
  });

  it("uses an explicit GitHub beta channel for prereleases", () => {
    expect(provider.resolveReleaseChannel("1.2.3-beta.4")).toBe("beta");
    expect(provider.createGitHubPublishConfiguration("1.2.3-beta.4", true)).toMatchObject({
      channel: "beta",
      releaseType: "prerelease",
    });
  });

  it("rejects an invalid release version before packaging", () => {
    expect(() => provider.resolveReleaseChannel("next")).toThrow("Invalid release version");
  });
});

describe("release version policy", () => {
  it("routes stable versions to master and beta versions to beta", () => {
    expect(versionPolicy.verifyReleaseVersion("1.2.3", "v1.2.3")).toMatchObject({
      channel: "latest",
      releaseType: "release",
      expectedBranch: "master",
    });
    expect(versionPolicy.verifyReleaseVersion("1.3.0-beta.2", "v1.3.0-beta.2")).toMatchObject({
      channel: "beta",
      releaseType: "prerelease",
      expectedBranch: "beta",
    });
  });

  it.each([
    ["1.2.3-alpha.1", "v1.2.3-alpha.1"],
    ["1.2.3-beta.0", "v1.2.3-beta.0"],
    ["1.2.3-beta", "v1.2.3-beta"],
    ["1.2.3+build.1", "v1.2.3+build.1"],
    ["next", "vnext"],
    ["1.2.3", "v1.2.4"],
  ])("rejects unsupported release version %s with tag %s", (version, tag) => {
    expect(() => versionPolicy.verifyReleaseVersion(version, tag)).toThrow();
  });
});
