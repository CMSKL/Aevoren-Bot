# User guide

This guide covers the v0.3.0-beta.44 local implementation candidate: reviewed portable templates and selected-scope offline exports, authenticated local Webhooks and metadata-only Runtime events, Bot/group MAIN Routines, personal organization, all-resource search, independent Task threads, media and voice, documents and text/script Skills, isolated Docker execution and browser/computer use, reviewable demonstration Skills, native connections, approved external drafts and scoped MCP Apps. Credentials remain in the host. See [Templates and offline export](TEMPLATES_EXPORTS.md), [Native connections](NATIVE_CONNECTORS.md), [External drafts](NATIVE_OUTBOUND.md) and [MCP Apps](MCP_APPS.md) for exact boundaries.

The six phases are implemented locally with recorded source and unsigned macOS-package acceptance. This is distinct from signed/public release availability. Later Beta versions still follow dev → beta validation and publication in order; master remains deferred. Exact per-version evidence and CI failures are preserved in the [implementation record](IMPLEMENTATION_PLAN.md), without treating focused checks as one complete all-green suite. Real cloud accounts, physical audio devices and Windows Docker remain unverified.

[Organization and Bot images](ORGANIZATION.md) passed local business, hidden UI and actual unsigned macOS-package acceptance; cross-platform and signed-release gates remain pending.

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

## Chat organization and Bot pictures

Choose **整理聊天** in the sidebar or **Settings → General → 聊天整理与通知** to create/order sections, move MAIN or TASK chats, choose the fallback default assistant and independently configure notifications/sound. Conflicts retain local edits. In **Contacts → Profile → 更换图片头像**, choose an authorized PNG/JPEG up to 2 MiB; the host publishes an owned 256×256 crop. The photo is visible as that Bot’s profile throughout its chats. Restore the default or duplicate a Bot without sharing mutable image identity. See [the detailed guide](ORGANIZATION.md).

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

Text Skill metadata, including declared tool names, does not grant tool permissions. The current development candidate adds [script Skills](SCRIPT_SKILLS.md): review a fixed entry, grant it access to the selected environment image, then confirm each run's arguments. Scripts use Bash, Python or Node inside that environment, with real execution output and cancellation. The separate approved Docker command workflow below and isolated [browser/computer tools](BROWSER_COMPUTER.md) remain available. [Demonstration drafts](SKILL_DEMONSTRATIONS.md), [native connections](NATIVE_CONNECTORS.md) and [approved external writes](NATIVE_OUTBOUND.md) are included in beta.35 with separate grants and fixed reviews. Local media, transcription/speech and Realtime voice are implemented source candidates with separate verification boundaries; see [Media](MEDIA.md), [Voice](VOICE.md) and [Realtime voice](REALTIME_VOICE.md).

## Task threads (development candidate)

Choose **New task (新建任务)** in the current chat header. Enter a title and explicitly select each executor. All Memory, quoted history, documents/Skills, media, Workspaces, MCP tools, product actions, network and clipboard permissions start empty. Creation opens a separate TASK chat and does not start a Runtime. Open it from the sidebar **Task threads (任务线程)** section; clicking a contact or ordinary group continues to open MAIN.

Each thread uses its own session ID, history and in-memory composer draft. Selected context is copied as fixed per-member revisions, not dynamically inherited from a parent or sibling. **Task details → Modify task authorization** reviews a separate selection revision. Existing runs and retries retain their original snapshot. A title conflict preserves the typed draft; reopen to review the current saved version. **Stop this task** cancels only this thread's active Runtime/Room batch; **Delete this task thread** requires an idle thread and preserves its Bot/group owner. See [Task threads](TASK_THREADS.md) for exact boundaries. All three targeted source UI scenarios have passed across the recorded runs; the actual unsigned macOS package also passed Task3 plus typed API (4/4), with cross-platform and signed publication pending.

## Docker execution environments (development)

Use your own running local Docker Linux engine. Open **Contacts → select Bot → Execution environment (执行环境)**, or **Group settings → Execution environment → select member**. Check Docker, prepare the Linux image, then start or wake the environment. Settings → General also provides a Docker status card. The first image build needs network access; remote Docker contexts and Windows containers are not supported.

