# 产品操作向 AI 开放

## 目标与范围

产品的每项已有用户功能都应能被接入的 AI 发现、发起并查询实际结果。界面与 AI 共用业务处理和参数校验；CLI 不取得任意 IPC、数据库或 Shell 执行权限。

原有目录包含 23 个界面功能域的 96 个宿主操作与 7 个语义操作，共 103 项。阶段 1–3 增加 38 个资料／Skill、23 个环境／执行／进程和 27 个浏览器／电脑／预览操作；脚本 Skill 交付另增加六个执行操作、固定辅助文件读取、审批快照读取和单群成员停止，共 200 项。原生读取／本地草稿增加 15 项、外发增加 11 项、示范草稿增加 9 项、可写 MCP／Apps 增加 11 项，共 246 项。发布可用性以[实施记录](IMPLEMENTATION_PLAN.md)为准。另有 `view.request` 的 25 个界面动作。事件回复、窗口生命周期应答不是用户业务功能，禁止作为任意模型操作暴露。目录与处理函数双向检查，漏登动作会在启动和测试时被发现。

| 范围 | 操作入口 |
| --- | --- |
| 个人资料、附件、成果 | userProfile、attachments、artifacts |
| 完整功能与权限信息 | capabilities.getSnapshot、product_catalog、product_describe |
| Bot 联系人及内容团队 | bots、bots.get、teams.createContentTeam |
| 聊天整理、项目与会话历史 | conversations、projects、sessions、transcript、transcript.page |
| 群聊及成员、Brief 决定 | rooms |
| 消息与任务控制 | messages、runtime、roomRuntime |
| 委派结果、等待与群回答 | tasks.getResult、tasks.waitResult、tasks.getRoomResult、tasks.waitRoomResult |
| 长期记忆及候选 | memories |
| 文件范围与权限 | workspaces |
| MCP 配置、授权及连接检测 | mcp |
| 定时任务与执行历史 | routines |
| 通用设置、模型连接、更新 | settings、providers、updates |
| 执行记录和用户审批 | tools、approvals |
| 固定版本脚本 Skill | skills.scripts、executionGrants、grantExecution、revokeExecution、runScript、scriptExecution |
| 原生应用读取、本地版本草稿 | connectors、drafts |
| 固定草稿外发、写授权与结果核验 | outbound |

脚本入口与工具声明不代表执行授权。`skills.runScript` 需要本会话执行者的精确授权，并在本次审批前保存不可变的版本、入口摘要、环境镜像、解释器、参数和目录。`approvals.review` 读取这份宿主记录并复核当前可执行状态；取消、撤销或未知结果不能通过重放缓存绕过。日志、退出码和单任务停止复用既有 execution 接口，见[脚本 Skill](SCRIPT_SKILLS.md)。

`outbound.prepare` 固定本地草稿版本、账号、写授权及目标，`outbound.send` 通过同一审批链执行；批准快照不含凭据。界面的外发任务使用 `host-outbound` Runtime，明确属于宿主业务动作，不伪装成模型回复。派发后连接中断或无法核验的结果保存为 unknown；`outbound.reconcile` 只读核验，不能重复发送。取消只封闭所属任务。移出后再加入群成员不会恢复旧草稿／外发正文。当前支持范围和未验证边界见[外发草稿](NATIVE_OUTBOUND.md)。

现有 Workspace 文件工具、网页搜索/抓取、时间/天气、剪贴板、文本计数和经过审查的只读 MCP 工具保留。它们的参数与当前可用范围由实际工具定义及能力快照提供，不把文件授权、连接检测或目录查询误报为数据读取成功。

## 统一调用

模型先用 `product_catalog` 搜索或列出动作，再用 `product_describe` 获得精确输入，最后用 `product_execute` 调用。空输入的动作可以省略 input；Bot/群成员必须使用实际 ID。实际输入仍通过宿主 Zod 校验和现有业务保护。

API 使用函数调用，Codex 使用 Dynamic Tools，Claude 的兼容 API 登录使用每个 Runtime 的 MCP 桥接。Claude 的安全文本登录路径仍关闭 CLI 原生工具，通过本轮随机标记绑定的完整结构化请求进入同一宿主执行链；普通文字、错误标记、未知工具或伪造权限不执行。认证方式是否可用由现有 CLI 登录和真实请求决定。

操作回执区分 completed、running、waiting_user、cancelled 和失败。长任务返回实际 runId 或 batchId；查询和等待只返回该次委派的实际回答与状态。目录、模型文字和参数说明不能算执行证据。

## 权限、来源与恢复

