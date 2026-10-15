# 阶段 6 实施设计：任务线程、搜索、自动化与本地分享

状态：beta.39 已实现 6A 的 TASK 数据、明确授权与线程界面，并通过专项单测及静态检查；完整构建与三个不同受控隐藏场景已分轮通过，真实未签名 macOS 包 4 项通过，跨平台及签名发行门禁仍待完成。6B–6F 待实施。当前使用说明见 [任务线程](TASK_THREADS.md)，验证证据见 [实施记录](IMPLEMENTATION_PLAN.md)。

历史准备稿存放基线为 `codex/media-documents` 的 `23eec734a1608b271a0e59d350d16197799abba0`，功能盘点依据为 Notion beta.35 源码 `b81174717ae16afdaf543d8cc2eed2d21f72c95c`。当前 6A 源码已整合阶段 4、5，并使用迁移 45；历史安装包证据不沿用为任务线程验收。下面未标为已实施的设计仍是后续约束。

阶段 5 的媒体与语音接口准备见 [MEDIA_VOICE_DESIGN.md](MEDIA_VOICE_DESIGN.md)。本稿只依赖其最终验收后的媒体所有权、版本与授权合同。

## 1. 当前基础与交付边界

| 范围 | 可以复用 | 尚需实现 |
| --- | --- | --- |
| 会话 | beta.39 源码已含 `MAIN / TASK`、独立线程界面、固定成员上下文及权限快照、原 Runtime 重试 | 完成 6A 隐藏场景、构建与安装包门禁；全资源搜索后续实施 |
| 搜索 | 当前会话资料 FTS、中文子串匹配；侧栏名称与末条消息过滤 | 跨资源结果、来源定位、分页、按调用者过滤正文 |
| 整理与偏好 | 项目分组、置顶、隐藏、未读；Bot 形状/颜色头像 | 持久侧栏分区、默认助理、Bot 图片头像、通知类别与声音设置 |
| 自动化 | 定时/间隔/Cron Routine、运行快照、唯一 trigger key、Runtime 回收 | 群目标、运行取消、内部事件、Webhook、持久入站去重与恢复 |
| 模板与导出 | 固定内容团队模板、Bot 复制、固定版本资料/Skill 导出、单条成果保存 | 通用模板版本、导入预检、选定会话/资料的离线导出 |

本轮继续采用本地无账号产品；公共分享服务、多人协作与市场后置。用户界面和 AI 使用相同业务函数、校验与审批。目录仍经 `product_catalog → product_describe → product_execute` 暴露，凭据不进入目录或模型参数。

## 2. 最小独立交付顺序

| 单元 | 实施结果 | 依赖与验收门槛 |
| --- | --- | --- |
| 6A：TASK 数据、授权与线程界面 | beta.39 源码已实现多个私聊/群任务、空授权默认、固定上下文、sessionId 界面与任务级停止／删除 | 专项单测／静态通过；完整构建和三个不同隐藏场景分轮通过；真实未签名 macOS 包 4 项通过；跨平台／签名发行待完成 |
| 6B：全资源搜索 | 搜索定位原消息/资料版本；复用 6A 的 sessionId 线程身份 | 待 6A 验收；AI 查询不能扩大范围 |
| 6C：整理与个人设置 | 分区、默认助理、Bot 图片头像、通知设置 | 6B 的会话身份；图片复用阶段 5 所有权与媒体处理；不改变项目授权 |
| 6D：群 Routine 与取消 | 固定目标与成员、运行快照、单运行停止 | 6A；复用 Runtime/RoomCoordinator；六成员并行，停止不影响其他批次 |
| 6E：内部事件与 Webhook | 入站账本、去重、明确状态、停用与恢复 | 6D 的共同派发入口；未知结果查询原 nonce，不能自动重新派发 |
| 6F：模板与选择性导出 | 不可变模板版本、显式导入；可独立打开的离线包 | 6A/6B 和阶段 5；导出只含选择范围，模板不携带授权或凭据 |