Enter a command and a workspace-relative directory (`.` means the workspace root), then choose **Run command** or **Run in background**. The panel shows real task status, stdout/stderr, exit codes and cancellation controls. Foreground tasks default to 120 seconds; background services have separate lifetimes. Six group members use independent environments; cancelling one foreground task does not stop a sibling or registered background service.

**Read directory**, **Read file**, **Upload file**, **Download file** and **Save text file** operate on that environment's files, with a 1 MiB decoded limit per file. Native transfers use file dialogs. Saving creates a new file unless an existing file was read first; a replacement must match the last-read SHA-256. Paths cannot escape the workspace or traverse symlinks/special files. Binary files can be downloaded without pretending the model understands their contents.

Closing the application and clearing history retain background services while Docker remains running. **Sleep** interrupts the environment's tasks and retains its workspace. **Rebuild** replaces the execution container and retains the workspace. Neither wake nor rebuild replays old commands. Unknown acceptance/connectivity means check the existing task and logs before starting new work. Deleting a Bot or group releases its containers after the normal approval/busy checks and retains Docker volumes.

For a running background service, register its listening port. The Worker verifies that the listener belongs to that process and reports its actual check time. **Preview** opens that registered service in the isolated browser; the original process's exit invalidates it. Execution Worker 1.1.0 is required, and older environments need an explicit rebuild. Setup, isolation, image versions, licenses and platform validation are documented in [Execution environments](EXECUTION_ENVIRONMENT.md) and [Browser/computer](BROWSER_COMPUTER.md).

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
- Routines support one-time, interval, and five-field cron schedules for Bot/group MAIN conversations. They depend on the selected Provider, permissions, and local app availability; see the workflow below.


## Bot and group Routines (beta.42 local candidate)

Open **Settings → 主动服务**, enter a name and saved task prompt, and choose **Routine 执行目标**. Only Bot and Room MAIN conversations are offered. A new rule starts paused; enable it after review or choose **立即运行** for one execution. TASK Routine targets are not supported. Events and local Webhooks are configured separately as described below.

A Room defaults to **Everyone · 保存当前全部成员**. This saves a fixed roster and uses the existing parallel group path; a member waiting for approval does not block its siblings. **只运行勾选成员** saves an explicit subset instead. The saved card shows the chosen members, session generation, reviewed membership version and rule version. Adding a member never silently adds it to an existing rule.

After a membership, selected Bot profile or authorization change, edit the rule and choose **重新选择并审阅目标**, check the members, then save. Explicit subsets retain only their still-present selected members; new members start unchecked. The UI refreshes the actual MAIN target before saving and the host checks the reviewed membership version. Conflicts preserve the draft. Changing the target conversation explicitly clears that rule's fixed document/media references; this editor currently has no resource picker.

**取消本次运行** cancels only the selected accepted Runtime or Room batch. **正在取消** remains visible until the host confirms an outcome; pausing the definition affects future scheduling. Recent runs show actual durable states and can be refreshed. An unknown acceptance result is kept as **结果未知**, without replaying the saved task after restart. Tool approvals and external-write verification still apply. Connected AI uses the same business handlers and current version checks, scoped to its actual MAIN conversation. See [Group Routines](GROUP_ROUTINES.md) for scope, recovery and pending acceptance gates.

## Events and local Webhooks (beta.43 local candidate)

Open **Settings → 事件与 Webhook**, explicitly select and review an enabled MAIN Bot/group Routine, then save a paused or enabled subscription. Internal completion/failure events require an explicitly selected source conversation and carry only opaque IDs/status, including for a private TASK source. Connected AI can manage subscriptions only within its current admitted MAIN session. It can also request application-wide listener start/stop through explicit approval of a fixed port and current state. Credential rotation stays in trusted settings.

For Webhooks, explicitly rotate the secret, copy the once-displayed token and start the listener. It is stopped by default and after restart; the page shows the actual loopback port and versioned URL. Send UTF-8 JSON with Bearer authentication and an Idempotency-Key. The payload remains an untrusted ordinary attachment; it cannot grant permissions or approve tools. Edits invalidate the old URL, rotation/revocation invalidate its token, and changes stop only that subscription's owned active runs. Unknown outcomes are reconciled without replay. See [Events and local Webhooks](AUTOMATION_EVENTS.md) for limits, recovery and acceptance evidence.

## Updating