基础状态与不含私密正文的目录可直接查询。私人历史、长期记忆及写操作复用当前真实用户审批；扩大权限、配置程序、删除、更新和重启遵循已有保护。权限卡片展示操作内容与宿主解析的目标。原有公开只读自动授权不适用于产品写操作、MCP 或私有文件。

AI 可以转交用户对具体审批的真实决定，但执行必须有该转交操作的用户批准及参数摘要绑定；不能自行批准自己的请求，也不能通过审批转交链扩权。Brief 决定绑定真实候选和文件哈希，非真人来源不能伪装成批准消息。密钥仍在可信配置入口保存，模型不能把明文 API 密钥写入工具日志。

真人、AI 委派和 Routine 来源持久区分。委派不把接收 Bot 的私聊历史或长期 Memory 自动加入上下文；文件访问需要真实批准，不继承其目录自动授权。定时任务沿用已经配置的范围与当前权限，但不冒充新真人消息或生成自动长期记忆候选。

普通委派最多深度 3，同一请求最多 8 次委派及 8 个新资源；内容团队是 5 个 Bot 加 1 个群。原子创建与成功回执共同提交，回执失败即回滚资源；同一请求校验后的默认值及字段顺序规范化，重复调用复用结果。未知中断不盲重发。取消父任务会取消其仍在运行的委派及群任务。

## 界面动作

`view.request` 覆盖打开聊天/联系人/工作区/设置/个人资料、打开 Bot 或群管理、任务成果与记录、侧栏搜索/未读/展开/多选、模型搜索、草稿读取和摘要保护更新、提及及响应模式、附件添加移除、头像选择、窗口显隐、退出与关闭更新通知。

后台业务动作不自动切换聊天或抢占窗口。需要文件选择、头像裁剪或登录时，如实返回用户交互状态。草稿更新需要当前摘要，内容发生变化时保留用户输入。退出仅在当前请求成功完成且没有其他活跃任务时进行；当前请求取消或失败即撤销退出安排。安装更新同样等待当前请求完成和全局任务空闲，重新核对已下载版本后执行，不把安排安装当作安装完成。

## 浏览器与电脑

`browser.*`、`computer.*`、`preview.*` 使用同一宿主处理与当前会话／执行 Bot 的 Scope。目录元信息不能代替授权，模型不能提交 actor、Worker 凭据或任意 IPC。写动作审批后才执行，稳定意图沿用原操作／预览回执；取消阻止迟到输入并保留兄弟任务。

用户接管后 AI DOM 读取、屏幕上传和输入均被拒绝；断线不自动归还。AI 的接管／归还／VNC 请求只返回 `waiting_user`，不返回连接能力。明确归还后要求新观察，旧控制意图不再次改变归属。服务预览核验原登记进程 UID 和 listener，旧端口被复用不转到新服务。

截图工具回执只保存媒体元数据。实际有界 PNG/JPEG 通过 API user image、Claude MCP image 和受支持 Codex app-server inputImage 临时传递，发送前重新核对 Scope／epoch／Runtime。缺少图片传输能力时明确返回限制并保留 DOM 操作；真实传输 fixture 不计为云模型视觉理解。配置与边界见[浏览器与电脑](BROWSER_COMPUTER.md)。

## 验收与发布

单元及业务验收使用真实 SQLite、真实处理服务和故障注入，覆盖设置审批、团队原子创建、重复请求、私密范围、真实来源、用户决策转交、委派结果、级联取消、新旧资源额度、昵称局部更新和参数失败恢复。受控 HTTP/CLI fixtures 验证协议，不作为真实模型成功证据。

真实 API、Codex 和 Claude 已在隔离数据、隐藏窗口中通过功能发现、参数说明、主题修改、团队创建及实际跨 Bot 委派回答；证据记录实际模型、route、成功工具摘要、实际资源数量和界面状态。CLI 认证仍依赖用户本机配置；103 个动作未作为真实模型逐项执行来声明验收；破坏性操作、系统文件选择和安装重启通过现有业务/隐藏界面回归验证。本机 Claude API 登录已验证隔离 MCP 入口；强制兼容文本入口的 k3 模型被 CLI 拒绝，不能把该入口计入真实成功证据。其结构化协议通过契约回归，OAuth 登录方式需在具备对应凭据时单独确认。Windows 的实际 CLI/认证环境不能由 macOS 验收代替。

当前 Beta 发行完成 dev 开发验证 → 合入 beta → 测试环境与安装包验证后发布，master 暂不晋级。后续生产发行必须在 Beta 验证成功后再合入 master。Release 标签和标题均精确为 `v<package.json version>`。未验证项目必须保留具体状态，不能用模拟结果计入真实来源或平台完成度。
