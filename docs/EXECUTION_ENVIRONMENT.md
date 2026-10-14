# Local Docker execution environments

Stage 2 is implemented in the `v0.3.0-beta.28` development candidate. Local quality gates, real Linux Docker integration, hidden source-Electron checks and final unsigned macOS package checks have passed; branch promotion and signing/release are pending. This document describes the candidate implementation; consult [Beta releases](https://github.com/CMSKL/Aevoren-Bot/releases) for published installers and the [implementation record](IMPLEMENTATION_PLAN.md) for completed checks.

## Setup and interface

Provide a running local Docker engine with Linux containers and keep the same local Docker context selected for existing environments; switching engines is not validated. The application does not install Docker or connect to remote Docker contexts. Supported image architectures are `linux/arm64` and `linux/amd64`. Windows must use a Linux-container runtime; its real execution workflow has not yet been validated on Windows.

Open **Contacts → select Bot → Execution environment (执行环境)** for its private conversation. In **Group settings → Execution environment**, select the executing member. **Settings → General → Linux execution environment** checks Docker readiness. Missing Docker, a stopped engine or an unsupported context is reported directly.

1. Click **Check Docker (检查 Docker)** or refresh the environment panel.
2. Choose **Prepare Linux image (准备 Linux 镜像)**. The first build fetches its base image and Debian packages and needs network access and disk space.
3. Choose **Start environment (启动环境)** or **Wake environment (唤醒环境)**.
4. Enter a command and a workspace-relative working directory. **Run command (运行命令)** starts a foreground task; **Run in background (后台运行)** starts a separately managed process.
5. Open **View output / View logs** to read actual stdout/stderr, task status, exit code and errors. Stop one task without stopping siblings.

The image contains Node.js 24, Python 3, Bash, Git and a build toolchain. Dependencies installed by commands should live under the writable workspace; the container's base filesystem is read-only. This is a command/output panel, not an interactive PTY or desktop terminal.

## Scope and lifecycle

Each `(sessionId, executorBotId)` owns one environment and persistent workspace. The same Bot's private conversation and different groups have separate environments. Six group members can start independently; lifecycle locks apply to one environment rather than all members. Jobs within the same environment share its workspace and use one of 32 independently tracked Linux UIDs. Exhausting those active slots returns a capacity error.

Foreground tasks use a default 120-second timeout; an AI request may specify up to one hour. A background task has no default timeout and remains separately visible and stoppable. Cancelling a Runtime stops its foreground tasks; it does not turn a registered background service into a foreground child. Closing the application or clearing chat history retains background processes while Docker remains running, along with their historical task identity.

Runtime cancellation seals its foreground execution session while command startup is pending. Cancelling one selected task records only that task's cancellation, so sibling tasks and background services remain independent. Delayed preparation cannot launch a cancelled task. Deletion closes admission before releasing affected containers; a new scope cannot finish its first environment creation during retirement. Unchanged Worker observations retain their existing version and do not repeatedly emit UI refresh events.

**Sleep (休眠)** stops the container and interrupts its active foreground and background tasks, retaining named volumes. **Rebuild (重建环境)** replaces the execution container using the prepared image and retains the workspace. Wake/rebuild do not replay previous commands or restart old background services. A Worker reboot reports formerly active tasks as interrupted. If acceptance or connectivity is unknown, inspect the existing task and logs; the host does not automatically repeat its possible side effects.

Deleting a Bot or group stops/removes its affected containers and removes associated application metadata after the existing approval and busy checks. Docker volumes are retained. Removing a group member revokes that member's ability to read or operate that group's environment. App updates do not automatically rebuild an existing environment or replace its running image.

## Files and service ports

**Read directory**, **Read file**, **Upload file**, **Download file**, and **Save text file** operate inside that environment's workspace. Paths are relative POSIX paths; `.` is allowed for directories and command working directories. Absolute paths, traversal, symbolic links and special files are rejected by file operations. Native uploads use the user's file selection and downloads use the save dialog. Each transferred or read/written file is limited to 1 MiB of decoded bytes.

Writes create a new file by default. To replace an existing file, first read it and provide that exact SHA-256 as `expectedSha256`; concurrent changes fail instead of being overwritten. This rule governs the file API. Approved shell commands can modify files inside their workspace and contact external services, so command side effects are not automatically reversible. Binary downloads retain actual bytes; AI file reads return binary metadata rather than interpreting base64 as text or images.

To register a service port, select a running background process and enter its environment-local listening port. The Worker checks Linux listener ownership and actual connectivity before reporting `listening`; the record includes its check time. Ports are not automatically published to the host. Use [Browser and computer](BROWSER_COMPUTER.md) for previews tied to an actual registered service, screenshots and isolated desktop control.

## Connected AI operations

The same validated host service backs the interface and these 23 product operations:

| Family | Operations |
| --- | --- |
| `environments.*` | `probe`, `initialize`, `list`, `get`, `start`, `stop`, `rebuild` |
| `execution.*` | `list`, `get`, `run`, `cancel`, `logs`, `wait`, `listFiles`, `readFile`, `writeFile`, `pickUpload`, `downloadFile` |
| `processes.*` | `list`, `start`, `stop`, `registerPort`, `listPorts` |

Models discover them through `product_catalog → product_describe → product_execute`. The host supplies the current conversation and executing Bot and rejects a different scope. Mutations require genuine approval; tool declarations and loaded Skill instructions do not grant permission. Model-supplied Runtime identities or command nonces are rejected. The host derives stable command intent from the original message, executor and normalized arguments; retry reads an existing task rather than blindly launching it again.

Saved text Skills load instructions and auxiliary text. The current development candidate adds the separate [script-Skill runner](SCRIPT_SKILLS.md), with exact revision/entry/image grants and approval of each run. Native Gmail/Drive/Notion and voice remain later deliveries.

## Storage and isolation

The Worker control interface requires a per-environment token and is published only on `127.0.0.1`. Tokens remain encrypted in the host and are absent from public environment DTOs, tool metadata and ordinary job environments. Containers have a read-only base filesystem, resource limits and limited capabilities. No host HOME, Docker socket or browser profile is mounted. Docker execution retains outbound networking; it is not an offline environment.

Host SQLite stores environment configuration, task state, logs and port registrations. Docker volumes `aevoren-work-<environmentId>` and `aevoren-state-<environmentId>` store workspace bytes and private Worker state. Runtime IDs are historical provenance after chat history is cleared; new execution sessions still require a real, same-scope Runtime. Worker health verifies protocol version, Worker version, environment identity and implemented capabilities. Log retention is bounded to 1 MiB per job; the interface reports truncation and a new reader can start at the retained head.

## Images and third-party licenses

Worker and protocol versions are independent of the app version. The current script-Skill candidate builds Worker `1.2.0`, protocol `1`, with local image tag `aevoren-execution-worker:1.2.0`. Worker `1.1.0` introduced service previews; `1.0.0` provides the original execution interface. Existing environments retain their recorded version and require explicit rebuild for newer features. [The Dockerfile](../workers/execution/Dockerfile) pins the multi-architecture base:

```text
node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
```

The host records each environment's actual platform and built image digest. The pinned base digest does not freeze Debian packages fetched during a later build; inspect the resulting image for its installed package versions. Existing environments keep their recorded image until an explicit rebuild.

The [generated production dependency inventory](../THIRD_PARTY_NOTICES.md) covers npm dependencies packaged with the app. The separately built Linux image also contains independently licensed operating-system tools; these do not become Apache-2.0 merely because Aevoren launches them.

| Image component | License information |
| --- | --- |
| Node.js and bundled runtime libraries | Node.js is MIT; bundled components retain their own notices in the upstream distribution's `LICENSE` |
| Python 3 | Python/PSF and historical component licenses; image package notice `/usr/share/doc/python3/copyright` |
| Git | GPL-2 and separately licensed components; `/usr/share/doc/git/copyright` |
| tini | MIT/Expat; `/usr/share/doc/tini/copyright` |
| util-linux | GPL, LGPL, BSD and other per-file/component terms; `/usr/share/doc/util-linux/copyright` |
| Debian build toolchain and base utilities | Multiple package licenses, including GPL/LGPL; `/usr/share/doc/<package>/copyright` and `/usr/share/common-licenses/` |

The image keeps its Debian copyright/license files. Local inspection verified the Python, Git, tini, util-linux and build-essential notices in the built arm64 image. Before redistributing a built image, inventory that exact image and retain the applicable notices and source obligations; this npm table does not serve as an operating-system SBOM. Docker itself is user-provided and governed by its own distribution terms.

## Validation status

| Check | Evidence available in development |
| --- | --- |
| Full local unit suite | 1,285 passed, 20 skipped; opt-in Docker scenarios are verified separately below |
| Focused Worker/Docker/gateway suite | 33 passed without skips: 15 Worker unit cases, nine real Linux Docker Worker cases, five real Docker host-service cases and four AI product-gateway cases |
| Repository and admission | 22 real SQLite/schema tests plus two deterministic lifecycle-admission regressions passed, covering exact member cleanup, delayed first-start deletion and legacy revoked-scope recovery/shutdown |
| File and cancellation boundaries | Real 1 MiB decoded files with worst-case valid JSON expansion read back correctly; cancelled pending foreground startup cannot spawn afterward or stop an independent background service |
| Quality gates | Node/Web/Worker TypeScript, ESLint, open-source readiness, documentation links, npm licenses and security checks passed |
| Hidden source Electron | Three execution-environment scenarios passed using isolated data and controlled fixtures |
| Packaged app | Final unsigned v0.3.0-beta.28 macOS package: all three execution-environment scenarios passed, with `appVersion=0.3.0-beta.28`, `isPackaged=true`, and Worker/license guide loaded from Resources; this is not a signed/public release |
| Windows with a real Linux Docker engine | Not verified; CI without a Docker daemon does not prove this workflow |
| Published Stage 2 Beta | Pending branch promotion, installation validation and signing/release gates |

Tests use temporary application data and fixture environments. No user chat database, credentials or browser profile is used. See [the implementation plan](IMPLEMENTATION_PLAN.md) for later stages and final release evidence.
