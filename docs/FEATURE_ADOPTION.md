# Grok Bot 功能对照与 Aevoren 实施方案

Aevoren 要补齐的主要能力是资料库与 Skill、可执行的电脑与浏览器、语音、可写应用连接，以及跨资源搜索和分享。现有 Bot、群聊、Memory、审批、执行记录、Routine 和自动更新可以继续复用。新增功能应同时提供界面入口和 AI 产品操作，进入现有任务取消、恢复和结果验证链。

本次对照以 Grok Bot 0.68.1 本机安装包和 Aevoren 0.3.0-beta.26 源码为基线，日期为 2026-10-13，静态逆向证据仍以该版本为准。当前 v0.3.0-beta.29 已发布签名 macOS 包，包含阶段 1–3。脚本 Skill 的 beta.30 与原生读取／本地草稿的 beta.31 分别验收；当前 beta.32 开发外发审批。下表基线对照保留为历史证据，最新交付和真实验证边界以[实施计划](IMPLEMENTATION_PLAN.md)为准，未完成能力不能显示为已安装版本可用。产品登录、注册暂不实施。

## 证据范围

REA 对安装包做了静态分析和只读提取。清单包含 595 个相关文件，其中 579 个 JavaScript 文件完成语法解析；读取约 39.4 MB 文本。用户提供的界面显示聊天列表、Bot 详情、资料库和电脑入口，以及正在启动桌面的状态。

“客户端链确认”表示界面消费者、状态模型、桥接或服务调用可以串起来，不能代替线上执行验收。完整语义图受到资源预算限制，部分动态 IPC 和关系仍未解析。六个解包原生文件的实测摘要与 ASAR 声明不同，已保留为不可信一致性证据；没有依据这些文件声明原生能力已验证。

本次没有执行 Grok Bot 代码、请求其云服务、修改安装包或读取用户数据库、密钥、Cookie。云端 Agent、调度器、桌面执行器和存储服务的实现没有随客户端完整交付。协议声明、通用库、品牌图标和实验开关不单独作为功能可用的证明。

## 功能对照

### Bot 与聊天

| 功能 | Grok Bot 客户端证据 | Aevoren 当前状态 | 借鉴方式 |
| --- | --- | --- | --- |
| Bot 创建、修改与主 Bot | 创建与 roster 更新、profile 写入和主 Bot 选择链；复制到团队有消费者，普通复制未确认 | 创建、复制、资料与模型配置已有；没有固定主 Bot 概念 | 复用联系人；增加可选默认助理，不改变普通 Bot 身份 |
| 名称、标签、角色指令、头像 | 实际资料写入；图片头像及远程头像生成入口 | 名称、标签、说明、指令和形状/颜色头像已有 | 支持 Bot 自定义图片头像；图片生成作为可配置来源 |
| 单聊、流式发送、停止与回执 | Send Journal、clientNonce、accepted 回执及中断链 | 已有流式、稳定 nonce、幂等、停止、恢复和工具证据 | 保留现有 Runtime，不另建发送执行器 |
| Bot 群、指定回复和成员管理 | 群创建与成员写入；调度主要在远端 | 最多六 Bot、自动路由、协调者、Handoff、`@所有人` 并行已有 | 将新资料、浏览器、电脑和语音能力按成员 Runtime 绑定 |
| 人与 Bot 混合群 | human recipients 和服务端身份消费者 | 当前为本机用户与 Bot 群 | 暂后置；多人邀请和云权限依赖身份系统 |
| 置顶、分区、未读、隐藏、恢复 | 实际侧栏菜单与 roster 写入 | 置顶、未读、移除/恢复已有；无自定义侧栏分区 | 增加可持久化分区，复用当前会话状态 |
| 全资源检索 | 搜索聚合 Bot、消息、文件、链接、Routine、插件、页面，并打开对应结果 | 主要是列表名称、标签、说明与摘要筛选 | 增加消息与资料全文索引、分类结果和定位跳转 |
| 任务线程和异步结果 | Agent task 状态仓库、openThread、未读写入 | 有 Runtime/群任务详情；每 Bot/群主要使用一个 MAIN 会话 | 增加独立任务线程与所属会话，复用执行结果 |
| 消息反应、反馈、外发草稿 | 反应/反馈调用；邮件与通道草稿有发送/丢弃消费者 | 普通对话和产品审批已有；无外发草稿与反应功能 | 增加结构化草稿，发送前显示真实账号、收件人和内容 |
| 补充信息、表单、审批和凭据请求 | 动态表单、widget 应答、secret 和 connector/local permission 处理 | 已有真实 Approval 与 Brief；通用表单和连接凭据收集不足 | 扩展现有审批与输入协议，绑定原任务和请求摘要 |

