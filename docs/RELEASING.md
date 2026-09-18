# Release Process

Aevoren Bot is not released directly from a developer workstation. The GitHub Actions release workflow is the authority for signed public artifacts.

The private source repository is the source of truth. The `mirror-master.yml` workflow pushes only the validated `master` branch and explicit `v*` tags to `CMSKL/Aevoren-Bot-public`; it never pushes `dev`, beta, or other refs. The mirror is distribution-only and does not receive development PRs. The public mirror also has a scheduled `pull-private-master-fallback.yml` job that reads only the private `master` ref with a read-only deploy key. This fallback keeps the mirror progressing if private-repository Actions capacity is temporarily unavailable; it never exposes or publishes `dev` or `beta`.

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

The tag workflow builds macOS arm64 ZIP and DMG artifacts, signs the app with Developer ID, enables Hardened Runtime, notarizes and staples the app and DMG, creates blockmaps and update metadata, generates SHA-256 checksums and a CycloneDX SBOM, attaches GitHub provenance, verifies the draft assets, and only then publishes the immutable Release.

The update channel is derived from SemVer:

- prerelease → `beta-mac.yml`;
- stable → `latest-mac.yml`.

## Rollback and incident handling

Do not overwrite or reuse a published version or tag. If a release is defective:

1. stop promoting the affected channel;
2. preserve the original immutable artifacts for investigation;
3. publish a higher patch or Beta version with the fix;
4. document migration or recovery steps;
5. issue a GitHub Security Advisory when the defect is security-related.

See [plans/automatic-updates.md](plans/automatic-updates.md) for the client update state machine and failure boundaries.
