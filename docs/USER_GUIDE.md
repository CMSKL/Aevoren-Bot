# User guide

This guide covers the v0.3.0-beta.27 document/text-Skill workflow. Download published installers from [Beta releases](https://github.com/CMSKL/Aevoren-Bot/releases). It applies to macOS 13 or newer on Apple silicon and the Windows 10/11 x64 MVP validation build.

## First run

1. Follow [Installation](INSTALLATION.md). The ordinary app uses your configured API or an installed, authenticated CLI; the Fake Provider is only a development test fixture.
2. Use **Contacts** or **New chat** to create a Bot. Its name, label, description and Instructions are edited within **Contacts → Profile**, without opening a chat details panel.
3. Open that contact's **Models & capabilities** tab and choose API, Claude Code, or Codex CLI. Expand **Local connection settings** to configure API or scan the two supported CLIs, then use **Test real request** to check the connection. Connection settings are shared; the source and model selection belong to this Bot.
4. Click **Send message** to enter the Bot's conversation. **Chats** contains recent direct and group conversations. Existing folder/project and archived-chat management is available through **Settings → Capabilities & permissions → Local files and chat management → Open management**.
5. Send a message from the center composer. You can attach up to six bounded text, code, CSV, JSON, YAML, or Markdown files. Replies render directly in the conversation; saved Workspace outputs appear in task details. Stopping, retrying and interrupted states remain available.

## Interface and appearance

The narrow left navigation switches between Chats and Contacts. Existing Workspace/project management is available through Settings. Settings stays at the bottom. The adjacent list keeps names, previews, unread markers and actual activity times together; project-specific creation remains under the corresponding Workspace.

Choose **Dark** or **Daylight** in **Settings → General**. Both themes use the same layout and controls. Click the personal avatar at the top of the navigation to change your nickname or upload a PNG, JPEG or WebP image up to 5 MB. Cropping and storage happen on this computer; the app saves a centered 256-pixel PNG. The personal avatar updates in your messages and group collages. Bots receive stable cartoon-human portraits derived from their existing saved avatar identity.

The conversation's **…** menu opens group management, files and execution records. Edit Bot profiles and model selection within **Contacts**; group management opens in a closable dialog. The next-message response mode sits beside **@** in the composer; explicit mentions still override it. **View collaboration details** or **View tool activity** above a related message expands that message's records without adding a permanent process panel. Enter sends; Shift, Ctrl or Cmd + Enter inserts a newline.

## Documents and text Skills

### Create, import and bind

For a Bot's private MAIN conversation, open **Contacts → select Bot → Library (资料库) / Skill**. For a group, open **… → Group settings → Library / Skill**. These resources belong to the selected session; joining a Bot to a group does not bring its private library into that group.

Use **New document / New Skill** to edit a name, description and Markdown body, or **Import file** for UTF-8 text. **Import Skill directory** accepts a directory containing `SKILL.md` with YAML `name` and `description`. Skill names in that frontmatter use lowercase letters/digits separated by hyphens. Imported references, scripts and assets retain their relative paths and checksums; application-owned copies remain available after the original directory is moved or removed. The import reports unsupported entries instead of treating them as successfully loaded.

Each text or resource file is limited to 1 MiB; an import and a saved resource's body plus files are limited to 4 MiB, with at most 250 files. Symlinks, path traversal, invalid UTF-8 and invalid Skill metadata are rejected or explicitly skipped; ignored build/dependency directories are not imported. Cancellation or invalid input does not publish half of the accepted resource set.

**Add existing resource → Add to current conversation** explicitly shares an existing resource. Its future versions are shared by all bound conversations, but sent messages retain their fixed revision. **Remove from current conversation** revokes only that session's binding. **Delete resource** affects every bound session and preserves recoverable contents; use **Show deleted → Restore resource** to restore it. These library actions remain available while an earlier reply is streaming.

### Edit, review and recover

Editing creates an immutable revision and uses the expected current version to detect concurrent changes. Conflicts preserve your local draft. **Read latest version, keep draft** updates the saved baseline; expand **Current saved content** to review it before saving again. Leaving a changed resource requires **Save and continue**, **Discard draft and continue**, or **Continue editing**. Markdown preview skips raw HTML and does not execute imported code.

**Version history → Restore this version** creates a new revision from the selected historical contents. **Export saved version** writes the selected revision to a user-chosen destination. Document exports contain its saved text; Skill exports create a new directory containing `SKILL.md` and its accepted resource paths. Existing destinations are not overwritten. Exports can be imported again with the saved bytes and metadata preserved.

### Use a fixed reference in a message

In the composer, type `/` to search Skills, or `@` and choose the **Documents / Skill** group. Group chats retain the separate **Bot** and **Everyone** choices: selecting a document or Skill does not select a Bot or change group routing. Selected resources appear as removable chips, and a message accepts up to 20 references.

**Add Skill to message (添加 Skill 到消息)** prepares the ordinary composer. It retains existing text and fills the default task prompt only when the composer is empty. Click **Send** after adding the actual task; selection alone does not create a Runtime. Drafts and references remain scoped to their session when switching chats. A successful send clears only the unchanged submitted draft; concurrent new typing remains intact.

The message pins `resourceId`, `revisionId` and `digest`. Editing the resource later does not rewrite that message or a member's retry context. Disabled, deleted or unbound resources cannot be read again; historical messages retain the reference ID and display an unavailable badge where the current session has no access.

### Connected AI access and current limits

Connected models discover the 38 new `library.*`, `documents.*` and `skills.*` operations through `product_catalog`, `product_describe` and `product_execute`. `skills.load` returns an authorized text Skill to the current Runtime; `skills.readFile` reads accepted auxiliary text, with paging and truncation information. Binary assets return metadata only. File imports from AI must use the current conversation's authorized Workspace; selecting arbitrary native import/export locations requires the user's file dialog interaction. Mutations and sharing continue through the existing permission and approval rules.

Text Skill metadata, including declared tool names, does not grant tool permissions. Scripts are preserved and may be read as text, but do not execute. This stage does not provide Docker terminals, browser sessions, desktop control, native Gmail/Drive/Notion connectors, media interpretation or voice. Those capabilities remain later stages in the [implementation record](IMPLEMENTATION_PLAN.md).

## Content-team workflow UI

- A one-click content team avoids a persistent stage tracker. It shows a compact decision card only while a real Brief is waiting for user input.
- In that card, choose candidate A/B/C, return the Brief for more evidence, or abandon the run without writing orchestration prompts.
- Routine tool records are available on demand in task details. Necessary approvals use a scoped dialog; model text alone never produces a successful execution state.
- The latest failed Room step stays visible above the composer with the failed step, safe reason, preserved evidence, and retry action. Superseded failed attempts collapse after a successful retry.
- Real Workspace writes render as artifact cards. Files and execution records remain available from the conversation's **…** menu, and each saved file can reveal its validated location; there is no per-reply Markdown save button.
- The Room composer holds the Automatic, `@` Specific Bot, and Everyone default; a structured `@` mention overrides that choice for the current message.

## Bots and Rooms

- A direct Bot conversation has one MAIN Session and a durable SQLite Transcript.
- Contacts remain available after their chats are removed from the recent list. **Send message** restores the same chat. **Clear history** removes only that chat's records, retaining the contact, accepted Memory and actual files; active tasks must finish or be stopped first. Deleting a contact remains a separate confirmed action.
- Replies completed while a chat is not visible are marked unread. Reading that chat clears the marker; manual unread and pin controls are also available.
- A Room contains 2–6 Bots. Select explicit `@Bot` targets or use the automatic owner route.
- New ordinary Rooms can have a fixed **Group coordinator**. Choose an available model source that supports structured Handoffs, or choose no coordinator to keep the existing automatic route. In automatic mode the coordinator assigns bounded, ordered work; the Host executes those assignments and brings the verified member results back for one final summary. The summary does not run more tools. A simple conversational reply does not need a delegation chain.
- Explicit `@Bot` and **Everyone** are fixed dispatch modes: only the requested members respond, without launching an extra internal Handoff chain. Choosing a coordinator does not override these modes. **Everyone** starts all members concurrently; each streams its own reply, and one member's slow response, approval wait or failure does not block the others. Stop cancels all active members.
- Completion of a member's file work and completion of the whole group task are separate. If a later assignment fails, earlier verified files remain valid and the group is partial, even when the coordinator successfully explains the failure. Retry the failed work rather than asking every member to repeat it.
- After the cause of a failure is corrected, retrying that member also resumes its originally planned dependents that never ran and were skipped only because their prerequisite failed. Already completed work and deliberately cancelled steps are not rerun; earlier attempts remain in the execution history and the latest summary is the effective result.
- Existing Rooms and content-team templates are not silently assigned a coordinator. Their Brief approval still pauses before writing; approving a Brief resumes the existing content-team chain, not an additional coordinator-summary loop.
- A Room preserves speaker identity, source turns, bounded handoffs, cancellation, and recovery in one transcript. A Bot's ordinary text such as `@OtherBot` is descriptive only; the next Bot starts only after a validated structured Handoff event, which prevents accidental calls and loops.
- Use the sidebar context menu for pin, hide, rename, archive, and deletion actions. Destructive actions require confirmation.
- Each workspace's **Bot +** creates a contact with a chat explicitly associated with that workspace; **Room +** opens global member selection. A contact may join groups in multiple projects without carrying private chat history, Memory or folder grants into them.
- Ask an API or Codex CLI Bot to create roles or a Room. It uses `project_list_bots`, `bot_create`, and `room_create`; approve each creation once. New roles inherit the creator's model/MCP restrictions, have no copied history or Bot Memory, and start no tasks. Identical commands in one request reuse the existing resource; each creator can create at most eight new resources per request. Members are global contacts, but a new Room receives only the requesting chat's explicit folder context, never the combined permissions of its members. Secret-bearing profiles are rejected. API, Codex and compatible Claude paths also provide `product_catalog`, `product_describe` and `product_execute` for the complete product operation directory. Use actual IDs and await real results; private reads and mutations require the corresponding user authorization. AI-delegated messages and Routine messages have explicit source identity. See [AI product operations](AI_PRODUCT_OPERATIONS.md).

## Memory and tools

- Memory is scoped to the user, a Bot, or an authorized Workspace. Background capture creates reviewable candidates from the current user message; accept, edit, or reject them in **Settings → Long-term Memory**. Only accepted, active, non-expired items enter later prompts. Turn off **Background Memory candidates** there when no secondary extraction request should be made.
- Workspace access is limited to roots selected by the user. Read/list/search are available by default; create-only Markdown/CSV and automatic Workspace approval require separate per-Workspace switches. Existing files are never overwritten or deleted.
- Open the existing Workspace manager through **Settings → Capabilities & permissions → Local files and chat management → Open management**. Click **+** beside Workspace to select a local folder and use its settings icon to manage permissions. From a chat's files, open **Manage folders** to bind or detach **Current chat workspace** directly in the permissions window; changes wait until its current tasks finish. New ordinary chats and duplicated contacts start with no folder access. Legacy chats retain the exact folders authorized at migration time; adding future folders does not silently expand that snapshot. File operations recheck the current chat's grant before execution and before returning data or publishing a new file.
- File access permission and Workspace Memory injection are separate controls. Granting file access does not inject a Workspace into long-term model context.
- **New chat → Create content team** atomically creates the research, planning, writing, fact-editing, and analytics Bots plus their Room. The planning-to-writing Handoff is blocked until the current user message explicitly approves a candidate.
- Chat shows the reply and saved artifacts. Open **Files** or **Execution records** from the **…** menu, or expand the evidence entry above a relevant message; records stay backed by the Tool Journal rather than model completion claims.
- Claims that a file/source was read, fetched, verified, or written require a succeeded Tool Journal record in the same Runtime. CSV metrics additionally require a successful read of that CSV; exact length claims require `text_measure`. Unsupported claims fail the Runtime instead of being presented as completed work.
- For source-based file tasks, the receiving member must successfully read the requested sources and the upstream artifact before creating its report. Inherited artifacts carry verified paths and checksums; handing over a path is not treated as a new read. Missing reads or an incorrect requested output path are returned for correction before a new file is created. These checks establish execution provenance, not a guarantee that every sentence in a model-written report is correct.
- Network and MCP tools are disabled or approval-gated by default. Review exact tools before allowing a call.
- The first public-information approval offers **Allow public queries and remember**. This explicitly enables the existing public-read setting and approves the current query once; subsequent public search/fetch, weather and time queries run in the background. It does not authorize files, clipboard, MCP or external writes. Close/reject the dialog or stop the task if you do not consent. **Allow once** does not save a lasting permission.
- Turn remembered public queries off in **Settings → General → Automatically approve public read-only tools**. Local and other protected operations keep their original per-Workspace or per-call authorization. Already-waiting unrelated requests are not silently approved by the new entry.
- Built-in web search returns untrusted public-index results with source URLs and retrieval time. Verify consequential or time-sensitive claims against the returned sources.
- Routines support one-time, interval, and five-field cron schedules. They depend on the selected Provider, permissions, and local app availability.

## Updating

Development builds do not check for updates. Signed Beta and Stable builds use the GitHub Release channel declared by their SemVer. Checking and downloading stay in the background; progress, errors and manual checks are available in **Settings → Updates**. Only a downloaded update displays a compact notification with its version, **Restart to update** and a close control. Closing the notification does not cancel the download or install an update. Installation waits for an explicit restart or the next normal quit; a manual restart is blocked while any task is executing. A failed update keeps the current version usable.

## Safe evaluation

Use a separate user-data directory for migrations, failure injection, or destructive tests:

```bash
AEVOREN_BOT_USER_DATA_DIR=/absolute/path/to/test-data \
AEVOREN_BOT_FAKE_PROVIDER=1 pnpm dev
```

Never paste real API keys, private transcripts, account data, or personal paths into public Issues, screenshots, fixtures, or pull requests. See [Troubleshooting](TROUBLESHOOTING.md) when a normal flow does not work.
