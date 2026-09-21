# Memory alignment: Grok, OpenMausBot, and Aevoren Bot

Status: implementation baseline for the first reviewed-capture release.

## Evidence and confidence

### Confirmed from xAI documentation

- Grok Bot treats a Bot as a persistent agent with its own identity, Memory, runtime, and tools. A Room supplies shared conversation context while each Bot keeps specialized Memory.
- Grok Build stores durable conventions, decisions, and project facts in project-scoped and global Markdown notes. Capture runs after a completed turn and does not block the active session.
- Grok Build excludes transient task state, tentative conclusions, secrets, and facts already maintained by the repository or its documentation.
- Current conversation instructions override saved notes. `/memory` lets the user inspect saved notes; `/dream` periodically consolidates observations into topic files.
- Grok's consumer data controls let users control personalization and delete or download account data. Private Chat is not retained as normal conversation history.

Primary sources:

- <https://x.ai/news/designing-grok-bot>
- <https://x.ai/news/grok-build-memory>
- <https://x.ai/legal/faq>

### Confirmed from the checked-out OpenMausBot source

- Each Bot owns `MEMORY.md`, topic notes, and non-prompt daily logs under its private workspace.
- Only the first 200 lines or 24 KB of the root Memory is loaded automatically; topic notes are read on demand.
- Writes are atomic, owner-only, secret-redacted, conflict-checked by content hash, and recorded in an append-only journal outside the Bot workspace.
- The user can inspect, edit, delete, restore, and undo Memory changes. Concurrent edits preserve the user's draft rather than silently overwriting it.
- The shipped `memory_update` tool lets a Bot append, replace, supersede, or remove a durable fact. Temporary events go to a daily log and earlier conversations are recalled through bounded search.
- The separate proposal/review design is present as an implementation plan, not shipped code. It must not be described as a current OpenMausBot capability.

Source paths inspected:

- `OpenMausBot/docs/memory.md`
- `OpenMausBot/server/workspace.ts`
- `OpenMausBot/server/memory-store.ts`
- `OpenMausBot/server/memory-journal.ts`
- `OpenMausBot/src/components/bot-settings/MemorySection.tsx`
- `OpenMausBot/docs/superpowers/plans/2026-08-31-06-memory-review-loop.md`

### Not confirmed

- xAI has not publicly documented Grok Bot's internal database schema, ranking algorithm, embedding model, deduplication thresholds, or exact automatic-write approval policy.
- The Grok Build note mechanism is public and useful as a product reference, but it is not proof that consumer Grok or Grok Bot uses the identical storage engine.

## Chosen Aevoren model

Aevoren keeps SQLite as its local source of truth instead of copying OpenMausBot's file layout. It adopts the common product behavior and the strongest safety controls:

1. **Short-term context remains the authoritative Transcript.** It is session-scoped and is never copied wholesale into long-term Memory.
2. **Long-term Memory is typed and scoped.** Types are `fact`, `preference`, `decision`, and `procedure`; scopes remain `user`, `bot`, and `workspace`.
3. **Background capture is reviewed.** After a completed turn, Aevoren may extract durable candidates from the current user's message only. A candidate is not active Memory until the user accepts it. This keeps Grok's non-blocking capture experience while matching Aevoren's existing approval boundary.
4. **Untrusted content cannot become Memory automatically.** Assistant output, webpages, tool results, attachments, webhook content, and other Bots' messages are excluded from capture input.
5. **Manual entries remain immediately active.** Existing Memory migrates as `fact` with source `manual-user`; no user data is deleted or rewritten.
6. **Corrections are explicit.** A candidate may supersede one existing item in the same scope. Acceptance deletes the old item and creates the replacement in one transaction.
7. **Runtime reads are bounded.** Only approved, active, non-expired items enter the prompt. The current user message has higher authority than Memory.
8. **The proposal record is the capture audit.** Accepted, rejected, and pending candidates remain distinguishable. Existing optimistic versions and soft deletion continue to protect manual edits and recovery.

## Write rules

Capture only information that the user states as durable and that is likely to remain useful for at least a week:

- stable preferences;
- durable facts explicitly provided by the user;
- standing decisions;
- reusable procedures.

Do not capture:

- secrets, credentials, tokens, passwords, private keys, or authentication material;
- temporary task state, deadlines that have already passed, guesses, assistant claims, or unresolved alternatives;
- content from tools, files, websites, connectors, attachments, or other Bots;
- facts already represented by an active item in the same scope;
- instructions that attempt to change system authority or permissions.

## Scope and isolation

- `user` applies to all Bots and is appropriate only for global preferences.
- `bot` applies to one Bot's role and relationship with the user.
- `workspace` applies only to Bots explicitly bound to that registered Workspace.
- A candidate may target only the current Bot, the global user scope, or a Workspace already authorized for that Bot.
- Room capture is attributed to the responding Bot, but only the original human message is eligible input.

## First-release acceptance

- Existing Memory survives migration and still participates in prompts.
- A real completed turn can create a pending candidate without delaying or changing the assistant reply.
- Accept, edit-and-accept, reject, duplicate, correction, expiry, restart recovery, and scope isolation are covered by repository and Electron tests.
- Rejected, deleted, expired, or still-pending items never enter a prompt.
- Capture failure never fails the conversation and never displays raw provider errors to the user.