每个单元先验证 dev，再进入 beta、安装包验收和对应 Beta Release。标签和标题严格使用 `v<package.json version>`；master 暂不晋级。6A 候选为 beta.39，后续单元尚不预定版本号。

## 3. 6A：TASK 的数据和宿主约束

### 3.1 数据迁移

- 迁移 45 已把 `Session.kind` 扩为 `MAIN | TASK` 并重建真实 SQL 约束，未只修改 TypeScript。
- 迁移 45 已将 `sessions_one_main_per_bot/room` 替换为仅 `kind='MAIN'` 生效的条件唯一索引，TASK 不设 owner 唯一约束。
- 实际 Task 标题、父 session 引用及 CAS 版本使用 `sessions.task_title/task_parent_id/task_version`；不把 `conversation_metadata.version` 或历史 `generation` 混作 Task 版本。单独删除父线程后置空引用，保留独立子任务；删除 owner Bot/Room 本身仍按其生命周期清理相关线程。
- 已增加 TASK 执行者准入记录，键含 `(session_id, executor_bot_id, incarnation)`，保存版本和撤销状态。增加窄用途的 TASK 选择快照：所选历史、资料版本、Memory 正文版本、目录权限上限及读工具策略。二进制只引用阶段 5 的应用拥有媒体，不复制宿主路径。
- 新增表／列使用迁移 45。重建 sessions 时逐字段复制并保留入向外键、索引和触发器，沿用备份、事务及 `foreign_key_check`，迁移失败回滚。
- MAIN 与 TASK 的初始化触发器分别建立元数据和范围版本；只有 MAIN 消费 `legacy_session_scopes`，先创建 TASK 不会取走旧 MAIN 的有限资料／Memory 快照。

依据：`src/shared/contracts.ts: Session`；`src/main/database.ts: MIGRATIONS / initialize_conversation / initializeMainSession / conversation_scope_versions`。

建议将新增存储限定为以下具体用途，沿用现有具体资源授权仓库：

| 存储 | 键与必要约束 |
| --- | --- |
| `task_executor_admissions` | `(session_id, executor_bot_id)` 主键；正整数 version、revoked_at；session 删除级联。成员重加不自动清空 revoked_at |
| `task_context_selections` | `(session_id, executor_bot_id)` 主键；固定所选 Memory 的 sourceId/version/content/digest、资源引用、网络/剪贴板布尔上限、version 与摘要。JSON 严格校验、总大小受现有内容预算限制；缺少记录即无授权 |
| `task_workspace_limits` | `(session_id, executor_bot_id, workspace_id)` 主键；read/write/automation 三项明确布尔值、version/撤销状态；与现有 session_workspace_grants 和当前全局权限求交集 |
| 会话元数据新增字段 | TASK 标题、可空 parent_session_id；复用原 version。分区字段在 6C 实现时才新增 |

Memory 选择按执行者隔离；不能把某成员选中的私聊 Memory 聚合成全群可读列表。群 TASK 共享的资料/历史在创建审阅中明确列出其准入成员。模型只能选择自己在父范围已获准读取的内容；从其他私聊分享资料必须另走用户明确授权。

所选历史、Memory 或资源若只有 ID 而没有历史版本存储，则复制经核验的正文快照及原摘要；新版本不原地修改快照。每次后续读取仍核对源是否存在/有效以及 TASK 自身是否撤权。现有绑定/授权记录生成新 TASK 范围的 ID，不复用父 grant ID；当前写操作和脚本执行授权始终重新建立。

### 3.2 创建和更新接口

beta.39 已新增共享 `task-session-contracts/schemas/channels/product`，宿主服务接入既有产品操作服务。以下八项接口已实现，三个不同受控端到端场景已分轮通过，真实未签名 macOS 包 4 项通过，跨平台／签名发行仍待完成；目录元信息不代表已授权：

