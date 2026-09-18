# Open-Source Release Checklist

Last reviewed: 2026-09-18. This is a readiness record, not authorization to publish or create a Release.

## P0 — public release blockers

| Item | Status | Evidence / required action |
| --- | --- | --- |
| Current tree secret scan | Passed | Local Gitleaks directory scan and the remote CI secret-scan job found 0 findings; ignored local `dist` fixtures are not publication inputs |
| Full Git history secret scan | Passed | Independent post-rewrite clones of `dev`, `beta`, and `master` were scanned with 0 findings |
| Main project license | Passed | Root `LICENSE` contains Apache-2.0 and `package.json` uses the `Apache-2.0` SPDX identifier |
| Third-party dependency license inventory | Passed | `pnpm licenses:check`; generated `THIRD_PARTY_NOTICES.md`; production graph has no GPL/AGPL/LGPL/SSPL/BUSL/unknown group |
| Vulnerability audit | Passed | `pnpm audit --audit-level high`: 0 high/critical findings at review time |
| Reverse-engineering and third-party evidence | Passed | A verified private Git bundle and checksummed material archive were created; 99 internal/evidence paths and the superseded visual assets were removed from the reachable history of `dev`, `beta`, and `master` |
| Icon and visual asset provenance | Conditionally passed | The legacy face icon is covered by the maintainer redistribution attestation in `docs/ASSET_PROVENANCE.md`; independent-authorship evidence and trademark clearance remain legal-review risks, not an undocumented project decision |
| README and public setup docs | Passed | Public README plus Installation, Configuration, Release, Support, Security, Contribution, Code of Conduct, Changelog, Notice, and trademark docs added |
| Reproducible dependency install | Passed | Fresh local `pnpm install --frozen-lockfile`, offline reinstall, and remote Ubuntu/macOS CI installs succeeded |
| Build and macOS package | Passed | Current `0.2.0-beta.7` arm64 directory package built locally and in remote CI; packaged hidden startup smoke passed |
| Privacy declarations and ATS | Passed | Unused camera/microphone/Bluetooth descriptions removed during `afterPack`; arbitrary network loads disabled; local networking retained |
| PR CI | Passed on `dev` | Pinned GitHub Actions workflow completed secret scan, Node 24 validation/build, dependency audit/license gate, macOS smoke, and unsigned package for the rewritten `dev` head |
| Signed/notarized release | Deferred binary gate | Not required for publishing source code; before the first public macOS binary, create a new version and verify Developer ID, Hardened Runtime, notarization, Gatekeeper, checksums, attestation, and update metadata |
| Real update from an older public build | Deferred binary gate | Requires two public test artifacts; complete Beta N → Beta N+1 download/install/relaunch validation before claiming production auto-update readiness |
| Repository settings | Pending public launch | The repository intentionally remains private with default branch `dev`; immediately before changing visibility, set the intended default branch, enable vulnerability reporting/secret scanning, and require CI reviews/protection |

The tag workflow invokes `pnpm open-source:check` before building, so an accidental version tag cannot publish while the license or internal-history blockers remain.

## P1 — important before broad adoption

| Item | Status / action |
| --- | --- |
| SBOM | Passed locally | `pnpm sbom:generate` creates a deterministic CycloneDX 1.5 SBOM; the release workflow attests and uploads it with the immutable asset set |
| Intel macOS / Windows / Linux | Either add CI/package support or keep them explicitly unsupported; do not imply cross-platform availability |
| Accessibility and localization | Run public-release accessibility review and decide whether an English/Chinese documentation split is needed |
| Dependency update automation | Dependabot configuration added; verify grouped PR behavior after the repository is public |
| Support operations | Define maintainer response targets, triage labels, and release/security ownership |
| Trademark clearance | Perform an official trademark search and legal review for “Aevoren Bot”; a web search alone is not clearance |

## P2 — later improvements

- Public roadmap and governance model.
- Discussions/community forum.
- Signed nightly builds.
- Reproducible-build comparison across independent runners.
- Website download metadata generated from immutable GitHub Releases.

## Source-publication conclusion

The source tree and reachable history have passed the technical P0 checks. The repository is not made public by this checklist. Binary signing, two-version update validation, and GitHub visibility/protection changes are intentionally deferred to the launch operation.

## Final launch gate

Run all commands from a clean checkout of the exact candidate commit:

```bash
pnpm install --frozen-lockfile
pnpm open-source:check
pnpm verify
pnpm test:smoke
pnpm security:audit
pnpm licenses:generate
git diff --exit-code -- THIRD_PARTY_NOTICES.md
```

Then run a redacted full-history Gitleaks scan, promote through `dev` → `beta` → `master`, and create the version tag only on the exact protected branch head.