### 资料、附件与成果

| 功能 | Grok Bot 客户端证据 | Aevoren 当前状态 | 借鉴方式 |
| --- | --- | --- | --- |
| 统一资料库 | listLibraryDocs/listLibraryPages 和 document/canvas 索引 | 已随签名 beta.29 发布持久文档、正文检索、不可变版本和显式会话绑定 | 复用已实现的资料对象；跨资源全文搜索和 Canvas 后续实施 |
| 可编辑文档 | Tiptap 编辑器与 saveDocument 实际保存链 | 已实现 Markdown 编辑/安全预览、expectedVersion 冲突保留草稿、版本恢复与导出 | 富文本及多格式预览后续实施，不替代当前真实版本链 |
| 群文档与 Canvas | 群文档/Canvas 读取及产物定位；完整协作画布未验证 | 已实现按群会话绑定文档和固定版本引用；没有 Canvas | 保留群资料边界与已有成果；画布单独实施和验收 |
| 团队 Bot 的 Files 资料页 | 文件导入实际转成 Bot skill 文本条目 | 私聊/群资料库与文本 Skill 已分别实现，独立于 Memory 和消息附件 | 保持资料、Skill 和记忆语义；多媒体资料后续实施 |
| 多类型附件、上传与下载 | staging、字节读取、分块上传、下载及丢弃链 | 仅 UTF-8 文本/代码，最多六份，单份 1 MiB、总计 4 MiB | 建立媒体引用、临时存储、大小/MIME 校验和上传状态 |
| 文件预览 | PDF、DOCX、图片、视频、音频、Markdown、HTML、JSON、表格和下载兜底 | 文本附件及 Markdown/CSV 成果 | 按类型增加只读预览；客户端能预览不等于模型能理解 |
| 长期记忆 | 用户/Bot 记忆和团队提升消费者；服务端检索策略未知 | user/Bot/Workspace Memory、候选审核与恢复已有 | 复用已审核 Memory；资料上传不自动变成长期记忆 |
| 云任务产物与网页预览 | artifact proposal、preview/publish 访问消费者 | 有真实文件成果，缺媒体和网页产物 | 增加可验证产物引用；服务预览另绑定实际进程与端口 |

### Skill 与插件