| 操作 | 必须固定的输入与结果 |
| --- | --- |
| `sessions.taskOptions` | 当前来源 session 的精确范围版本、可选择的执行成员和固定资源／权限选项；默认不勾选 |
| `sessions.createTask` | `parentSessionId`、父范围版本、`clientNonce`、标题、所选执行者、所选历史与授权；返回新 Session、元数据版本、选择快照摘要 |
| `sessions.listTasks` | parentSessionId 与有界 limit；AI 结果仅限当前执行者已准入的线程 |
| `sessions.getTask` | sessionId；返回元数据、准入状态与授权摘要，不返回凭据 |
| `sessions.updateTask` | sessionId、expectedVersion、标题等元数据变更；授权调整由单独明确的选择操作处理 |
| `sessions.reviseTaskSelection` | expectedVersion、完整所选快照；宿主重验来源、当前授权和执行者，产生新版本 |
| `sessions.cancelTask` | sessionId 与当前版本；只停止此线程当前任务，转调已有 Runtime/Room 批次取消 |
| `sessions.deleteTask` | sessionId 与当前版本；要求线程空闲，删除线程并保留 Bot／群 owner |

实际迁移 45 使用 `sessions.task_title/task_version` 保存 Task 标题与 CAS 版本；`generation` 仍只表示历史世代。执行者准入另含 incarnation，避免移出／重加复活旧授权。MAIN 与 TASK 分别初始化元数据，只有 MAIN 消费旧的 legacy 范围。选择修订由可信界面显式完成；旧 Runtime／重试继续读取原选择版本。

同 nonce 的规范化输入和选择摘要必须一致，改变成员、正文或资源版本即冲突。AI 的当前 session/executor 从 Runtime 注入，不能伪造父范围；创建其他会话仍需真实审批。共享授权、创建记录与首条选定上下文原子提交；中途撤权或取消不留下半成品。

历史只复制明确选择的条目正文、来源 ID/世代/摘要；不连接父会话的动态历史游标，也不复制 Runtime/审批/外发账本。首个任务及后续消息都从新 session 正常发送。资料、媒体、消息选择使用阶段 5 最终合同和现有大小上限。

### 3.3 固定成员与精确撤销

beta.39 的 `assertSessionExecutor` 对 TASK 同时核验：TASK 准入记录有效，并且仍为该 Room 当前成员（私聊则仍是 owner Bot）。

- 新 Bot 加入父 Room，不获得已有 TASK 的资料、Memory、环境、浏览器或结果权限。
- 移出成员时撤销该成员在相关 TASK 的准入，递增范围版本，封闭准备中的调用，并取消精确 `(taskSessionId, botId)` 的任务。其他成员/私聊不受影响。
- 再加入父 Room 不恢复旧准入；用户明确重新授权后才生成新准入版本。旧 Runtime、下载票据、图片和审批不得因重加成员复活。
- 群 TASK 的路由、协调者、成员列表和界面均使用“固定准入 ∩ 当前成员”；不能继续直接使用 `getRoomDetail().members` 作为 TASK 名单。协调者必须在此交集中。
- 当前修改群成员的 busy 检查仅针对 MAIN；实施时检查该 Room 全部 session，或先精确封闭相关 TASK 再提交成员变更，不能存在检查 MAIN 为空就绕过活跃 TASK 的窗口。

复用点：`src/main/database.ts: assertSessionExecutor / removeRoomMember / session scope version`；`src/main/room-coordinator.ts: assertLiveRoute / selectAndSend / cancelMember`。所有环境、浏览器、连接器、MCP 和外发仓库已经接入 `assertSessionExecutor`，不能只在 UI 过滤成员。

### 3.4 授权默认值与已确认的继承风险

以下是新增 TASK 必须修正的 MAIN 假设，不作为当前已有 TASK 的缺陷声明。