Development builds do not check for updates. Signed Beta and Stable builds use the GitHub Release channel declared by their SemVer. Checking and downloading stay in the background; progress, errors and manual checks are available in **Settings → Updates**. Only a downloaded update displays a compact notification with its version, **Restart to update** and a close control. Closing the notification does not cancel the download or install an update. Installation waits for an explicit restart or the next normal quit; a manual restart is blocked while any task is executing. A failed update keeps the current version usable.

## Safe evaluation

Use a separate user-data directory for migrations, failure injection, or destructive tests:

```bash
AEVOREN_BOT_USER_DATA_DIR=/absolute/path/to/test-data \
AEVOREN_BOT_FAKE_PROVIDER=1 pnpm dev
```

Never paste real API keys, private transcripts, account data, or personal paths into public Issues, screenshots, fixtures, or pull requests. See [Troubleshooting](TROUBLESHOOTING.md) when a normal flow does not work.


## Demonstration Skill drafts

In a member's **Computer** panel, take over and connect the isolated computer, then explicitly start a demonstration. The counter records only accepted pointer/button transitions and selected navigation keys. Text, typed URLs and clipboard contents become placeholders; page content and screenshots are not captured. Closing the viewer interrupts recording and preserves human control.

Stop to create an editable `SKILL.md` draft. Save changes before publishing; a conflict preserves the local editor. Publish the saved fixed version only after reviewing placeholders and coordinates. The result is initially disabled in this conversation's Library / Skill; enable it explicitly when ready. This creates no execution grant and starts no task. AI publication uses the saved full-body approval snapshot, and edits invalidate the old approval.

This development unit requires Browser Worker 1.1.0. Older environments continue running; explicitly stop and rebuild when ready. See [Skill demonstrations](SKILL_DEMONSTRATIONS.md) for limits, scope and pending Docker/cross-platform validation.

## Scoped MCP tools and Apps

The beta.35 candidate retains the beta.34 [scoped MCP tools and isolated Apps](MCP_APPS.md) to the existing Contact/Room Applications sections. Grant specific tools, approve fixed JSON arguments and targets, and query unknown results without resending. Server-reported results and real third-party verification remain distinct.


## 图片与文档（beta.36 开发候选）

在私聊或群的资料库中打开媒体区，或点击输入框文本附件旁的媒体入口，导入／选择图片、PDF 或 DOCX。只发送媒体也走原有任务流程；引用固定原始摘要及解析版本，群成员可并行读取同一已授权引用。预览、撤销、停用、删除和恢复均按当前会话权限检查；导入期间继续编辑不会被旧结果覆盖。PDF 支持逐页预览和文字提取，扫描件无 OCR；DOCX 显示纯文本分节。图片实际传输和模型是否支持视觉分别标识。当前仍在验收，完整限制见[媒体与文档](MEDIA.md)。


## 转写与朗读（beta.37 开发候选）

在设置 → 语音分别配置转写、朗读和 Realtime。点击输入区工具栏的“语音”展开控件，普通聊天默认保持收起。关闭面板会停止其录音与播放，并使正在等待的插入操作失效；已派发的转写任务保留在历史中，可重新打开后单独查询或停止。点击录音主动授权音频，停止后显示独立转录任务；手动插入会核对会话与草稿版本，冲突保留结果，发送仍走原有聊天流程。回复的朗读入口生成真实 WAV，当前会话可选择按新回复完成顺序排队，停止会清理队列并拒绝迟到音频。媒体库支持平台实际可解码的有界音视频。实时连接、物理设备与云账号的验收状态见[语音说明](VOICE.md)。


## 实时语音（beta.38 开发候选）

聊天面板选择业务 Bot 后主动连接，逐轮开始说话／结束并提交。停止语音与停止已委派业务任务分开；重新连接需要用户操作，不自动复播未知请求。详细流程、采样打断、授权和未验证边界见[实时语音](REALTIME_VOICE.md)。



## Search saved resources

Use the search icon beside the chat/contact filter to open **全资源搜索**. Choose the current conversation, current project or all local resources, enter a literal keyword and search. Results open their original message, immutable document/Skill revision or saved media/transcript source. A revoked or cleared source cannot redirect to another similar item. Connected AI searches only its actual current conversation and explicitly selected Task context. See [Search](SEARCH.md) for supported sources and verification limits.

便携模板和选择范围导出请见[使用说明](TEMPLATES_EXPORTS.md)。入口为聊天选项或设置通用页；先选择并审阅，再保存或导入，Skill 初始停用。