| 功能 | Grok Bot 客户端证据 | Aevoren 当前状态 | 借鉴方式 |
| --- | --- | --- | --- |
| 文本 Skill 创建、编辑、删除 | workflow store 和团队 Bot Skill CRUD 实际调用 | 已实现创建/编辑/软删除/恢复、启停、不可变版本和会话目录 | 脚本执行与示范技能仍需阶段 4 |
| 文件、目录和文本/URL 导入 | UTF-8 筛选、frontmatter、名称去重和 addSkills 链 | 已实现文本创建、UTF-8 文件和 SKILL.md 目录导入；没有 URL 安装 | 显示导入失败/跳过原因；URL 安装另行实施和验收 |
| 导入格式与资源 | 团队路径仅 txt/md/markdown/csv/json/yaml/yml；单条最多 256000 个 UTF-16 单元、最多 250 条；辅助文本各成条目 | 已实现应用拥有的 SKILL.md、references/scripts/assets 字节保存、摘要校验和可再次导入的导出 | 1 MiB 单文件、4 MiB 总量、250 文件；二进制保存字节／返回元信息；beta.30 候选另提供授权后执行脚本 |
| 输入框 `/`、`@` 发现与选择 | 按 Skill 名称与显示标签搜索，说明作为副标题；选择后插入结构化 ID/label | 已实现 `/Skill` 与 `@` 的 Bot/资料/Skill 分组，固定 ID/版本/digest 引用；资源不产生 Bot 路由 | 沿用原 Send；仅准备草稿，点击发送后才启动 Runtime |
| 运行、插件同步与发布 | runAgentWorkflowNow、syncPluginSkills 及失败重试消费者 | 文本 Skill 经原 Send 启动任务；AI `skills.load/readFile` 可实际读取；没有插件发布/同步 | 插件同步、脚本执行和市场发布后续实施 |
| 脚本型技能包 | wrapper 的 files 字段被当前主进程和 protobuf 丢弃；未证实脚本兼容 | beta.30 候选已实现固定版本、入口摘要和镜像授权的 Bash／Python／Node；真实 Docker、UI／包验证通过，发行待完成 | 元信息不授予权限；每次运行审批固定参数，取消和结果查询沿用执行账本 |
| 录制示范 | armed/recording、开始、保存、丢弃和失败校正链 | 未实现 | 在电脑能力可用后增加示范录制；自动生成可执行技能另验收 |

### 电脑、浏览器与本机执行

| 功能 | Grok Bot 客户端证据 | Aevoren 当前状态 | 借鉴方式 |
| --- | --- | --- | --- |
| 长期电脑、唤醒、休眠、更新、重建 | ensureSandBox 与运行状态消费者；电脑升级排期受开关控制 | 签名 beta.29 包含本机 Docker 生命周期、独立桌面伴随容器与实际镜像摘要 | 安装包仍为独立门禁；应用升级不自动替换运行中的后台环境 |
| 共享环境与 Bot/任务窗口 | account-level Box 请求没有 agentId；响应含 tenant/pod、primary/fork VNC，界面按 Bot/子任务显示 monitor | 独立 Environment／ExecutionSession，阶段 3 另有同 scope BrowserSession／ComputerView，六成员实际并行通过 | 按会话／执行者隔离，资料／工作卷／profile 不因 Bot 入群自动共享 |
| 屏幕预览、多窗口、全屏与重连 | VNC 预览、monitor 切换、加载/失败/重试链 | beta.29 已发布真实桌面帧、noVNC 连接与 epoch 票据；完整多窗口／全屏尚未交付 | 断线保留用户控制；当前只显示所选 scope 桌面，不据此声明全部窗口能力完成 |
| 用户接管、归还与剪贴板 | handoff、交还、可信 VNC guest 剪贴板和输入链 | 阶段 3 后端接管／归还与过期重放真实验证通过；浏览器剪贴板尚未单独验收 | 用户接管暂停 AI 观察／输入／图片，明确归还后重新观察 |
| 本机命令、后台进程、输出与取消 | local daemon 实际注册 streaming/background shell、Read、Ls，有 requestId/execId 与取消 | 开发分支有经审批的隔离 Linux 命令、真实 stdout／stderr、退出码、独立后台进程与取消；无宿主 Shell | 保留真实任务／进程归属；unknown 不盲重发，后台服务与聊天历史生命周期分开 |
| 本机与环境间文件传输 | upload/download、根目录与 realpath 校验、执行权限链 | 开发分支有环境文件读取／写入及原生上传／下载，单文件最多 1 MiB、create-only／hash 覆盖核验 | 完成 UI／包验证；拒绝越界／symlink／特殊文件，传输不扩大他人环境权限 |
| AI 浏览器与电脑操作 | 远程桌面可手工操作浏览器；云端 AI 执行器未做运行验证 | beta.29 已发布真实 Chromium、DOM 操作、桌面像素和下载，27 共享操作；真实云模型视觉理解另验收 | 截图实际字节进入传输，不把文本路径或 fixture 当真实模型视觉理解 |
| 浏览器登录态 | 选定 Chrome 站点、审批、注入 Box、成功/跳过原因的实际链 | 独立持久 profile 已实现并有真实 Docker cookie 隔离／重启证据；不复制宿主 cookies | 用户在选中 scope 内自行登录，持久 cookie 和网站 session cookie 依浏览器语义保存 |
| 项目服务预览与端口 | 找到云产物 preview；未证实通用本地端口转发 | beta.29 已发布实际登记服务预览，核验原任务 UID、listener、端口与连接失效 | 阶段 3 根据已登记真实服务提供预览，不把任意 URL 当运行成果 |
| 通用本机 GUI 控制 | bundle 有泛用 screenshot/click 类，但本地注册表未装 computerUse executor | 未实现 | 单独的 OS 控制适配器及验收；不宣称 Grok 本机已有完整 GUI 控制 |
| 桌面悬浮聊天入口 | desktopMount 是浮动 Bot 面板，需开关，仅 darwin/linux 路径 | 未实现 | 可选后置；不将此名称解释为文件夹挂载 |