| 路径 | 当前行为 | TASK 首次交付规则 |
| --- | --- | --- |
| `database.ts: getMemoryCaptureScopes / listRuntimeMemories` | 自动加入全局 user Memory；目录授权与 Bot 的 `memoryWorkspaceIds` 交集会加载整个工作区 Memory | 空 TASK 不自动带入任何 Memory。仅保存明确选择的 Memory 版本/正文/摘要；后续新增 Memory 或 Bot 订阅不能进入 TASK。源全局删除与 TASK 撤销阻止后续读取 |
| `database.ts: memorySourceSession` | 无 sourceEntryId 的 Bot Memory 写入回落 MAIN | TASK 的手动与 AI Memory 写入均携带真实 source session/entry；捕获目的地也受 TASK 选择约束，不能把任务私有内容写入全局 user/workspace Memory |
| `product-handlers.ts: memories.*` | 原接口按 Bot/全局 scope 读写，部分操作仍需审批 | 模型读取和变更必须检查当前 TASK；仅过滤提示词不够。请求更广范围须走明确授权，不能将普通 Memory 操作审批当作永久扩大线程快照 |
| `database.ts: configureSessionProject / setConversationProject / registerWorkspaceFolder` | 项目关联可授予其目录；后续绑定目录会重配该项目所有会话 | TASK 的项目仅作整理；单独保存选定目录与 read/write/automation 上限。有效权限 = TASK 选择 ∩ 当前全局目录权限。后续项目绑定或打开 write/automation 开关不能扩大 TASK 权限 |
| `mcp-service.ts: availableTools`；`runtime-executor.ts: providerContext.mcpTools` | `Bot.mcpServerIds=null` 可使用全部启用的可信只读 MCP；未按 session 筛选 | TASK 默认不暴露 Bot 全局 legacy `mcp-call` 列表。选定工具使用现有 scoped MCP 产品路径，保存 serverVersion、schemaDigest、credentialDigest 和新 TASK grant；账户/配置变化或撤权立即失效。MAIN legacy 行为保留 |
| `workspace-tool-coordinator.ts: autoApprovePublicRead / automationEnabled` | 全局设置与目录开关可自动批准 | 先检查 TASK 对网络/设备/目录的准入上限，再应用原审批策略。全局自动批准设置不是线程授权；剪贴板默认不授予 |
| `library-repository.ts: bindings / resolveReferences` | 绑定资源可读未来版本；单条消息的固定引用保护重试 | 创建 TASK 明确所选 ResourceReference；任务快照读取不默默切换到新版本，刷新选择使用 CAS。消息、nonce 和 PromptManifest 仍保存实际版本 |

采用现有具体授权仓库和少量 TASK 专用选择/上限记录；不引入通用权限语言或另一套执行框架。新 TASK 不复制 Docker 环境 ID、浏览器 profile/登录态、控制票据、执行 UID、脚本执行 grant、外发写 grant、待批操作或未知外发结果。用户在 TASK 中需要写入或执行时，由原操作入口重新授权和批准。

复制选择会建立独立子会话授权；父绑定后续变化不成为子会话的动态授权来源。全局删除/停用、连接撤销及子会话自身撤权仍按现有实时规则生效。Bot 角色/模型配置可以继续共享，但每个 Runtime 仍固定实际 profile/model 版本；角色或目录中声明的工具不是授权。

## 4. 已纳入 6A 的线程选择与待实施 6B 搜索

### 4.1 界面按 sessionId 选择

beta.39 已把 Task 侧栏身份与 owner 的 MAIN 行分开；Task 使用 `session:*`，读取精确 Task Session 的 Runtime／Room 快照。Bot／群联系人入口继续打开 MAIN，Task 摘要不会覆盖 owner 行的未读、置顶或隐藏元数据。此项界面实现已纳入 6A，其三个受控隐藏场景已有分轮通过证据，真实未签名 macOS 包另有 4 项通过记录，跨平台／签名发行待完成。

草稿、未读、隐藏、置顶、打开中的资源/审批、取消和历史加载均以 sessionId 为键。迟到异步响应须同时核对 sessionId 与打开请求代次。Room TASK 快照/发送接口接收并校验实际 sessionId，不能转回 Room MAIN。原 Bot/Room 菜单继续保持联系人管理语义，线程删除与删除联系人分开。

### 4.2 搜索合同

