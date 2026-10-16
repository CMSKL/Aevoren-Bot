# Aevoren 功能扩展实施计划

基线为 0.3.0-beta.26。实施依据为 [功能对照](FEATURE_ADOPTION.md)，按六阶段补齐界面与 AI 能力，共用宿主校验、真实审批、执行记录、取消和恢复，保留 `@所有人` 六成员并行。产品登录注册、多人云协作、支付、完整会议助手和专属邮箱不进入首轮。

当前 **v0.3.0-beta.37 仅是本地整合草稿**：从实际 dev `d0c2ec4d28507b8707420b5a424b516e240cc3d7`（package 为 beta.35）出发，正常整合 PR #67 的 beta.36 与原 Voice37 `dcbe41ef6c9ceb95c7d27dc6fe870e3b43f479aa`，再正常合并后继测试修正 `ceb4aa5213f1a1fe2d85a1f04dbce9e14947aeba`。PR #67 尚未合入受保护 dev，本地37也未推送或建立 PR；下面的本地专项已通过，自身完整 CI、跨平台及签名包验收仍待完成。实际 dev 推送 CI 38874946550 与固定 beta.35 预览 38875180574 已分别完成四项完整检查，包含 Windows 实际安装包与关闭验证；它们不替代 PR #67 或本地37的独立门禁。beta 保持 beta.34，最新公开版本仍为 **v0.3.0-beta.33**，master 暂不晋级。本单元包含独立 STT／TTS 与有界音视频；Realtime 只保存配置，实际连接属于 beta.38，阶段 6 按后续单元单独交付。

下文回执保留各自原始提交和安装包的历史证据。原 beta.36 的实际 dev 身份整合、106 项专测、6 项源码解析器与 10 项真实 Mac 包证据不因这次本地37合并而成为新组合验收；真实硬件／云账号也未由受控测试证明。

后继 MCP 测试修正只改变未打包的测试与本实施记录；正常合并前后的应用、Worker、依赖、构建配置及全部打包资源逐项比较无变化，原本地37 Main／ASAR 与资源回执维持相同字节，不重复构建或冒充新 Windows 验收。PR #67 修正提交自身完整 CI 38879862158 仍待完成，原 Windows 指针原因保持未知。

本地37整合回执（2026-10-16）：

- 13 个文件专项 99 项通过、1 项现有可选 Codex 协议产物跳过；五个 TypeScript 项目、构建、ESLint、文档与开源文件检查通过。包校验器单测 11／11 通过。
- 新未签名 macOS 包实查版本 beta.37；Main SHA256 `81230e3f8340b620e41354403495998466d946ff543dc75eb8a49ac590b4fa86`，ASAR `31ab89d053f0af5fbc1a4c7b6127024aae8e3cb9a131bb7028364e12f1fe857b`。16 个应用文件与 228 个配置资源逐字节一致；解析器 1.1.0 的 207 项清单资源通过，麦克风用途声明及 4 个 Helper 存在，未据此声称签名权限或真实硬件可用。
- 单工作进程静默运行：源码解析器 WAV 2／2；真实新包语音 4／4 与严格退出／重启 1／1。无跳过、重试或强制清理；语音用显式 mock-keychain 并断言实际开关，录音与播放均由 fixture 代替，HTTP 为 loopback 受控服务。六成员请求在首个结果前全部启动。
- WebM 编码及实际媒体元素播放的两项场景本机不运行，完整 CI 保留；没有真实云密钥、麦克风、扬声器或 Windows Docker 验收。真实 SDK 的四项图像／文本授权回归属于源码证据，不能当作真实包里的 Claude CLI 验收。
- 官方音频文档已重新读取核对，保留 `gpt-transcribe` 与 `gpt-4o-mini-tts` 适配器及已记录的 TTS 停用日期，不把 Realtime 替代模型直接套到 Speech 接口。历史构建输出已完整归档后才重新构建，未复用旧包作新证据。

PR #67 的首个完整组合 CI（`0444b749`／38875596148）保留为失败记录：Linux、macOS、Secret 检查通过；Windows 单元 1,632 项通过、66 项跳过，源码场景 49／50。唯一失败为 MCP App 的不支持能力请求：隐藏 iframe 中按钮处理器没有进入，`requestPosted=false`，尚无 RPC 请求，不能据此认定宿主拒绝响应或产品权限错误。Windows 指针投递的具体原因仍未确定。

当前仅调整这项协议验证：检查可见按钮及其文档内 activeElement，再使用一次真实 Enter，断言可信处理器与实际请求已触发，继续核验 HTTP 200、相同请求 ID、错误码 -32601 和原有 App 写入审批。未使用 DOM click、强制点击、重发、重试或放宽时间。初次键盘探针在 Playwright `toBeFocused` 前置检查失败；其实现同时要求 document.hasFocus，当次未分别记录两个条件，不能反推具体失败分支。修正后源码与真实既有 beta.36 包各 1／1 通过，均记录 `activeElement=true`、`documentHasFocus=false`、可信事件及完整响应，静默窗口无需取得系统焦点。测试启动显式使用并核验 mock-keychain；真实系统密钥库不由此验收。原 Windows 日志和两次本地探针均保留。

这一变更不修改应用、Worker、构建配置、依赖或打包资源，沿用逐字节核验过的同一 Main／ASAR；新的完整组合 CI、实际 Beta 和签名门禁仍须完成。Mac 本地通过不等于原 Windows 指针原因已解决。

## 已确定的方案

- 电脑首期使用本机 Docker 隔离 Linux 环境，自托管服务器后置。
- 云语音使用用户自带密钥，转写、朗读、实时语音独立配置。
- 首批内置连接为 Gmail、Google Drive、Notion，保留通用 MCP。
- 沿用现有聊天、联系人、设置、主题和图标；新增功能入口。

## 共用架构

资料与 Skill 使用不可变版本与显式会话绑定；文本正文、元数据、版本存 SQLite，二进制资源存应用拥有的内容寻址存储。导入先暂存真实字节，后提交版本与绑定，取消不发布半成品。编辑采用 expectedVersion，冲突保留草稿；修改产生新版本，授权撤销阻止后续读取。

发送命令增加结构化资源引用，固定资源 ID、版本和摘要并写入消息、幂等摘要、群路由摘要与 PromptManifest。成员重试沿用原版本。私聊资源不会因 Bot 加入群聊自动授权给群成员。

环境按 sessionId 与 executorBotId 隔离，Runtime 建立独立 ExecutionSession。执行容器与浏览器/桌面伴随容器分开，Shell 不访问浏览器登录卷。TypeScript Worker 使用版本化 HTTP 与事件流，首期仅连接本机 Docker、仅开放 loopback；发布 linux/arm64 与 linux/amd64 镜像。

六成员不共用全局执行锁。停止只终止所属任务，明确登记的后台服务拥有独立生命周期。休眠停止容器并保留持久卷；唤醒核对资源，不自动重放未知副作用。用户接管时暂停相应 AI 输入、观察和画面上传，归还后重新观察。

界面和 AI 共用产品目录、输入 schemas、业务 handlers、Preload/IPC 与能力快照。AI 继续使用 product_catalog、product_describe、product_execute。新增 documents/skills/library、environments/execution/processes、browser/computer/preview、connectors/drafts、media/voice、search/templates/exports 操作族。

## 阶段与交付记录

| 阶段 | 交付范围 | 当前状态 | 验收证据 |
| --- | --- | --- | --- |
| 1 资料库与文本 Skill | 持久资料、版本、文本检索、绑定；SKILL.md 导入、启停、结构引用、按需加载 | 已纳入 v0.3.0-beta.29 签名发行 | 开发与跨平台安装包验证通过，之前签名 fixture 失败保留为历史记录 |
| 2 执行环境 | Docker 探测、镜像、Worker、生命周期；命令与输出、文件、后台进程、日志与端口 | 已纳入 v0.3.0-beta.29 签名发行 | 33 项专项、源码与真实 macOS 包验证通过；真实 Windows Docker 未验证 |
| 3 浏览器与电脑 | 独立 profile、Playwright、截图图像传输、noVNC 接管及服务预览 | v0.3.0-beta.29 已公开发布，master 未晋级 | 最终开发／Beta CI 全绿，签名工作流成功；此前 13 项真实未签名 macOS 包验收与 Linux Docker 证据保留 |
| 4 技能包与应用连接 | Bash/Python/Node 脚本、资源、示范草稿；Gmail/Drive/Notion、写 MCP、外发草稿与 Apps | 脚本／读取／外发／示范已纳入 beta.33；MCP34 与 Notion35 按序待发布 | 历史组合 `4178157`：Linux 普通 1,593／45 跳过与真实 Docker 41；macOS 源码 139、实际功能包 21、关闭 8；Windows 普通 1,578／60 跳过、源码 40＋关闭 8、安装包 38＋关闭 8；真实第三方账号写入未验证 |
| 5 多模态与语音 | 图片/PDF/DOCX/音视频；STT/TTS、实时语音、打断与转录 | 5.1 候选待合入 dev；5.2 本地37专项通过，完整 CI 待完成；5.3 不在本单元 | 当前37专测 99／可选跳过 1，源码 WAV 2、实际 Mac 包 5，字节与声明校验通过。原 beta.36／Voice37 历史证据单列，不据旧回执宣称新组合通过 |
| 6 自动化、搜索与分享 | 全资源搜索、TASK 线程、分区/默认助理/头像/通知；事件/Webhook、群 Routine、模板及导出 | 后续交付，未纳入本单元 | 待按对应单元补充 |

## 阶段 1 交付记录：v0.3.0-beta.27（历史快照）

当时为未发布候选；这些能力后来纳入 beta.29 发行。master 不晋级。该候选完成以下实现：

- 资料/文本 Skill CRUD、正文检索、expectedVersion、不可变版本、历史恢复、启停、软删除及显式会话绑定；跨会话只提供可复用元信息，正文读取仍检查绑定。
- `SKILL.md` YAML 元信息、文件/目录导入、references/scripts/assets 保存、内容寻址摘要校验与固定版本导出。导出保留真实字节、不覆盖已有目标；取消和无效输入不发布部分资源。脚本不执行，二进制只提供元信息。
- 联系人私聊和群资料入口、Markdown 编辑/预览、保存/丢弃/继续编辑导航保护、冲突后读取最新基线并保留草稿。
- `/Skill` 与 `@` 的 Bot/资料/Skill 分组、按 session 缓存的资源引用和草稿；添加 Skill 只准备消息，用户发送后走现有 Runtime。资源选择不修改 Bot 路由，六成员可共享同一固定原版并各自回复。
- 38 个共享产品操作；`skills.load` 在当前任务读取已授权文本指令，`skills.readFile` 读取已保存辅助文本。AI 写入、删除、共享和导入仍受既有审批与来源权限约束。
- 固定引用进入 Transcript、Send Journal、幂等/群路由摘要和 PromptManifest；重试保留原版，撤销、停用或删除阻止后续读取。AI 草稿更新核对资源授权、digest 及异步前后草稿版本。
- 数据库增量迁移与原子变更回执；沙箱 Preload 仅导入纯通道常量，不加载宿主 schema 依赖。