### 应用连接与外部动作

| 功能 | Grok Bot 客户端证据 | Aevoren 当前状态 | 借鉴方式 |
| --- | --- | --- | --- |
| 应用目录、连接、多账号、重授权与移除 | connector card 与安装/auth/remove、账号状态消费者；实际目录由后端返回 | beta.31 候选增加 Gmail／Drive／Notion 配置目录、加密凭据和会话／Bot 读取授权；保留通用 MCP | 复用 MCP，增加可配置连接目录；图标不作为可用性证明 |
| 自定义 MCP、Bot 插件绑定与工具管理 | stdio/http/sse 配置、OAuth、Bot 插件绑定；工具禁用按账号下 serverId/toolName 保存，自定义指令按服务器配置 | stdio/HTTP、OAuth、加密密钥、Bot 范围和只读工具审查已有 | 保留现有连接层，补工具选择、说明和连接状态；维持 Aevoren 的 Bot 权限范围 |
| 可写应用动作、外发邮件与消息 | 工具调用、connector grant、邮件/通道 draft 真实消费者；目的服务依赖外部连接 | beta.31 候选提供固定账号本地草稿；beta.32 实施写授权、固定审批和外发账本 | 外发结果未知时只读核验，不盲目重发；第三方写入需要实际测试目标 |
| MCP 媒体与交互 Apps | resource/view 与 callMcpAppTool，包含 userActivated 等参数 | 只保留文本，图片/音频被省略；无 Apps | 先媒体结果，再加入有来源与权限绑定的交互视图 |
| Slack 与其他消息渠道 | Slack 安装/重装/解绑及 platform/token 连接接口 | 未实现 | 可选连接器，先一个平台完成真实收发与撤销验证，再扩展 |
| 凭据与敏感输入 | secret 写入口、请求批准、1Password/WebAuthn 相关消费者 | 模型连接密钥和 MCP OAuth 已加密 | 密钥仍通过可信配置保存；模型只能获得引用和使用结果 |

### 语音、主动任务与分享

