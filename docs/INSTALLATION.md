# Installation

## Supported platform

The supported desktop target is:

- macOS 13 or newer;
- Apple silicon (`arm64`).

Windows 10/11 x64 is supported in the source-build and CI smoke/package matrix, but a signed public Windows installer is not published until the Windows certificate secrets are configured. Linux and Intel macOS are not currently covered.

## Install a signed release

Install only artifacts from the repository's [GitHub Releases](https://github.com/CMSKL/Aevoren-Bot/releases) page. Beta releases are prerelease builds. Verify `SHASUMS256.txt` for macOS or `SHASUMS256-win.txt` for Windows before opening the installer.

Do not download Aevoren Bot from mirrors, file-sharing sites, or links posted by third parties.

## Run from source

Requirements:

- Git;
- Node.js 24;
- pnpm 11.19.0;
- Xcode Command Line Tools on macOS, or PowerShell on Windows.

```bash
git clone https://github.com/CMSKL/Aevoren-Bot.git
cd Aevoren-Bot
pnpm install --frozen-lockfile
AEVOREN_BOT_FAKE_PROVIDER=1 pnpm dev
```

The Fake Provider is deterministic and does not need an account or API key.

Build the application without opening a window:

```bash
pnpm verify
pnpm build
```

Create an unsigned local macOS directory package:

```bash
pnpm package:mac
```

This local package is for development verification only. It is not signed, notarized, or eligible for distribution.

On Windows x64, run the same source commands from PowerShell. `pnpm package:win` creates an unsigned NSIS installer for local validation; `pnpm package:win:dir` creates an unpacked directory. An official Windows Release installer requires the signed release workflow; do not treat a local package as an official update source.

## Unsigned Windows validation installer

For manual Windows validation, select a fully successful run from this repository's [CI workflow](https://github.com/CMSKL/Aevoren-Bot/actions/workflows/ci.yml). Download the artifact named `aevoren-bot-v<version>-windows-x64-unsigned-<checkout-head>-attempt<N>`; artifacts are retained for **30 days**. GitHub may require sign-in to download an Actions artifact. Match the version and head to the intended validated build.

The archive contains the same x64 NSIS `.exe` used for that run's isolated installation, business and close checks, plus `UNSIGNED-WINDOWS-SHASUMS256.txt` and `UNSIGNED-WINDOWS-BUILD.json`. After extraction, compare the installer's PowerShell `Get-FileHash -Algorithm SHA256` result with the checksum entry before running it. The build JSON identifies its version, checkout head and unsigned status.

This **unsigned Windows validation installer** is for manual validation, not a signed Beta Release or automatic-update source. Windows signing credentials remain required for official Windows Release assets. Actual Windows Linux-container/Docker execution is not established by these installer checks.

## Data location and backups

Aevoren Bot stores local state in Electron's application data directory. Before testing migrations or prerelease builds, back up the application data directory or use an isolated location:

```bash
AEVOREN_BOT_USER_DATA_DIR=/absolute/path/to/test-data AEVOREN_BOT_FAKE_PROVIDER=1 pnpm dev
```

Never run destructive tests against a daily-use database.

The Windows build uses the normal Electron user-data directory under the current Windows user profile. macOS and Windows `safeStorage` identities are platform-bound, so moving an encrypted API key or CLI credential database between operating systems is intentionally not supported; re-authenticate on the destination system. Windows startup-task integration is currently disabled. Bots, Rooms, transcripts, and non-secret settings can be migrated only through a future explicit export/import flow.

## Uninstall

Quit Aevoren Bot, remove the app bundle, and optionally remove its application data directory. Removing application data permanently deletes local Bots, Rooms, transcripts, settings, Memory, encrypted credentials, and Routine history.