| 验证项 | 状态与证据 |
| --- | --- |
| 完整单元测试 | 最终 Linux CI 1,219 通过、3 跳过；Windows 1,214 通过、8 跳过，覆盖真实 SQLite、文件字节、版本/授权、导入导出、业务审批/回执及 UI 契约 |
| TypeScript / ESLint | 完整 TypeScript、ESLint、构建和文档链接检查通过 |
| 隐藏 Electron | 最终 macOS CI 完整源码冒烟 121 通过、33 跳过；两项迟到导航先复现失败、修复后通过；200% 缩放页头回归通过 |
| 导出归属回归 | Linux 旧实现 100/100 误删替换对象；持有原句柄后 400 次替换保护与 100 次正常导出通过，无句柄泄漏；本机 24 项文件系统回归、联合业务测试 68 项通过 |
| macOS / Windows 安装包 | 最终 CI：macOS arm64 包八项资料库场景通过；Windows x64 NSIS 安装、启动、语言包和 24 项安装后场景通过（包含八项资料库验收）；Windows 源码冒烟 26 项通过 |
| 分支与签名发布 | [Beta PR #20](https://github.com/CMSKL/Aevoren-Bot/pull/20) 已合入 beta `dc482777`，标签 `v0.3.0-beta.27` 精确指向该提交；[签名工作流](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38510099979) 首轮 Apple stapling 网络失败，重跑后签名／公证成功，但签名包资料库 fixture 八项超时，未创建正式 Release。正在定位 CI 凭据保存／Keychain 边界，不降低安装包门禁 |

验收采用临时数据与受控 localhost HTTP，未调用真实云模型或用户聊天数据库。Windows 符号链接相关用例受运行器权限限制而跳过；未将这些边界标为实际验证。

该历史时点的阶段 1 只完成文本资料与 Skill 能力，阶段 2–3 尚在后续验收；此段不描述 beta.35 的当前实现。未发布能力不能作为已安装产品的可用功能。

## 阶段 2 交付记录：v0.3.0-beta.28（历史快照）

开发分支为 `codex/docker-execution`，从已验收的 `dev` 创建；`v0.3.0-beta.28` 已合入 beta 并建立同名标签，尚未公开发布，master 不晋级。

- 23 个共用 `environments.*`、`execution.*`、`processes.*` 操作，联系人／群成员执行页和设置 Docker 状态卡；AI 由宿主补全会话与执行者，拒绝跨范围身份，变更进入真实审批。
- 本机 Docker Linux 探测、镜像准备、创建／唤醒／休眠／重建；Worker 1.0.0、协议 1、版本／能力健康检查、认证 loopback 控制与实际镜像摘要。应用升级不自动替换已运行环境。
- 真实 Node／Python／Bash 命令、stdout／stderr 字节、退出码、前台取消、独立后台进程和日志；每环境 32 个活跃任务 UID 槽位，六成员环境并行，无全局执行锁。
- 发送意图 nonce、Runtime provenance、同命令重试查询原任务；省略与显式默认 `cwd=.`／前台 120s 规范化一致。接收未确认用 unknown 保存，不把未知副作用当成可自动重放。
- 环境工作区文件列表、读取、写入、原生上传／下载，单文件解码后最多 1 MiB；默认仅新建，覆盖核验 expectedSha256，拒绝越界、符号链接与特殊文件。
- 后台服务端口核验 Linux listener 的任务 UID 归属和实际连通性；停止后更新真实端口状态。端口登记尚不提供浏览器或服务预览。
- 迁移 35 使用现有 SQLite 连接保存环境／执行／日志／端口，并可嵌入本地回执事务；远端执行不伪装为可原子回滚。历史 Runtime 删除后保留后台记录与 provenance，创建新任务仍核验真实 Runtime 同范围。
- 关闭应用／清空聊天记录保留运行中的后台服务；休眠中断该环境所有任务并保留卷，唤醒不重放。删除 Bot／群释放相关容器后清理应用记录，保留命名 Docker 卷。
- 群成员移出只清理该群／成员 tuple 的环境，不影响私聊、同群其他成员或其他群。删除期间首次启动在提交环境前再次检查 admission；旧撤销范围记录不阻塞兄弟环境恢复和退出清理。
- Runtime 取消封闭尚在准备的前台 ExecutionSession；单任务取消只登记该任务，阻止迟到启动并保留兄弟任务与独立后台服务。1 MiB 合法文件的 JSON 最大转义膨胀仍可真实读取；同值 Worker 观察不递增版本、不反复触发 UI 刷新。

| 验证项 | 当前状态与证据 |
| --- | --- |
| 完整本机单元 | 1,285 项通过、20 项跳过；Docker opt-in 场景由下面独立启用的专项验收补齐，不把跳过计为实际执行 |
| SQLite／共享合同 | 22 项真实回归通过，覆盖六成员范围、版本冲突、同 nonce 默认规范化、未知结果、日志滚动、端口、清空历史及成员精确清理 |
| admission／旧撤销范围 | 2 项确定性回归通过；使用真实 SQLite 与真实磁盘 context 字节摘要、延迟 IO 屏障核验首次启动拒绝，Docker 动作仅用于边界单测、未当作真实执行成功 |
| Worker／真实 Docker／AI 工具链 | 专项 33／33 通过、无跳过：Worker 单元 15 项、真实 Linux Worker Docker 9 项、宿主服务 Docker 5 项、AI gateway Docker 4 项；包含启动取消、独立后台服务、真实文件字节及端口归属 |
| TypeScript／质量门禁 | 最终 Node／Web／Worker TypeScript、ESLint、open-source readiness、文档、npm 许可和 security 检查通过 |
| 隐藏源码 Electron | 3 项执行环境场景通过，使用临时数据与受控环境 |
| 最终 macOS 安装包 | 未签名 beta.28 包的 3／3 执行环境场景通过，实查 `appVersion=0.3.0-beta.28`／`isPackaged=true`、Worker 与许可指南来自 Resources；未签名包不作为官方发行或签名验收证据 |
| Windows Linux 容器 | 未验证；CI 无 Docker daemon，不将其声明为真实环境支持验收通过 |
| 分支与发布 | [PR #22](https://github.com/CMSKL/Aevoren-Bot/pull/22) 四项 CI 全绿并合入 dev；[Beta PR #23](https://github.com/CMSKL/Aevoren-Bot/pull/23) 已合入 beta `dabe27fc`，标签 `v0.3.0-beta.28` 指向该提交。签名包资料库验收已修复，但 Apple stapler 验证两次遭遇网络连接丢失（-1005／Error 68），中间一次保存 fixture 回执竞态已由 [PR #26](https://github.com/CMSKL/Aevoren-Bot/pull/26) 修复。未创建 Release；下一候选纳入有界网络重试，不移动旧标签 |

镜像 base manifest 固定为 `node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`，实际构建 digest／平台保存在环境记录。Docker 由用户提供，首期保持同一个本机 context，不挂宿主 HOME、Docker socket 或浏览器 profile。Worker 保留对外网络，审批过的命令仍可能产生外部副作用；执行目录不代替容器隔离。镜像内 Node／Python／Debian 工具各自保留许可，见[执行环境与镜像说明](EXECUTION_ENVIRONMENT.md)。

本阶段没有交付 BrowserSession、桌面／截图／图像传输、接管、服务预览、可执行 Skill 包、应用连接或语音；这些继续按阶段 3–6 实施。首期命令界面不提供交互式 PTY。

## 阶段 3 交付记录：v0.3.0-beta.29（候选与发行历史）

当前发行状态： [Beta PR #29](https://github.com/CMSKL/Aevoren-Bot/pull/29) 已合入 beta `c36049b8`，同名标签精确指向该提交；[macOS 签名工作流](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38548693111) 成功并公开 [v0.3.0-beta.29](https://github.com/CMSKL/Aevoren-Bot/releases/tag/v0.3.0-beta.29)。标签和标题均为 `v0.3.0-beta.29`，包含 DMG、ZIP、blockmap、Beta 更新清单、SHA256 与 SBOM。Windows 签名工作流因未配置签名而跳过，不将其声明为已发布签名 Windows 包。下方候选阶段记录保留为开发历史。

Beta 验证的一轮六 Scope 截图返回 `BROWSER_OBSERVATION_STALE`，该请求没有返回过时画面；同一代码另一轮及失败检查的重跑通过，最终八项检查全绿。失败日志保留，未放宽画面来源、焦点或版本验证。

从 dev 基线创建 `codex/browser-computer` 并纳入已验证的阶段 2；当前源码与镜像已经构建，尚未作为第三阶段正式发行。

后续跨平台检查确认 Linux Docker 网络接入会重新分配 published port，宿主端口重新核验修复已经通过原生 Linux CI。桌面复核发现并修复 Playwright 模拟焦点造成的画面来源与旧截图输入问题；最终冻结包已完成相应回归，证据如下。签名测试隔离与 Windows 清理修复 [PR #24](https://github.com/CMSKL/Aevoren-Bot/pull/24) 已四项 CI 全绿并合入 dev `6c99b7b`。

- 迁移 36 保存 BrowserSession、页面／观察／控制 epoch、下载、截图引用与服务预览，使用原应用 SQLite；真实会话／执行者边界贯穿界面、AI、Worker 与媒体读取。
- 27 个共享 `browser.*`、`computer.*`、`preview.*` 操作，独立 Chromium 持久 profile、Xvfb/Openbox/x11vnc/noVNC，浏览器登录卷和控制密钥不暴露给执行 Shell。
- AI DOM／桌面操作要求当前 epoch 和新鲜观察；用户接管撤销旧图片与连接，断线或关闭面板不自动归还。只有明确归还且收到真实确认后恢复 AI；旧控制意图在后续接管／归还后不能再次改变归属。
- PNG/JPEG 真字节经 API、Claude MCP 和受支持的 Codex app-server 输入传输；发送前复验授权与活跃 Runtime，Tool Journal 不存 raw pixels。只证明传输，未把 fixture 当真实云模型视觉理解。
- Execution Worker 1.1.0 增加固定目标 HTTP／WebSocket 预览，256-bit 票据使用两段 32 hex DNS label，绑定原登记任务 UID／process／port。原任务退出或端口复用会撤销旧入口和已有 WS，不转发到新进程。
- 同 nonce 使用原 tab／预览／写入回执；取消封闭迟到操作，不取消兄弟页或独立后台服务。明确重建切换当前 Worker／伴随镜像，普通休眠保留旧镜像与卷，不自动重放未知副作用。
- 联系人和群成员浏览器／电脑页提供实际状态、浏览器读写、下载、接管／归还与登记服务预览；不控制宿主 GUI，不复制现有浏览器 cookies。

| 验证项 | 当前状态与证据 |
| --- | --- |
| 完整本机单元／质量 | 1,376 通过、35 跳过；Node/Web/执行 Worker/浏览器 Worker TypeScript、ESLint、构建、许可／文档／开源／安全检查通过，跳过的 Docker 场景单独启用验证 |
| Worker／代理实际专项 | 21／21、无跳过：8 个真实 Chromium Docker、7 单元、4 localhost HTTP／WS 单元、2 实际代理 Docker；包含六环境同时启动、实际桌面／RFB、profile／Shell 隔离、旧端口复用失效、SPA 绝对路径与 WS |
| 真实 Host／AI 工具链 | 最终 4／4、无跳过：真实 JPEG、Scope、接管、审批、旧回执、Runtime cancel、兄弟页／后台保存；最早一次首启短暂 BROWSER_UNAVAILABLE 原因未确定，后续三次首启正常，保留仅 route/code/OOM 的测试诊断 |
| 图片／CLI 生命周期 | 23／23 通过，验证真实 localhost API payload、MCP 图片块、实际版本 JSON schema 下的 Codex inputImage、过期授权和同 ID 重放；未调用用户真实云模型 |
| 隐藏界面／安装包 | 原 Runtime／200% 缩放／窄屏 14 项通过，真实 Browser 源码 2／2 通过；最终未签名 macOS beta.29 包 13／13（资料库 8、真实环境 3、真实 Browser 2）通过。实查 isPackaged、版本、两套 Worker Resources 与说明文件；RFB 输入采用实际物理键保持／Shift chord，fixture 持久 cookie／真实 listener 就绪与精确清理均保留 |
| 平台／发布 | macOS arm64 与 Linux Docker 真实专项已有证据；Windows Linux Docker 仍未验证；本阶段未晋级或签名发布，master 暂不晋级 |

使用、镜像与边界见[浏览器与电脑说明](BROWSER_COMPUTER.md)。阶段 4–6 仍按顺序实施，不据此声明脚本 Skill、应用连接、多媒体解析、语音和全资源任务能力已完成。

真实焦点修复采用应用自启的隔离 Chromium、私有调试管道与随机能力地址的 loopback WebSocket 桥，再用公开 `connectOverCDP(noDefaults: true)` 保留浏览器真实焦点。原始 Chrome HTTP 调试端口的网页关闭标签页风险已在隔离 probe 中复现并排除；新方案已实证拒绝 HTTP／未知地址／网页 Origin，仍保留真实 CDP 下载事件和文件字节。最终 Worker、Host 与安装包验证均已完成，不以 probe 代替产品验收。

新管道首轮专项 28／30 通过，cookie 重启保存和六环境截图曾失败。后续保存问题已修复并完成最终包重跑；六环境的本机内存边界与原生 Linux 通过证据分别记录如下。

后续 cookie 持久化通过真实浏览器协议关闭修复；本机剩余八个真实 Docker 场景与 21 个单元共 29 项通过。六环境场景未通过：六个均先到启动屏障，随后多个容器 OOM；截图子进程已实证仅一线程且 RSS 不超过约 12.5 MiB，Docker VM 总内存约 3.83 GiB。未修改 VM、容器内存限额或超时；六并行完整断言继续在原生 Linux CI 启用，并增加仅自有容器的 cgroup memory.events/peak 与进程名/RSS 诊断，以区分单容器限额和整机压力。此处不把本机失败算通过，也不声称更大 VM 必然解决。

原生 Linux [CI 38534108904](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38534108904) 的 Validate 在 `68a1e76` 成功：真实 Docker 33／33、无跳过（浏览器 9、Host 4、代理 2，加既有执行环境 18），六 Scope 并行用例 7.569 秒通过，端口映射 32785→32786 等实际核验成功且 OOM=false。普通 Linux 单元 1,375 通过、37 跳过；本机完整 1,376 通过、36 跳过。由此补齐六环境原生 Linux 证据，仍保留本机低内存失败与真实 Windows Docker 未验证的边界。

最终私有管道版本的隐藏源码 Browser 2／2、Host 4／4 通过；同一冻结 macOS beta.29 包完成 13／13（资料库 8、执行环境 3、Browser 2）。实查版本／isPackaged／两套 Worker Resources／随包说明；原生 F8 仅发送一次，随后等真实只读 DOM 回执再做界面断言。最新包已覆盖准确 B 页画面、旧 A 输入拒绝、下载字节与自动失败通知、预览及私聊／群登录隔离。初次无远端回执屏障的失败保留，不作为已通过记录。

## 阶段固定实现与完成条件

阶段 4 第二个交付为 `codex/native-connectors` 上的 `v0.3.0-beta.31` 开发候选。Google PKCE／本机回调、Drive 独立文件选择授权、Notion 固定 API 与只读适配器已经实现；凭据宿主加密保存，会话／Bot 明确绑定，令牌刷新不扩大权限，撤销及成员移出阻止迟到读取和旧授权恢复。Gmail／Drive／Notion 的本地草稿保留固定账号、版本与幂等标识；未实现外发。适配器受控测试 22、存储／服务／处理函数 31、真实 SQLite/IPC 隐藏场景 2 项通过；能力快照与网关另外验证授权、鲜读取和旧草稿回执复核。首轮完整普通测试 1,480 通过、44 跳过，后续网关／二进制边界修复仍需记录最终完整计数。隐藏界面暴露的群标签栏压缩问题已经用一条 flex 规则修复，真实点击重跑通过，未使用强制点击绕过。

该交付的真实 Google／Notion 凭据尚未提供，不把受控 HTTP／真实本机回调测试算作真实第三方账号验收。宿主读取的二进制只返回元信息与字节计数，没有媒体存储、下载、预览或模型像素。最后安装包与跨平台 CI 尚未完成。使用与支持边界见[原生应用连接](NATIVE_CONNECTORS.md)；外发、示范与写 MCP／Apps 仍为阶段 4 后续单元，阶段 5–6 未开始。

最终 native.31 本机验收：普通测试 1,487 通过、44 跳过，四套 TypeScript、lint、构建、文档、许可、开源和安全检查通过。Drive 25 项适配器测试包含仅请求绑定 ID 的网络边界、空授权零 HTTP、绑定／查询改变拒绝旧分页游标；不用账号级列表再过滤。真实 SQLite 与共享网关验证每次远端读取鲜取、撤销丢弃迟到正文，原草稿版本重试复核当前授权且不覆盖新草稿。最终未签名 macOS beta.31 包的原生连接 2 项通过，确认 isPackaged、beta.31 与随包连接指南；当时汇总中的 typed API 1 项更正为源码 fixture 证据，原因见末尾验收更正；较早 beta.31 包的资料库 8 项也通过。测试均采用假 provider 数据和真实本机 HTTP／IPC／SQLite，不声称真实第三方账号已经授权。跨平台 CI／签名发行仍是后续门禁。

阶段 4 首个交付从已通过四项跨平台 CI 并合入 dev 的第三阶段创建 `codex/script-skills`，候选版本为 `v0.3.0-beta.30`。固定版本、入口 SHA、镜像和会话／执行者构成脚本授权；每次运行另记录固定参数审批快照。执行复用现有任务、日志、取消与未知结果查询，Worker 1.2.0 使用私有安装缓存和逐任务只读快照。真实 Docker、界面与关键安装包场景已经通过，跨平台最终 CI 与签名发行尚未完成；该单元不代表整个阶段 4 完成。使用与边界见[脚本 Skill](SCRIPT_SKILLS.md)。

首轮普通测试 1,413 通过、36 跳过，完整四套 TypeScript、ESLint、构建、文档、许可、开源与安全检查通过。后续新增回归继续单独验证，冻结包前再记录最终完整计数。具体已通过证据如下，不把控制适配器测试作为真实执行：

- 真实 Worker 三项验证 Bash／Python／Node、Unicode／换行／字面参数、二进制资源和 Python 辅助导入，逐任务 UID／GID／group1000、只读快照与私有缓存权限；取消后代但保留兄弟和后台任务；启动前 ID／Session 取消、并发同 ID 去重、完整 251 文件／4 MiB HTTP 安装与重启保存。
- 真实 Host 四项验证导入后删除原目录仍使用固定字节、版本编辑保留原任务、精确撤销与绑定移出、真实 Worker 返回 202 后丢失响应导致 unknown，随后同 nonce 只查询且计数文件仍为 1；六个群成员经真实 Runtime 审批后并行执行，跨 Scope 被拒绝。
- 隐藏源码界面两项验证三种解释器、真实文件／日志与资源读写、私聊授权不能用于已启动的群环境、成员参数草稿隔离；迟到的可执行审批回执在撤销后不能重新启用允许按钮，固定旧名字与参数保留且零任务执行。
- 隐藏六成员审批停止一项验证只取消当前成员，其他五个 HTTP 请求继续并全部完成；群底部整批停止入口保留。

最终本机普通测试 1,420 通过、43 跳过，类型、lint、构建和文档检查通过。真实 Worker 完整 12／12、Host 4／4；未知结果 nonce 清理、迟到查询隔离及应用关闭前准备取消均有回归。安装包曾把完整审批查询参数传给严格 Scope 校验，误报不可执行；修复为仅传会话／执行者两字段，实际业务服务的有效审批正向回归通过。修正包 `e9cf650` 的两项脚本场景明确验证撤销前真实回执 `executable=true`，随后撤销／改名仍显示旧快照、禁用允许且零执行；包内单成员停止也通过。该包确认 `isPackaged=true`、beta.30、Worker 1.2.0 与随包脚本指南。

同一 beta.30 候选的资料库 8、环境 3、浏览器 2 安装包场景也通过；这些较早构建的历史证据与修正包的审批证据分开记录。首轮跨平台 CI 的 Windows 成功；Linux／macOS 失败分别来自预览测试硬编码旧 Worker 版本和运行时 API 白名单未包含新增接口，保留业务断言修正 fixture 后继续验收。当前本机 Docker daemon 已停止，新预览回归在 CI 原生 Linux 执行，不把未执行的本机检查算通过。

旧 Worker 1.1.0 的不支持分支目前是明确标识的受控 health 单测，不声称本轮启动了真实旧镜像。真实 Windows Docker、第三方账号写入与云模型推理继续标为未验证。应用连接已在独立 dev 功能分支继续实施；示范、外发与写 MCP／Apps 尚未完成。

1. 文本 Skill 兼容 SKILL.md YAML 与 references/scripts/assets；第一阶段保存整套资源而不执行脚本。用户运行 Skill 走现有 Send，AI 当前 Runtime 使用 skills.load。资源写入、共享和删除复用真实审批及原子结果回执。
2. 本地环境可实际运行 Node/Python 项目。Docker 缺失或未运行时显示真实状态；不挂载宿主 HOME、Docker socket 或控制密钥。镜像版本与应用版本独立，更新不自动重建提供后台服务的环境。
3. 浏览器使用独立持久 profile，桌面采用 Xvfb/Openbox/x11vnc/noVNC。MediaRef 必须传递实际图片字节，路径文字不计为视觉能力；不支持图片的来源保留 DOM 工具并如实标明限制。
4. Gmail 先提供搜索、读取和本地发送草稿，发送明确账号、目标和内容。Drive 首期访问用户选择或应用创建的文件。Notion 使用内部连接 Token 与 2026-03-11 API，访问已共享页面。工具元信息和 OAuth scope 不代替具体写操作批准。
5. 先录音转文字与朗读，再实时语音。独立云语音适配器首先参考 OpenAI 接口；业务继续通过当前 Bot Runtime。群回复并行，朗读按完成顺序排队。转写不覆盖并发草稿，取消停止采集、播放与所属任务。
6. MAIN 保留单个主会话，TASK 允许多个子会话；迁移条件唯一索引并保留旧 ID 与外键。子任务只复制明确选择的授权快照，不动态继承父会话全部历史。导出可独立打开，模板可导入复现，事件去重且可停。

## 验收

- 单元/业务检查覆盖真实 SQLite、文件、参数校验、版本冲突、取消和迁移恢复。
- 隐藏 Electron 使用临时数据，覆盖界面真实 IPC 与保存/恢复，避免影响用户现有资料。
- 六成员在首个结果前全部启动；审批、慢响应、失败隔离、整批取消及单成员重试均核对真实状态。
- 同 nonce 不同资源版本冲突；导入后删除原目录仍可读取；撤销与停用立即阻止后续读取。
- 私聊、群、TASK、浏览器 profile 与进程不能跨授权范围；接管暂停 AI 输入和观察。
- API、Codex、Claude 共用宿主调用链，图片按实际传输验证。不具备真实配置的来源标为未验证。
- macOS arm64 与 Windows x64 安装包验证环境、浏览器、下载、预览、语音恢复；第三方写入仅在用户批准的测试目标上进行。

## 发布

开发从 dev 或其功能分支开始，验证后进入 beta，安装包验收后发布下一可用 Beta。标签和标题都为 v<package.json version>。master 暂不晋级。每次发布同步中英文 README、用户指南、功能矩阵、Changelog、许可与能力边界。首轮不实施宿主 Shell/GUI、现有浏览器 Cookie 复制和远端部署；公共分享、完整画布和逆向未确认候选另立后续计划。

## 阶段 4 外发交付：v0.3.0-beta.32 实施中

从 dev 创建 `codex/native-outbound`，纳入 beta.31 原生读取与本地草稿基础。实现独立写授权、固定账号／目标／草稿版本的审批快照与持久外发账本；派发前登记、未知结果只读核验，不自动重发。当前尚在编码，测试和发行未完成。真实第三方写操作仍需用户批准的具体测试目标；受控 HTTP 不替代真实账号验收。示范录制、可写 MCP／交互 Apps 是阶段 4 后续单元，阶段 5–6 尚未开始。

脚本 Skill 晋级记录：PR #30 在精确提交 a7d9ac6 的四项检查通过后合入 dev 79a6a68。PR #32 的八项 push／PR 检查全部通过并合入 beta 93bd211bed9fd01598a8140bc95a784f5c1d0bd9，package.json 为 0.3.0-beta.30；Beta 合并提交验证与同名签名发行仍在执行。此前 Windows a7d9ac6 首次启动页面五秒断言失败；同一源码的定向重跑通过，保留失败证据，未提高超时或声称已确定系统原因。master 保持不晋级。

外发 beta.32 本机验收：普通测试 1,528 通过、44 跳过；TypeScript、lint、构建、许可 215 包／7 类、文档、开源和安全检查通过。真实 SQLite／Coordinator 网关覆盖有效审批正向回执、固定草稿、已确认／未知结果经过新工具调用查询而不再次审批／派发、六成员全部先启动、单成员停止、同步校验失败清理与移出再加入的不可恢复正文边界。迁移 39 以真实旧库验证历史各表、待处理审批／工具、环境／进程／日志／端口、外键、索引和触发器保留。

隐藏源码外发五项与 typed API 一项共 6／6 通过；最终未签名 macOS beta.32 包为连接 2、外发 5 共 7／7 通过，typed API 1 项更正为独立源码 fixture 证据，实查 isPackaged、版本和随包指南。实际本机 HTTP／IPC／SQLite 的 Notion 503 已提交提示保存 unknown，重启后仅 GET 核验确认且 POST 总数为 1；审批前编辑／撤权禁用允许按钮且零外发，六群成员停止一个后另外五个完成，已经打开群聊时新宿主任务仍能精确停止。接管用户应用未参与这些测试，所有 Electron 窗口隐藏。

首次外发隐藏场景复现严格 Scope 额外参数拒绝，修正为仅会话／执行者后暴露隐藏聊天和应用页的重复审批 portal；修复实际显示归属后重跑通过，没有改用第 n 个匹配或强制点击。外发仍只验证受控服务，真实第三方账号、真实 Windows Docker、签名包另行验收；示范、可写 MCP／Apps 和阶段 5–6 尚未完成。

原生 beta.31 跨平台 fixture 收尾：新增应用设置入口后的六项导航假设修正为实际七项并保留键盘焦点断言；后一轮 Windows 两个场景在末尾诊断截图等待 30 秒失败，业务回调断言已到末尾，后续隐藏窗口断言尚未执行。仅对 Windows 不采集两张装饰性诊断截图，业务／错误／隐藏窗口断言全保留，修正 ed8675f 后仍需跨平台 CI 全通过。不能将原失败或未取得的 Windows 像素记为验收成功。


## 阶段 4 Notion 页面更新单元：beta.35 开发候选

由 dev 基线创建 `codex/notion-page-updates`，接入已实现的 beta.32 固定草稿外发基础。新增 `notion-page-title` 和 `notion-page-append`，分别对应仅更新标题和末尾追加段落的精确页面写授权；不做覆盖正文或多步删除。普通／data-source 页面准备时读取真实 title 属性 ID、标题和编辑时间，存入原审批快照；保存后操作类型固定。派发前重新核对账号／写授权及标题目标观察，保持同一外发账本和一次派发规则，无新迁移。

Notion API `2026-03-11` 的标题 PATCH 仅包含已观察的属性 ID。追加单次 PATCH，省略 position 表示末尾，最多 100 个 2,000 字符段落。成功返回或 503 committed_child_ids 均精确 GET 子块并验证父页面与文本摘要；缺失、重复、错父级或不可读取不确认且不重发。标题未知结果只读匹配时明确展示“已核对目标当前状态”，不证明原请求造成变化。依据 [更新页面](https://developers.notion.com/reference/patch-page)、[追加区块](https://developers.notion.com/reference/patch-block-children)、[503 提交提示](https://developers.notion.com/reference/request-limits#retry-a-write-that-returns-503)。

初步针对性验收为主进程 100 项通过、Renderer 18 项及状态文案回归 7 项通过；Node／Web TypeScript、相关 ESLint 通过。随后新增成功回执后精确块 GET 断线保留提示用例继续验证。隐藏 Electron、安装包、跨平台 CI 和签名发行均另行记录；真实账号凭据和写目标未提供，受控 HTTP 不代表实际第三方验收。

Final Notion beta.35 source acceptance: one complete build passed all four TypeScript projects and main/preload/renderer/Worker bundles. Hidden Electron acceptance passed 10/10 in 23.2 seconds: two Notion updates, five existing outbound cases, two native-read cases and one typed-API case. Actual IPC/SQLite and controlled Notion HTTP exercised title-property-ID PATCH, disabled approval after a draft edit with zero writes, and append 503 unknown recovery after restart with exact child GET verification and a total of one PATCH. Existing six-member parallelism, single-member stop and group approval ownership assertions also passed. All windows stayed hidden. These are source checks, not installer or live-account verification.

Frozen SHA-256: main `51d6738f71a2d1f164dd7b7ab46d16da6e5f9ca83a3d98055422406b54be32cf`, preload `bb83458a39161e01f8f16983d811513c1ca1cc2a0b6b4ff9b0e27c433737a6ab`, renderer `f9d7ac861455cf013e2214dd0ff5a72c363a06b2b863655d7839d63799a1838d`. The final focused Notion/SQLite/evidence-label suite passed 21 tests; documentation link checking passed for 32 files. No third-party credentials were available.


### 阶段 4：示范录制与待审阅 Skill 草稿（独立开发单元）

`codex/skill-demonstrations` 从已验证 dev 的 Script30 基线创建。Browser Worker 1.1.0 在真实接受的 WebSocket→VNC 输入转发之后解析有界分片 RFB，仅保存按钮/滚动坐标及白名单导航键；文字、Unicode 按键、修饰键和剪贴板以脱敏占位符替代，页面内容、截图和网址不进入录制。断线、epoch 变化、引擎停止、重启和 500 步上限会封存中断录制，不自动归还 AI。

宿主迁移 40 保存独立会话/执行者草稿；停止不会创建、启用、绑定或执行资料库 Skill。用户审阅固定版本与摘要后才能发布，发布结果初始停用，无脚本授权。AI 开始/停止/丢弃录制仅返回 waiting_user；草稿读写共用宿主处理器，发布采用保存的全文审批快照并在提交前重新核验版本、摘要和 Scope。完整使用与边界见[示范 Skill](SKILL_DEMONSTRATIONS.md)。

本机专项包含 13 项分片 RFB、真实鉴权 WebSocket→TCP 转发、Worker SQLite、宿主 SQLite 与请求关闭验收；合并脚本审批回归的 10 个核心文件 67 项通过，普通测试（排除等待真实 38/39 的旧连续迁移诊断命令）1,432 项通过、44 项跳过。隐藏 Electron 示范编辑／冲突／确认发布与完整 Typed API 共 2 项通过（5.4 秒），最终四配置类型检查、lint、build、文档链接、许可与安全审计通过。此开发工作树保留迁移 38/39 给原生连接与外发单元；独立完整单测中旧诊断命令要求连续迁移号，合入真实 38/39 后再验证。当前 Docker daemon 不可用，不将控制 RFB fixture 声称为 Docker/noVNC、Windows 或第三方网站实测。

示范 beta.33 集成原生连接及外发基础后，真实迁移 38、39 先于示范迁移 40 执行，连续迁移诊断三项通过；脚本、外发和示范三类固定审批保留各自严格判别分支。专项 68 项与外发／脚本回归 49 项通过，四配置 TypeScript、lint、build、文档、215 包／7 类许可、开源和安全 32 项检查通过。隐藏源码界面 17／17 通过（示范 1、资料库 8、原生连接 2、外发 5、typed API 1）。普通完整检查遇到原有计时断言超时，保留原结果后对未改变的用例复核；不能据此宣布完整门禁已经通过。

审查发现已发布示范的缓存回执可能在资料解绑／删除后仍带旧正文；修复为复核原资源、原版本及当前 Scope，拒绝已解绑／删除资源，原发布 Skill 不重复创建或自动启用。产品网关 37 项通过，含后续修改资料后仍返回原版本、解绑／删除后拒绝两项回归。修复源码重新通过四配置 TypeScript 与构建并冻结未签名 macOS beta.33 包；该包原生连接 2、外发 5 通过，typed API 1 项更正为源码 fixture 证据；示范 1 在纠正测试读取随包指南的方式后通过，实查 isPackaged、版本与指南正文。最初指南测试在 Electron evaluate 内动态 import 不被支持，改为查询实际 Resources 路径后读取；应用和包均未为此重建或修改。



最终完整普通测试记录为 1,540 通过、45 跳过、6 失败：五项原有 5 秒超时（CDP 1 MiB、群聊 20 轮、FIFO 20 轮、工具混合指令循环、诊断参数循环），一项 lead-room 在轮询期限内仍为 running。对应未修改的六个文件单 Worker 复核 128／128 通过，未提高超时或减少断言；保留完整失败证据，远端完整 CI 仍须独立通过，不能把分次复核改记为一次完整全绿。

真实 Linux Docker 集成测试已加入现有浏览器套件，走实际 x11vnc 的 RFB 握手、页面点击、文字／剪贴板脱敏、断线封存、容器重启、旧 epoch 拒绝和归还后重新观察。该测试将在 Linux CI 的真实容器门禁执行；本机 Docker daemon 未启动，本机结果为跳过，不算真实 Docker 已验收。示范单元不代表阶段 4 全部完成，可写 MCP／交互 Apps 以及阶段 5–6 仍待交付。

## 阶段 4 MCP／Apps：v0.3.0-beta.34 候选

迁移 41 接在真实 38／39／40 后，按 Scope 保存工具授权、固定参数／目标审批及持久调用账本。配置、凭据与格式变化使授权失效；移出再加入不能恢复旧参数。host-mcp Runtime 支持六成员先启动，单成员停止／撤权不影响兄弟任务；HTTP 写调用不自动重授权重放，已结束意图只查询回执。

隔离 App 使用独立 loopback 外层及 opaque 内层。App-only 工具不进入模型和旧只读路径；协议 _meta 仅在宿主及已授权 App 之间传递，公共回执、模型和日志剥离顶层 _meta，保留同名嵌套用户数据。模型打开操作返回 waiting_user，不暴露视图 URL。一个活跃 Scope 的原生／MCP 审批由同一组件持有。支持范围见[MCP 工具与 Apps](MCP_APPS.md)。

初次隐藏验收复现 Renderer CSP 阻止 loopback iframe，修正窄 frame-src 后 MCP 3 与 typed API 1 共 4 项通过，原生外发回归 5 项通过；含真实隔离 frame、父级／Preload 拒绝、实际 App 调用审批、撤权关闭、未知取消及原生→MCP 审批交接。后续私有 metadata／app-only 回归与能力检查 19 项、Node 类型及针对性 lint 通过。上述早期源码回执为 Source33；Source34 最终构建、完整普通测试及安装包验收单列，尚未完成。

脚本 beta.30 的合并提交 93bd211 已全部验收并建立不可变标签。签名工作流 38591554270 在 Mac 普通文件系统测试发生只读目录 rename EACCES，未创建公开 Release。修复 39e12da 保持 staging0700 到 rename 后再固定0550；原代码确定性回归失败、修正后10项通过，不放宽最终只读权限。修复进入后续 Beta，旧标签不移动。

MCP beta.34 最终源码包含 metadata 私有投影、App-only 路由、统一 Apps 审批持有者及快照发布修复。完整普通测试单 Worker 1,565 通过、45 跳过；四配置 TypeScript、lint、build、文档、215 包／7 类许可、开源及安全审计通过。隐藏源码 MCP3／示范1／typed1／外发5／读取2 的不同场景均通过；读取回归最初因新增 MCP 范围说明与原生说明文字重复而严格匹配失败，收窄到真实“聊天应用”区域后两项通过，未使用第 n 个元素或减少业务断言。最终安装包仍在验收。

Combined Stage 4 beta.35 source acceptance after merging MCP beta.34 foundation `4c0834fa`: all four TypeScript projects, full ESLint, one full build and the ordinary single-worker suite passed (1,586 passed, 45 skipped; 130 passed and 8 skipped test files). The combined hidden Electron suite passed 14/14 in 46.7 seconds: demonstrations 1, MCP Apps 3, native reads 2, native outbound including Notion updates 7, typed API 1. The unified parent-owned Apps approval host remained intact; no child native approval portal was restored. Actual migrations 38/39/40/41, private MCP metadata, App-only visibility, demonstration privacy/replay protection and the Worker private staging rename fix were preserved. No new migration or dependency was introduced.

Combined frozen SHA-256: main `b69062c51e85525ae838aaf8659119891d4c7af44bdd4351becb2b51536ab436`, preload `04360d5de6b69c317a2a4f4cbcc56a0a4a92d26e4ef6f1bd00716108cc49d05d`, renderer `a1e3f97f27cc288fe38cb5c3c70f3316696eb9778aea2ea56400cf804a16c301`. Documentation links passed for 34 files; license checks passed for 215 packages / 7 groups, open-source readiness and dependency/security audits passed with the verified existing backport. Package beta.35 and cross-platform CI are separate pending gates; real third-party credentials were unavailable. The earlier isolated Notion source receipts remain historical and are not substituted for this combined build.

## Earlier beta.35 package snapshot and evidence correction

The final MCP setup-failure cleanup `f85c8cc` was integrated as `c384380`. The controlled DNS/client-cleanup suite passed 6 tests with 1 skipped; the scoped-write foundation passed 13 tests, and Node TypeScript passed. The 1,586/45 ordinary and 14-source-case aggregates above belong to the pre-cleanup combined source; they were not relabeled as a fresh full run after this narrow fix.

The rebuilt unsigned macOS beta.35 package from `c384380` passed 21 actual packaged scenarios in 1.4 minutes: Library 8, demonstrations 1, MCP Apps 3, native reads 2 and native outbound including Notion updates 7. Each relevant fixture used the actual package executable and checked packaged metadata. That historical bundle SHA-256: main `02945cd6a5439fa5cb52be18366cc8a5fe28aea115045fe6d6642a0cb29309a5`, preload `04360d5de6b69c317a2a4f4cbcc56a0a4a92d26e4ef6f1bd00716108cc49d05d`, renderer `a1e3f97f27cc288fe38cb5c3c70f3316696eb9778aea2ea56400cf804a16c301`.

A final audit found that the old runtime typed-API fixture ignored `AEVOREN_PACKAGED_APP_PATH`; earlier typed-API checks counted in beta.31/beta.32/beta.33/beta.34 package summaries therefore establish source behavior only. Their separate Library/native/outbound/demonstration package receipts remain valid where those fixtures selected and verified the real package. The corrected fixture commit `37c762e` now honors the executable and asserts `isPackaged` and the exact version. Its initial real-package run exposed a source-only mock-keychain-flag assertion; the test now applies that assertion only to source runs. The actual packaged rerun passed 1/1, and the source rerun passed 1/1. At that historical candidate, package acceptance was 21 + 1 = 22 actual packaged checks, without retroactively upgrading old evidence. All windows stayed hidden.

Stage 4 has local implementation, source and unsigned macOS-package acceptance; cross-platform CI, actual Docker demonstration increments, Windows Docker and signed publication remain gates. Real user private credentials, Gmail/Drive/Notion account writes, cloud-model inference and audio service integration were not exercised. Phase 5 media/audio/voice and Phase 6 automation/search/thread/template/export extensions remain unimplemented. The complete six-phase scope and branch/release requirements above remain in force; master does not advance.

## Normal-close fix: current beta.35 candidate

The former test cleanup helper could terminate an application that had not exited normally. Earlier business assertions and genuine packaged metadata remain evidence for those behaviors, but do not establish a successful graceful shutdown. Subframe loading had cleared the main renderer's readiness, leaving a real close request waiting for an ACK that would never be resent.

The current source at `843d8d4` incorporates the complete readiness/close fix, strict normal-close cleanup, private owned-tree cleanup, transactional legacy database fixtures and event-driven project-tool waits. Readiness resets only on committed main navigation; iframe and in-page navigation preserve it. Main loading gates flush requests, and an existing pending-close request retries when loading stops. Cancelled main navigation retains the live renderer and its dirty-save handshake. No additional readiness IPC or replacement timeout was introduced.

The old main code fails the real `srcdoc` regression. Fixed beta.35 source passed eight close scenarios plus three MCP scenarios (11 total); an actual MCP application exited normally with code 0 in 275 ms without forced termination. The first beta.31 package close selection passed 17/18: its HTTP iframe fixture was blocked by beta.31's intended CSP, so the fixture was corrected to a real `srcdoc` frame without loosening CSP. The corrected frozen beta.31 package then passed 19 actual packaged checks (Library 8, native connections 2, close 8, typed API 1). Beta.31 backport validation also passed 1,488 ordinary tests with 44 skipped, all four TypeScript projects, lint, build, license checks for 215 packages / 7 groups, documentation checks for 31 files and four focused Node fixture tests. These are beta.31 receipts, not final beta.35 package results.

Windows checks for PR #37/#38 reached their source business assertions, but the test worker failed during exit; no installation-package gate ran in those jobs. They are not successful Windows or package acceptance. A pre-close-fix beta.35 source run passed 1,587 ordinary tests with 45 skipped, and 41 Linux Docker checks passed; those and the earlier package aggregate remain historical. The current results follow below. Phase 5/6 remain unimplemented, and real account/private-credential, microphone, audio/cloud inference and Windows Docker checks remain unverified.

## Final beta.35 local acceptance after normal-close fixes

The clean tested source is `93e5e17b18c400d75dafe6873d80454853dc2614`. A single full run with one worker passed **1,587 tests, 45 skipped**, across 130 passing files; no rerun or timeout change. Lint, all four TypeScript projects, the complete build and both Worker bundles, license checks (215 packages / 7 groups), 34 documentation files and open-source readiness passed.

Hidden source acceptance passed **22/22**. The rebuilt actual unsigned macOS arm64 beta.35 application passed **30 unique scenarios**: Library 8, native reads 2, outbound 7 (including both Notion updates), demonstration 1, MCP Apps 3, normal close 8 and actual packaged typed API 1. Source and package UI logs contain **zero forced-cleanup warnings**. Genuine `isPackaged`, version, seven guides and Execution Worker 1.2.0 / Browser Worker 1.1.0 were checked; packaged Worker bytes match the build output.

ASAR SHA-256 is `74f70835a892b86d227bd0a6dbcdca1c1491ebdf0434c133aa0bb552e51a1cf3`. Compiled Main and package-extracted Main both hash to `627d2e5c89eccd164d5e60240bb41d70ea42894146be9c59852c467a772ca78b`. Subsequent documentation-only commits do not change these application bytes. Cross-platform CI, validated Beta promotion and signed publication remain pending; these local results do not establish real external-account or Windows Docker behavior.

## Linux 六环境截图诊断（历史快照）

另有 Linux run 38677885045：普通测试 1,587／45 跳过通过，真实 Docker 40／41；六独立 Scope 的截图返回 `409 BROWSER_OBSERVATION_STALE`。容器仍运行，约 427.5／768 MiB，OOM 计数为零；未据此认定内存问题。代码没有观察 TTL，截图内部聚焦并重新观察，不能靠增加夹具观察或放宽新鲜度解决。

`65437c8` 仅在显式开启时写入固定诊断文件，记录焦点／文档版本前后、epoch、布尔状态和有界耗时，不记录 DOM、URL、图片、Cookie、路径或能力令牌。所有 409 校验和捕获顺序保持不变。六个负向用例及相关 26 项、Node／浏览器 Worker 类型、lint、Worker 构建通过。Worker 字节／镜像 context 摘要会变化；前述包 30 项先于此补丁，补丁后的真实 Docker／安装包仍待验证。下一轮真实 Linux CI 用于确定拒绝阶段。

历史冻结 beta.34 验收曾统计 20 项；复核确认当时 typed API fixture 忽略安装包路径，实际为包内 19 项与源码 typed API 1 项。MCP 包测试实查 isPackaged、精确版本以及 Resources 中的 MCP 指南；验证真实 opaque iframe、父级／Preload 隔离、工具输入／结果、真实 UI 调用审批、撤权、未知结果与延迟原生→MCP 模态交接。全部使用临时数据库、真实 IPC 与受控 HTTP，未触及真实外部账号；此处保留历史并纠正证据类别，最新包结果单列于下。

示范基础的真实 Linux [CI 38666108922](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38666108922/job/116198324472) 在 12288fd 完整通过：普通 1,547／45 跳过，实际 Docker／Host 41／41；新增真实 RFB 示范用例 3.239 秒通过。此证据属于 Demo33 基础提交，MCP34 自身跨平台完整 CI 与签名发行仍须通过，真实 Windows Docker 仍未验证。

最终只读复核发现离线 DNS／传输准备失败时 Client 已登记、但尚未进入清理 try，反复刷新目录会累积引用。f85c8cc 将准备过程纳入清理并在分配 HTTP Agent 前验证 Header；原代码重复失败回归复现引用保留，修正后通过。此后四配置重新构建、MCP／旧连接／能力专项 25 通过、1 跳过及针对性 lint 通过；修正后包 MCP3 与源码 typed1 分别通过。此前完整 1,565 与实际包 19 项是清理补丁前的回执，未混称为补丁后全量结果。

## MCP beta.34 关闭修复后的本机验收

主 Renderer 的 ready 状态现仅在主文档提交后清除；子框架、Hash、被阻止的导航和真实重载均有关闭／保存回归。真实 App 的关闭停滞在旧代码复现，修正后正常退出；未增加生产强制退出或绕过草稿确认。测试只清理确定归属的 PID 树／进程组，并支持已关闭 Playwright 通道的幂等清理。

- 构建源 `ee0cbe2`、测试收尾 `40c29d3`：四套 TypeScript、lint、build、215 包／7 类许可与 34 份文档检查通过。
- 完整本机普通测试为 1,560 通过、45 跳过、6 失败；五项达到原 5 秒测试上限，一项未在 60ms 协调截止前进入预期阶段。原文件无相关变更，106 项隔离串行检查全部通过，未提高超时或删减断言。全量成功仍待 CI 补齐。
- 隐藏源码 12／12；同一真实未签名 macOS beta.34 包最终 28 个不同场景通过：资料库 8、原生读取 2、外发 5、示范 1、MCP 3、关闭 8、真实包 typed API 1。实查版本、isPackaged、指南和两套 Worker 资源；源码及包界面验收无强制关闭警告。
- 首轮包 18 通过、示范收尾 1 失败：应用已正常关闭后，测试清理错误访问已销毁进程通道。幂等修正前负向回归失败、修正后五项进程检查通过；相同包的示范复验与后续关闭／typed API 均通过，应用包未重建。保留初次失败，不把收尾错误算作业务失败或抹去记录。

跨平台检查、Beta 晋级与签名发行仍为门禁，master 不晋级；真实第三方账号与 Windows Linux Docker 未验证。阶段 5–6 未实施。


## Windows TCP 录制夹具验收更正

最新 TCP 录制夹具更正：MCP34 Windows 运行 38675963129 的五项进程清理通过，但普通测试 1,550 通过／60 跳过／1 失败；录制事件数先更新，接收端 TCP data 回调尚未交付 28 字节，后续构建／包验收未运行。真实 socket 暂停确定性复现旧断言失败；现先登记接收等待，再恢复并等待完整字节，保留原录制／控制和精确字节断言。相关 9 项、Node／浏览器 Worker 类型和 lint 通过。仅测试改变，安装包业务代码和既有本机回执不变；修正后的跨平台 CI 待验证。

## Beta.31 晋级收尾：主页面关闭与测试进程生命周期

[PR #33](https://github.com/CMSKL/Aevoren-Bot/pull/33) 在 `51196b5` 四项 CI 全通过后合入 dev `80586fd`。[Beta PR #39](https://github.com/CMSKL/Aevoren-Bot/pull/39) 暂不合并：其中一项 Windows 旧库备份测试达到 60 秒上限。随后 [PR #40](https://github.com/CMSKL/Aevoren-Bot/pull/40) 的首轮出现另一项审批测试的一秒轮询超时；失败记录保留，未提高测试超时或放宽审批断言。

- 实际 iframe 复现了产品关闭停滞：子页面加载错误清空主 Renderer 的 ready 状态，关闭无法发出保存请求。最终仅在主文档提交时清除 ready，加载期间延后请求，并由真实 ready 与停止加载恢复；保留取消导航、Hash 和重载边界。未绕过保存确认或增加生产强制退出。
- Windows 的另一处测试进程退出问题由 Playwright 的 shell 包装和父进程单独强杀造成。现仅清理确定归属的 PID 树／已核验的 POSIX 进程组，等待退出和管道关闭；真实父子进程负向用例修复前失败、修复后通过，兄弟进程始终存活。
- 旧库测试夹具按生产方式逐迁移事务建库，保留外键、版本、回滚和失败关闭；生产迁移不变。审批测试改为等待真实 Runtime／审批事件，并在关闭数据库前排空 Worker，保留实际状态与资源数量断言。
- 当前普通测试 1,488 通过、44 跳过；四套 TypeScript、完整 lint、构建、文档和许可检查通过（215 包／7 类）。进程清理五项无跳过通过，包含已关闭通道的幂等回归。同一冻结未签名 macOS beta.31 包完成 19 项真实检查：资料库 8、原生读取 2、关闭 8、typed API 1，均核验实际包与版本。首次 17／18 的失败由测试 loopback iframe 被该版本现有 CSP 阻止造成；保留失败，改用真实 sandboxed srcdoc 并验证子页面 DOM／Preload 后，八项关闭重跑通过，未扩展 CSP。旧 Main 的同一 srcdoc 负向用例明确关闭失败。此后仅补充测试清理幂等修复，应用安装包未改变。

现仍是开发候选，跨平台修复检查、Beta 晋级及签名发行未完成；master 不晋级。真实第三方账号和 Windows Linux Docker 继续标为未验证。后续阶段 5–6 尚未实现。

## Diagnostic beta.35 rebuild and fresh Linux acceptance

Source `b81174717ae16afdaf543d8cc2eed2d21f72c95c`, containing the opt-in sanitized frame diagnostics, was rebuilt and packaged locally with reduced process priority. The actual unsigned macOS arm64 application passed **30/30** distinct checks in **1.8 minutes**: close 8 (including ten immediate startup close attempts), Library 8, native reads 2, outbound 7, demonstrations 1, MCP Apps 3 and actual packaged typed API 1. No forced-cleanup warning occurred. Fixtures checked genuine packaged metadata and beta.35; no installed user application, personal profile, microphone, real credentials or local Docker was used.

Archive metadata, compiled/package-extracted Main, both complete Worker resource directories and all seven bundled guides matched at build time. ASAR SHA-256 remains `74f70835a892b86d227bd0a6dbcdca1c1491ebdf0434c133aa0bb552e51a1cf3`; Main remains `627d2e5c89eccd164d5e60240bb41d70ea42894146be9c59852c467a772ca78b`. The ASAR excludes the separately bundled Workers: the diagnostic Browser Worker 1.1.0 index now hashes to `41e2318a05a29e20c1b0777f2d28d2871ecad5505b553ff9d2970d7b55898a73`, its engine to `9788e576cc351bcfea9e380484b33df8456582b143d0c7fac271662e1ded6e7d`; Execution Worker 1.2.0 index hashes to `3ec6b2072432c77b904b363b2afad4929e6568115e513ff08304f4dd1055570e`. Worker bytes exactly matched this build output. Subsequent documentation edits do not change those tested application bytes.

Fresh [Linux run 38680254801 / job 116243117780](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38680254801/job/116243117780) checked PR merge `ef1beefb0320145713c60cd6f4e495fdc28bc8f2` (b811747 into dev 4f24f153). One ordinary run passed **1,593 tests, 45 skipped**, across 131 passing and 8 skipped files in 77.29 seconds. The six frame-diagnostic unit tests are already included in that total. TypeScript, lint, build, 215-package / 7-group license checks, 34-document checks and security/backport checks passed.

The opt-in real Linux Docker gate separately passed **41/41**, seven files, in 125.27 seconds: Chromium/desktop 10, host browser 4, environment gateway 4, host environment 5, host Skill execution 4, Worker execution 12 and registered preview 2. Six isolated scopes with private cookies/profiles and real frames passed in 7.999 seconds; sanitized human RFB recording with disconnect/restart passed in 4.153 seconds; six approved Room scripts passed in 5.439 seconds. Both diagnostic flags were enabled. This successful run emitted no failed capture-phase record; it does not identify the cause of the prior `BROWSER_OBSERVATION_STALE` rejection, relax provenance/freshness checks or erase another run's failure.

The earlier pre-diagnostic 30-case package/source receipts and negative runs remain historical. This is fresh diagnostic-code Linux and unsigned macOS-package evidence, not complete cross-platform acceptance or signed publication. Windows Linux Docker, real third-party account actions and cloud inference remain unverified; phase 5/6 are not implemented and master does not advance.

## Windows compound navigation-test budget correction

Notion beta.35 Windows job [116243117566](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38680254801/job/116243117566) passed all 40 source-interface cases in 17.8 minutes. The separate close suite passed seven cases, including all ten immediate startup closes, but the main-document navigation case reached its overall 30-second test deadline; package gates did not execute.

The retained trace proves reload succeeded, the dirty description was filled and the first normal-close assertion passed at 22.58 seconds. The second application launch also completed. Reopening its contact profile consumed the remaining budget through several Windows navigation clicks of about two seconds each; only approximately 173ms remained when it reached the Edit Profile button. Timeout occurred there, before the persisted-description assertion or second close request. This is evidence of the compound test exhausting its total budget, not a failed close handshake.

Only that main-document case on Windows now uses a 60-second total test budget. Other platforms and the same-document case retain 30 seconds; per-request close limits remain 3 seconds, and the separate immediate-startup close limit remains 1.5 seconds. All UI, persistence, normal-exit and failure assertions remain intact. No product handler, readiness flag, IPC, guard or application byte changed. The new Windows branch requires CI validation; the change was checked with targeted lint, documentation links and diff checks rather than relabeling a local macOS run as Windows evidence. Earlier failures and traces remain retained, and stages 5/6 remain unimplemented.

## Installed Windows MCP unsupported-RPC evidence and fixture diagnostics

At source `9b238fd946e93f44bfa14ca6c304122508842ad0`, [Windows job 116251033557](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38682850255/job/116251033557) passed 1,578 ordinary tests with 60 skipped, all 40 source-interface cases, all eight source close cases, packaging checks and isolated installer launch. Installed feature acceptance passed 37/38: the first MCP App case did not receive its expected `data-unknown` attribute within five seconds after clicking the unsupported-capability button. Both other MCP cases, both Notion update cases and all remaining installed feature cases passed. The separate installed close suite was skipped after this failure; the overall Windows gate did not pass.

The retained trace shows the nested-frame click returned, the initialized inner App remained live and normal application close completed in 228 ms. It contains no browser input/network events, so it cannot establish whether the original click, message forwarding or response delivery caused the missing attribute. No production protocol defect or original cause is claimed.

The test now registers a real page response waiter before the same UI click, matching only POST to that controlled view's exact RPC endpoint with the unsupported method. It verifies HTTP 200, the matching numeric JSON-RPC ID and error -32601 before retaining the original five-second DOM assertion. The 90-second case limit and existing Playwright deadlines are unchanged; no direct/fake RPC, forced click, retry or application change was added. A bounded attachment records only handler entry, trusted-input status, request posting, response receipt, HTTP status, ID-match boolean and numeric error code; URLs, capability tokens, request/response contents and credentials are excluded.

The updated fixture passed all three source MCP cases in 10.63 seconds and all three cases against the existing actual unsigned macOS arm64 beta.35 package in 10.07 seconds, with no skips, flaky results or forced-cleanup warnings. Both receipts show a trusted click, posted request, real HTTP 200, matching ID, -32601 and inner response receipt. The packaged fixture checked genuine `isPackaged`, version `0.3.0-beta.35` and its bundled MCP guide. No rebuild was needed: ASAR remains `74f70835a892b86d227bd0a6dbcdca1c1491ebdf0434c133aa0bb552e51a1cf3`, and compiled Main remains `627d2e5c89eccd164d5e60240bb41d70ea42894146be9c59852c467a772ca78b`. Node TypeScript, targeted lint, documentation links and diff checks passed. These local macOS checks do not replace the retained Windows failure or establish a new complete cross-platform gate; stages 5/6 remain unimplemented.



示范 beta.33 基线合并准备：本分支纳入已通过四项 CI 的 dev `4f24f15`（PR #40），保留原生连接 38、外发 39、示范 40 的实际迁移顺序与 Browser Worker 1.1.0。上述计数保留为各次验收记录，不代表本次合并后的源码／安装包已经重新验证；当前仅完成合并准备，尚未推送或构建，可写 MCP／交互 Apps、Notion 页面更新／追加和阶段 5 功能不进入本单元。

### 示范 beta.33 合并后本机复验（2026-10-15 UTC）

冻结源码 `14046f04aec88ae7096f1aa1b0fffa32fa1269d2` 完成本次验证，应用版本保持 `0.3.0-beta.33`。验证前后工作树干净，所有重任务以 `nice -n 10` 串行执行，未启动本机 Docker、麦克风或真实第三方账号，也未操作用户已安装应用。

| 本次检查 | 实际结果 |
| --- | --- |
| 定向业务单测 | 8 文件／110 项通过：Skill 包 10、数据库 25、项目工具 25、示范宿主 4、示范桥 2、Browser Worker 示范 3、RFB 解析 4、共享产品网关 37；包含真实暂停 TCP 接收再等待完整转发字节的回归。未重跑完整普通套件 |
| 静态与构建 | 四套 TypeScript、lint、build、215 包／7 类许可、33 份文档链接和开源检查通过 |
| 隐藏源码验收 | 示范 1、原生读取 2、外发 5、关闭握手 8、typed API 1，共 17 项通过 |
| 新构建实际 macOS arm64 包 | 直接使用本次 out 构建未签名目录包；上述 17 项加资料库 8，共 25 项通过，0 项跳过、0 次强制夹具清理，无遗留本次 Electron 进程 |
| 随包内容与身份 | 34 份实际运行记录确认 `isPackaged=true`／`0.3.0-beta.33`；6 份功能指南、Execution Worker 1.2.0 与 Browser Worker 1.1.0 全部逐字节匹配源码构建产物；未签名包不包含更新源 |

本次 Main SHA-256 为 `f4041c76e81762ee105d66244188627c436f3f1364620982ff9cffb847cfc80a`，源 out 与包内 Main 一致；app.asar SHA-256 为 `9796aa2438ccc19613f437f6ae815d0e7adf950f0c3d68d6f032fa1a6aa7384c`。本机临时证据为 `/tmp/aevoren-demo33-final-evidence.json`；单测／构建日志为 `/tmp/aevoren-demo33-final-units.log`、`/tmp/aevoren-demo33-final-build.log`，源码验收为 `/tmp/aevoren-demo33-final-source-smoke.log` 与 `/tmp/aevoren-demo33-final-source-typed.log`，包验收为 `/tmp/aevoren-demo33-final-package-smoke.log` 与 `/tmp/aevoren-demo33-final-package-typed.log`，四份对应 Playwright JSON 保存在同名前缀的 `.json` 文件。临时路径不是仓库内可下载附件。

历史完整套件失败、旧 Windows TCP 竞态和旧包 CSP 阻止 iframe 的记录继续保留；本次定向复验不将它们改记为完整 CI 全绿。合并后提交仍须通过当前跨平台 CI，未签名 macOS 本机包不代替签名发行、Windows 安装包或真实 Windows Docker 验收。可写 MCP／交互 Apps、Notion 页面更新／追加未进入此单元，阶段 5–6 仍未实现。


## Beta.32 同步 dev 后的验收

`e83e91dd67ca665f2045fc378a3989605d87bb97` 合入已验证 dev `4f24f15`，保留版本 beta.32。相较原 `b922ca8`，生产代码仅增加主文档关闭修复与 Skill 私有 staging 发布修复，原生外发业务及 API 未改，也未引入示范或 MCP Apps。

专项 96／96（快照 10、数据库 25、项目审批 25、外发 36），四套 TypeScript、目标 lint 和完整构建通过。隐藏源码 16／16；实际未签名 macOS arm64 包 24／24：资料库 8、原生读取 2、外发 5、关闭 8、真实包 typed API 1。源码／包界面日志均无强制清理或关闭超时警告，实查版本、isPackaged 和 Resources。

随包 Execution Worker 1.2.0 含私有发布修复，与构建输出字节相同，SHA-256 为 `572b1b355fa653ff37957750aeab7c4aa8af6c1aa77d40fd0b6d05b13056321b`；脚本指南字节一致。未重复整套普通测试，新的跨平台 CI 与签名发行仍待完成；未将此记录称为真实账号或 Windows Docker 验收。

### Beta.32 截图诊断历史补充

> beta.32 当前补充：CI `38680943010` 的 Linux 普通检查通过，真实 Docker 为 39／40；六 Scope 电脑截图被原有 `BROWSER_OBSERVATION_STALE` 规则拒绝。本轮未取得成功画面，不能记为完整 Linux 门禁通过。当前补入同仓 beta.35 已验证的脱敏截图阶段诊断，保持原有焦点、版本和接管检查及调用顺序；该补丁不表示已修复错误。此前本机安装包记录先于该 Worker 补丁，后续须分别核验。

诊断候选 `1ca624d` 的本机补充验收：截图诊断／控制专项 15 项、Browser Worker TypeScript 与定向 lint、Worker 构建通过。重新打包的真实未签名 macOS arm64 beta.32 完成 23 项场景（原生读取 2、外发 5、关闭 8、Runtime 8），包括 15 次重载恢复、失败后重试、SIGKILL 恢复、关闭阻塞提示及 typed API；全部通过。两套 Worker 共八个文件及五份指南与构建输出逐字节相同。ASAR SHA-256 为 `f095741de56104676e8854fcf9d2472a4887ed0164945bb850dbdd3d035cff0a`，Browser engine 为 `9788e576cc351bcfea9e380484b33df8456582b143d0c7fac271662e1ded6e7d`。新一轮跨平台／Docker 检查仍需完成；本机没有启动 Docker 或连接真实账号。

当前 beta.35 合入已验证 dev `36a48730002a5a8bd7115891a99a18a7cffa792c`，保留上述两版独立验收记录。相较合并前 `15ac2b8`，源码、测试、工作流、构建配置、package 和锁文件字节均未改变；只合并实施历史，不重记既有失败为成功。版本仍为 beta.35，新的合并提交仍须完成正常跨平台 CI。


## 阶段 5.1：图片与文档引用（v0.3.0-beta.36，实施中）

- 新增 PNG/JPEG/PDF/DOCX 内容寻址存储、不可变解析版本、会话绑定及任务准入；发送／群路由摘要与 PromptManifest 固定引用。撤销、停用、删除及成员移除立即阻止后续读取，重绑不恢复旧任务授权。
- 解析器使用独立无 Node 的沙箱 Renderer／真实 PDF Worker、临时 session、精确资源清单与哈希；网络、宿主文件、权限、下载和导航均拒绝。PDF 提取和有界逐页预览、DOCX 严格 ZIP／XML 校验后的纯文本提取；扫描 PDF 无 OCR，DOCX 分节不代表物理页。
- 界面和 AI 共用十二项 `media.*` 业务动作。正文与实际像素仅以可撤销的瞬时宿主附件传输；工具数据库回执只保存元信息，三个来源的协议适配在后续轮次及缓存重放时重新检查权限。
- 独立解析资源、精确依赖许可、四个 OFL 字体和真实未签名 macOS 包已通过下述本地验收；当前候选的跨平台 CI、Windows 实包及签名发行仍待验证，不能据此宣称已发布。音视频、语音及阶段 6 不在本单元完成范围。

### 5.1 本地验收：冻结 beta.36 产物

冻结产品构建对应 `c2850bd4413f04fb37c5979501f4e2e105acfe0d`，实际包版本为 `0.3.0-beta.36`。后续校验器与 typed API fixture 修正不改变产品字节，未重新构建安装包。Node 24 目标工具链、pnpm 11.19 冻结依赖验证、完整类型与 lint 均已通过；普通单元测试为 1,627 通过、45 跳过。

| 验证范围 | 实际结果与边界 |
| --- | --- |
| 完整隐藏 Electron smoke | 首轮发现 182 项：149 通过、32 跳过、1 项旧 typed API 白名单失败；实际只新增预期的 `media` 分组。固定列出该分组及其 13 个 API、增加非法媒体 ID 断言后，源码定向 1/1 通过。保留首轮失败，不将它改写为单轮全绿；同一冻结产品下累计 150 个不同场景已验证 |
| 隔离解析器 | 上述完整运行中的六项全部通过：真实 PDF 全物理页与空页、OFL 字体深色像素、CMap 日文、CMYK／JPEG2000 红色像素、JPEG、DOCX store/Deflate/UTF-16、CRC/DTD/伪造内容类型/越界与预算拒绝、加密文件拒绝、六任务并行及单任务取消、私有资源／本地文件／网络／主 API 隔离、伪造摘要拒绝、实际 30 秒超时销毁 |
| 真实未签名 macOS arm64 包 | 共用包身份／版本断言的媒体 4、资料库 8、原生读取 2、原生外发 7、示范 1、MCP Apps 3、正常关闭 8，合计 33/33 通过（1.8 分钟）；随后修正后的 typed API 实包定向 1/1 通过。正常退出是门禁，未出现强制清理警告 |
| 完整资源与 ASAR | 207 个解析器清单资产逐字节一致，扫描 228 个资源文件及 9,555 个 ASAR 条目；四个替换字体及许可摘要匹配，无原始 GPL 字体、QuickJS、原生 canvas 或重复原始解析包树。包内 Main 与冻结 source out 完全相同 |
| 校验器反例 | 独立复核发现 `.TTF` 大写扩展名会漏读已知旧字体字节；ASAR／extraResources 两个反例先复现失败，修正后校验器 7/7 通过，真实包再次通过扫描。未发现该禁止资产实际进入冻结包 |

冻结摘要：Main 为 `9eab40d3a8be0bbe52e47ae947ceeda8f34c0b9eaa1f313cff562514b721d88e`；ASAR 为 `8b7843c9b64921b9ef51ad67be9bab6029ad93ddb8425e1882a140315bca8bd1`；parser manifest 为 `07888e2755c41232ff400118ad5b0e910bcc150ee68920ad50f1251e2dd12e50`。安装包资源验证命令为 `node scripts/verify-media-parser-package.mjs <Mac.app 或 Windows resources>`。

本地日志与 JSON 分别保存于 `/tmp/aevoren-media36-actual-package33.log`、`/tmp/aevoren-media36-full-source-hidden.log`、`/tmp/aevoren-media36-typed-source-final.log`、`/tmp/aevoren-media36-typed-package-final.log`、`/tmp/aevoren-media36-actual-package-assets.json` 和 `/tmp/aevoren-media36-frozen-package-hashes.json`；首轮 typed fixture trace 保留于 `/tmp/aevoren-media36-initial-typed-surface-failure`。这些是临时本机证据，不是仓库附件。JBIG2 解码样本、Windows beta.36 实际运行、签名包与真实外部账号／硬件未在本轮验证；扫描件无 OCR，DOCX 不承诺物理分页，尚未交付阶段 5.2–5.3 或阶段 6。


## 已公开发行：v0.3.0-beta.31

[Beta PR #39](https://github.com/CMSKL/Aevoren-Bot/pull/39) 的八项检查在 dev `4f24f153` 全部通过后，正常合入 beta `7989bf6d2bd42efa0525dee84377bbcf3b1ab860`。实际合并树 `80479d1062a51b3f63ad85ebdff73b6c40d024a5` 与已测试 PR 合并树逐字节相同；同名不可变标签指向该 beta 提交。[macOS 签名工作流 38684641775](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38684641775) 成功并公开 [v0.3.0-beta.31](https://github.com/CMSKL/Aevoren-Bot/releases/tag/v0.3.0-beta.31)，标签／标题严格一致，包含签名、公证 DMG／ZIP、两个 blockmap、Beta 更新清单、SHA256 和 SBOM，共七项资产。小型清单下载及 GitHub 资产摘要复核通过；完整产物的下载校验由发行工作流完成。

该发行提供脚本 Skill、Gmail／Drive／Notion 原生读取及本地草稿，包含主页面正常关闭与脚本快照发布修复；不包括后续原生外发、示范录制、可写 MCP／Apps、Notion 页面更新或阶段 5–6。发行校验中普通测试 1,488 通过／44 跳过，源码界面 128 通过／33 跳过，真实签名包资料／原生读取 10 项及关闭 8 项全部通过。Windows 签名工作流因当前配置跳过，没有公开签名 Windows 包。master 未晋级。旧 PR #18（beta → master）自动触发的 Windows 源码检查出现 Skill 工具往返的五秒捕获等待失败；该轮不是 PR #39 或直接 beta 分支检查。保留失败及此前同树八项成功证据，PR #18 按用户要求暂不推进，旧标签和发行不移动。


## MCP beta.34 integration of verified Native32 baseline

Merged exact dev `36a48730002a5a8bd7115891a99a18a7cffa792c` into the MCP34 feature branch. That baseline contains verified Native32 PR #34 merge `a84e87f` and the published beta.31 README boundary; beta.34 remains the source version. Earlier `d016c974` had four successful CI checks, and its actual 28-case unsigned macOS package receipt remains historical. Those results were not relabeled as acceptance of this newly combined Worker.

The only production-code difference from d016c974 is the BrowserEngine's opt-in, bounded, sanitized stale-frame diagnostics from `65437c8`; existing capture order, provenance checks, 409 rejection and authority boundaries remain intact. Companion changes are the focused diagnostic tests and failure-only Docker diagnostic collection. MCP/native/demo production code, approvals, private metadata, App-only visibility, migrations and Main lifecycle are unchanged. All expanded native/outbound/demo/MCP workflow selections and the eight close scenarios remain selected. Notion title updates and appends from beta.35 were not imported.

Local focused acceptance passed **15/15** (frame diagnostics 6, browser lease boundary 5, Chrome pipe/HTTP/WebSocket boundary 4), plus Browser Worker TypeScript, targeted ESLint and the Browser Worker build. Three workflow YAML files parsed with the expanded feature and close gates retained; 34-document link and diff checks passed. No full unit suite, full application build, package rebuild, Docker or real-account test was repeated. This integration needs its own new CI gate, including actual Docker and platform/package checks; the earlier Main/package evidence remains distinct from the new Worker context. Published beta.31, frozen dev, beta and master were not changed. Phase 5/6 remain unimplemented.

The MCP34 feature subsequently integrated exact dev `a8469cbad078c7ace92c607ac227c3cd648e1f5a`, whose only change from 36a4873 is the two-line, evidence-based Windows main-document compound-test budget correction already described in the beta.35 record. It retains the 3-second per-close and 1.5-second immediate-startup limits and every UI/persistence assertion. Only the affected fixture's targeted lint and diff checks were repeated; application/Worker code and the earlier focused results were unchanged. The new feature head requires fresh CI rather than inheriting d016c974's successful checks.

## MCP34 Windows source fixture deadlines

At `a5d674999d215a837e29101434060b6eddb78c91`, [Windows CI 38689015680](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38689015680/job/116270524225) passed 36/38 source smoke cases, including all three MCP App cases. The demonstration case exhausted its 30-second total budget: setup used 9.005 seconds and the second saved-v2 draft click began at 28.254 seconds; publication and application close were not reached. The Library group case had already verified all six requests, routing and pinned original prompt content when its 5-second completion poll expired. Its first actual snapshot IPC took 5.599 seconds and eventually reported `running`; batch completion and the final reference-badge assertion were not verified. Source close handshakes, Windows packaging and installed checks were consequently not run. These failed results remain separate from earlier green runs.

The test-only correction gives the compound demonstration case a 60-second total budget on Windows, retaining 30 seconds on macOS. Only the observed Library completion poll is replaced: subscribe to the production RoomRuntime event before querying current state, match room/session/batch IDs, accept only `completed`, reject other terminal states and unsubscribe on settlement. Its existing 90-second whole-case budget and all business assertions remain unchanged; no sleep, retry or polling-timeout increase was added. Product code and the existing beta.34 package were not rebuilt or changed.

Limited local macOS validation passed both affected source cases (2/2, 10.3 seconds) and the same cases in the existing actual unsigned beta.34 package (2/2, 8.7 seconds). Packaged identity/version checks passed, and package Main matched source out (`c8cd5865fd452e50dcfc074c2269eebbb111d574aae64e892085e0474524f746`); the ASAR digest was unchanged before/after. Targeted ESLint, documentation links and diff checks passed. Evidence is stored locally at `/tmp/aevoren-mcp34-windows-fixtures-evidence.json`, with separate `source` and `package` logs/JSON under the same prefix. Original log/artifacts and trace timing are retained at `/tmp/aevoren-mcp34-a5d6749-windows-failure-summary.json`. These are temporary local files, not repository attachments. This limited macOS rerun does not establish Windows success, a full-suite pass or a signed release; fresh cross-platform CI remains required.

### 示范 beta.33 再次同步已验证 dev

示范提交 `b46a92143b647f355c4b771f84ed4b1bf2b63a17` 的[CI 38681547433](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38681547433) 四项全部通过：Windows 源码与 NSIS 安装后的功能、八项关闭握手均通过，未重复先前的初始化或复合关闭超时。随后合入固定 dev `36a48730002a5a8bd7115891a99a18a7cffa792c`，保留 beta.33、实际迁移 38→39→40、Browser Worker 1.1.0、示范扩展 CI 数组及原八项关闭夹具。公开安装包基线仍为 beta.31。

本次相较 `b46a921` 的生产差异仅为 Browser Engine 的显式启用、无敏感内容的旧画面诊断；Main、业务契约、版本和关闭夹具不变，未纳入 MCP34、Notion35 或阶段 5。定向 frame 诊断 6 项与 CDP 下载 10 项（含本机符号链接边界）全部通过，Browser Worker TypeScript、目标 lint、Worker 构建、文档链接、三份工作流 YAML 及 diff 检查通过；日志和源文件／Worker 摘要保存在本机临时 `/tmp/aevoren-demo33-dev36-merge-evidence.json`，YAML／生产差异核验为 `/tmp/aevoren-demo33-dev36-merge-yaml-diff.json`。没有重跑完整套件或重新打包，前述 25 项包验收仍对应原冻结构建；新 Worker 的跨平台结果须由本次合并提交的 CI 单独验证。



### beta.32 Windows 关闭阶段诊断（未发布）

PR #41 的一个完整跨平台检查已通过；另一个 Windows 检查的首次关闭及随后一次不改代码的重跑仍出现失败。重跑通过源代码业务场景后，在主文档重载后的关闭断言失败，重启持久化校验未到达。保留失败记录，不能用另一轮成功替代。

关闭 smoke 现在只在其自有进程内记录主文档加载、可信 Renderer-ready、flush 请求、可信确认、窗口关闭和进程退出阶段；失败时附上有界 JSON。记录不含 URL、页面内容、密钥或用户文件路径，不修改产品代码、关闭时限或启动参数。新增诊断的本机隐藏主文档重载／修改／关闭／重启用例已通过；下一次 Windows 检查用于定位停在哪个阶段，尚不能据此确认根因或发布。



### 媒体 CAS 并发回补（beta.36，重新验收中）

后续六成员朗读验收用受控边界稳定复现：一个读取者已打开同内容 CAS 文件时，写入者清理临时硬链接会改变 ctime，即使字节与 mtime 未变，也被原严格来源读取器拒绝。此前随机成功不作为修复证据。回补仅在读取前已知预期 SHA 的 CAS 路径允许这一元数据变化，并在读取器内验证完整真实字节摘要；用户选择／Workspace 来源继续严格比较 ctime、fd/path、模式、大小和 mtime。新增来源篡改与摘要不符负例、六个同摘要并发写入通过。当前候选正在重新执行完整普通测试、源码和实际安装包门禁；上方冻结包的成功是回补前的历史证据。

### CAS 回补后的 beta.36 本地验收与 Windows fixture 前置失败

回补后重新构建的真实未签名 macOS 包通过功能／正常关闭 33 项及 typed API 1 项，Main 与冻结 out 字节一致。Node24 普通测试 1,630 通过／45 跳过；完整隐藏源码独立一轮 150 通过／32 条件跳过，无失败或强制清理。资产扫描仍为 207 个清单资产、228 个资源文件、9,555 个 ASAR 文件。新 Main SHA-256 为 `66653babda594c7dc6cdb791caf89ed7603711ef36b7e6489e3b9ceb512853cd`，ASAR 为 `0518eaab74bb1e5574e06b7105059cae3c2d01278349d5c028c2f293557d5b9e`，parser 清单为 `07888e2755c41232ff400118ad5b0e910bcc150ee68920ad50f1251e2dd12e50`；上方旧冻结包证据保持独立。本机 JSON 位于 `/tmp/aevoren-media36-cas-acceptance.json`，它不是仓库附件。

PR #42 的首次 Windows 普通测试为 1,613 通过／61 跳过／1 失败：新增硬链接回归停在 `realpath(dirname(path))` 前置校验，尚未进入被测 ctime 边界；Windows源码与安装包步骤未到达。fixture 现在使用和业务读取器相同的异步规范路径准备临时目录，并规范实际 CAS 父目录，不放宽产品路径、fd 或摘要检查。七项本地 CAS 测试通过；Windows结果须由新检查确认，不能用 macOS 成功替代。签名发行与真实账号／模型验证仍为独立门禁。

### beta.36 Windows 字节一致性修复

- 第二轮 Windows CI（38703832369）普通测试通过后在构建阶段拒绝 OFL LICENSE 摘要；原因是 Windows checkout 的自动 CRLF 转换改变了已固定摘要的上游文本。新增 Git 属性对字体及来源/许可资源保留原始字节，不更改任何已审阅摘要或放宽检查。
- 保留两次原始失败记录；修复后重新运行完整 CI，Windows 安装包验收尚待通过。

### beta.36 第三轮 Windows 来源读取 fixture 与 Linux 桌面焦点诊断

[CI 38710354729](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38710354729) 的 Windows 普通测试为 1,613 通过／61 跳过／1 失败，停在 `media-blob-store.test.ts` 的同大小来源覆写断言；尚未进入构建、源码界面或安装包。该 fixture 原先假定快速覆写必然立即改变文件时间戳。本次仅在受控 fd 读取边界将 mtime 显式推进一秒，先确认大小未变且 bigint mtime 已变化，再保留原拒绝及取消断言；外层另确认该前置验证确实完成，避免错误包装掩盖失败的测试前提。没有延时、产品代码或来源／CAS 校验变化。本机七项 CAS 测试通过；此结果不表示已在 Windows 执行，也不扩张来源读取器在全部时间戳均被保留时的保证。

同轮 Linux 普通测试 1,630 通过／45 跳过，真实 Docker 浏览器场景 40／41；六环境并行截图在捕获前触发 `BROWSER_OBSERVATION_STALE`。既有诊断为 `phase=focus-before`、耗时 11 ms，epoch 1／1、文档版本 5／5、页面存在且未关闭；没有 ffmpeg 失败，未出现正文、URL 或凭据。桌面焦点原因仍须独立定位，没有放宽焦点、epoch、版本或新鲜度保护，也未以本机成功覆盖此失败。新的正常 CI 将同时验证 Windows fixture 修正并继续提供跨平台证据，当前不宣称完整门禁通过。

### beta.36 显式截图聚焦等待（实际 Docker 门禁待验证）

受控回归先在原实现稳定失败：`bringToFront()` 已返回而隔离世界中的 `document.hasFocus()` 仍为 false 时，旧截图操作在 7 ms 内直接返回 409，尚未等待随后释放的实际焦点事件，也未读取正文或捕获。此测试复现聚焦确认与文档焦点就绪之间的边界，不宣称已在本机复现 Linux 窗口管理器本身。

修复只在 AI 显式聚焦后获取画面的路径增加最多五秒的隔离世界焦点事件等待；事件就绪后仍核验唯一实际焦点、原 page 记录及文档版本、控制 epoch 和所属操作状态，然后才观察及捕获。永久失焦、错误焦点、导航、页面关闭、用户接管、epoch 改变、单操作取消和 Worker 退出均不允许迟到捕获，取消会清理所属等待监听与计时器。电脑输入的焦点检查保持即时；原截图阶段的五秒限制独立保留，没有延长该阶段时限，也不将两个阶段称为原有统一五秒总期限。

定向八文件 43／43、Browser Worker TypeScript、目标 lint 和 Worker 构建通过；延迟焦点正例返回既有 JPEG fixture 的完整字节及摘要，不代替真实 X11 像素验收。协议及接口未变，Worker 仍为 1.1.0／协议 1，新 bundle 以独立字节摘要区分；本机证据为 `/tmp/aevoren-media36-focus-worker-evidence.json`。没有启动 Docker Desktop、重建用户环境、重新运行完整普通套件、Main 构建或安装包；此前冻结安装包属于修复前证据。新 CI 的真实六环境截图及跨平台门禁仍须全部通过。

### beta.36 Linux 实际聚焦结果与 Windows ctime 单测前提

准确提交 `da3263498c00aae73e72a35f342bad4416de20dd` 的 [CI 38714025139](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38714025139) 中，Linux 普通测试 1,639 通过／45 跳过，真实 Docker 浏览器七文件 41／41 全部通过；此前失败的六环境独立 cookie、profile 和真实画面场景在 7,397 ms 内通过。该结果验证聚焦修复的实际 Linux 路径，不代替其他平台或后续提交的门禁。

同轮 Windows 普通测试为 1,621 通过／61 跳过／2 失败，尚未进入构建或安装包。显式 mtime 的来源覆写测试已通过；剩余两项都假定硬链接 unlink 后系统立即报告不同 ctime，其中正例的 changed 断言为 false，原始来源负例返回了未改变的文件字节。保留该失败，不声称操作系统报告了它没有报告的元数据变化。

本次仅修改这两个单测及其窄 fixture：实际 fd 打开／读取、link／unlink 和返回字节不模拟，仅将目标 lstat／FileHandle.stat 的 ctimeNs 控制为原值及原值加一；外部断言确认 unlink 已发生、link 数 2→1，以及真实 dev／inode／mode／size／mtime 均未变化。已知 SHA 正例返回完整原字节，无 SHA 负例拒绝该受控 ctime 变化，实际摘要篡改负例保留；mock 在 finally 恢复。没有修改产品、来源校验、时限或跳过条件，也不据此扩张原始来源读取器对全部时间戳均保留的覆写检测保证。

本机独占资源的最终七项 CAS 测试 7／7 通过（3.06 秒），Node TypeScript 与目标 lint 通过；此前与长场景同时运行时两个原有大文件 IO 测试触发五秒限制的日志独立保留，没有增加时限。本次没有完整套件、构建、Docker 或界面重跑；新的 Windows CI 仍须实际通过。日志分别为 `/tmp/aevoren-media36-ctime-fixture-tests.log` 与 `/tmp/aevoren-media36-ctime-fixture-final-tests.log`。

### beta.36 旧库构造 fixture 事务与阶段诊断

提交 `1a84b81ad942c4b3f73353d44c903f013f42f2e8` 的 [CI 38716663804](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38716663804) 中，Windows CAS 文件六项适用测试通过、一项既有平台条件跳过，受控 ctime 两项没有失败。普通测试共 1,622 通过／61 跳过／1 失败；唯一失败是原生连接器旧库升级及 OAuth 重启场景触发原 60 秒限制，实际同步执行约 98,361 ms。构建、源码界面及安装包未到达。日志没有细分构造／首次打开／重启阶段，不能仅凭超时断言 Windows 停在哪一步。同期 Linux 普通测试 1,639 通过／45 跳过，真实 Docker 浏览器 41／41 通过，六环境并行画面场景为 6,646 ms；不以 Linux 成功替代 Windows 门禁。

该测试的旧版 37 数据库原先逐条自动提交迁移 SQL；本机先增加真实 SQLite `isTransaction` 前置断言，旧 fixture 在 6 ms 内以 false 失败。现在仅让旧库构造采用与已有数据库测试相同的逐迁移显式事务、回滚、外键检查及模式恢复，旧句柄始终关闭；产品迁移、原聊天／密文／OAuth 重启断言及 60 秒时限均未改。七个固定名称及累计毫秒数的阶段记录在 finally 输出，不含路径、正文、凭据或账号，用于下次 Windows 失败定位。

本机定向连接器仓库 12／12 通过（总计 902 ms），Node TypeScript、目标 lint、文档链接与 diff 检查通过；没有完整套件、构建或界面重跑。修正明确证明了 fixture 的事务边界，不宣称已证明 Windows 超时根因或新 Windows 门禁通过。旧失败与本机前置失败日志分别保留为 `/tmp/aevoren-media36-1a84b81-windows-failure.log`、`/tmp/aevoren-media36-legacy-transaction-before.log`。


## 阶段 5.2 原 beta.37 候选历史（本地源码与未签名 Mac 包回执）

- 独立加密 STT/TTS/Realtime 配置、版本、真实流式转写、PCM→WAV、持久 nonce／未知恢复／当前范围授权；微音频权限只允许用户主动的可信主文档。
- 有界真实音视频解码、时长保存、私有二进制读取、媒体失效后停止与清除播放器；转录手动 CAS 插入、群完成顺序朗读、取消及清空 generation 释放。
- Node24 完整普通测试 1,669 通过／45 跳过；隐藏语音 4、typed API 1、A/V 与原媒体 5 通过；独立解码 3 和有界权限／存储／SSE／WAV 等专项证据分别保留。UI 与音频设备是受控测试，不证明真实硬件或云账号。
- 宿主语音 nonce 对规范化后的实际 scope／参数生成。旧代码可由省略／显式当前 session 重复未知云请求的确定性负例已复现，修复后共用一个实际请求与任务 ID。密钥与原始音频不进入模型工具回执。
- 补齐 macOS 麦克风声明、App／Helper 音频权限及有区分的未签名／实际签名校验；三个校验器正反例通过。真实 beta.37 安装包、跨平台、签名和账号／设备仍待完成。


### 5.2 布局修复后的冻结 Mac 包与完整源码回归

代码基线 `020cee458e2bba0c90767ca5c1fbe3b01f1861bf`，工具链为 Node `24.19.0` / pnpm `11.19.0`。串行普通测试 **1,670 通过 / 45 跳过**（111.71 秒）；后续 Renderer 修正通过完整 lint、五个 TypeScript 目标及一次完整构建，再直接打包同一冻结输出，未重复构建。源码专项 **6/6** 通过，包括原有明暗参考图、200% 缩放键盘操作、关闭控件释放录音/播放、草稿冲突及显式 `@所有人` 的六请求并行与朗读顺序。两项包校验器的 10 个正反例、39 份文档链接、依赖许可检查（240 包 / 11 组）、未变化的 243 项 npm notices 与 250 项 SBOM 组件检查分别保留。

真实未签名 macOS arm64 `0.3.0-beta.37` 应用包完成 **38 项功能/正常关闭 + 1 项 typed API = 39 项不同场景**，全部通过。八项正常关闭均保留，强制进程清理和目录清理警告均为 **0**。这些场景实际断言打包身份和版本；不将源码启动计为包验收。Main、Preload、14 个 Renderer 文件、两套 Worker 的八个文件、九份随包指南及 notices 与冻结构建/源码逐字节一致；VOICE 指南 SHA-256 为 `10ed6461ce8cf8a9a9bd64b910b186dca982fe35413cd734558f5db4c72f0332`。

包内解析器扫描通过：清单资产 **207**、Resources 文件 **230**、ASAR 文件 **9,555**。实际麦克风包校验确认用途声明及四个 Helper；`signedEntitlementsVerified=false`、`physicalMicrophoneVerified=false`，未将声明当成签名权限或硬件证明。`.gitattributes` 仅对 `resources/media-parser-fonts/**` 设定 `-text`；以 `core.autocrlf=true` 的独立 checkout 复核六个文件均与原始字节相同，LICENSE SHA-256 为 `93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b`。未改变字体、许可或固定摘要的验证规则。

冻结 Main SHA-256：`63b26b2c31d4a613113d5ceab5cc3183c2936cb8d0abe7c77ee70b16bd8eca84`；ASAR：`acdff8bfbae6d6c675996c8577a069ef90fc557c2c07584956d1ce8ca1716c8d`；parser manifest：`657468e6f843090b3d5bd7a9b55a92f286bce6397e283a921d52e679cb1042cd`。完整资产、指南摘要与待验状态记录于本机 `/tmp/aevoren-voice37-final-acceptance-artifact.json`；包场景日志为 `/tmp/aevoren-voice37-final2-actual-package39.log`，源码专项日志为 `/tmp/aevoren-voice37-final-quiet-target-source6.log`。它们是临时本机证据，不是仓库附件。

历史失败继续保留：旧包首轮 37/38 的视频首帧红色通道为 0；两次诊断未重现，测试现等待真实 presented frame 后仍检查原 RGB 阈值与暂停状态，未宣称确定了唯一原因。旧完整源码轮次 **156 通过 / 32 跳过 / 2 失败**，分别为遗漏“语音”分类的旧键盘顺序和真实布局回归：默认语音面板将 composer 增高至 337px、transcript 缩至 407px。产品现以紧凑入口和有界浮层承载控件；原参考图可见性断言未修改。中间浮层修正还发现外部点击焦点与提及选择交互问题，已修正并用明确的提及 chip、everyone 路由、六请求及朗读顺序验证；未提高断言时限。原 trace、布局截图/矩形及旧包摘要独立留在 `/tmp/aevoren-voice37-package-initial-av-pixel-failure`、`/tmp/aevoren-voice37-source-initial-settings-tab-failure`、`/tmp/aevoren-voice37-source-initial-ui-reference-failure`、`/tmp/aevoren-voice37-post-layout-target6-failures` 和 `/tmp/aevoren-voice37-pre-layout-package-hashes.json`。

最终冻结输出随后独立完成完整 **190 项隐藏源码回归：158 通过 / 32 条件跳过 / 0 失败**，约 13.5 分钟；测试进程正常结束，没有将前述专项或旧失败轮次相加作为全量结果。该完成结果在环境重启前由执行代理及主代理直接读取。重启清除了 `/tmp` 原始日志、JSON 和历史 trace，故上列临时路径目前不能重新取证；仓库原有失败摘要继续保留，不声称原始附件仍可下载。

重启后只做冻结字节与清单复核，没有重跑这 190 项或修改构建输出：应用版本 `0.3.0-beta.37`、Main／Preload／14 个 Renderer 文件、两套 Worker 的八个文件、九份指南、notices 和 parser 清单仍与现存冻结输出逐字节一致；Main、ASAR、parser SHA-256 与上列完全一致。`test-results/.last-run.json` 保留 `passed`、空失败列表，但该文件不包含场景数量，不能独立证明 158／32。新测量记录位于本机持久目录 `$CODEX_HOME/aevoren-evidence/2026-10-15/phase5/voice37-frozen-recheck.json`，它是字节／清单复核，不冒充丢失的测试日志。

该冻结包仍使用 Browser Worker engine `9788e576cc351bcfea9e380484b33df8456582b143d0c7fac271662e1ded6e7d`，没有纳入 beta.36 后续显式 AI focus 等待修正；新的 Worker 验收不能归属于本包。Windows、实际签名权限、真实麦克风/输出设备和云账号仍待相应验收；此记录不代表阶段 5.3、阶段 6 或整个计划完成。


### beta.33 外发重启关闭诊断（未发布）

PR #43 的 [Windows 检查 38707578493](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38707578493) 在源码 35 项中通过 34 项；外发未知结果场景已确认一次提交和 unknown 状态，但首次重启的关闭夹具失败，第二次启动及只读核验尚未到达。原 trace 只有关闭调用和夹具错误，没有该进程的退出／管道状态或 Main 关闭阶段，不能确定是产品关闭、进程退出还是继承管道未释放。

本次仅在外发测试夹具增加有界诊断，缓存其确切 ChildProcess，记录 PID、exit／close 事件、退出码、信号和 stdio destroyed 状态，并复用已有的 Main flush／可信确认／窗口关闭阶段；每个进程最多 120 条，重启和清理调用无论成功或失败均附 JSON，随后移除监听。没有修改产品、关闭辅助函数、时限或业务断言，也没有重跑原失败任务。

新构建的本机隐藏 beta.33 源码场景 1／1 通过，第一次关闭约 191 ms、最终清理约 52 ms，均有可信 flush 确认、exit 0、全部管道关闭且未强制终止。四套 TypeScript、正常构建和定向 lint 通过；没有重跑完整套件或打包。该本机成功不证明 Windows 根因已解决，新的正常 CI 将提供该平台的诊断证据。

### beta.36 Windows ASAR verification path correction

[CI 38718418892](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38718418892) at `01efdaece09e9db2fe7cee369d6e3c5f4c05393e` passed Linux, macOS and Secret scan. Windows passed **1,623 ordinary tests / 61 skipped**, **50/50 source-interface cases** (20.5 minutes), **8/8 source close cases**, and actual Windows packaging. Step 13 failed during parser asset verification with `node_modules/@hono/node-server was not found in this archive`; installation and installed scenarios were not reached. This was not a 30-minute job timeout. The failed result remains recorded.

The verifier converted ASAR inventory paths to `/` before passing them to `@electron/asar.statFile`, whose directory traversal uses native `path.sep`. Windows therefore could not look up nested entries. The correction preserves native relative paths for ASAR stat/extract while retaining normalized `/` paths for whole-package forbidden-asset checks. Manifest bytes, size, SHA-256, font licenses, uppercase variants and undeclared-file checks remain unchanged. Product code, build output and deadlines were not modified.

An eighth fixture runs the dependency's real Filesystem methods with the Windows path implementation against a nested ASAR. The original verifier deterministically failed with the same `@hono/node-server` error (seven passed / one failed); the corrected verifier passed **8/8**, targeted lint and diff checks. This portable local test does not establish Windows installer acceptance; fresh Windows CI must validate the complete chain. Original workflow and before/after logs are stored in the local persistent directory `$CODEX_HOME/aevoren-evidence/2026-10-15/phase5/`, not as repository attachments.

### beta.36 platform gate and portable evidence references

At `d401708`, CI `38739051128` passed macOS smoke/package, Windows smoke/package and Secret scan. Windows reached the actual NSIS installation, installed feature scenarios and both source/installed close handshakes; the corrected native ASAR traversal passed against the real Windows package. Linux stopped before verification/Docker at `open-source:check` because this plan contained an absolute personal evidence-directory path. The gate correctly rejected that tracked path; it was not a product or Docker failure. Evidence references now use portable `$CODEX_HOME/aevoren-evidence/` notation, with no gate exception. This documentation-only correction does not change application, Worker, parser, dependency, package or workflow bytes. The original failed run remains recorded; fresh CI must confirm all gates on the corrected commit before promotion.


### beta.37 propagation of verified focus and platform fixtures

The beta.37 source now incorporates exactly the beta.36 `ec820c4` BrowserEngine focus fix: only an explicit AI frame-focus request waits up to five seconds for isolated-world focus, then still verifies the unique target, document version, ownership epoch and owned operation before capture. Input focus checks and the separate capture-stage timeout are unchanged. Before applying selected files, the existing engine and frame-diagnostics source were verified byte-identical to the patch's base. This is the only production-code change relative to `064b9e8`; beta.37 voice/UI contracts and version are retained.

The same narrowly selected update includes the deterministic raw mtime/CAS ctime fixtures, transactional legacy-connector migration fixture and native-ASAR-path verifier correction from beta.36. These modify tests and verification only; no deadline, skip, permission or asset-digest rule changes. Local Node 24 checks passed **62/62** (43 focus/browser, seven CAS, 12 native-connector), **8/8** parser-verifier cases including actual Windows ASAR traversal semantics, Node and Browser Worker TypeScript, targeted lint and documentation links. Logs are retained under the persistent local `phase5` evidence directory.

The exact BrowserEngine production source already passed beta.36 Linux CI, including all **41/41** real Docker cases and six independently scoped profiles/frames; that is beta.36 evidence, not a beta.37 Docker run. No Docker Desktop, hidden Electron, full build or packaging was run for this propagation. The prior beta.37 full-source 158/32 and actual-package 39 results retain their earlier boundaries: its cached package still has engine `9788e576...` and has not been relabeled as testing the new focus source. Fresh beta.37 CI must build and verify the combined candidate before Beta promotion or release. Master remains deferred.

### beta.37 first Windows results and fixture corrections

At `d38ec40`, CI `38739510867` passed the macOS smoke/package gate. Linux correctly stopped at the open-source path check because the evidence note contained an absolute personal directory; this plan now uses portable `$CODEX_HOME/aevoren-evidence/` references without changing the gate. Windows ordinary tests passed, then source UI completed **56/58**: an older settings fixture expected seven categories although Voice adds an eighth, and the WAV playback fixture tried to click a message behind the open voice popover. The retained trace explicitly reports the popover header intercepting pointer input. Source close, Windows packaging and installed acceptance did not run after the source failures.

Both corrections are test-only. Windows core acceptance now checks all eight exact current category labels. Playback queues completed speech through the existing visible in-panel action and explicitly asserts queue length two before closing/clearing; fresh message requests close the panel first. WAV bytes, exact cloud-request counts, blocked-play recovery, late-audio rejection, local pause counts and generation-clear assertions remain. No force click, timeout increase, skip or product change was introduced. Targeted lint, Node types, documentation links and open-source readiness pass; the corrected interaction still requires actual UI/Windows validation. The original failed workflow and trace remain separate evidence, and the cached macOS package is unchanged.

### MCP34 Windows 初始文档顺序校验

[CI 38717680788](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38717680788) 的 Linux、macOS 和密钥检查通过，Windows 普通测试通过；源码 smoke 为 37 通过、1 失败。首个 MCP App 场景在初始化 `.app-shell` 的原有 5 秒断言失败，尚未进入 MCP 配置、审批或写入。保留的 trace 只有测试侧步骤，未包含页面快照或导航状态，不能据此确认产品根因；Windows 打包和安装后验收尚未执行。

夹具现在先等待由 `app.getAppPath()` 确定的实际 Renderer 文件 URL 提交及 `DOMContentLoaded`，再执行不变的 `.app-shell` 断言。整体用例和断言时限均未扩大，没有休眠、重试或生产代码改动。失败时只记录 Main 就绪、窗口加载状态、预期文件类别、DOM readyState、Preload 是否存在及页面错误数量，不保存实际路径、正文或密钥。定向 ESLint 和 diff 检查通过；本机隐藏 Electron 正由另一阶段验收，本次未重复启动，Windows 结果仍待新的 CI 确认。

### beta.33 签名发布核验

`v0.3.0-beta.33` 已从正常合入 beta 的 `ffc4e858635ac98d5fc51e0446fa48a5ada2a5ff` 发布，标签／标题完全相同，公开 prerelease 含七个预期资源；master 未晋级。签名工作流 [38717619116](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38717619116) 首轮在签名包功能／关闭及 DMG 公证成功后，四次 stapler 请求均遭 Apple CloudKit `-1005` 连接中断，未创建 Release。核对该明确网络原因后，只重跑一次失败任务；同一不可变标签的第二次运行全部通过，包括下载后逐字节校验，再公开发布。

发布后单独读取公开元数据和实际下载的 `beta-mac.yml`、`SHASUMS256.txt`、SBOM，核对它们的大小、GitHub SHA-256、五项校验和及更新清单版本／包大小。清单 SHA-256 为 `2a97ef83dece7d31ccc55184d5826ffb4422811b46468e71b320491a9a82ffc7`；DMG／ZIP 大文件的完整字节验收由成功的签名工作流下载门禁执行，没有将元数据比较写成重复本地下载。Windows 签名任务因缺少配置跳过，真实 Windows Docker、麦克风或第三方账号不在本次证明范围内。

### MCP34 第二轮 Linux 原生标签焦点诊断

`0059e4a` 的 [CI 38738887096](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38738887096) 普通测试 1,572 通过、45 跳过；真实 Linux Docker 为 40／41。原生标签场景已验证 B 内容点击与白色画面、旧 A 画面点击拒绝、接管后 RFB 点击、首次 Ctrl+Tab 到 A 及真实蓝色画面，但第二次 Ctrl+Tab 后两个页面均报告无焦点，原断言失败。截图成功且容器无 OOM，当前证据不能确认键盘、浏览器 chrome 焦点或 X11 状态的根因。

为下一次门禁补充仅失败时的受控夹具诊断：有界 A／B 焦点、可见性和按钮焦点报告，以及 RFB 连接状态、X11 活动／输入焦点窗口与活动进程数字 ID。不记录页面正文、URL、标题、路径或密钥，不增加输入、重发、重新聚焦、休眠或断言时限；产品与镜像代码不变。Node TypeScript、定向 ESLint、文档和 diff 检查通过；本机 Docker 保持关闭，未将诊断代码称为问题已修复。

同一 `0059e4a` 检查的 Windows 任务随后完整通过，包含原生源码、关闭握手、NSIS 打包／安装、安装后功能与关闭；初始 Renderer 顺序校验进入实际 MCP 业务断言并通过。macOS 与密钥检查也通过。Linux 40／41 的失败仍使整轮 CI 失败；未合入 dev 或 beta，也未将 Windows 成功视为 Linux 已修复。

### beta.34 Windows main-document close diagnostics

At `00a8ad07`, CI `38744993113` passed Linux verification/real Docker, macOS smoke/package and Secret scan. Windows passed source business scenarios, then seven of eight source close cases; the main-document reload case failed because the original three-second process-exit check returned false. The retained Main trace records a flush request, trusted successful acknowledgement about 25 ms later and window-closed about 38 ms after the request. It contains no application quit lifecycle or owned process/stdio observations, so it does not establish why process exit was not observed. Windows packaging/installed gates were not reached; the failure remains recorded.

This test-only update extends that fixture's existing bounded diagnostics with application before-quit/will-quit/quit/window-all-closed events and window counts, the exact owned ChildProcess exit/close events and pipe-destroyed flags, plus request/evaluate/deadline/cleanup phases. Final diagnostic JSON is attached on both successful and failed requests, including the cleanup outcome, and listeners are removed afterward. Each process remains capped at 120 records; no URLs, arguments, file paths, contents or credentials are recorded. Product code, close helper, process-exit authority, all deadlines and business assertions are unchanged. Targeted lint, Node types, documentation and open-source checks pass. No local hidden scenario, rebuild, packaging or unchanged workflow rerun was performed; fresh normal CI is needed to obtain the missing causal observations.


## Beta.35 refresh after MCP34 source acceptance

This branch integrated dev `a743f7d835948a051d316a74fdc3752c190eacc2`, the normal PR #37 merge. MCP34 exact source head `2ccd1c9` passed all four checks in CI 38758776745, including actual Linux Docker and macOS/Windows source plus installed-package acceptance. Prior native focus/close failures above remain historical; no unproven production fix is inferred. The dev integration and Beta promotion are still running. Source version stays beta.35, preserving its separate Notion title/append functionality. This refreshed Notion merge requires new normal cross-platform gates; it has not been released, and master remains deferred.


### Native35 parallel-frame focus evidence

PR53 preview CI38837437002 at dev `80ab17e` passed all ordinary verification, then actual Linux Docker40/41. One of six scopes rejected a desktop screenshot at the unchanged focus-before check: epoch1/AI owner/page known and open/document version5 remained stable; no observation was created. Later native diagnostics showed the Chrome window active/focused with no OOM, but did not preserve the exact trusted-world result or window-manager readiness at the rejection. This does not establish a product cause or permit bypassing409.

The opt-in Worker diagnostic now saves only the existing focus check's numeric CDP stage, focused/closed booleans and presence of a JavaScript exception, capped at20 pages. It neither issues extra CDP reads nor repeats bringToFront, input or capture. Raw exception text, URL, DOM, title, frame/page IDs, cookies and credentials remain excluded. The failure-only controlled Docker fixture separately reports numeric supporting-WM window and Openbox process presence without input.

Focused frame/Worker tests passed15/15, with the same409, capture counts and access rules; Browser Worker TypeScript, targeted lint and build passed. Rebuilt engine SHA256 `f2146a8a8185d1646441751a706adb07c30639f79fa8abd591a23a74adc87617`; server `41e2318a05a29e20c1b0777f2d28d2871ecad5505b553ff9d2970d7b55898a73`. This is diagnostic code, not a focus fix. No local Docker or application/package rebuild was performed; older package receipts remain historical and fresh normal CI must build/test the new image and platform packages before promotion.

### Windows validation download and fixture cleanup — 2026-10-16 local snapshot

The [Beta34 backport Windows job](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38854100767/job/116821586945) failed in the Node fixture gate before product UI ran: the 1,500ms timeout killed `taskkill` itself while the known parent and descendant remained alive and the sibling remained alive. Linux actual Docker/RFB, macOS package and secret checks passed in that run. The reason Windows delayed the command is unknown; this is not evidence of an application crash.

The fixture allowed 3s graceful close, 1.5s command and 2s pipe cleanup, but its whole-case assertion allowed only 5s. The local correction retains the product's 3s graceful close and exit assertions, and shares the existing 3.5s forced allowance between command completion and actual owned exit/stdio closure. Expiry stops only the helper's own command handle; no target PID retry is added. The controlled total is 8s, explicitly including 3 + 3.5 + 1s descendant verification + 0.5s runner allowance; descendant death and sibling survival remain required.

A frozen-dev ordinary-helper Node shim reproduced the early abort at 4,509ms with both targets still alive. The same delayed command under the corrected helper completed at 5,134ms with both targets dead, closed pipes and the sibling alive; its forced result still fails an exit-0 requirement. An uncompleted owned command was rejected at 3,503ms and its command process was terminated. These are isolated macOS Node controls, not real Windows timing or an OS-cause claim. All five original Node checks, Node TypeScript, targeted lint and whitespace checks passed. Local raw evidence is under `$CODEX_HOME/aevoren-evidence/2026-10-15/releases/fixture-taskkill-delay-{baseline,after}.log` and `fixture-taskkill-window-hard.log`.

The delivery workflow records exact version, checkout head, `NotSigned` and SHA-256 before installing the NSIS file, then requires the same hash after installed business and close acceptance. Only successful Windows gates preserve that file, checksum and build identity for 30 days under a version/head/attempt artifact name. This is an unsigned Windows validation installer for manual use; official Releases and automatic updates retain their signing policy, and Windows Docker remains unverified. The helper and workflow have independent code review; real Windows execution and actual downloadable artifact identity must be verified by the new normal candidate gate before branch promotion. No local Electron, Docker, signing or installation replacement was performed for these changes.

### Startup close acceptance uses the existing normal-close contract

PR63 at `300081e` passed Linux verification/real Docker, macOS, secret scanning, Windows Node fixtures and the full Windows source UI suite. Its separate Windows source close gate failed only the first three of ten immediate-startup requests against a startup-only 1.5s process-exit allowance; the other seven close cases passed. Installation and the downloadable installer were not reached. The retained phase attachments show those three windows closed 11–15ms after their requests, with no renderer-ready or flush acknowledgement. Their owned processes subsequently exited normally with code 0, no signal, no forced termination and closed pipes after 2,685ms, 1,755ms and 2,393ms. Database/native shutdown latency is not established by these observations.

The startup case now reuses the same existing 3s process-exit allowance as the other normal-close cases instead of its separate 1.5s argument. Both window-close and application-quit helpers explicitly require code 0 and no signal on their normal exit path, inside the diagnostic `try/finally`. No product code, platform-specific allowance, longer normal-close timeout or retry is added. The original failure and all ten phase attachments remain recorded; this corrects a test budget and does not claim a native-exit performance fix or an OS root cause.

Using the existing built application, the ten-startup case, dirty-window three-restart case and application-quit case passed 3/3 in 10.9s, exercising both normal-exit assertions. Node TypeScript and targeted lint passed. Local evidence is under `$CODEX_HOME/aevoren-evidence/2026-10-15/releases/pr63-close-contract-*.log`; the original Windows log and extracted phase summary remain separate. A new normal cross-platform run is still required, including the actual unsigned installer download; beta remains unchanged and master is deferred.

### macOS GUI Docker CLI discovery correction (development)

A read-only local version check reproduced `ENOENT` for bare `docker` with the GUI-style PATH `/usr/bin:/bin:/usr/sbin:/sbin`, while the installed Docker Desktop executable returned version 29.5.3. The default DockerDriver inherited that PATH unchanged and therefore misreported an installed CLI as missing. The Darwin-only correction appends standard Docker Desktop, user and Homebrew directories to the command's child environment, preserving the caller's PATH precedence. It does not mutate the application environment, invoke a shell, switch Docker contexts or relax the existing unix/npipe-only endpoint checks. Standard locations are documented in [Docker's macOS permissions guide](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/#installing-symlinks).

The initial three black-box default-runner cases produced two failures and one pass on the unchanged driver. After correction, five new GUI-path cases and seven existing Docker-driver cases passed, including absent/empty PATH without a current-directory entry, existing executable precedence and remote-context rejection. The executable fixture returns controlled Docker-shaped responses; it is not real Linux-container acceptance.

A fresh unsigned macOS beta.35 package was built from clean output after preserving the older beta.37 generated output separately. All four TypeScript configurations, build and targeted lint passed. The actual hidden packaged app, launched with the minimal GUI PATH, passed its real Preload/IPC Docker probe and normal exit-0 check (1/1, 6.48s). It reported `dockerInstalled=true` and `daemonReachable=false`, correctly distinguishing the installed real CLI from the stopped engine; no daemon or container was started. Inherited application/database/renderer overrides were filtered, and an owned poison-database canary remained unchanged. This proves GUI command discovery, not engine execution or Windows Docker support.

Frozen Main SHA-256 is `03b1748914c019bdffc8e535fbec38863a70e459c8817c8039013066e866eb6c`; ASAR is `7a0d0f869bca7cd5255c5c1dfcf86e400c15ba5510a04077f27412949ac0508c`. All 16 generated app files and eight generated Worker files match the package byte-for-byte, and stale media-worker output is absent. Local receipts are in `$CODEX_HOME/aevoren-evidence/2026-10-15/releases/docker-gui-{path-before,path-after,package-receipt,actual-package}.*`. Normal development CI, necessary Beta backport validation and signed publication remain separate pending gates; public beta.33 and master are unchanged.

### Claude retained-batch image authorization correction (development)

A bounded cross-cutting review found that the real MCP SDK JSON transport can retain a rendered tool result while another request in the same HTTP batch is pending. On unchanged combined candidate `da6999f`, one isolated failure-first regression using SDK 1.31.0, authenticated loopback HTTP and an owned project-icon PNG confirmed this boundary: the first image authorization was read once, the response remained pending, authorization was revoked before the second tool responded, and the eventual HTTP 200 batch still contained the original 825,244-byte PNG. The controlled test failed at the no-stale-pixels assertion in 102ms. No SDK, transport or write hooks, artificial transport delay, user screen, real Claude CLI, cloud request or user account was involved. Ordinary single-response scheduling was not shown to have this interval.

The narrow bridge correction records only images actually included by a fresh or cached render in a response-local async scope. Every actual HTTP body write/end rechecks those leases; revocation, a closed source or cancelled image Runtime destroys only that response. A separate HTTP request has its own scope, including when the same completed request is redelivered. Already-redacted replies and ordinary text cancellation errors retain their existing behavior. The tool receipt is reused without executing the tool again. No batch support, authorization, normal-close budget, global lock or provider capability is removed or expanded.

Two real-SDK regressions cover both a false and a throwing revoked lease while a second batch tool remains pending. Each proves that an independent image request succeeds after the first lease is revoked, the held batch is refused without stale pixels or timeout, and a same-ID cached retry returns its authorization notice without redispatch. The focused image/model/Claude-bridge suite passed 27 tests, with one existing optional locally generated Codex-protocol artifact case skipped; Node TypeScript and targeted lint passed. An initially overbroad guard also refused a text-only cancellation error; that local attempt was rejected by the existing regression and the correction now checks cancellation only for included image leases. Both logs are preserved.

Raw local evidence is under `$CODEX_HOME/aevoren-evidence/2026-10-15/releases/claude-batch-takeover-before{.log,-receipt.json}`, `claude-response-lease-unit{,-initial}.log` and `claude-batch-takeover-after.log`. The original PR63 unsigned Windows download, PR64 normal CI and earlier GUI35 package retain their own historical scope and do not validate this new guard. A fresh package, independent review, normal combined development CI, necessary narrow Beta backports and signed publication are separate required gates. Public beta.33, the pending beta.34 branch and master remain unchanged.

The fresh unsigned macOS beta.35 package passed all four TypeScript/build configurations and one actual hidden packaged GUI bootstrap/Docker-probe case (1/1, 4.96s), with normal exit 0 and no forced cleanup. The owned database canary stayed unchanged; the real installed Docker CLI was discovered while its engine remained stopped. No daemon, user window, real Claude CLI or cloud operation was started. Main SHA-256 is `6d521b7b3e6b11c5e8b3851fb37ffa7ddf6643f1a11b6b4e985212ca6f3131f1`; ASAR is `c383625ba644fdf8406ba1cdbe55747b6a2f2c310d68b39ae4fcfa6cf1391936`. All 16 generated app files, eight Worker files and the changed browser guide match the package; the compiled response-local scope and final image guard are present. These byte/bootstrap checks and the source actual-SDK regressions remain distinct evidence, not an actual packaged Claude batch or real-human takeover test. Old GUI35 output was archived before rebuilding.

Independent read-only review found no remaining blocker in the narrow fix: request-local ALS ownership, cached redaction, normal text cancellation and installed SDK/Hono body-write paths were checked without duplicate execution. Future media integration must also register any actually included private text lease, and the later TASK authority guard must remain active for text-only results. New full development/Beta/signing gates are still pending.

## 0.3.0-beta.36 refresh from normal MCP34 dev integration

This candidate integrated normal dev `a743f7d835948a051d316a74fdc3752c190eacc2` after PR #37 exact source head `2ccd1c9` passed all four checks (CI 38758776745), including actual Linux Docker and macOS/Windows source plus installed acceptance. Current candidate features, expanded feature/package/close workflow selections and exact package version are retained. Only conflict resolution in documentation/workflow lists was needed; production feature behavior was not replaced. Prior failed and earlier local receipts above remain tied to their original builds. Fresh normal CI is required for this merge; no Beta tag or master promotion has occurred.


### Media36 Windows initial document evidence

Normal CI 38832566027 at `27a89fd` passed Linux verification/actual Docker, macOS source/package and Secret scan. Windows ordinary tests passed, and source smoke was 49/50. The one failure was Library fixture launch: `.app-shell` was absent at its unchanged five-second check, before resource opening, draft mutation or any Library business assertion. The Room single-member failure case passed in this run; its earlier failure remains unexplained and did not trigger the new controlled diagnostic. Windows packaging/installed gates were not reached.

The Library launch helper now waits for the production Renderer file URL derived from `app.getAppPath()` and its actual DOMContentLoaded event before the same shell/Preload checks. It retains every business assertion and whole-case deadline, with no sleep, retry or product change. Failure-only boot evidence is limited to readiness/loading booleans, expected file category, DOM readyState, Preload presence and page-error count. The original trace contained no DOM/navigation evidence, so this sequencing correction does not claim a proven Windows product root cause; fresh normal CI remains required.

Limited local acceptance of the corrected initial-document sequencing passed the actual hidden macOS source case 1/1 (8.4 seconds) with its original assertions and normal closure. Node TypeScript, targeted ESLint and whitespace checks passed. No application rebuild, package rebuild or Windows rerun was substituted for the pending new normal CI.


### Local Media36 integration and retained private-text leases — 2026-10-16

This local-only work started from actual protected dev `ffd5dab99d153097ff8971a8895647d0b5d7dae6`, normally integrated pending PR65 `f1629278fdbf4fdb3e1b0bda1dcf75f959ddea7c` and original Media36 `a8e0980fe7b4b5bfab90801b5a56e41687c0c065`, and resolved their documented conflicts. Neither pending source is relabelled as newly accepted protected dev. The browser engine combines every per-await access/cancellation check with passive diagnostics; its entire source blob matches the earlier combined reference `66349a4b5b9bcea5af806092bb36d432b0a0955f`. GUI discovery, finite fixture cleanup, strict normal-close checks, parser/license gates and success-only exact-file Windows validation downloads remain intact.

A failure-first natural SDK batch test on the naive image-guard/text-carrier combination passed both browser-image cases and failed both private-text cases at the actual stale-body assertion (109ms/106ms). The narrow composition now records the one text-authority decision actually used by the existing rendering helper, then registers the original text carrier only after that helper succeeds and includes it. Current authority is checked at each actual HTTP body write alongside included image leases. The four false/throwing image/text cases passed, preserving independent response delivery, correct response IDs, method receivers, redacted cached retry and no redispatch. The source image/text helper and public schemas were not rewritten. Later TASK authority must still run unconditionally for all responses, outside any empty-lease predicate.

Local acceptance used Node 24.19.0 and pnpm 11.19.0. Thirteen targeted files passed 106 tests, with one existing optional locally generated Codex-protocol artifact check skipped; this includes real SQLite media/admission/native repositories and browser focus guards. All five TypeScript projects, targeted lint, documentation links, dependency-license checks (240 packages / 11 groups) and the security gate passed. The security gate retains its explicit verified packaging-advisory backport and five moderate advisories; no new dependency exception was introduced. Independent read-only code review found no blocker. Root removed incoming duplicated history that would have reintroduced an obsolete typed-API package classification, retaining the corrected source-only receipt.

A fresh unsigned macOS beta.36 package was built after preserving the old output. One single-worker hidden run passed 16/16 in 60.47s, with zero skips, failures, retries or forced-cleanup warnings. Evidence is separated: six **source parser** cases cover real PDF text/blank pages/preview pixels, DOCX/UTF-16/ZIP rejection, CMap/CMYK/JPX/JPEG, six independent jobs with selected cancellation, sandbox denial and the actual 30-second parser deadline; ten **actual packaged application** cases cover media 4, Library initial-document selection 1, Notion35 updates/restart/send-once 2, typed API 1, real GUI Docker discovery 1 and strict application-quit/restart close 1. Eleven package identity attachments verify exact version and `isPackaged`; explicit strict close checks require exit 0/no signal. These do not establish an actual packaged Claude/cloud batch, real-human takeover, third-party account or real Windows Docker. No user foreground window, daemon or container was started.

Fresh Main SHA-256: `2e752322c563b110dff1e37d9ad09343b63217448c49f6672e43074b79ee8c3f`; ASAR: `e47b4b017032798b1ff8dc6005b01e7278691cbc7f34f1ada2c6989382de52cf`. All 16 generated app files and 226 configured extra-resource files match the actual package byte-for-byte. Parser verification scanned 207 manifest assets, 228 resource files and 9,555 ASAR entries; parser manifest SHA-256 remains `07888e2755c41232ff400118ad5b0e910bcc150ee68920ad50f1251e2dd12e50`. The compiled response-local image/text guard is present. Previous Media36 Main `66653bab...` / ASAR `0518eaab...` output was preserved intact before rebuilding and remains historical. Local receipts are under `$CODEX_HOME/aevoren-evidence/2026-10-15/releases/media36-response-lease-*`, with failure-first `media36-private-text-lease-{before,after}.log`.

No Media36 push, new PR, protected merge or release occurred during this local acceptance. After PR65's own required gates, normal protected-dev merge/tree equality and fixed beta.35 snapshot, this work must normally integrate that actual dev identity and verify unchanged production/resource inputs or validate any real delta before its ordinary feature PR and full CI. Actual Beta installation gates and exact-version signing/publication remain required in 34 → 35 → 36 order, with master deferred.

The production notice generator reproduced the staged inventory unchanged. Whole-feature whitespace checking reports whitespace in the inherited verbatim OFL license; its exact bytes match original Media36 (SHA-256 `93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b`) and remain unmodified. The rest of the staged feature passes whitespace checking with only that single upstream license excluded; no repository validation policy or Git attribute was weakened.


### Media36 normal integration of the actually accepted dev identity

After PR65 completed its own four normal checks, the release owner normally merged it to actual protected dev `d0c2ec4d28507b8707420b5a424b516e240cc3d7`, with tree equality to the tested source, and fixed the separate beta.35 snapshot before further development. This branch normally merged that actual identity as `600c1f2d78c3a9b7faabff73bd2a98c4ffc300f5`. Its entire tree `77dded19e0db0d8b686032dab084803d4091bc59` equals local acceptance `f091ebd37dc72ac638ab0d7b92aac6f8be6f5c3d`: zero tracked content changed, including every product, Worker, parser, dependency, build and packaged guide input. Only excluded source-status README/matrix/implementation records were then updated for the ordinary feature PR. No rebuild or unchanged test repeat was substituted for the required new normal CI.

The actual dev push run 38874946550 remains pending at this handoff. This candidate still needs its own normal CI and protected promotion; actual Beta gates and signed publication remain separate. The beta.35 fixed snapshot prevents later dev/media changes from entering that earlier release, and the release owner preserves the 34 → 35 → 36 order with master deferred.

## 0.3.0-beta.37 refresh from normal MCP34 dev integration

This candidate integrated normal dev `a743f7d835948a051d316a74fdc3752c190eacc2` after PR #37 exact source head `2ccd1c9` passed all four checks (CI 38758776745), including actual Linux Docker and macOS/Windows source plus installed acceptance. Current candidate features, expanded feature/package/close workflow selections and exact package version are retained. Only conflict resolution in documentation/workflow lists was needed; production feature behavior was not replaced. Prior failed and earlier local receipts above remain tied to their original builds. Fresh normal CI is required for this merge; no Beta tag or master promotion has occurred.

### Local Voice37 integration draft — 2026-10-16

This local-only draft starts from actual dev `d0c2ec4d28507b8707420b5a424b516e240cc3d7`, normally fast-forwards pending Media36 PR #67 at `0444b7492758db2835809f4fb04e8df0c096eb66`, and merges original Voice37 `dcbe41ef6c9ceb95c7d27dc6fe870e3b43f479aa`. The accepted dev identity and the Media36 local proof remain separate; neither pending Media36 nor this new Voice37 combination is described as accepted protected dev. No new Voice37 push, PR, package proof or verification result is claimed here.

Original Voice37 source/package and controlled-device receipts above remain historical to their own builds. The current combination retains the corrected Library document sequencing, GUI Docker discovery, strict normal-close callers, finite cleanup, response-local image/private-text leases and verified same-file Windows delivery gates. Quiet local fixture choices and fresh source/package/CI evidence will be recorded only after actually performed; no real microphone, speaker, cloud account or OS-keychain-backed real-credential verification is inferred from old fixture results. Actual Realtime connections remain a later delivery. Beta remains beta.34, public beta.33 and master remain unchanged.


### Local37 release-fixture maintenance preparation — 2026-10-16

This local-only merge incorporates pending maintenance PR68 head `1c3122540523f102a885e5409573a17644a36851`, which contains actual dev36 identity and only two fixture prerequisites plus progress notes. The candidate remains unpushed: PR68 still requires its own Windows/full gate, normal development acceptance and actual accepted-dev identity merge before the first new37 PR. No protected acceptance or public release is implied. All application, dependency and packaged resource inputs remain those of frozen37; only the legacy-migration and six-browser-focus fixtures change. Their original deadlines and business assertions remain. Fresh local fixture checks and exact byte/diff evidence are recorded externally, and the actual protected-dev merge must still be integrated after acceptance.

### Actual development maintenance identity integrated into Voice37

Maintenance PR68 own CI38896964585 passed all four jobs, including actual Windows source50/close8/installed42/close8 and verified artifact upload. Its normal dev merge is `5bdff605bccfa3a32e64b1db1a5206b0a777cc29`, entire tree identical to reviewed1c31225. This branch now normally merges that actual protected identity. Compared with local37c1aa, only this progress note changes; all application, dependency, packaged resources and actual unsigned Main/ASAR bytes remain unchanged. The accepted actual-dev push38904530777 and the new Voice37 own normal CI remain separate required gates before protected37 acceptance. Beta34/35 release sequencing and master deferral remain.