| 功能 | Grok Bot 客户端证据 | Aevoren 当前状态 | 借鉴方式 |
| --- | --- | --- | --- |
| 录音转文字与设备选择 | getUserMedia、MediaRecorder、transcribeAudio 和失败/停止消费者 | 未实现 | 可配置 STT，转写写入正确草稿，保留用户编辑 |
| 实时语音聊天 | credential mint、真实 WebSocket、PCM 收发、静音/结束/重连/转录和工具路由 | 未实现 | 独立 VoiceSession 与可配置实时服务，复用产品工具和取消 |
| 朗读、语音 memo、播放与文字定位 | synthesizeSpeech、缓存、暂停、倍速、逐字高亮和 seek | 未实现 | 可配置 TTS 与真实音频引用，先朗读再实时语音 |
| 每 Bot 声音、速度和语言 | setAgentVoice 的实际配置消费者 | 未实现 | 扩展 Bot 能力配置，不能替代实际语音来源校验 |
| 定时任务与运行历史 | Routine CRUD、cron、暂停/启用、runNow、运行失败消费者 | once/interval/cron、时区、历史、通知与恢复已有 | 复用 Routine；扩展群目标和任务关联，保持运行来源 |
| 事件、组合触发和 Webhook | listener、触发显示、webhook credential、run/pause 消费者 | 仅时间触发，应用运行时本地调度 | 新触发器适配器、事件去重与可选常驻自托管服务 |
| Bot 模板、版本、导入与分享 | 模板编辑、publish、版本缓存、share URL、createFromTemplate | 只有本地 Bot 复制 | 先本地模板导入/导出；公共分享和市场作为可选自托管服务 |
| 分享内容和访问范围 | 链接/团队访问消费者；细粒度模板可见性写入口部分未知 | 无分享链接；可另存单条回复 | 先会话/资料静态导出和预览；远程发布需明确快照与撤销 |

### 设置与待确认能力

| 功能 | Grok Bot 客户端证据 | Aevoren 当前状态 | 借鉴方式 |
| --- | --- | --- | --- |
| 主题、语言、拼写与硬件加速 | 主进程设置校验/保存、theme/language 状态广播和系统菜单 | 深浅主题及 system 默认已有；界面缺语言、拼写/加速选项 | 按实际平台和需要逐项增加设置，保留当前主题与图标 |
| Bot 通知与提示音 | 通知分流和 Bot 状态；提示音路径需员工资格与开关 | 审批/Routine 通知已有，没有完整 Bot 声音设置 | 增加独立通知偏好；后台任务结果和审批分开配置 |
| 桌面更新、通道与空闲安装 | 版本校验、更新 track、idle 信号、安装消费者 | 签名、公证、Beta feed 与忙时拒绝重启已有 | 复用现有发布链；环境镜像升级与应用版本分开 |
| 时区、网络诊断与本地权限 | 相应 RPC/处理函数和设置保存链 | cron 时区和工具审批已有；没有电脑网络诊断 | 与对应能力一起提供真实诊断、撤销和失败结果 |
| 数据隐私 | 云端隐私模式和发送门禁消费者 | 本地数据、受限模型上下文、无云同步 | 展示具体发送范围与数据去向，不照搬商业账户隐私模式 |
| 专属邮箱 | 有 list/create client model；最终可见入口和服务兑现部分未知 | 未实现 | 后置候选；不能从协议声明直接列为已可用 |
| 会议辅助 | 查询/离开 model，缺 meetings 服务返回空；完整入会/录制未验证 | 未实现 | 后置候选，具备实际会议来源后独立验证 |
| 独立 Todo 产品功能 | 目前仅找到部分 protobuf 声明 | 没有独立 Todo；有任务执行状态 | 保留待确认，不与已有 Runtime 任务混为一谈 |
| 账号、团队成员、付费和市场运营后台 | 身份、团队访问和商业/内部协议路径 | 当前无账号和付费系统 | 登录注册按要求排除；其他服务依赖不纳入本地基础版的首轮实施 |

## 实施顺序与验收

各阶段从 `dev` 开发，验证后进入 `beta`。`master` 按此前要求暂不晋级。功能尚未完成真实适配器验证时，能力快照应报告不支持或配置缺失。每阶段交付后同步中英文 README、用户指南、能力目录和实际支持边界。

