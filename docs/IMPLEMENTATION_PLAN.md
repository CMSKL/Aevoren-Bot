# Aevoren 功能扩展实施计划

> beta.32 当前补充：CI `38680943010` 的 Linux 普通检查通过，真实 Docker 为 39／40；六 Scope 电脑截图被原有 `BROWSER_OBSERVATION_STALE` 规则拒绝。本轮未取得成功画面，不能记为完整 Linux 门禁通过。当前补入同仓 beta.35 已验证的脱敏截图阶段诊断，保持原有焦点、版本和接管检查及调用顺序；该补丁不表示已修复错误。此前本机安装包记录先于该 Worker 补丁，后续须分别核验。

诊断候选 `1ca624d` 的本机补充验收：截图诊断／控制专项 15 项、Browser Worker TypeScript 与定向 lint、Worker 构建通过。重新打包的真实未签名 macOS arm64 beta.32 完成 23 项场景（原生读取 2、外发 5、关闭 8、Runtime 8），包括 15 次重载恢复、失败后重试、SIGKILL 恢复、关闭阻塞提示及 typed API；全部通过。两套 Worker 共八个文件及五份指南与构建输出逐字节相同。ASAR SHA-256 为 `f095741de56104676e8854fcf9d2472a4887ed0164945bb850dbdd3d035cff0a`，Browser engine 为 `9788e576cc351bcfea9e380484b33df8456582b143d0c7fac271662e1ded6e7d`。新一轮跨平台／Docker 检查仍需完成；本机没有启动 Docker 或连接真实账号。

基线为 0.3.0-beta.26。实施依据为 [功能对照](FEATURE_ADOPTION.md)，按六阶段补齐界面与 AI 能力，共用宿主校验、真实审批、执行记录、取消和恢复，保留 `@所有人` 六成员并行。产品登录注册、多人云协作、支付、完整会议助手和专属邮箱不进入首轮。

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
| 4 技能包与应用连接 | Bash/Python/Node 脚本、资源、示范草稿；Gmail/Drive/Notion、写 MCP、外发草稿与 Apps | 脚本、读取／外发和示范本机验收通过，MCP／Apps 及 Notion 更新收尾，阶段尚未完成 | 各源码／包与真实适配器证据分开记录，跨平台 CI／签名发行仍为门禁 |
| 5 多模态与语音 | 图片/PDF/DOCX/音视频；STT/TTS、实时语音、打断与转录 | 未开始 | 待补充 |
| 6 自动化、搜索与分享 | 全资源搜索、TASK 线程、分区/默认助理/头像/通知；事件/Webhook、群 Routine、模板及导出 | 未开始 | 待补充 |

## 阶段 1 交付记录：v0.3.0-beta.27

当前为候选版本，尚未发布；master 不晋级。已完成以下实现：

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

阶段 1 只完成文本资料与 Skill 能力。阶段 2 已完成开发验收；阶段 3 已完成本机与原生 Linux 核心验收，跨平台最终 CI／签名发布仍在收尾，阶段 4–6 尚未实施。未发布能力不能作为已安装产品的可用功能。

## 阶段 2 交付记录：v0.3.0-beta.28 开发候选

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

## 阶段 3 交付记录：v0.3.0-beta.29 开发候选

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

最终 native.31 本机验收：普通测试 1,487 通过、44 跳过，四套 TypeScript、lint、构建、文档、许可、开源和安全检查通过。Drive 25 项适配器测试包含仅请求绑定 ID 的网络边界、空授权零 HTTP、绑定／查询改变拒绝旧分页游标；不用账号级列表再过滤。真实 SQLite 与共享网关验证每次远端读取鲜取、撤销丢弃迟到正文，原草稿版本重试复核当前授权且不覆盖新草稿。最终未签名 macOS beta.31 包的原生连接 2 项与 typed API 1 项通过，确认 isPackaged、beta.31 与随包连接指南；较早 beta.31 包的资料库 8 项也通过。测试均采用假 provider 数据和真实本机 HTTP／IPC／SQLite，不声称真实第三方账号已经授权。跨平台 CI／签名发行仍是后续门禁。

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

隐藏源码外发五项与 typed API 一项共 6／6 通过；最终未签名 macOS beta.32 包为连接 2、外发 5、typed API 1 共 8／8 通过，实查 isPackaged、版本和随包指南。实际本机 HTTP／IPC／SQLite 的 Notion 503 已提交提示保存 unknown，重启后仅 GET 核验确认且 POST 总数为 1；审批前编辑／撤权禁用允许按钮且零外发，六群成员停止一个后另外五个完成，已经打开群聊时新宿主任务仍能精确停止。接管用户应用未参与这些测试，所有 Electron 窗口隐藏。

