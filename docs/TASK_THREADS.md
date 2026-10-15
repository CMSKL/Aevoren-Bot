# Task threads

Source candidate `v0.3.0-beta.39` implements independent private/group TASK conversations. The full source build, focused checks and three distinct hidden Electron scenarios have passed across separate recorded runs. The actual unsigned macOS arm64 package passed all three Task scenarios plus typed API (4/4). Cross-platform and signed publication are still pending; this page does not describe the published beta.33 installer.

## Create and open a task

Open the parent chat and select **New task (新建任务)** in its header. Enter a title and explicitly check the executing Bot or group members. Every context and permission selection starts empty, including Memory, quoted history, documents/Skills, media, Workspaces, MCP, product actions, public-network tools and clipboard access. Checking a member does not select its private data.

Review the optional context and permissions separately for each executor. Resource revisions, media digests, Memory versions and quoted history entries are fixed when saved. Workspace read, write and automation permissions have separate ceilings; existing global settings cannot expand them. The initial task MCP selection supports explicitly chosen read-only tools with a fixed server/configuration/credential identity.

**Create task thread (创建任务线程)** opens a new chat without running a model or creating a first message. Task rows appear separately in **Task threads (任务线程)** and are identified by session ID. Clicking a contact or ordinary group opens its existing MAIN conversation. Multiple tasks can share one owner without sharing transcript entries or composer drafts. Drafts are cached per session while the app is running; persistent draft recovery across an application restart is not promised.

## Send and revise context

Send through the ordinary composer, Runtime, tool approvals and result records. Group **Everyone** uses the task's admitted members and retains parallel execution; one member's failure or cancellation does not stop other members or sibling threads. Environments and browser profiles remain isolated by task session and executor.

**Task details (任务详情)** shows the session and parent IDs, title/version, admitted executors and selection digests. Changing a task title does not rename its Bot/group. Concurrent title changes preserve the typed draft and reject the old expected version; close and reopen to review the latest saved version.

**Modify task authorization (修改任务授权)** is a separate, explicit selection review. It creates a new selection version. An existing Runtime and its retry retain the original selection; later permissions, context or parent messages are not silently added. Retired authorization can reject the old run instead of reviving it. Removing then readding a group member, resource or MCP connection does not restore the old admission or credential identity.

The user controls selection changes in the trusted interface. Connected AI uses the shared `sessions.taskOptions/createTask/listTasks/getTask/updateTask/reviseTaskSelection/cancelTask/deleteTask` catalog; host validation still restricts the current executor, source scope, selected product actions and approvals. Listing a method or declaring a tool does not grant permission to use it. AI cannot use task creation to manufacture another member's private grants or use a selection revision to grant itself new access.

## Stop or delete

**Stop this task (停止此任务)** targets only the selected task's active Runtime and group batch. Other conversations, sibling tasks and independently registered background services have their own lifecycle. Use their existing process controls when needed.

**Delete this task thread (删除此任务线程)** requires an idle task and explicit confirmation. It removes this thread and its history and retires its scoped execution resources; it preserves the owner Bot/group and its MAIN chat. Deleting the owner itself remains a different contact/group action.

## Verification and later work

Migration and authority regressions use real SQLite. Focused UI identity tests and capability tests cover empty defaults, MAIN separation, exact MCP identity, independent network/clipboard flags and original Runtime snapshots. Three controlled hidden acceptance cases are under validation for real Preload/provider transport and UI effects. All three distinct scenarios have now passed: the six-member/sibling and actor/revocation scenarios passed together, then the locator-only corrected UI/restart scenario passed separately. This is not a single 3/3 all-green run; failed attempts are retained in the implementation record. No live cloud account, physical audio device or Windows Docker result is inferred from these fixtures.

Task threads are Phase 6A. Cross-resource search (6B), sidebar sections/default assistant/custom Bot images/notifications (6C), group Routines (6D), events/Webhooks (6E), and versioned templates/selective offline exports (6F) remain pending. Releases follow verified `dev → beta`; tag and title must both equal `v<package.json version>`. `master` promotion remains deferred. See the [implementation record](IMPLEMENTATION_PLAN.md).