| 阶段 | 实施范围 | 完成条件 |
| --- | --- | --- |
| 1 资料与文本 Skill | 持久资料、文档编辑、文本检索、Skill CRUD/导入、输入框选择、按需上下文加载 | 重启保留真实内容与版本；Bot/群范围不串；编辑冲突可检测；AI 能发现、读取和执行对应任务；不把文本加载当脚本执行 |
| 2 执行环境 | Environment、ExecutionSession、命令／输出、文件、后台进程、上传/下载、日志、停止和恢复 | 六成员并行且输出／目录／进程归属正确；停止只取消所属任务；重启不误报存活进程；文件和环境边界真实生效；后台服务可查询和关闭 |
| 3 浏览器与电脑 | 独立浏览器登录态、操作/截图、电脑屏幕、连接恢复、接管/归还、登记服务预览 | 截图与操作来自真实会话；接管暂停对应 AI；断线恢复到同一资源；预览来自实际进程；群并行和单成员重试仍不串资源 |
| 4 技能包与应用连接 | 脚本/资源型 Skill、成品连接目录、可写 MCP、媒体结果、结构化外发草稿、交互 Apps | 脚本只在已配置执行环境运行；写入明确目标和真实批准；撤销立即生效；重试不重复发信/写入；MCP 元数据不能自行授予权限 |
| 5 多模态与语音 | 图片/PDF/音视频引用和预览、STT、TTS，再实时 VoiceSession | 来源能力实际匹配；转写不覆盖并发草稿；取消停止采集/播放/任务；断线不伪造成功；不同 Bot 不串语音会话 |
| 6 自动化与分享 | 全资源搜索、任务线程、事件/Webhook、群 Routine、模板与会话导出、可选自托管分享/渠道 | 搜索能定位原内容；事件幂等且可停；导出可独立打开且仅包含选择范围；远程分享可撤销；后台任务状态能核验 |

资料与文本 Skill 已完成阶段 1 功能、CI 和跨平台安装包验证，签名发行正在进行，不依赖建立云账号。阶段 2 已按批准方案采用本机 Docker Linux，真实 arm64 环境集成、源码界面与最终未签名 macOS 包场景通过，Windows 真 Docker、签名和正式发行待完成。普通进程的工作目录不等于文件系统隔离；当前只开放隔离容器命令，宿主 Shell、通用 GUI 与远端部署不进入首轮。

最小资源关系为 `Environment → ExecutionSession → BackgroundProcess / BrowserSession / ComputerView`，任务身份仍使用已有 `Runtime runId / Room batchId / member turnId`。共享环境不自动共享资料范围、浏览器 profile、连接器授权、进程或预览端口。新的业务操作接入 [产品操作服务](../src/main/product-operation-service.ts) 与 [产品目录](../src/shared/product-operations.ts)，继续由界面和 AI 共用处理函数。

## 阶段 1 实施记录

目标版本为 **v0.3.0-beta.27，待发布**。本次增加 38 个 `library.*`、`documents.*`、`skills.*` 操作，界面与接入 AI 共用宿主处理与权限校验；`skills.load` 和 `skills.readFile` 是实际读取工具。模型加载文本指令与辅助文件不等于脚本执行，也不扩大工具权限。

SQLite 保存资源、不可变版本和会话绑定，导入文件保存为应用拥有的内容寻址字节。消息、幂等摘要、群路由和 PromptManifest 使用固定引用；修改资料产生新版本，成员重试保留原版。移出只撤销当前会话；删除影响所有已绑定会话且可恢复。私聊资料不会因 Bot 入群被共享。

最终开发 CI 的 Linux 单元测试 **1,219 通过、3 跳过**；macOS 源码冒烟 121 通过、安装包资料库 8 项通过；Windows 安装后 24 项通过。签名发行仍为独立门禁，完整证据见[实施记录](IMPLEMENTATION_PLAN.md)。该阶段未实现 Docker、浏览器／电脑、脚本技能执行、Gmail／Drive／Notion 内置连接或语音。

## 阶段 2 实施记录

当前源码为 **v0.3.0-beta.28 开发候选，未正式发布**。开发分支增加 23 个共享环境／执行／进程操作，真实本机 Docker Worker 和按会话／成员隔离的环境。命令／输出、任务取消、独立后台服务、有界真实文件传输与监听端口检测均有对应界面与 AI 入口。后台服务可保留至应用关闭／清空聊天之后，环境休眠则中断任务，不重放未知副作用。群成员移出只释放对应环境；删除阻止迟到首次启动，前台取消阻止尚在准备的命令继续启动，同值观察不触发循环刷新。

