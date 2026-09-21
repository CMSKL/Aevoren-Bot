# Release Process

Aevoren Bot is not released directly from a developer workstation. The GitHub Actions release workflow is the authority for signed public artifacts.

The current repository `CMSKL/Aevoren-Bot` is the sole source, issue tracker, Release host, and public distribution entry point. Development promotes through `dev` → `beta` → `master`; signed assets and update manifests are published only as immutable GitHub Releases from this repository.

## Branch promotion

1. Develop and validate on `dev`.
2. Merge `dev` into `beta` and complete Beta validation.
3. Merge `beta` into `master` and complete stable validation.
4. Create a version tag on the exact release commit.

Beta tags must use `vX.Y.Z-beta.N` and point to a commit contained in `beta`. Stable tags must use `vX.Y.Z` and point to a commit contained in `master`.

## Before tagging

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm test:smoke
pnpm security:audit
pnpm licenses:generate
git diff --exit-code -- THIRD_PARTY_NOTICES.md
pnpm sbom:generate
```

Also confirm:

- `package.json` contains the intended SemVer;
- the main project license and third-party notices are present;
- the changelog is updated;
- no release artifact, database, `.env`, certificate, key, notarization response, or local log is tracked;
- current Git history has passed a full secret scan;
- the target commit has completed the required CI checks.

## Required GitHub environment secrets

The `release` environment requires:

- `CSC_LINK`;
- `CSC_KEY_PASSWORD`;
- `WIN_CSC_LINK`;
- `WIN_CSC_KEY_PASSWORD`;
- `APPLE_TEAM_ID`;
- either App Store Connect API key credentials:
  - `APPLE_API_KEY_P8_BASE64`;
  - `APPLE_API_KEY_ID`;
  - `APPLE_API_ISSUER`;
- or Apple ID notarization credentials:
  - `APPLE_ID`;
  - `APPLE_APP_SPECIFIC_PASSWORD`.

Never store these values in repository variables, workflow files, Issues, Actions artifacts, or application update metadata.

## Workflow output

The tag workflows build macOS arm64 ZIP and DMG artifacts and Windows x64 NSIS artifacts into one shared draft Release. macOS signs with Developer ID, enables Hardened Runtime, notarizes and staples the app and DMG; Windows signs the executable and installer with the configured Authenticode certificate. Both workflows create blockmaps and update metadata, generate platform-specific SHA-256 checksum files (`SHASUMS256.txt` for macOS and `SHASUMS256-win.txt` for Windows) and a CycloneDX SBOM, attach GitHub provenance, verify draft assets, and the macOS workflow publishes only after the Windows asset set is present.

The update channel is derived from SemVer:

- prerelease → `beta-mac.yml`;
- stable → `latest-mac.yml`.

The Windows workflow uses the matching `beta.yml` or `latest.yml` manifest and requires `WIN_CSC_LINK` plus `WIN_CSC_KEY_PASSWORD` in the `release` environment. Missing Windows signing credentials fail closed before an installer is published.

Windows publishing is additionally gated by the repository variable `AEVOREN_WINDOWS_RELEASE_ENABLED=1`. Leave it unset while Windows remains an MVP track: the macOS workflow then publishes a complete macOS Release without waiting for Windows. Enable it only after both Windows signing secrets are configured; from that point the macOS workflow requires the Windows asset set before publishing the shared Release.

## Rollback and incident handling

Do not overwrite or reuse a published version or tag. If a release is defective:

1. stop promoting the affected channel;
2. preserve the original immutable artifacts for investigation;
3. publish a higher patch or Beta version with the fix;
4. document migration or recovery steps;
5. issue a GitHub Security Advisory when the defect is security-related.

See [plans/automatic-updates.md](plans/automatic-updates.md) for the client update state machine and failure boundaries.