- `search.query({query, kinds, cursor, limit, ...scope}) → {items, nextCursor}`。返回类型包括 message、document、skill、media、task、routine、local-draft；以已完成阶段 5 的解析正文作为多媒体文本来源。
- 每项返回稳定 `source`：资源类型、sessionId、原条目 ID/seq/世代，或 resourceId/revisionId/digest；加标题、纯文本片段与定位状态。没有授权时连片段也不返回。
- 用户可以从全局搜索选择范围；AI 默认只能搜索当前 session 和明确授予的 TASK/委派结果。Bot 相同、同项目、同父会话均不构成正文访问许可。
- 宿主在查询时过滤授权，而不是先返回全局正文再让 Renderer 隐藏。现有 `library.available` 仍只是元数据，不升级为全局正文读取。
- `search.open` 交给语义 UI 请求定位精确来源；原消息已清除/世代改变或资源已撤权时显示明确状态，不跳到相似文本。分页使用稳定键和查询/范围摘要；范围变化使旧游标失效。

先用 SQLite 查询与已有 FTS，迁移时对旧正文补索引；中文保留已有子串策略。暂不引入云搜索、网络连接器批量抓取或新搜索依赖。索引更新和源变更同事务；索引缓存不能绕过实时撤权。

复用：`src/main/library-repository.ts: list/filterRows/resolveReferences`、`src/main/product-operation-service.ts: libraryInput/tasks result validation`、`src/shared/product-view.ts`、`src/renderer/src/components/Conversation.tsx`。

## 5. 6C：整理与偏好

- 新增持久 sidebar sections/顺序，成员键为 sessionId；保留项目、置顶和归档现有功能。`sidebarSections.create/rename/delete/reorder` 与 `conversations.setSection` 使用 expectedVersion；删除分区仅解除归属。移动分区不修改项目/目录授权。
- `settings.defaultAssistant` 保存 Bot 引用；先恢复最后打开的有效 session，再在需要新会话时采用默认助理。默认 Bot 删除后清空设置，不自动创建联系人。
- `bots.setAvatar` 只接受经过阶段 5 导入、校验并由应用拥有的图片引用；复用用户头像裁剪模式及 CAS 字节存储。保留形状/颜色回退、当前主题与品牌图标；拒绝原始宿主路径和任意远程图片 URL。
- 扩展现有 GeneralSettings 的通知类别和声音设置。默认保持当前审批/Routine 通知行为；新增任务完成提醒由用户启用。统一在宿主 `showNotification` 生效，点击定位真实 session/run，不能由通知重新执行任务。

依据：`src/renderer/src/components/Sidebar.tsx`、`BotAvatarIcon.tsx`、`src/shared/bot-avatar.ts`、`src/main/index.ts: showNotification/emitTool`、`src/main/settings.ts`。

## 6. 6D / 6E：Routine、事件与 Webhook

### 6.1 共同派发入口

保留当前 `advanceRoutineAndCreateRun` 的事务 CAS、`trigger_key` 唯一约束和固定 prompt/schedule 快照。扩展目标为明确 session：私聊使用 SendWorker，群使用 RoomCoordinator，记录实际 runtimeRunId 或 batchId。旧 Routine 回填其 Bot MAIN；若尚未创建 MAIN，先走有限 legacy MAIN 初始化，不能填空目标或推断所有项目授权。

群 Routine 默认固定创建时选定的成员/路由及资源版本；后加成员不自动加入。成员移除、TASK 准入撤销或授权变化使相应派发失败/取消，不能改投 MAIN 或其他 Bot。调度 tick 的重入锁只保护领取，不等待成员完成，也不成为六成员执行的全局锁。

增加 `routines.cancelRun({runId, expectedVersion})`：未派发运行写入取消终态；活跃运行只取消其绑定 Runtime/批次。停用 Routine 阻止后续触发；界面分别提供“停用后续”和“停止本次”，不能把停用当成取消成功。保留运行版本与终态不可变约束。

### 6.2 持久入站与去重