完整本机单元 1,285 通过、20 跳过；独立启用的专项 33 项无跳过通过，包含 Worker 单元 15、真实 Worker Docker 9、宿主 Docker 5、AI gateway Docker 4。22 项 SQLite／合同及 2 项 admission／旧撤销范围回归通过，最终 TypeScript／lint／开源／文档／许可／安全检查通过，源码隐藏 Electron 3 项通过。最终未签名 macOS 包的 3／3 场景通过，实际版本 beta.28、`isPackaged=true` 且 Worker／许可指南来自 Resources；真实 Windows Linux Docker、分支晋级和签名发行仍待完成。只有端口登记，没有浏览器／服务预览、桌面、截图和接管；技能包脚本执行、应用连接、多模态与语音保持阶段 3–6 范围。设置与限制见[执行环境说明](EXECUTION_ENVIRONMENT.md)。

## 阶段 3 实施记录

当前 beta.29 开发候选增加 27 个共享浏览器／电脑／预览操作。21 项 Worker／代理专项、4 项真实 Host、23 项图片／CLI 生命周期 已通过；完整本机单元 1,376 通过、35 跳过，14 项隐藏恢复／布局通过。真实 Browser 界面 2 项与最终未签名 macOS 包 13 项通过，跨平台 CI／签名发布待完成，Windows Linux Docker 未验证。模型图片传输与视觉理解分别标识；失败或未验证项保留在[实施记录](IMPLEMENTATION_PLAN.md)。使用和限制见[浏览器与电脑](BROWSER_COMPUTER.md)。脚本技能、应用连接、多媒体、语音及阶段 6 能力尚未交付。

## 主要实现入口

阶段 4 首个脚本 Skill 单元为 `v0.3.0-beta.30` 开发候选，仍在验收。新增六个脚本操作、固定版本／入口／镜像授权、不可变审批快照、源码确认与原执行状态查询。脚本只在配置的 Docker 环境内执行，未知结果不自动重跑，元信息不授予权限。第三方应用、示范草稿、外发与写 MCP／Apps 尚未交付；真实 Worker、界面与安装包证据继续记入[实施记录](IMPLEMENTATION_PLAN.md)。使用见[脚本 Skill](SCRIPT_SKILLS.md)。

| Aevoren 模块 | 复用或扩展方向 |
| --- | --- |
| [Runtime 执行器](../src/main/runtime-executor.ts)、[Room 协调器](../src/main/room-coordinator.ts) | 新工具归属、并行、停止、成员重试与恢复 |
| [能力注册](../src/main/capability-registry.ts)、[模型接入](../src/main/model.ts) | 来源可用性、媒体事件和真实能力快照 |
| [数据库](../src/main/database.ts)、[Memory](MEMORY.md) | 资料/Skill/会话/环境记录；保留原数据并提供迁移恢复 |
| [MCP 服务](../src/main/mcp-service.ts)、[OAuth](../src/main/mcp-oauth.ts) | 连接目录、写动作、媒体结果和 Apps |
| [Routine 服务](../src/main/routine-service.ts) | 事件触发、群目标与可选常驻调度 |
| [联系人详情](../src/renderer/src/components/ContactDetail.tsx)、[聊天](../src/renderer/src/components/Conversation.tsx) | 资料库、Skill、电脑、语音和任务入口 |
| [附件](../src/main/attachments.ts)、[成果](../src/main/artifacts.ts) | 媒体引用、预览、下载及导出 |

## 可复查证据

安装包 ASAR SHA-256：`a4662991353e61761558fb6fcbe6c9a3298dd17df5d9e9f9f3eba98cf016a834`。

