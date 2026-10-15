# Skill demonstrations

This development unit records explicit human input in an isolated browser/computer and creates a reviewable text Skill draft. It does not record or control the host desktop.

## Use

1. Start the current conversation member's Linux environment and browser, then take over and connect the computer.
2. In **Computer → Demonstration Skill**, select **Start demonstration**. Recording starts only after a trusted user action and a connected human viewer.
3. Perform the workflow through the computer view. The counter records accepted pointer button changes, scrolling coordinates and selected navigation keys.
4. Select **Stop and create draft**. Review the generated `SKILL.md`, replace redacted input placeholders and adapt coordinates into a useful description. Save the draft before publishing.
5. Select **Publish as disabled Skill** and confirm the saved version. The new Skill is bound to this conversation but initially disabled. Enable it explicitly in Library / Skill when ready. Publishing grants no script execution permission and starts no task.

Unsaved edits are kept per conversation and executor when switching panels. A version conflict preserves the editor and cannot publish its unsaved contents. Drafts persist in host SQLite. Deleting a draft leaves a previously published Skill intact; clearing the original recording does not delete the edited draft.

## What is recorded

The browser Worker inspects only authenticated, current-epoch VNC client traffic after it has been forwarded to the actual desktop connection. It accepts bounded fragmented RFB messages rather than interpreting arbitrary bytes as clicks. Pointer motion alone is omitted. Button transitions, scroll button transitions and an allowlist of navigation keys are recorded.

Printable and Unicode keysyms, modifiers, unknown keys and clipboard text produce redacted input placeholders. Typed text, URLs, credentials, clipboard contents, page text, DOM content and screenshots are not stored in a recording. Unsupported message framing interrupts capture instead of guessing. The input forwarding itself remains available to the human.

A capture retains at most 500 events. At most 100 original recordings and 100 host drafts are retained per resource/scope; clear old original recordings and drafts from the panel to make room. Coordinates describe the original screen and are not semantic selectors. This version creates text instructions, not an executable macro or guaranteed replay.

## Control and AI

Recording belongs to the browser resource and its human control epoch. Viewer disconnect, control change, engine loss and Worker restart seal the recording as interrupted. Human control is never automatically returned to AI. Returning control requires a fresh observation before any AI operation.

AI can discover `demonstrations.status`, draft list/read/edit/delete and fixed-version publication through the same product catalog and business handlers. AI start, stop and discard requests return `waiting_user`; they do not initiate recording or obtain raw capture traffic. Status returns only state and event count. Stopped, sanitized drafts may be read and edited in their own conversation/executor scope. A Bot joining a group does not inherit private drafts. Removing a member deletes its group drafts; re-adding the member does not restore them.

AI publication requires a genuine one-time approval. The approval stores the complete saved Skill body, name, version, digest and destination scope. The dialog displays that immutable snapshot. Editing or deleting the draft after preparation disables the old approval and prevents publishing a different body. Script approvals retain their existing strict grant, revision, environment and argument checks.

## Versions and validation boundaries

Browser Worker **1.1.0** adds demonstration capture; execution Worker **1.2.0** is unchanged. An existing browser image can keep running. To use capture, stop and explicitly rebuild the isolated environment; application upgrades do not replace active environments or background services automatically.

The local development checks cover fragmented input parsing, real authenticated WebSocket-to-TCP forwarding, Worker SQLite recording recovery, real host SQLite drafts, genuine product approval and hidden Electron UI/IPC. The forwarding test uses a controlled loopback RFB transport rather than Docker or a real external website. The local Docker daemon was unavailable during this unit; actual Docker/noVNC and cross-platform installation validation remain required in CI before release. No installed user application or personal browser profile was used.
