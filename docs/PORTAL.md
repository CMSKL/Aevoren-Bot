# Aevoren Bot project portal

<p><img src="../resources/icon.png" alt="Aevoren Bot logo" width="128"></p>

![Aevoren Bot overview](assets/aevoren-bot-overview.png)

Aevoren Bot is an open-source, local-first desktop workspace for persistent AI Bots and deterministic multi-Bot collaboration. Conversations, explicit Memory, approvals, tool journal data, and runtime recovery stay on the user's computer.

## Current status

- Open source plus signed macOS Beta distribution through GitHub Releases; Windows remains an explicitly labeled MVP track.
- Supported release target: macOS 13 or newer on Apple silicon.
- Windows 10/11 x64 is in the MVP source/CI validation track; signed public Windows artifacts are pending certificate setup.
- Linux, Intel macOS, and mobile builds are not currently published.
- Local unsigned packages are development artifacts, not official releases.

## Start here

| Need | Document |
| --- | --- |
| Install from source or understand data isolation | [Installation](INSTALLATION.md) |
| Use Bots, Rooms, Memory, tools, and Routines | [User guide](USER_GUIDE.md) |
| Configure model CLIs, MCP, Workspace, and environment overrides | [Configuration](CONFIGURATION.md) |
| Understand reviewed Memory capture and scope rules | [Memory architecture](MEMORY.md) |
| Diagnose a reproducible problem | [Troubleshooting](TROUBLESHOOTING.md) and [Support](../SUPPORT.md) |
| Contribute code or documentation | [Contributing](../CONTRIBUTING.md) |
| Report a security issue | [Security policy](../SECURITY.md) |
| Understand signed releases and update channels | [Release process](RELEASING.md) |
| Review public-release gates | [Open-source checklist](OPEN_SOURCE_CHECKLIST.md) |
| Read licensing and brand rules | [LICENSE](../LICENSE), [Trademark notice](../TRADEMARKS.md) |
| See planned direction | [Roadmap](../ROADMAP.md) |

## Product boundaries

Aevoren Bot does not currently provide cloud sync, multi-user accounts, billing, unrestricted shell execution, arbitrary Workspace file writing, remote desktop, unreviewed automatic Memory writes, or write-capable MCP tools. Users can explicitly export a completed reply as a bounded Markdown artifact through the system save dialog. External actions remain explicit, scoped, and approval-gated.

Forks may reuse the source under Apache-2.0. The Aevoren Bot name, Logo, and official release identity are separate project identifiers; modified distributions should use their own name and visual identity and must not imply official endorsement.

## Official channels

The canonical public source repository is [CMSKL/Aevoren-Bot](https://github.com/CMSKL/Aevoren-Bot). Signed builds, when published, will be distributed only through this repository's immutable GitHub Releases and checksums.