增加小型入站账本，唯一键为 `(sourceId, eventKey)`，保存 payloadDigest、固定规则版本/目标快照、dispatchNonce、状态版本与实际 Runtime/批次引用。内部事件和 Webhook 共用此账本，不能用仅驻内存的 Set 去重。

| 状态 | 行为 |
| --- | --- |
| received / queued | 已持久接收，未派发；可精确取消 |
| dispatching | 已先保存稳定 dispatchNonce，正在请求既有发送链 |
| accepted / running | 已核对原 nonce 的接收记录，并绑定实际 Runtime/批次 |
| completed / failed / cancelled / unknown | 保留终态与原因；unknown 只查询原发送记录，不生成新 nonce |

- 相同 key/相同规范化摘要返回原 receipt；同 key/不同摘要为冲突。停用、重启、轮换密钥后仍保留已处理和已取消 key，避免迟到重放。
- 崩溃落在派发与回执之间时，按原 nonce 查询 send_journal/Room batch。只有宿主能证明尚未接受时才继续同一幂等意图；无法证明就保持 unknown。
- 派发前后重验目标、规则启用状态和范围版本；取消记录是持久 tombstone，防止正在准备的任务迟到启动。外发工具继续走独立逐次审批和既有 unknown 账本，不因事件规则而自动获批。
- 首批内部事件只接明确注册的应用事件，保存去重键和原事件来源；自身产生的事件携带因果 ID，拒绝同规则的循环触发，并设置有界因果深度。不要订阅全部 IPC 或模型文字来推断“真实事件”。

### 6.3 本地 Webhook

新增 `automationSources.*` 与 `automationEvents.list/get/cancel` 产品接口；密钥配置是可信设置入口，AI 只能使用 source 引用。入站服务只绑定 loopback，默认不自动创建 Tunnel 或远端部署；外部接入另需用户明确配置的转发。

HTTP 入口先鉴权，再校验固定 JSON schema、请求体上限、来源 ID 与 eventKey，持久化成功后返回 receipt；失败或超限不派发。密钥保存在宿主密钥库，不写入 URL/查询参数或日志。撤销立即拒绝新请求，旧去重记录保留。外部 payload 只能成为标明来源的不可信输入，不允许选择工具、覆盖系统指令、增加成员或携带自动批准指令。

复用：`src/main/routine-service.ts: tick/dispatch/reconcile`、`src/main/database.ts: createRoutineRun/advanceRoutineAndCreateRun`、`src/main/send-worker.ts`、`src/main/room-coordinator.ts`、`src/main/native-outbound-repository.ts` 的稳定意图/unknown 处理原则。新增入口使用本身的数据库范围校验，不跨接其他会话的原生写账本。

## 7. 6F：模板版本与离线导出

### 7.1 模板

`templates.create/update/versions/read/export/import` 保存不可变版本与摘要；更新使用 expectedVersion。模板描述 Bot 角色/模型引用、群角色关系和明确选择的资料/Skill/媒体版本；保存模板不等于授权使用其工具。

导出采用有版本 manifest 加 `blobs/<sha256>` 的本地目录格式，复用现有内容寻址与目录导出，不为此单独引入压缩依赖。导入先暂存与预检路径、大小、摘要、schema、引用关系，再一次性建立新的 ID 映射。未知格式拒绝；缺少模型来源或媒体时给出可审阅的未解析项，不自动替换成其他私有连接。

不包含凭据、宿主目录路径、OAuth token、浏览器 profile、环境/执行 ID、外发/脚本写授权、运行历史或待审批项。脚本初始停用且无执行授权；模板导入不会启动环境、运行脚本、连接账户或发消息。现有固定内容团队模板继续调用已验证的事务创建函数，不重写为另一套默认团队。

### 7.2 会话/资料导出