首次外发隐藏场景复现严格 Scope 额外参数拒绝，修正为仅会话／执行者后暴露隐藏聊天和应用页的重复审批 portal；修复实际显示归属后重跑通过，没有改用第 n 个匹配或强制点击。外发仍只验证受控服务，真实第三方账号、真实 Windows Docker、签名包另行验收；示范、可写 MCP／Apps 和阶段 5–6 尚未完成。

原生 beta.31 跨平台 fixture 收尾：新增应用设置入口后的六项导航假设修正为实际七项并保留键盘焦点断言；后一轮 Windows 两个场景在末尾诊断截图等待 30 秒失败，业务回调断言已到末尾，后续隐藏窗口断言尚未执行。仅对 Windows 不采集两张装饰性诊断截图，业务／错误／隐藏窗口断言全保留，修正 ed8675f 后仍需跨平台 CI 全通过。不能将原失败或未取得的 Windows 像素记为验收成功。


### 阶段 4：示范录制与待审阅 Skill 草稿（独立开发单元）

`codex/skill-demonstrations` 从已验证 dev 的 Script30 基线创建。Browser Worker 1.1.0 在真实接受的 WebSocket→VNC 输入转发之后解析有界分片 RFB，仅保存按钮/滚动坐标及白名单导航键；文字、Unicode 按键、修饰键和剪贴板以脱敏占位符替代，页面内容、截图和网址不进入录制。断线、epoch 变化、引擎停止、重启和 500 步上限会封存中断录制，不自动归还 AI。

宿主迁移 40 保存独立会话/执行者草稿；停止不会创建、启用、绑定或执行资料库 Skill。用户审阅固定版本与摘要后才能发布，发布结果初始停用，无脚本授权。AI 开始/停止/丢弃录制仅返回 waiting_user；草稿读写共用宿主处理器，发布采用保存的全文审批快照并在提交前重新核验版本、摘要和 Scope。完整使用与边界见[示范 Skill](SKILL_DEMONSTRATIONS.md)。

本机专项包含 13 项分片 RFB、真实鉴权 WebSocket→TCP 转发、Worker SQLite、宿主 SQLite 与请求关闭验收；合并脚本审批回归的 10 个核心文件 67 项通过，普通测试（排除等待真实 38/39 的旧连续迁移诊断命令）1,432 项通过、44 项跳过。隐藏 Electron 示范编辑／冲突／确认发布与完整 Typed API 共 2 项通过（5.4 秒），最终四配置类型检查、lint、build、文档链接、许可与安全审计通过。此开发工作树保留迁移 38/39 给原生连接与外发单元；独立完整单测中旧诊断命令要求连续迁移号，合入真实 38/39 后再验证。当前 Docker daemon 不可用，不将控制 RFB fixture 声称为 Docker/noVNC、Windows 或第三方网站实测。

示范 beta.33 集成原生连接及外发基础后，真实迁移 38、39 先于示范迁移 40 执行，连续迁移诊断三项通过；脚本、外发和示范三类固定审批保留各自严格判别分支。专项 68 项与外发／脚本回归 49 项通过，四配置 TypeScript、lint、build、文档、215 包／7 类许可、开源和安全 32 项检查通过。隐藏源码界面 17／17 通过（示范 1、资料库 8、原生连接 2、外发 5、typed API 1）。普通完整检查遇到原有计时断言超时，保留原结果后对未改变的用例复核；不能据此宣布完整门禁已经通过。

审查发现已发布示范的缓存回执可能在资料解绑／删除后仍带旧正文；修复为复核原资源、原版本及当前 Scope，拒绝已解绑／删除资源，原发布 Skill 不重复创建或自动启用。产品网关 37 项通过，含后续修改资料后仍返回原版本、解绑／删除后拒绝两项回归。修复源码重新通过四配置 TypeScript 与构建并冻结未签名 macOS beta.33 包；该包原生连接 2、外发 5、typed API 1 通过，示范 1 在纠正测试读取随包指南的方式后通过，实查 isPackaged、版本与指南正文。最初指南测试在 Electron evaluate 内动态 import 不被支持，改为查询实际 Resources 路径后读取；应用和包均未为此重建或修改。