| REA 记录 | 标识 |
| --- | --- |
| 原始 JavaScript 应用分析 | `ev_675717a6da5aace33f59361ba87ef5db33fb94d6e795ad086bd22acdf88226dc` |
| 分析摘要视图 | `ev_e918fc1383a450afe06cbba7aa497d9bd38602f5d72bbec04d21789bc7e01dc0` |
| 745 项模块身份视图 | `ev_4d28870e81d3ba1bd53bafbe5fad811ec4895760530377b30a578283f41bd279` |
| 安装包只读提取与逐文件摘要 | `ev_02bb8961be936bc7fd6f214586c560a09ce68a3ba22fb15dd52e03a5451fff99` |
| 电脑预览模块视图 | `ev_4f57e9d11745a387b060094ca93f55a3210eff6bd5971ec5adee1c7a15fd65be` |
| 文本 Skill 导入模块视图 | `ev_e2619d081b9c0d4acd68b1138ea32c35b534bb067b7aa6a592b87c06144460eb` |
| VNC Preload 模块视图 | `ev_cf76126549e23f4941c87f943b8ff8b5a6c665c26effcda8f02cfad97b54531a` |

以下位置均为该版本 ASAR 内路径与 UTF-16 字符偏移，不能作为其他版本的固定地址。

| 功能链 | 主要位置 |
| --- | --- |
| 共享 Box 与云状态 | `dist/electron-main/main-app.cjs` 1796210、1797971；`dist/electron-main/proto.cjs` 769720、770702 |
| 屏幕、窗口和接管 | `dist/renderer/assets/index.eager-app-aiFqpW8R.js` 903750、906636；`chunk-computer-screen-preview-Cr1P0SK4.js` 9387；`chunk-box-desktop-modal-CZ66jeVR.js` 9189 |
| 本地执行与文件 | `dist/local-exec-daemon/main.cjs` 2859116、2864342、2865484、3281509 |
| Skill 和导入边界 | `index.eager-app-aiFqpW8R.js` 1475341；`chunk-team-setup-new-skill-dialog-D22ECcwv.js` 3462、3776、5465；`dist/electron-main/main-app.cjs` 1993346；`proto.cjs` 938732、939567 |
| 资料、编辑、附件 | `index.eager-app-aiFqpW8R.js` 258252、262148；`chunk-document-page-7wYDMWxd.js` 232405；`dist/electron-main/main-app.cjs` 2091443、2096418 |
| 语音 | `index.eager-app-aiFqpW8R.js` 1057123、1060526、1571661、1683214；`dist/electron-main/main-app.cjs` 1636911 |
| 连接与 Apps | `index.eager-app-aiFqpW8R.js` 1342560、1652163；`dist/electron-main/main-app.cjs` 2168997 |
| 搜索、模板和自动化 | `dist/renderer/assets/index-ByKx0M82.js` 1889356、1892177；`index.eager-app-aiFqpW8R.js` 435586、1188730 |
| 设置与通知 | `dist/electron-main/main-app.cjs` 1771342、2083596、2243581；`dist/electron-main/main-core.cjs` 496912、513184 |
| 悬浮聊天面板 | `index.eager-app-aiFqpW8R.js` 274500；`dist/electron-main/main-app.cjs` 1954582、1957403 |

源码锚点只支持对应客户端链。尚未验证的项目包括云端环境/fork 的完整隔离、登录态跨重建保留、AI 自动点击实际成功、长期服务/容器运行、脚本型 Skill、示范学习算法，以及当前账号的所有功能开关。专属邮箱、完整会议助手和独立 Todo 仍保持待确认状态。


### Notion 页面更新候选（beta.35）

新增独立的仅改标题与末尾追加段落草稿，分别授权明确页面 ID。审批固定账号、原标题属性 ID 与草稿版本；单次 PATCH 保留已有正文。返回子块 ID／503 提交提示通过精确块 GET 核验，缺少证据保持未知，不重发。标题只读核对明确标识为目标当前状态，不能证明原请求造成变化。受控 HTTP、真实 SQLite 和 Renderer 检查已通过，隐藏界面、安装包与跨平台证据另记；真实 Notion 凭据未验证。