- `exports.prepare` 固定用户选择的 session/消息范围/资料版本/附件与媒体引用，返回快照 ID、摘要、大小和项目清单；`exports.write` 经过原生目标选择与实时授权复验，返回实际路径/摘要。AI 不能提供任意宿主目的地绕过文件对话框。
- 离线目录包含 manifest、仅被选中的 bytes 和 `viewer.html`。HTML 内嵌已转义的数据，不依赖 file:// 下 fetch JSON，也不要求服务器/登录；媒体用相对文件链接。保留消息作者/时间/来源提示，导出文本不伪装为已验证工具结果。
- 渲染按不可信内容处理：不执行消息 HTML/脚本，不加载外部网络，不暴露原模型 App `_meta`、签名 URL、密钥、审批内部记录或未选择的上下文。已有 stdout/工具结果是否导出由用户单独选择，默认只导出选定消息/资料。
- 发布目录沿用 `library-export.ts` 的暂存、独占目标与句柄归属保护；失败/取消不覆盖已有目标或清理后来替换的对象。运行中的聊天以准备时快照导出，后续新消息不混入。

依据：`src/main/library-export.ts`、`src/main/library-service.ts: prepareExport`、`src/main/artifacts.ts`、`src/main/mcp-write-repository.ts: publicResult/appResponse`、`src/main/database.ts: createContentTeamTemplate`。

## 8. 验收与实施入口

以下现有回归必须保留；标注“新增”的用例在对应单元实现时添加，不在准备提交中假建测试。

| 单元 | 现有源码/测试锚点 | 必须新增的验收 |
| --- | --- | --- |
| TASK 迁移 | `database.test.ts`、`conversation-repository.test.ts`、`session-scope-repository.test.ts` | MAIN+两个 TASK/owner；先 TASK 后 lazy MAIN；真实旧库全部历史/外键/触发器保留、备份失败拒绝、重复打开不变 |
| TASK 授权 | `session-scope-tool.test.ts`、`library-runtime.test.ts`、`capability-registry.test.ts`、`mcp-write-foundation.test.ts` | 空选择不加载 user/workspace/Bot Memory；父项目/订阅/全局工具变化不扩权；真实 dispatch 检查与能力列表一致；选定资源版本固定 |
| 群成员 | `multi-agent-journal.test.ts`、`room-coordinator.test.ts`、`native-outbound-gateway.test.ts` | 创建后加成员不可读；移出后立即封闭调用；重加不恢复；六成员首结果前全部启动，单成员取消不影响兄弟 |
| 线程 UI/搜索 | `src/renderer/src/App.tsx`、`Sidebar.tsx`；新增 `tests/smoke/task-sessions.spec.ts` / `search.spec.ts` | 同 Bot 多线程草稿和历史分离；迟到响应不换选中项；搜索能定位原 seq/revision，撤权不返回片段，旧游标无效 |
| 偏好 | `settings` 与 avatar 现有测试；新增对应设置和隐藏 UI 回归 | 重启保留分区/默认助理/头像；默认 Bot 删除清空；分区移动不改变授权；通知设置在宿主实际生效 |
| 自动化 | `routine-service.test.ts`、`runtime`/Room 原取消测试 | 同事件并发接收只建一条 receipt；变 payload 冲突；跨崩溃窗口查询原 nonce；停用/取消阻止迟到启动；群重试/停止不重发兄弟副作用 |
| 模板/导出 | `team-template.test.ts`、`library-export.test.ts`、`library-service.test.ts` | 模板版本冲突保留草稿；导入后新 ID 且零隐式权限；导出离线打开、范围精确、XSS/路径越界/替换对象保护，移动原文件不损失 bytes |

每单元使用真实 SQLite 和隐藏 Electron 临时数据；共享业务层覆盖 API/Codex/Claude 宿主路径。媒体与图像验收复用阶段 5 的真实传输证据，不以路径或模拟结果代替。涉及 Docker 和第三方写入的用例分别列出真实执行证据；没有配置时保留“未验证”，不计作通过。macOS arm64、Windows x64 安装包核对实际 isPackaged/版本/资源；通过后再由 dev 晋级 beta 和发行。

实施第一步应在阶段 5 最终基线上重新核对本文的文件、schema 和未发布迁移。优先完成 6A 的空授权与宿主边界，未通过前不要开放 TASK UI，也不要先启用自动化入口。