最终完整普通测试记录为 1,540 通过、45 跳过、6 失败：五项原有 5 秒超时（CDP 1 MiB、群聊 20 轮、FIFO 20 轮、工具混合指令循环、诊断参数循环），一项 lead-room 在轮询期限内仍为 running。对应未修改的六个文件单 Worker 复核 128／128 通过，未提高超时或减少断言；保留完整失败证据，远端完整 CI 仍须独立通过，不能把分次复核改记为一次完整全绿。

真实 Linux Docker 集成测试已加入现有浏览器套件，走实际 x11vnc 的 RFB 握手、页面点击、文字／剪贴板脱敏、断线封存、容器重启、旧 epoch 拒绝和归还后重新观察。该测试将在 Linux CI 的真实容器门禁执行；本机 Docker daemon 未启动，本机结果为跳过，不算真实 Docker 已验收。示范单元不代表阶段 4 全部完成，可写 MCP／交互 Apps 以及阶段 5–6 仍待交付。

## 阶段 4 MCP／Apps：v0.3.0-beta.34 候选

迁移 41 接在真实 38／39／40 后，按 Scope 保存工具授权、固定参数／目标审批及持久调用账本。配置、凭据与格式变化使授权失效；移出再加入不能恢复旧参数。host-mcp Runtime 支持六成员先启动，单成员停止／撤权不影响兄弟任务；HTTP 写调用不自动重授权重放，已结束意图只查询回执。

隔离 App 使用独立 loopback 外层及 opaque 内层。App-only 工具不进入模型和旧只读路径；协议 _meta 仅在宿主及已授权 App 之间传递，公共回执、模型和日志剥离顶层 _meta，保留同名嵌套用户数据。模型打开操作返回 waiting_user，不暴露视图 URL。一个活跃 Scope 的原生／MCP 审批由同一组件持有。支持范围见[MCP 工具与 Apps](MCP_APPS.md)。

初次隐藏验收复现 Renderer CSP 阻止 loopback iframe，修正窄 frame-src 后 MCP 3 与 typed API 1 共 4 项通过，原生外发回归 5 项通过；含真实隔离 frame、父级／Preload 拒绝、实际 App 调用审批、撤权关闭、未知取消及原生→MCP 审批交接。后续私有 metadata／app-only 回归与能力检查 19 项、Node 类型及针对性 lint 通过。上述早期源码回执为 Source33；Source34 最终构建、完整普通测试及安装包验收单列，尚未完成。

脚本 beta.30 的合并提交 93bd211 已全部验收并建立不可变标签。签名工作流 38591554270 在 Mac 普通文件系统测试发生只读目录 rename EACCES，未创建公开 Release。修复 39e12da 保持 staging0700 到 rename 后再固定0550；原代码确定性回归失败、修正后10项通过，不放宽最终只读权限。修复进入后续 Beta，旧标签不移动。

MCP beta.34 最终源码包含 metadata 私有投影、App-only 路由、统一 Apps 审批持有者及快照发布修复。完整普通测试单 Worker 1,565 通过、45 跳过；四配置 TypeScript、lint、build、文档、215 包／7 类许可、开源及安全审计通过。隐藏源码 MCP3／示范1／typed1／外发5／读取2 的不同场景均通过；读取回归最初因新增 MCP 范围说明与原生说明文字重复而严格匹配失败，收窄到真实“聊天应用”区域后两项通过，未使用第 n 个元素或减少业务断言。最终安装包仍在验收。

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



### beta.33 外发重启关闭诊断（未发布）

PR #43 的 [Windows 检查 38707578493](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38707578493) 在源码 35 项中通过 34 项；外发未知结果场景已确认一次提交和 unknown 状态，但首次重启的关闭夹具失败，第二次启动及只读核验尚未到达。原 trace 只有关闭调用和夹具错误，没有该进程的退出／管道状态或 Main 关闭阶段，不能确定是产品关闭、进程退出还是继承管道未释放。

本次仅在外发测试夹具增加有界诊断，缓存其确切 ChildProcess，记录 PID、exit／close 事件、退出码、信号和 stdio destroyed 状态，并复用已有的 Main flush／可信确认／窗口关闭阶段；每个进程最多 120 条，重启和清理调用无论成功或失败均附 JSON，随后移除监听。没有修改产品、关闭辅助函数、时限或业务断言，也没有重跑原失败任务。

新构建的本机隐藏 beta.33 源码场景 1／1 通过，第一次关闭约 191 ms、最终清理约 52 ms，均有可信 flush 确认、exit 0、全部管道关闭且未强制终止。四套 TypeScript、正常构建和定向 lint 通过；没有重跑完整套件或打包。该本机成功不证明 Windows 根因已解决，新的正常 CI 将提供该平台的诊断证据。


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
