# Aevoren 功能扩展实施计划

基线为 0.3.0-beta.26。实施依据为 [功能对照](FEATURE_ADOPTION.md)，按六阶段补齐界面与 AI 能力，共用宿主校验、真实审批、执行记录、取消和恢复，保留 `@所有人` 六成员并行。产品登录注册、多人云协作、支付、完整会议助手和专属邮箱不进入首轮。

当前开发候选为 **v0.3.0-beta.44**。阶段 6A 已实现 MAIN/TASK 隔离、固定上下文、权限、独立线程与共用业务入口，三项不同源码场景和真实未签名 macOS 包四项本地验收通过；普通回归原整轮 1,777 通过／9 失败／45 跳过，九项旧迁移断言修正后七文件 72 项定向通过，累计 1,786 个不同通过场景，不记为单轮全绿。阶段 6B 全资源搜索的 11 项 SQLite、2 项产品传输及2项实际界面场景通过，实际未签名 macOS 包已有验收，跨平台／签名仍待完成。6C 分区／偏好／图片头像已通过业务、源码界面和实际未签名 macOS 包检查，跨平台／签名发行待验收；6D 群 Routine 与 6E 事件／本机 Webhook 已通过本地源码和真实未签名 macOS 包检查，6F 模板／选择范围离线导出的界面和 AI 集成、源码专项与真实未签名 macOS 包验收亦已完成。六阶段本地实现可审阅，不代表后续 Beta 已发布或跨平台／签名门禁通过。[beta.33](https://github.com/CMSKL/Aevoren-Bot/releases/tag/v0.3.0-beta.33) 已公开签名公证 macOS 包，后续版本按正常顺序晋级；master 不晋级。真实第三方账号、音频硬件及 Windows Docker 未验证。

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
| 4 技能包与应用连接 | Bash/Python/Node 脚本、资源、示范草稿；Gmail/Drive/Notion、写 MCP、外发草稿与 Apps | 开发组合候选四项 CI 通过，分单元晋级中 | `4178157`：Linux 普通 1,593／45 跳过与真实 Docker 41；macOS 源码 139、实际功能包 21、关闭 8；Windows 普通 1,578／60 跳过、源码 40＋关闭 8、安装包 38＋关闭 8；真实第三方账号写入未验证 |
| 5 多模态与语音 | 图片/PDF/DOCX/音视频；STT/TTS、实时语音、打断与转录 | 5.1–5.3 源码及本地包证据完成，跨平台／签名发行待通过 | beta.38 源码累计 159 个不同通过、32 条件跳过；保留完整运行 3 项失败及定向 3/3，通过真实 Worklet／受控协议／普通 Runtime；云账号／硬件另行验证 |
| 6 自动化、搜索与分享 | 全资源搜索、TASK 线程、分区/默认助理/头像/通知；事件/Webhook、群 Routine、模板及导出 | 6A–6F 已有本地源码及实际未签名 macOS 包证据；跨平台、签名和顺序发布仍单独验收 | beta.39 的迁移／授权／UI 身份与能力专项已有证据；完整构建与三个不同隐藏场景分轮通过，保留失败，真实未签名 macOS 包 4 项通过，跨平台／签名待完成 |

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

> 同步 dev 保留的历史记录；不覆盖本文开头的最新候选与验证状态。

审查发现已发布示范的缓存回执可能在资料解绑／删除后仍带旧正文；修复为复核原资源、原版本及当前 Scope，拒绝已解绑／删除资源，原发布 Skill 不重复创建或自动启用。产品网关 37 项通过，含后续修改资料后仍返回原版本、解绑／删除后拒绝两项回归。修复源码重新通过四配置 TypeScript 与构建并冻结未签名 macOS beta.33 包；该包原生连接 2、外发 5、typed API 1 通过，示范 1 在纠正测试读取随包指南的方式后通过，实查 isPackaged、版本与指南正文。最初指南测试在 Electron evaluate 内动态 import 不被支持，改为查询实际 Resources 路径后读取；应用和包均未为此重建或修改。

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

## Windows TCP 录制夹具验收更正

另有 Linux run 38677885045：普通测试 1,587／45 跳过通过，真实 Docker 40／41；六独立 Scope 的截图返回 `409 BROWSER_OBSERVATION_STALE`。容器仍运行，约 427.5／768 MiB，OOM 计数为零；未据此认定内存问题。代码没有观察 TTL，截图内部聚焦并重新观察，不能靠增加夹具观察或放宽新鲜度解决。

`65437c8` 仅在显式开启时写入固定诊断文件，记录焦点／文档版本前后、epoch、布尔状态和有界耗时，不记录 DOM、URL、图片、Cookie、路径或能力令牌。所有 409 校验和捕获顺序保持不变。六个负向用例及相关 26 项、Node／浏览器 Worker 类型、lint、Worker 构建通过。Worker 字节／镜像 context 摘要会变化；前述包 30 项先于此补丁，补丁后的真实 Docker／安装包仍待验证。下一轮真实 Linux CI 用于确定拒绝阶段。


> 同步 dev 保留的历史记录；不覆盖本文开头的最新候选与验证状态。

后续原生 Linux [CI 38666108922](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38666108922/job/116198324472) 在 12288fd 通过完整 Validate：普通 1,547 通过、45 跳过；真实 Docker／Host 7 文件 41／41 通过。新增实际桌面 RFB 示范用例 3.239 秒通过，包含输入脱敏、断线／重启封存和归还后观察边界。该证据来自 Linux 容器，不改变本机 daemon 未启动和真实 Windows Docker 未验证的记录。


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

> 同步 dev 保留的历史记录；不覆盖本文开头的最新候选与验证状态。

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

> 同步 dev 保留的历史记录；不覆盖本文开头的最新候选与验证状态。

### 示范 beta.33 再次同步已验证 dev

示范提交 `b46a92143b647f355c4b771f84ed4b1bf2b63a17` 的[CI 38681547433](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38681547433) 四项全部通过：Windows 源码与 NSIS 安装后的功能、八项关闭握手均通过，未重复先前的初始化或复合关闭超时。随后合入固定 dev `36a48730002a5a8bd7115891a99a18a7cffa792c`，保留 beta.33、实际迁移 38→39→40、Browser Worker 1.1.0、示范扩展 CI 数组及原八项关闭夹具。公开安装包基线仍为 beta.31。

本次相较 `b46a921` 的生产差异仅为 Browser Engine 的显式启用、无敏感内容的旧画面诊断；Main、业务契约、版本和关闭夹具不变，未纳入 MCP34、Notion35 或阶段 5。定向 frame 诊断 6 项与 CDP 下载 10 项（含本机符号链接边界）全部通过，Browser Worker TypeScript、目标 lint、Worker 构建、文档链接、三份工作流 YAML 及 diff 检查通过；日志和源文件／Worker 摘要保存在本机临时 `/tmp/aevoren-demo33-dev36-merge-evidence.json`，YAML／生产差异核验为 `/tmp/aevoren-demo33-dev36-merge-yaml-diff.json`。没有重跑完整套件或重新打包，前述 25 项包验收仍对应原冻结构建；新 Worker 的跨平台结果须由本次合并提交的 CI 单独验证。



### beta.32 Windows 关闭阶段诊断（未发布）

PR #41 的一个完整跨平台检查已通过；另一个 Windows 检查的首次关闭及随后一次不改代码的重跑仍出现失败。重跑通过源代码业务场景后，在主文档重载后的关闭断言失败，重启持久化校验未到达。保留失败记录，不能用另一轮成功替代。

关闭 smoke 现在只在其自有进程内记录主文档加载、可信 Renderer-ready、flush 请求、可信确认、窗口关闭和进程退出阶段；失败时附上有界 JSON。记录不含 URL、页面内容、密钥或用户文件路径，不修改产品代码、关闭时限或启动参数。新增诊断的本机隐藏主文档重载／修改／关闭／重启用例已通过；下一次 Windows 检查用于定位停在哪个阶段，尚不能据此确认根因或发布。


## MCP34 Windows source fixture deadlines

At `a5d674999d215a837e29101434060b6eddb78c91`, [Windows CI 38689015680](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38689015680/job/116270524225) passed 36/38 source smoke cases, including all three MCP App cases. The demonstration case exhausted its 30-second total budget: setup used 9.005 seconds and the second saved-v2 draft click began at 28.254 seconds; publication and application close were not reached. The Library group case had already verified all six requests, routing and pinned original prompt content when its 5-second completion poll expired. Its first actual snapshot IPC took 5.599 seconds and eventually reported `running`; batch completion and the final reference-badge assertion were not verified. Source close handshakes, Windows packaging and installed checks were consequently not run. These failed results remain separate from earlier green runs.

The test-only correction gives the compound demonstration case a 60-second total budget on Windows, retaining 30 seconds on macOS. Only the observed Library completion poll is replaced: subscribe to the production RoomRuntime event before querying current state, match room/session/batch IDs, accept only `completed`, reject other terminal states and unsubscribe on settlement. Its existing 90-second whole-case budget and all business assertions remain unchanged; no sleep, retry or polling-timeout increase was added. Product code and the existing beta.34 package were not rebuilt or changed.

Limited local macOS validation passed both affected source cases (2/2, 10.3 seconds) and the same cases in the existing actual unsigned beta.34 package (2/2, 8.7 seconds). Packaged identity/version checks passed, and package Main matched source out (`c8cd5865fd452e50dcfc074c2269eebbb111d574aae64e892085e0474524f746`); the ASAR digest was unchanged before/after. Targeted ESLint, documentation links and diff checks passed. Evidence is stored locally at `/tmp/aevoren-mcp34-windows-fixtures-evidence.json`, with separate `source` and `package` logs/JSON under the same prefix. Original log/artifacts and trace timing are retained at `/tmp/aevoren-mcp34-a5d6749-windows-failure-summary.json`. These are temporary local files, not repository attachments. This limited macOS rerun does not establish Windows success, a full-suite pass or a signed release; fresh cross-platform CI remains required.

### 媒体 CAS 并发回补（beta.36，重新验收中）

后续六成员朗读验收用受控边界稳定复现：一个读取者已打开同内容 CAS 文件时，写入者清理临时硬链接会改变 ctime，即使字节与 mtime 未变，也被原严格来源读取器拒绝。此前随机成功不作为修复证据。回补仅在读取前已知预期 SHA 的 CAS 路径允许这一元数据变化，并在读取器内验证完整真实字节摘要；用户选择／Workspace 来源继续严格比较 ctime、fd/path、模式、大小和 mtime。新增来源篡改与摘要不符负例、六个同摘要并发写入通过。当前候选正在重新执行完整普通测试、源码和实际安装包门禁；上方冻结包的成功是回补前的历史证据。

### CAS 回补后的 beta.36 本地验收与 Windows fixture 前置失败

回补后重新构建的真实未签名 macOS 包通过功能／正常关闭 33 项及 typed API 1 项，Main 与冻结 out 字节一致。Node24 普通测试 1,630 通过／45 跳过；完整隐藏源码独立一轮 150 通过／32 条件跳过，无失败或强制清理。资产扫描仍为 207 个清单资产、228 个资源文件、9,555 个 ASAR 文件。新 Main SHA-256 为 `66653babda594c7dc6cdb791caf89ed7603711ef36b7e6489e3b9ceb512853cd`，ASAR 为 `0518eaab74bb1e5574e06b7105059cae3c2d01278349d5c028c2f293557d5b9e`，parser 清单为 `07888e2755c41232ff400118ad5b0e910bcc150ee68920ad50f1251e2dd12e50`；上方旧冻结包证据保持独立。本机 JSON 位于 `/tmp/aevoren-media36-cas-acceptance.json`，它不是仓库附件。

PR #42 的首次 Windows 普通测试为 1,613 通过／61 跳过／1 失败：新增硬链接回归停在 `realpath(dirname(path))` 前置校验，尚未进入被测 ctime 边界；Windows源码与安装包步骤未到达。fixture 现在使用和业务读取器相同的异步规范路径准备临时目录，并规范实际 CAS 父目录，不放宽产品路径、fd 或摘要检查。七项本地 CAS 测试通过；Windows结果须由新检查确认，不能用 macOS 成功替代。签名发行与真实账号／模型验证仍为独立门禁。


## 阶段 5.2（beta.37，本地源码验收通过，包／跨平台待验证）

- 独立加密 STT/TTS/Realtime 配置、版本、真实流式转写、PCM→WAV、持久 nonce／未知恢复／当前范围授权；微音频权限只允许用户主动的可信主文档。
- 有界真实音视频解码、时长保存、私有二进制读取、媒体失效后停止与清除播放器；转录手动 CAS 插入、群完成顺序朗读、取消及清空 generation 释放。
- Node24 完整普通测试 1,669 通过／45 跳过；隐藏语音 4、typed API 1、A/V 与原媒体 5 通过；独立解码 3 和有界权限／存储／SSE／WAV 等专项证据分别保留。UI 与音频设备是受控测试，不证明真实硬件或云账号。
- 宿主语音 nonce 对规范化后的实际 scope／参数生成。旧代码可由省略／显式当前 session 重复未知云请求的确定性负例已复现，修复后共用一个实际请求与任务 ID。密钥与原始音频不进入模型工具回执。
- 补齐 macOS 麦克风声明、App／Helper 音频权限及有区分的未签名／实际签名校验；三个校验器正反例通过。真实 beta.37 安装包、跨平台、签名和账号／设备仍待完成。


## 阶段 5.3（beta.38，实施中）

- 新增独立实时语音会话、逐轮最终转录、持久函数调用意图及真实业务任务链接；迁移 44 保留现有媒体与 STT/TTS 数据。
- 宿主固定 `realtime-v1`，确认完整 session.updated 后接受音频；工具只能由完成的 response.done 与已固定最终转录共同派发。模型参数不成为用户消息或权限。
- 用户主动开启并逐轮提交录音；真实 AudioWorklet 重采样／播放计数、取消与截断确认、15 分钟会话租约及独立停止任务正在验收。
- Root 专项已通过 42 项（真实 SQLite／普通 Runtime 来源、资料版本及原授权、文档麦克风租约、Prompt 用户权限）；完整类型、受控 WebSocket、隐藏界面、安装包与跨平台尚待完成，不记为已交付。
- 真实云账号、物理设备与网络恢复未验证。阶段 6 尚未开始实施。


### 5.3 专项与独立复核（最终整体验收前）

- 首轮真实隐藏界面通过生成音频的两轮录制、真实 AudioWorklet、本地受控 WebSocket、最终人类转录、普通 Runtime 委派和独立停止；物理扬声器仅在 fixture 中静音，不记为硬件验证。
- 独立复核修复了三项实际边界问题：人类语音不再附加 peer-task 提示块；资料停用／删除后的重启用不能恢复旧实时连接准入；截断回执的时长上限与输出采样预算一致。资料停用 ABA 有失败在先与修复后 42 项专项通过记录；输出协议专项 15 项通过。
- 无限制测试进程的首轮普通测试 1,703 通过、45 跳过、6 失败，其中五项超出原 5 秒预算，60 毫秒取消／期限用例先进入期限终态；已保留失败日志。随后限制为两进程的整轮 1,710 通过、45 跳过，只在新加入但当时尚未修复的资料 ABA 回归失败；该结果不能算最终全绿。现正运行修复后的冻结整轮，不增加超时或产品全局锁。
- 真实六成员 Room 链专项验证六成员在首个结果前启动，取消其中一名后其余五名完成。完整安装包及跨平台仍待通过。


### 已公开 beta.32 小型发行清单复核

公开 Release 的 tagName／name 均为 `v0.3.0-beta.32`，isDraft=false、isPrerelease=true。独立下载 `beta-mac.yml` 与 `SHASUMS256.txt`，字节大小与 GitHub 资产摘要一致；清单中五项 SHA256 均与相应 GitHub 资产 digest 一致。更新清单版本为 `0.3.0-beta.32`，DMG／ZIP 文件名和长度匹配公开资产。这项检查没有重新下载完整安装包，完整字节与签名公证仍以已成功的签名发行工作流为据。Windows 签名缺配置，未公开签名 Windows 安装包。


### beta.38 当前冻结业务源码普通回归

最终限制为单测试进程的一轮完整普通回归通过：150 文件通过／8 条件跳过，1,713 项通过／45 条件跳过，145.66 秒，原有 5 秒测试期限与产品群聊并行均未修改。完整 ESLint 通过。此前两进程一轮仍有两项超时及超时清理后的 database-not-open 未处理异常，日志保留；不能重记为成功。两失败文件单独串行通过 71 项；以上全绿整轮另有独立日志 `/tmp/aevoren-realtime38-serial-full-unit.log`。该冻结源码仍待合入阶段 5.2 的聊天区语音布局修复，再做完整类型、构建及安装包验收。


### beta.33 晋级 Windows 失败（不发布）

晋级 PR #43 的运行 38707578493：Linux、macOS 与密钥检查通过，Windows 源码选择 34 项通过、1 项失败。失败为 `native-outbound.spec.ts` 的未知结果重启场景，`closeTestApplication` 在拥有的 Electron 进程／stdio 收尾阶段报错；该场景含中途重启，尚不能据终端错误断定全部业务断言已完成。Windows 后续关闭、打包和安装验证均未执行，因此当前不合并或发布 beta.33。原始日志 `/tmp/aevoren-beta33-windows-promotion-failure.log` 已保留，正分析 trace 与关闭诊断，未通过盲目重跑或增加期限掩盖失败。


### beta.38 当前冻结源码覆盖与宿主休眠证据（2026-10-15）

在 `65e497d3ba18f17ca682a144ac08cc9c777fbfbf`、Node 24.19.0 下直接使用现有构建，单 worker、nice 10、隐藏 Electron、独立临时数据目录及禁用更新执行完整 191 项源码 smoke。结果为 **156 通过、32 条件跳过、3 失败**，25.1 分钟，退出码 1；没有修改产品、fixture、原有期限或重建产物。受控 HTTP 在三个 Runtime 阶段跨 15 次 Renderer 重载保持响应屏障的修正已在该轮通过（1.3 分钟）；真实 Chromium AudioWorklet／生成音频、受控 WebSocket 和普通 Runtime 委派界面亦通过。

失败分别是三十秒 stale／取消、关闭超时提示、未绑定聊天工作区入口。独立读取系统电源记录确认宿主在 08:04:13 −0500 进入 Idle Sleep 586 秒，08:13:59 DarkWake；08:14:43 再进入 Maintenance Sleep 354 秒，08:20:37 用户活动唤醒。关闭提示的 trace 在 close 请求后停顿约 589 秒，未绑定聊天在 firstWindow 阶段停顿约 352 秒，与两段系统休眠对应。stale 场景则在约 19.2 秒时页面关闭，未到三十秒断言边界；没有独立记录证明这次页面关闭的根因，不将其直接归因为产品或休眠。三项原始失败与 trace 保留。

仅对上述三项使用有限子进程 `/usr/bin/caffeinate -i` 防止该轮空闲系统休眠，不唤醒屏幕、不改变电源设置或操作用户应用；冻结代码、构建及 45／20／30 秒原期限均保持不变。定向 **3/3 通过（44.7 秒，退出码 0）**，所属 Electron 均 exitCode=0、signal=null，无强制清理警告。当前累计覆盖 **159 个不同通过场景、32 项条件跳过**，**不是一次完整全绿运行**。随后误启动的完整重跑已按范围收敛要求在 8 项后中止（退出码 130），不计入成功门禁。

只读复核确认包版本为 `0.3.0-beta.38`，Main／Preload／Renderer 共 17 个 out 文件与现有真实未签名 macOS 包逐字节一致；解析资产校验通过 207 项清单资产、231 个资源文件与 9,556 个 ASAR 文件。Main SHA-256 为 `faa97cfb320b2b951982e8d6cf27f06e94aa835b2272774900d355bab56ae7bc`，Preload 为 `1e984f697c82447ea2c6b68faefbb73819c0cf86ad86ac184522b0ee35fb27ca`，Renderer 为 `45092d7bd13fbe6e0a1623f30f41909ee71589c2c8e24cd7d0b9f86b534f7828`，ASAR 为 `c88639591fad72fad6c7509537e59dc5ec99ea8880f19155612acb38987532a3`，parser 清单为 `c3849e73366654ababa5a7aebe47e053201dacc40b2c6c03918a549c8bba1fa1`。麦克风用途声明及四个 Helper 存在；此轮未执行签名 entitlement 验证或物理麦克风测试。

新证据持久保存于本机 `$CODEX_HOME/aevoren-evidence/2026-10-15/`：`voice38-final-source191.log`、对应 metadata JSON、`voice38-final-source191-test-results/`、四行 `voice38-final-source191-power-transitions.log`、`voice38-focused-awake-three.log` 及对应 metadata、`voice38-final-out-package-hashes.json`、`voice38-final-package-assets.json` 与 `voice38-final-microphone-declaration.json`。这些本地证据不是仓库附件。环境重启前部分历史 `/tmp` 证据已不存在，前文仍按历史结果保留，不能宣称那些临时文件当前可用。此前真实未签名包 40 项为既有验收结果，本轮未重复该套场景。跨平台、签名发行、真实云账号、物理设备与 Windows 恢复仍待验证；阶段 6 尚未交付。


## 阶段 6A：TASK 数据、授权与线程界面（beta.39，门禁待通过）

- 迁移 45 保留 MAIN、旧聊天／Runtime／Memory／媒体及入向外键，TASK 可与相同 Bot／群的 MAIN 和其他 TASK 并存。任务标题／版本与历史 generation 分开。
- 通过 taskOptions 读取精确来源范围版本，默认不选择执行者、上下文或权限。每个执行者明确选择固定 Memory、引用历史、资料／Skill 版本、媒体摘要、Workspace 读写／自动化上限、read-only MCP 身份、产品动作、联网和剪贴板。目录／同 Bot／同项目不产生授权。
- 原 Runtime 与重试固定最初选择，修订不动态扩权。成员／资源／MCP 撤销和 ABA 不复活旧授权；任务能力快照只描述当前执行者与实际选择，不泄露其他连接元信息。
- 新建 Task 只打开独立聊天。Task 侧栏按 sessionId 识别，联系人及原群继续打开 MAIN；历史、运行事件、草稿缓存、迟到请求和 Room 快照分别按实际 session 过滤。任务标题 CAS 冲突保留用户草稿；授权修订另行审阅。
- 停止仅作用于此 Task 的活动 Runtime／批次；删除要求空闲并保留 owner Bot／群。独立后台服务仍使用其生命周期控制。
- 八项 sessions.* 共享业务动作及可信 onTasksChanged 生命周期已实现，模型不能伪造执行者或通过权限修订自授新访问。

本地已运行的具体增量证据：Renderer 身份／空默认值和设置合计 8 项通过，能力注册专项 10 项通过（含原 Runtime 重试快照、独立联网／剪贴板、精确 MCP 及旧 MAIN 行为）；Node／Web 类型与定向 ESLint 通过。日志在 `$CODEX_HOME/aevoren-evidence/2026-10-15/task39-ui-focused.log`、`task39-capability-tests.log` 及同前缀 types／lint 日志。另有 SQLite、宿主 Runtime/MCP 专项由对应交付记录汇总，当前不填尚未冻结的整轮总数。

三项 `tests/smoke/task-sessions.spec.ts` 已通过静态发现（3 项）并开始执行，覆盖真实 Preload／SQLite、受控 HTTP／MCP、独立草稿／重启历史、CAS、任务级删除、六成员／兄弟线程并行、actor 查询与撤销。**三个不同隐藏场景现已分轮通过，不是单轮 3/3 全绿**；参数规范化修复后的冻结完整构建通过，当前没有 beta.39 真实包、Windows 或签名发行通过记录。6B 搜索、6C 整理与偏好、6D 群 Routine、6E 事件／Webhook、6F 模板／离线导出仍待实施，不能将 6A 视为全部六阶段完成。

当前公开基线为 v0.3.0-beta.33。前文 beta.33 Windows 晋级失败保留为历史，不代表现有发行未发布；之后的正常验证与签名发行已完成。beta.34 起按单元继续 dev → beta → 安装包验收 → 同版本 Beta Release，标签和标题都严格等于 v<package.json version>，master 暂不晋级。


### beta.39 隐藏验收前两轮失败（保留，尚未通过）

首轮三项均在 Electron 启动前失败：fixture 的连续大写 Memory 标记触发既有 MEMORY_SENSITIVE_CONTENT 校验。只把种子改为普通带空格的私有测试句子，未修改产品敏感内容检查；精确清理三个本轮拥有的临时目录，失败日志／trace 保留。第二轮三个 Electron 均正常退出，但场景仍失败：两个 fixture 分别使用不符合已有规则的中文 MCP 连接名和 Everyone 空目标列表，现已改为合法 slug 与明确成员 ID。第三项已完成实际产品工具往返，发现 Task 产品输入在宿主注入范围之前被 normalizeProductRequest 的严格 UI schema 拒绝；Task 专用产品 schema 现允许省略宿主 session 字段，再由既有宿主校验注入，可信 UI schema 保持严格。对应规范化专项通过，新的完整构建及三项隐藏回归待验证，不把先前 INVALID_REQUEST 当作查询成功。

本机持久证据为 `$CODEX_HOME/aevoren-evidence/2026-10-15/task39-hidden-first-three*` 和 `task39-hidden-second-three*`（完整日志、metadata 与 artifacts）；第二轮清理前未保存私有 Tool Journal，因此不能声称这些行仍可读取。后续 fixture 在失败时附上有界真实请求／工具回执、Runtime/Tool API 快照及自有 SQLite，避免再次丢失诊断。没有增加原 90 秒场景期限、绕过审批或放宽产品权限。


### beta.39 受控源码场景累计通过（未验证安装包）

参数规范化修复后的完整构建 `dec880c` 通过五个 TypeScript 项目及 Electron／Worker／parser 构建。后续运行继续保留失败：第三轮 MCP fixture 在实际 probe 前请求信任工具，被已有规则拒绝；并行场景把尚未收到响应头的 dispatching 错当 running；撤销场景收到正确的 LIBRARY_NOT_BOUND，但断言只接受泛化范围错误。只修正测试的实际 probe／信任流程、SSE 响应头屏障与精确拒绝码，不放宽产品校验。

第四轮六成员／兄弟线程并行及 actor 查询／撤销场景 **2 项通过**；UI 场景已通过空默认值、两个草稿、真实发送与正文隔离、标题 CAS 冲突保留、改名、页面重载及应用重启，但删除步骤错误复用了重启前的 Page Locator。只更新 Locator 后，对此失败场景定向 **1/1 通过（10.1 秒）**，包括删除线程并保留 Bot／MAIN 及兄弟线程。当前三个不同场景全部覆盖，**不能记为单轮三项全绿**。所有所属 Electron 均正常 exitCode=0、signal=null，无强制清理警告。

冻结 Main SHA-256 为 `dfed4ba9dd78f1039b6627e1d90afc2ffa453a348415a1699202b9b59964e501`，Preload 为 `6e330d432392704231efc98ec191c16527d9100515ee8bc973dd2f0a4155c6b4`，以上测试修正没有重建或改变业务字节。持久日志／metadata 位于 `$CODEX_HOME/aevoren-evidence/2026-10-15/task39-hidden-third-three*`、`task39-hidden-fourth-three*` 与 `task39-hidden-first-case-final*`；失败 trace、有界真实 HTTP／Tool Journal／Runtime 快照及自有关闭 SQLite 已保留在对应 artifacts。完整普通测试正在单 worker、原有期限下执行；实际未签名包、跨平台及签名发行仍待验收。


### beta.39 普通回归与真实未签名 macOS 包验收

完整普通测试以 Node24、单 worker、原期限运行一次，结果为 **1,777 通过、45 跳过、9 失败（7 个文件）**，137.28 秒。失败均由新增 Task 结构触发旧 fixture 的范围／字段假设：V5/V9 逻辑哈希额外包含新 Session 列，MAIN 摘要增加 kind，原生 Runtime 范围增加三个空 Task 字段，两个媒体／实时迁移测试遇到刻意变更的 MAIN 谓词、Task 索引和 Runtime 触发器，诊断 fixture 的无列名 Session INSERT 仍给八个值。只修正测试：保留每个原字段／行的精确比较，另核对 Task 默认值和 MAIN 的三个 NULL 范围字段；逐一比对原外键与明确新增的 parent 自引用；只有具体的 MAIN 谓词／Task 索引／完整声明的 Runtime 触发器采用明确新期望。诊断 CLI 本身未修改。七个失败文件定向 **72/72 通过（5.33 秒）**。累计 **1,786 个不同普通测试通过、45 条件跳过**，**不是一次完整全绿运行**；原九项失败保留。完整 ESLint、Node 类型、41 文件文档链接和开源准备检查均通过。

使用 pnpm11.19 的 electron-builder 直接打包已有冻结 out，没有重建业务源码、签名、公证或触发发布。真实未签名 macOS arm64 包在同一轮通过 **Task3 与 typed API 共 4/4（28.6 秒）**，每个相关 fixture 验证 packaged=true/version39；全部自有进程正常 exitCode=0、signal=null，无强制清理。验证包含空权限／真实 Prompt 排除私有上下文、独立草稿和发送、标题冲突／改名、重载／重启、删除线程而保留 owner、七个并发 HTTP 请求、单成员停止、actor 查询及撤销／重绑后零传输，并明确断言全部 11 个 sessions Preload 方法和八项非法请求拒绝。

Main／Preload／Renderer 的 17 个 ASAR 文件及执行 Worker／Browser Worker／parser 的 216 个资源文件与冻结 out 逐字节一致，Task 指南已随包复制。资源校验为 207 项 parser 清单资产、232 个资源文件、9,556 个 ASAR 文件，无禁止资产。ASAR SHA-256 为 `7ffcff2fcefcf5fb8f9040f1a32c9ed03446409e0aa18f673260fde7dfd2c7c9`；Main／Preload 与上方冻结值一致，Renderer 为 `422c5905e22d2012a62e9c9de0b1a659316f349003f9c599489e221a9772c0e9`，parser 清单为 `6de64fb986756e666d7fe1a4c0d20c77f91beae33bb7ac1e3633a44947477ef8`。未签名麦克风用途声明和四个 Helper 检查通过；signedEntitlementsVerified=false、physicalMicrophoneVerified=false，不能作为签名或硬件证据。

持久日志与 JSON 位于 `$CODEX_HOME/aevoren-evidence/2026-10-15/` 的 `task39-full-unit-serial*`、`task39-legacy-fixture-focused.log`、`task39-full-eslint.log`、`task39-unsigned-mac-package.log`、`task39-actual-package-four*`、`task39-frozen-package-hashes.json`、`task39-package-assets.json` 和 `task39-package-microphone.json`。包内指南记录打包时的验证边界；本次后续文档更新不改变上述冻结业务字节。CI 的 macOS 实包、Windows 源码及 Windows 安装后清单现都包含 Task3，保留原有场景。跨平台检查、dev／beta 晋级及签名发行仍待完成，master 暂不晋级；阶段 6B–6F 尚未交付。

> 同步 dev 保留的历史记录；不覆盖本文开头的最新候选与验证状态。

### beta.33 外发重启关闭诊断（未发布）

PR #43 的 [Windows 检查 38707578493](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38707578493) 在源码 35 项中通过 34 项；外发未知结果场景已确认一次提交和 unknown 状态，但首次重启的关闭夹具失败，第二次启动及只读核验尚未到达。原 trace 只有关闭调用和夹具错误，没有该进程的退出／管道状态或 Main 关闭阶段，不能确定是产品关闭、进程退出还是继承管道未释放。

本次仅在外发测试夹具增加有界诊断，缓存其确切 ChildProcess，记录 PID、exit／close 事件、退出码、信号和 stdio destroyed 状态，并复用已有的 Main flush／可信确认／窗口关闭阶段；每个进程最多 120 条，重启和清理调用无论成功或失败均附 JSON，随后移除监听。没有修改产品、关闭辅助函数、时限或业务断言，也没有重跑原失败任务。

新构建的本机隐藏 beta.33 源码场景 1／1 通过，第一次关闭约 191 ms、最终清理约 52 ms，均有可信 flush 确认、exit 0、全部管道关闭且未强制终止。四套 TypeScript、正常构建和定向 lint 通过；没有重跑完整套件或打包。该本机成功不证明 Windows 根因已解决，新的正常 CI 将提供该平台的诊断证据。


### beta.39 同步最新 dev 与检查清单

本候选已合并同步最新 dev `a2207e58b4eaaf093a3c4cd43dbef7aff08b33d8` 的历史与有界外发重启关闭诊断。冲突保留 beta.39 的较新功能／检查清单与两侧历史验收记录；本次合并对 src、共享合同、版本、依赖、Worker、构建配置和所有业务字节均无差异，没有重建产品或重跑已通过的 UI 场景。Node 类型、定向 lint、文档／开源检查及工作流 YAML 通过。macOS／Windows 的 CI 源码／实包列表，以及之后的签名发行功能列表均加入 Task3，原有场景与正常关闭门禁完整保留。当前只准备正常开发 PR，不合入 dev／beta 或发布新标签，master 不变。


## 阶段 6B：全资源搜索（beta.40，本地源码验收）

实现 `search.query/open` 共用业务入口、当前会话／项目／全部本地资源界面、七类资源与已保存语音转录、固定来源与分页游标。AI 固定 Runtime 会话和执行 Bot，TASK 使用原始选定版本与历史；来源撤销、重绑、世代清空和内容变化会重新校验。私有标题／片段不进入持久工具回执，实际模型发送前检查私有附件授权。

本地十一项 SQLite、两项产品传输、两项隐藏 Electron 界面和二十四项组合回归通过，完整类型与构建通过。两项界面场景同轮通过，应用拥有进程正常退出。证据标签：`$CODEX_HOME/aevoren-evidence/2026-10-15/search40-*`。未验证当前实际安装包、Windows、签名或真实云账号。详见 [搜索说明](SEARCH.md)。

### beta.40 真实未签名 macOS 包验收

Search2 与继承的 Task3 同轮 **5/5 通过（40.3 秒）**，实际 app.isPackaged=true、版本 0.3.0-beta.40，拥有进程均正常退出。Main SHA-256 `56d0a85414736fb5aefa9b1bdee86a84fd2935c4fa669a8a79b82bd0028c9319`；已验收 ASAR `b613e598efaab4bf519cad53d54361dbb83729aae57eca10dc2ec36db03fd12e`。17 项 ASAR 输出与216项Worker/parser输出逐字节匹配；207 parser资产／233资源文件／9556 ASAR条目校验通过，四Helper麦克风声明存在，未验证真实硬件。后续合入39的正常dev同步仅修改历史文档、工作流和七项旧迁移测试，无业务代码差异，不重记为新的模型／设备证据。当前跨平台CI和签名发行仍待完成。

### beta.40 高缩放布局与继承 Runtime 修复

保留正常 CI 失败与本地复现：200% 缩放时新增搜索按钮使输入框只余 6px；修正旧的单按钮期望后，新增任务入口也使会话标题只余 5px。保留搜索、未读、创建、关闭、任务和菜单入口，搜索按钮使用 24×32px 的独立布局，窄屏减少搜索内边距／间距与会话头间距。没有删除原有宽度、包含关系、拖动区域或防重叠检查。typed API 的固定命名空间清单只补入实际存在的 search。

另继承 beta.39 的有界 Codex 子进程 teardown 修复 `e1078a0`，相关权限／关闭普通测试 12/12 通过。最终 Electron Main／Preload／Renderer 构建、Node／Web 类型与定向 lint 通过。两个高缩放场景、typed Runtime API 和 UI-only 明暗设计参考在最终源码同轮 4/4（5.9 秒），新实际未签名 macOS arm64 包同轮 4/4（12.3 秒）；四个对应夹具均真实核验 packaged=true/version40。200% 时搜索输入 40px、会话标题 43px，150% 标题 108px，控件均在范围内且没有内外重叠。UI-only 设计参考仍不是 Agent 执行业务证据。

首次打包停留在 Electron 校验清单网络下载且没有生成输出；保存诊断后终止该下载进程，使用已安装且核验为 Electron 44.3.0 arm64 的运行时执行标准 ASAR／afterPack 未签名打包。17 项应用输出与 216 项 Worker／parser 输出逐字节匹配，Worker／parser 输出未重建。实际 ASAR SHA-256 `d67b1a55c22c960aa57d903029ed7c1548ad0cf85ef2cc313d5a29ac4a8715a5`，Main 为 `1cd908a142d6a0e882cb9a2ac43e60d9f09433b9113be47a1c6b1581b4744ef0`。207 项 parser 资产、234 项资源文件及 9556 ASAR 条目校验通过；四 Helper 麦克风声明通过，未验证签名或硬件。

持久证据在 `$CODEX_HOME/aevoren-evidence/2026-10-15/releases/search40/`，包含修复前日志／trace、最终 source/package-focused-final 的日志与 JSON、实际几何与明暗截图、字节核对、打包与 parser／麦克风回执。Browser 插件未提供，使用仓库既有隐藏 Playwright Electron 工作流。上述四项是本次变更的定向验收；新的完整跨平台 CI／签名发行仍待完成，不能把历史五项业务包验收记为本次完整全绿。


## 阶段 6C：聊天整理、通知与图片头像（beta.41）

迁移 46 保存聊天分区、按 sessionId 的归属／顺序和偏好，并扩展 Bot 图片引用。界面和 AI 共用七项 organization 操作及三项 Bot 头像操作；原生图片取消只属于可信界面。主会话与 TASK 分别整理，分区不改变内容／权限。默认助理仅作为无有效恢复目标时的启动回退；通知类别和声音独立设置。版本冲突保留名称、移动和偏好草稿。

图片源必须属于实际任务的授权媒体；原生宿主读取实际 PNG/JPEG 字节、居中裁剪为 256×256 PNG 后先暂存，再原子提交独立拥有副本与 Bot 版本。模型读图经真实图像附件和现有可撤销 Media lease 传输；图片字节不进入持久工具回执。源删除、复制 Bot、恢复默认及取消互不误伤。停用／重启用缓存的回归原实现已通过，复用已有 lease，不声称复现了新的 ABA 缺陷。

54 项相关业务回归、五配置类型、完整构建和定向 lint 通过。新增两项隐藏 Electron 界面同轮 2/2（11.4 秒）通过：真实 SQLite／IPC、MAIN/TASK 分区顺序、并发编辑、默认助理恢复，以及真实原生裁剪像素、源删除、应用重启、独立复制及恢复默认；相关拥有进程正常 exitCode=0。证据为 `$CODEX_HOME/aevoren-evidence/2026-10-15/organization41-*`。实际安装包、Windows、签名发行与物理通知待验收；6D–6F 未完成，不作为六阶段全部交付。无新依赖／许可。详见[使用说明](ORGANIZATION.md)。

### beta.41 AI 头像回执与真实包记录

修复前实际未签名 macOS 包同轮 6/6（42.4 秒）通过 Organization、原生头像、typed API 和 Task3，正常退出；该结果属于修复前业务字节。之后新增网关回归先修正测试未选择媒体和 Runtime 未结束的 fixture 错误，再确定性复现真实问题：成功发布后重复相同指令绕过保存回执查询，误报 BOT_VERSION_CONFLICT。最小修复把头像设置移到既有回执复用后，暂存解析仍在 SQL 外，真正发布和完成工具回执同步原子提交；同一事务拒绝回执时照片／资产／Bot 全部回滚。同三文件 56/56 通过，含实际授权 PNG 字节模型传输、持久回执无像素、清除后序列化零图片。原失败日志与修复后日志分别保留在 `organization41-avatar-receipt-before*`、`organization41-avatar-receipt-final.log`。最终业务字节需要重新打包并做定向包验收，不覆盖前一六项回执。

### beta.41 修复后的最终未签名 macOS 包

头像原子回执修复后重新构建 Main／Preload／Renderer，用已安装且核验版本的 Electron44.3 arm64 执行标准 ASAR／afterPack 未签名打包。最终真实包 Org、Avatar 与 typed API 同轮 **3/3（24.7 秒）** 通过，实际 packaged=true／版本41，所有自有进程正常退出。历史 Task3 仍按修复前六项包回执保留，不重记为最终三项。

最终 Main SHA-256 `f851b04cb6fcac2b12ad1cec643dfef98382b3992bfec5ccc5999eaacc1bc636`，ASAR `e551a5091e67e08215480ff7b1f961ff91737552c931da02c6b5762880f5b00f`。17 项应用和216项Worker/parser文件逐字节一致；随包整理指南与打包时源文档相同。207 parser资产／235资源文件／9556 ASAR条目验证通过，四 Helper 麦克风用途声明通过，不作为签名或真实硬件证据。此处后续文档验收说明未重写已冻结的包内历史指南；生产业务字节不变。持久回执为 `organization41-actual-package-final.log`、`organization41-final-package-bytes.json`、`organization41-final-package-parser.json` 和 `organization41-final-package-microphone.json`。Windows／跨平台及签名发行待正常门禁，master 不晋级。


## 阶段 6E：事件与本机 Webhook（beta.43）

迁移 49 新增持久订阅、独立加密凭据与幂等接收回执；允许已装 49 后补入尚未应用的 48，按缺失迁移执行并在修改前备份。真实 SQLite 升级／备份回归已通过。设置界面提供明确来源、保存 Routine 的版本／指令／目标／成员审阅、保留冲突草稿、一次性密钥显示、真实监听地址与接收历史。AI 只提供当前 MAIN 会话的 `automationEvents.snapshot/create/update/revoke/cancel`；原 `events` 命名空间、Runtime 取消和审批仍独立，监听控制与密钥轮换不进入 AI 目录。

监听默认停止，显式启动时仅绑定 127.0.0.1；每次重启仍停止。HTTP 先认证再解析并在接收前复查凭据，限制连接数／正文时间／UTF-8 JSON 大小和结构，拒绝网页 Origin。相同 key 与规范化载荷返回原回执，载荷改变报告冲突。事件正文固定为普通不可信 JSON 附件，不能覆盖 Routine 提示词或成为批准。订阅、目标版本与准入快照固定；旋转／暂停／撤销只取消所属运行，未知接收结果不重新派发。

内部完成／失败事件由宿主核验实际 Runtime 后发出，只有不透明 ID 和状态，不携带私有 TASK 文本、Memory 或工具参数。真实 Routine → AI `messages.send` → 子 Runtime 的宿主 rootClientNonce 链已验证；持久 ancestry 阻止重复订阅与超过四跳的循环。

已保存 70 项关联 SQLite／HTTP／Runtime 检查，以及 9 项补充 UI／委派检查通过记录。五配置类型与完整构建通过；补充 7 文件 54 项（含真实旧库迁移）通过。新增隐藏 Electron 两项同轮 2/2（16.1 秒）通过，真实 loopback HTTP、六成员在首个结果返回前全部启动、独立兄弟任务、所属取消、私有 TASK 元数据、一次性密钥、监听重启停止及冲突草稿均经实际 IPC／Renderer 检查；拥有进程正常 exitCode=0。实际未签名 macOS 包最终证据待下文验收，不从源码通过推断发行可用。无新依赖／许可；Windows、真实用户端点／账号、远程转发、公开入口及签名发行未验证。证据标签 `$CODEX_HOME/aevoren-evidence/2026-10-15/event43-*`，详见[使用说明](AUTOMATION_EVENTS.md)。

## 阶段 6F：版本化便携模板与选择范围导出（beta.44）

迁移 48 记录模板版本、原始 Runtime 准入、资源撤销世代、导入回执和本机保存意图。合并迁移49后仍按缺失版本执行，真实48缺口回归保留聊天和 higher version49，并在修改前备份。复制的文件在模板CAS；SQLite只保存正文/清单和摘要，不保存二进制。模板不携带模型连接、凭据、Memory、聊天、MCP、工作区和浏览器登录态；导入创建独立对象，Skill 初始停用。

界面从聊天选项和设置通用页进入，所有内容初始不选；预览完整配置/资源/具体文件，保存版本冲突保留草稿。AI 使用同一业务校验，prepared token绑定会话/执行者/Runtime，TASK禁止导入联系人，原Runtime重试仍固定原模板版本。私有名称/正文在模型实际序列化时复查授权，不进入持久工具结果。

真实SQLite的两项fail-first已复现并修复：重复capture新建第二模板；回执失败留下已发布模板。异步CAS暂存后通过同步publish钩子，把发布与回执一起提交。取消保存回执复用；结果未知的本机保存意图不重开对话框。文件发布复用已有持有inode的writeLibraryExport，异步link期间撤权清除自有输出，不删除用户替换inode。

后续实际源码/未签名包证据补在本节；当前不把构建推断为安装包验证。证据前缀 `$CODEX_HOME/aevoren-evidence/2026-10-15/templates44-`。无新增依赖或许可，master不晋级。

补充验证记录：模板后端20项和产品/事件/原子文件回归在分批日志中通过；原子回执两项保留修复前失败证据。`templates44-focused-first.log` 为72项通过加3项测试mock递归失败；修正mock后 `templates44-focused-after.log` 三文件55项通过（含3项持有link撤权/替换inode）。新增私密序列化回归首次错误为fixture仍有活跃Runtime，已先结束该Runtime后重跑，不作为生产缺陷。Renderer精确选择、完整预览、冲突保留、版本导出和取消7项通过，日志 `templates44-ui-target-after.log`（后续目标隔离回归共9项）。

### beta.43 实际未签名 macOS 包

使用已安装且核验为 Electron44.3.0 arm64 的运行时执行标准 ASAR／afterPack 打包，没有改业务输出。实际包 Events2 与 typed API 同轮 **3/3（23.8 秒）** 通过，均验证 packaged=true／版本43；真实六成员 Webhook、所属取消、重启停止监听、TASK 元数据隐私、CAS 草稿和完整 API 命名空间均通过，拥有进程正常 exitCode=0，无强制清理。

Main SHA-256 `5b3388f97038ab07f7b747e29274bf2bb23449582c7dee014372af4fa48951ff`，ASAR `df5189c65301d6303806b9cbd4fadf5c7830624c8dfc40941b5fc4192b9d0ef4`。17 项应用输出与216项Worker／parser文件逐字节相同；随包事件指南与打包时源码相同。207 parser资产／237资源文件／9556 ASAR条目及四Helper麦克风用途声明检查通过；不作为真实硬件或签名验证。持久回执为 `event43-actual-package-first.log`、`event43-package-bytes.json`、`event43-package-parser.json` 和 `event43-package-microphone.json`。

本交付复用前阶段回归记录，并补充事件相关 70 项、9 项及最终 7 文件54项定向检查，不把它们相加为独立场景数，也未宣称新跑一轮完整普通套件。最终五配置类型、完整构建、全仓 lint、文档、开源及240包许可检查通过。平台 CI 和签名发行仍待正常门禁，公开版本按顺序晋级，master 不变。后续仅文档补充验收记录，不改变冻结的业务和包内指南字节。


## 同步 dev beta.34 的历史验收与诊断

以下记录保留 dev 的历史证据，不覆盖本文当前 beta.44 状态。

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

## MCP beta.34 integration of verified Native32 baseline

Merged exact dev `36a48730002a5a8bd7115891a99a18a7cffa792c` into the MCP34 feature branch. That baseline contains verified Native32 PR #34 merge `a84e87f` and the published beta.31 README boundary; beta.34 remains the source version. Earlier `d016c974` had four successful CI checks, and its actual 28-case unsigned macOS package receipt remains historical. Those results were not relabeled as acceptance of this newly combined Worker.

The only production-code difference from d016c974 is the BrowserEngine's opt-in, bounded, sanitized stale-frame diagnostics from `65437c8`; existing capture order, provenance checks, 409 rejection and authority boundaries remain intact. Companion changes are the focused diagnostic tests and failure-only Docker diagnostic collection. MCP/native/demo production code, approvals, private metadata, App-only visibility, migrations and Main lifecycle are unchanged. All expanded native/outbound/demo/MCP workflow selections and the eight close scenarios remain selected. Notion title updates and appends from beta.35 were not imported.

Local focused acceptance passed **15/15** (frame diagnostics 6, browser lease boundary 5, Chrome pipe/HTTP/WebSocket boundary 4), plus Browser Worker TypeScript, targeted ESLint and the Browser Worker build. Three workflow YAML files parsed with the expanded feature and close gates retained; 34-document link and diff checks passed. No full unit suite, full application build, package rebuild, Docker or real-account test was repeated. This integration needs its own new CI gate, including actual Docker and platform/package checks; the earlier Main/package evidence remains distinct from the new Worker context. Published beta.31, frozen dev, beta and master were not changed. Phase 5/6 remain unimplemented.

The MCP34 feature subsequently integrated exact dev `a8469cbad078c7ace92c607ac227c3cd648e1f5a`, whose only change from 36a4873 is the two-line, evidence-based Windows main-document compound-test budget correction already described in the beta.35 record. It retains the 3-second per-close and 1.5-second immediate-startup limits and every UI/persistence assertion. Only the affected fixture's targeted lint and diff checks were repeated; application/Worker code and the earlier focused results were unchanged. The new feature head requires fresh CI rather than inheriting d016c974's successful checks.

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


### beta.43 同步 dev beta.34

本候选合并正常已晋级的 dev `a743f7d`。冲突保留 beta.43 的较新功能、MCP 实际 Runtime 发送前授权检查、完整检查列表和版本，两侧历史回执均保存。相对已验收的 `1d3b15b`，合并只增加历史文档及四个诊断／导航夹具，不改变业务源码、共享合同、package、依赖、构建或 Worker 输出；不重建或重复宣称实包业务验收。Node 类型、定向 lint、文档／开源及工作流 YAML 检查通过；新正常 CI 仍须验证。

### beta.44 本地验收记录

最终关联后端4文件77项通过（`templates44-gate-unit.log`，同轮Renderer因新useCallback未mock失败，未把整轮误记全绿）；Renderer补齐hook后9/9（`templates44-ui-target-after.log`）通过，包含真实fail-first保存目标被历史查看意外改写的回归。独立captureTarget固定ID/version且只列当前会话owned模板，历史审阅仍可浏览其他已保存模板。完整五配置类型与构建（`templates44-build-reviewed.log`）、目标lint、文档链接、开源门禁及许可均通过。真实迁移48缺口追加表存在断言单独验证。

隐藏Electron源码最终同轮2/2（8.4秒，`templates44-hidden-source-accepted.log`）通过：typed API、UI完全未勾选默认、真实Skill资源包只选一个二进制文件、模板CAS后原目录删除、重启后nativeJSON导入、初始停用Skill、明确启用后的实际文件字节一致、只选一条消息的离线HTML保存和无preload/无Node隐藏窗口真实渲染、无HTTP访问/脚本未执行，以及自有进程正常退出。原三次fixture失败分别为子串checkbox选择歧义、Electron不支持context.newPage、未load的窗口无window事件；均修fixture，无产品/超时变更。首轮只保留原日志，后两失败trace保留在持久证据目录，不虚称已保存第一轮trace。

### beta.44 最终真实未签名 macOS 包

标准 ASAR／afterPack 打包使用已核验版本44.3 arm64 Electron 分发目录，避免重新下载；不改变打包清单或权限。实际 packaged=true／version44 包同轮 **2/2（22.6 秒）** 通过 typed API 与完整模板／导出场景，所有自有进程正常退出。源构建与包内17项应用文件、216项Worker/parser逐字节一致；随包模板指南与打包时源文档一致。Main SHA-256 `b82d0e5e1e11b686ee7d4f0e744bc680c725aa73cc7b28f38dcff2cfbf18f80f`；ASAR `c5040c5492dabad1f3b10edfeceada3dbba5b8267ffef56641186f02f7c91171`。207 parser资产、238资源文件、9556 ASAR条目和四Helper麦克风用途声明检查通过；未签名／无真实物理麦克风证据。

回执为 `templates44-hidden-package.log`、`templates44-package-bytes.json`、`templates44-package-parser.json`、`templates44-package-microphone.json`，真实48缺口表断言7项通过于 `templates44-real48-migration.log`。本次后续文档总结不重写已经冻结的包内指南；业务字节不变。Windows、真实外部账号／硬件、跨平台CI与签名发布仍待正常门禁，按dev→beta与版本顺序推进，master不晋级。未运行新的完整普通单元套件，不把77项后端加9项Renderer表述成一次全量全绿。

### beta.44 正常 CI 首轮与夹具修复

正常 CI `38833441318` Linux 完整普通单元执行记录为 **1,919通过／3失败／45跳过**，另有1项关闭SQLite后的未处理错误；不记为全绿。原始失败日志保留在 `templates44-ci-linux-first-failed.log`。两项失败是在多轮真实文件写入／读回或群下游hash校验尚处running时，夹具默认一秒轮询提前结束；workspace夹具随后直接关闭数据库，未等待所拥有Worker，产生背景任务读已关闭SQLite的未处理错误。第三项为受控Codex子进程release文件先于watch注册，夹具未消费已存在release。

修复仅修改测试：Room与duplicate-write场景等待真实终态事件，保留原五秒it期限及全部终态／hash／证据断言；所有workspace夹具Worker先awaitshutdown再关闭库。Codex夹具在watch注册后消费已经存在的release，并保留单次响应保护。最初测试事件缓存误复用旧promise，随后中间版本会丢失pendingawaiter，原失败及终止的诊断日志保留；最终采用当前状态检查加每次新建终态waiter集合，不缓存已完成promise。

最终三文件55/55（17.75秒，`templates44-ci-causes-final.log`）通过且没有未处理错误，定向lint和Node类型检查通过。不扩大任何timeout，不弱化审批／hash／authority断言，不修改生产／共享合同／打包字节，因此原真实未签名macOS包证据仍对应相同业务产物。后续正常CI按新提交验证，未取消或盲重试首轮运行，也不以定向55项代替新的完整CI。

### beta.44 第二轮正常 CI 的 Windows HTTP 诊断

正常 CI `38834434666` 的 Linux Validate/build 与真实 Docker 检查通过；Windows 普通单元记录 **1,905通过／1失败／61跳过**。唯一失败为本机 Webhook 负例集合中的 fetch `ECONNRESET`，原日志没有定位到集合内哪次请求；完整日志保留于 `templates44-ci-windows-second-raw.log`。不能由该日志推断为Memory迁移或已确定的服务端故障。

仅修测试HTTP客户端的所有权与诊断：每次请求读取实际response body到EOF后才开始下一次，并用明确阶段、实际已收到状态和安全cause code/syscall包装异常；保留错误认证、重复幂等、非法JSON/UTF-8、Origin、Content-Type、缺key、超限413、精确上限202和撤销token的全部原始断言。不忽略网络异常、不加重试、不延长Windows60秒或hook10秒期限，不修改服务端响应规则。15项本地真实HTTP/SQLite测试、Node类型及lint通过；这不证明Windows reset原因已解决，后续正常CI仍需给出结果或更精确阶段证据。已验收生产/安装包字节不变，原运行继续，不手动取消或重试。
