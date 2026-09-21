# Asset Provenance Review

This inventory records the disposition of visual and research assets before the repository becomes public.

| Asset group | Current location | Current status | Required action |
| --- | --- | --- | --- |
| Aevoren Bot application icon | `resources/icon.png`, `resources/icon.icns`, `resources/icon.ico`, `resources/AppIcon.icon/` | Restored from the project's private legacy archive and horizontally mirrored for the approved left-facing direction in Apple Icon Composer without changing its scale, palette, or composition parameters. The Windows ICO is a generated PNG-compressed derivative of the same approved 1024px PNG. Final 1024px PNG SHA-256: `a871716880806806a03199f4625772838a43387f9a565462cc96cd257091100f`; Icon Composer layer SHA-256: `0fa442a952bca676ecbb3d17ea385d0713f60870bd5882d5fc47b4bd137bfe5e`; ICNS SHA-256: `2dbb997197334b95bd526161772949f5f64cf64c15b57ccd77105b18931c22f9`; ICO SHA-256: `e07f32db512052a4945d22a7f0f13fb27ba5eaf88191811232178f4573ecdad4` | The repository maintainer explicitly directed this legacy project asset to be redistributed with Aevoren Bot; the attestation below records that project-level permission. Independent authorship and trademark clearance remain legal-review items |
| Public product overview screenshot | `docs/assets/aevoren-bot-overview.png` | Captured from an isolated Electron run using the locally authenticated Codex CLI and GPT-6-Astra in the product's dark theme, with a fresh temporary database, a formal Bot profile, and a synthetic product-strategy prompt. No account identifier, key, private transcript, or personal path is visible. SHA-256: `2e0beed23bc99841032de7a7bd8dc856102a663688ffb998fc776b2b462a546d` | Safe for public README and portal display; regenerate if the public UI changes materially or the shown model/provider is no longer representative |
| Original abstract Aevoren icon | Superseded locally; retained in Git history and a temporary recovery backup | Original project asset generated for Aevoren Bot with documented provenance | May be restored if an independently cleared public-release icon is required |
| Internal UI concepts and implementation captures | Removed from the public tree and rewritten history | Project-internal validation material | Retained only in the private archive |
| Third-party product screenshots and comparison composites | Removed from the public tree and rewritten history | Third-party interface imagery | Retained only in the private archive; not redistributed in the public repository |
| Extracted protocol/manifests and reverse-engineering evidence | Removed from the public tree and rewritten history | Internal interoperability research | Retained only in the private archive; not redistributed in the public repository |

References to third-party product names in source code should be limited to interoperability and accompanied by the notice in [TRADEMARKS.md](../TRADEMARKS.md).

## Maintainer redistribution attestation

On 2026-09-18, the project maintainer explicitly directed the repository to retain and redistribute the legacy Aevoren Bot face icon after the left-facing adjustment. This records project-level permission to include the asset with Aevoren Bot; it is not a legal opinion, independent-authorship certificate, or trademark clearance. Before a public binary release, the maintainer should retain any source/permission evidence available and complete the trademark review described in the open-source checklist.
