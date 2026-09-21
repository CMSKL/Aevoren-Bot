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
| Repository settings | Passed | Repository is public with default branch `master`; vulnerability reporting, secret scanning, and public CI are enabled; master protection is handled as a post-public governance gate |

The tag workflow invokes `pnpm open-source:check` before building, so an accidental version tag cannot publish while the license or internal-history blockers remain.

## P1 — important before broad adoption

| Item | Status / action |
| --- | --- |
| SBOM | Passed locally | `pnpm sbom:generate` creates a deterministic CycloneDX 1.5 SBOM; the release workflow attests and uploads it with the immutable asset set |
| Windows 10/11 x64 | MVP validation track | Source build, Windows-specific CLI/path tests, CI smoke, and unsigned NSIS package job are configured; signed public installer remains blocked on Windows certificate secrets |
| Intel macOS / Linux | Documented unsupported | README, Installation, Support, and Portal scope the current release line to macOS arm64 and Windows x64 MVP |
| Accessibility and localization | Pending public review | Core UI tests and user-facing English/Chinese strings exist, but a dedicated accessibility audit and documentation-language decision remain |
| Dependency update automation | Prepared | Dependabot grouping is active and grouped PRs have been observed; upgrades remain subject to compatibility and license gates |
| Support operations | Passed | SUPPORT.md defines private security reporting, issue triage guidance, and maintainer response targets |
| Trademark clearance | Deferred by instruction | Formal trademark search/filing is intentionally not part of this preparation pass; the remaining legal risk is documented in the asset and trademark notices |

## P2 — later improvements

| Item | Status |
| --- | --- |
| Public roadmap | Passed — [ROADMAP.md](../ROADMAP.md) is linked from the README and Portal |
| Discussions/community forum | Deferred | Public Discussions/categories and moderation can be enabled after the first public release |
| Signed nightly builds | Deferred — not required for the first source publication or the first stable Release |
| Reproducible-build comparison across independent runners | Deferred — local/CI install and build gates pass, but independent runner comparison is not yet established |
| Website download metadata generated from immutable GitHub Releases | Deferred — no external website is configured; the repository is the canonical portal until a website exists |

## Source-publication conclusion

The source tree and reachable history have passed the technical P0 checks. The current repository is the sole public source of truth; the former mirror is archived and no mirror workflow or credential remains. Binary signing, two-version update validation, and first-release credentials remain separate binary-release gates.

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
