# Installation

## Supported platform

The supported desktop target is:

- macOS 13 or newer;
- Apple silicon (`arm64`).

Windows, Linux, and Intel macOS builds are not currently published or covered by the release test matrix.

## Install a signed release

No public release is published yet. When releases begin, install only artifacts from the repository's GitHub Releases page and verify `SHASUMS256.txt` before opening the DMG.

Do not download Aevoren Bot from mirrors, file-sharing sites, or links posted by third parties.

## Run from source

Requirements:

- Git;
- Node.js 24;
- pnpm 11.19.0;
- Xcode Command Line Tools on macOS.

```bash
git clone https://github.com/CMSKL/Aevoren-Bot-public.git
cd Aevoren-Bot-public
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

## Data location and backups

Aevoren Bot stores local state in Electron's application data directory. Before testing migrations or prerelease builds, back up the application data directory or use an isolated location:

```bash
AEVOREN_BOT_USER_DATA_DIR=/absolute/path/to/test-data AEVOREN_BOT_FAKE_PROVIDER=1 pnpm dev
```

Never run destructive tests against a daily-use database.

## Uninstall

Quit Aevoren Bot, remove the app bundle, and optionally remove its application data directory. Removing application data permanently deletes local Bots, Rooms, transcripts, settings, Memory, encrypted credentials, and Routine history.
