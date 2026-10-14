# Isolated browser and computer

Stage 3 adds a browser and Linux desktop beside the local Docker execution environment. This document describes the implementation under validation; check [Beta releases](https://github.com/CMSKL/Aevoren-Bot/releases) and the [implementation record](IMPLEMENTATION_PLAN.md) for published availability and platform evidence.

## Start and use

Use a running local Docker Linux engine. Prepare and start the execution environment, then open **Contacts → Bot → Browser / Computer**, or select a member in **Group settings → Browser / Computer**. The first browser image build downloads Chromium and desktop dependencies. The browser belongs to the selected conversation and executing Bot; the same Bot in another group receives a separate profile.

The browser panel lists real tabs, opens HTTP(S) addresses, reads page text and exposes freshly observed element references for input. The computer panel shows actual desktop pixels. **Take over** transfers control to you; **Connect computer** opens the same Chromium desktop through noVNC. Closing the panel, an expired connection ticket or a disconnected connection keeps your control. **Return to AI** explicitly returns it and requires a new observation before the next AI input. While you hold control, AI DOM reads, screenshots and inputs are blocked.

Completed downloads contain verified bytes, sizes and digests. Choose a new host destination to save a download; existing files are not overwritten. Failed or oversized downloads appear as errors rather than completed resources. The host download limit is 1 MiB per file.

Run a background service in the execution environment, register its real listening port, and choose **Preview**. The preview is bound to that registered process. Absolute application paths and WebSocket connections use a private capability hostname. Stopping or replacing the original process invalidates its preview; a different process taking the same port does not inherit access. Closing a preview does not stop the background service. Preview tickets expire after one hour; create a new preview rather than replaying an expired intent.

## AI tools and image transport

The same host handlers serve the interface and `product_catalog → product_describe → product_execute`. The `browser.*`, `computer.*` and `preview.*` families provide 27 actions. Browser writes require the existing approval workflow and stable intent identifiers. AI requests to take over, return control or create a VNC connection return `waiting_user`; the user controls these actions in the interface.

`computer.screenshot` transfers bounded PNG/JPEG bytes through the host image carrier, rather than returning a path as visual evidence. API sources receive image data in a user message after the complete tool response group. Claude MCP responses carry image blocks. Codex app-server sources use the verified `inputImage` contract for CLI versions 0.162.1 or newer. The host rechecks scope, control epoch and active Runtime immediately before transmission. Pixels are kept out of the Tool Journal and transcript tool text.

Transport support does not prove that the selected model accepts or understands images. Unsupported adapters retain DOM operations and report that screenshot interpretation is unavailable. No real cloud inference is implied by local transport tests.

## Isolation and lifecycle

Each `(sessionId, executorBotId)` has its own execution container, browser companion, scoped Docker network and named volumes. Browser profile, download and private supervisor state volumes are not mounted in the execution container. Browser control credentials are not passed into the model Shell or renderer. Control endpoints bind to loopback; VNC is served through an expiring, epoch-bound host ticket. The desktop is Xvfb/Openbox/Chromium/x11vnc; the image runs an unprivileged browser engine and a separate supervisor.

Sleep stops containers and retains volumes. Wake checks actual health and preserves user ownership, and never replays a previous command or input. Explicit environment rebuild recreates the companion from the current image while retaining its profile and control ownership. App upgrades do not automatically replace running environments or their background services. New preview support requires an explicit rebuild of an older execution image.

Execution Worker 1.1.0 adds the preview proxy; browser Worker 1.0.0 uses Playwright Core 1.63.0. Images record their actual platform and immutable digest separately from the application version. Both use the pinned base manifest `node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`. See [third-party notices](../THIRD_PARTY_NOTICES.md) for host dependencies; Debian and Chromium distributions retain their own notices in the image.

## Current boundaries

Only the application's local Docker environments are controlled. Host Shell/GUI control, copying existing browser cookies, remote Docker and remote deployment are outside this implementation. The browser has outbound network access and may encounter an account login; log in only inside the selected isolated profile. Application connectors, executable Skill grants, document interpretation and voice follow later stages.

Actual macOS arm64 and Linux Docker checks, package checks and remaining platform limitations are recorded with evidence in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Windows x64 uses a local Linux container runtime; real Windows Docker/desktop validation remains pending until run on such a host.
