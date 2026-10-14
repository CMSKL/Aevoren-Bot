# Aevoren 功能扩展实施计划

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
| 1 资料库与文本 Skill | 持久资料、版本、文本检索、绑定；SKILL.md 导入、启停、结构引用、按需加载 | 源码和跨平台包验证通过；签名包 fixture 超时待修复，未公开发布 | dev／beta 已晋级；签名失败的实际记录见阶段 1，不把未签名包当官方发行 |
| 2 执行环境 | Docker 探测、镜像、Worker、生命周期；命令与输出、文件、后台进程、日志与端口 | beta.28 开发候选；本机／源码 UI／最终未签名 macOS 包通过，签名发布待完成 | 33 项专项无跳过通过，含 18 项真实 Docker／AI 工具链；源码隐藏 Electron 3 项、最终未签名包 3 项通过；Windows 真 Docker 待验证 |
| 3 浏览器与电脑 | 独立 profile、Playwright、截图图像传输、noVNC 接管及服务预览 | beta.29 开发候选；源码与最终未签名 macOS 包验收通过，跨平台 CI／签名发布待完成 | 21 项 Worker／代理专项、4 项真实 Host、23 项图片／CLI 生命周期，完整单元 1,355 通过；最终包 13 项通过，未签名包不作为官方发行 |
| 4 技能包与应用连接 | Bash/Python/Node 脚本、资源、示范草稿；Gmail/Drive/Notion、写 MCP、外发草稿与 Apps | 未开始 | 待补充 |
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

阶段 1 只完成文本资料与 Skill 能力。阶段 2 已完成开发验收；阶段 3 的浏览器／电脑进入联调，阶段 4–6 尚未实施。未发布能力不能作为已安装产品的可用功能。

## 阶段 2 交付记录：v0.3.0-beta.28 开发候选

开发分支为 `codex/docker-execution`，从已验收的 `dev` 创建；源码版本为 `v0.3.0-beta.28` 开发候选。当前未晋级 beta、未正式发布，master 不晋级。

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
| 分支与发布 | [PR #22](https://github.com/CMSKL/Aevoren-Bot/pull/22) 的[最终 CI](https://github.com/CMSKL/Aevoren-Bot/actions/runs/38511154615) 四项全绿，已合入 dev `752a50e`；[Beta PR #23](https://github.com/CMSKL/Aevoren-Bot/pull/23) 正在验证。正式签名发行待完成；不得把候选文档当已发布版本 |

镜像 base manifest 固定为 `node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`，实际构建 digest／平台保存在环境记录。Docker 由用户提供，首期保持同一个本机 context，不挂宿主 HOME、Docker socket 或浏览器 profile。Worker 保留对外网络，审批过的命令仍可能产生外部副作用；执行目录不代替容器隔离。镜像内 Node／Python／Debian 工具各自保留许可，见[执行环境与镜像说明](EXECUTION_ENVIRONMENT.md)。

本阶段没有交付 BrowserSession、桌面／截图／图像传输、接管、服务预览、可执行 Skill 包、应用连接或语音；这些继续按阶段 3–6 实施。首期命令界面不提供交互式 PTY。

## 阶段 3 交付记录：v0.3.0-beta.29 开发候选

从 dev 基线创建 `codex/browser-computer` 并纳入已验证的阶段 2；当前源码与镜像已经构建，尚未作为第三阶段正式发行。

后续跨平台检查确认 Linux Docker 网络接入会重新分配 published port，宿主端口重新核验修复已经通过原生 Linux CI。补充桌面复核发现 Playwright 模拟焦点会导致截图 pageId 与实际标签页不一致、旧截图可输入，当前正修复并等待新 Worker／包回归；之前包的通过记录不代替此修复验收。签名测试隔离与 Windows 清理修复 [PR #24](https://github.com/CMSKL/Aevoren-Bot/pull/24) 已四项 CI 全绿并合入 dev `6c99b7b`，Beta.28 晋级／签名发布继续独立进行。

- 迁移 36 保存 BrowserSession、页面／观察／控制 epoch、下载、截图引用与服务预览，使用原应用 SQLite；真实会话／执行者边界贯穿界面、AI、Worker 与媒体读取。
- 27 个共享 `browser.*`、`computer.*`、`preview.*` 操作，独立 Chromium 持久 profile、Xvfb/Openbox/x11vnc/noVNC，浏览器登录卷和控制密钥不暴露给执行 Shell。
- AI DOM／桌面操作要求当前 epoch 和新鲜观察；用户接管撤销旧图片与连接，断线或关闭面板不自动归还。只有明确归还且收到真实确认后恢复 AI；旧控制意图在后续接管／归还后不能再次改变归属。
- PNG/JPEG 真字节经 API、Claude MCP 和受支持的 Codex app-server 输入传输；发送前复验授权与活跃 Runtime，Tool Journal 不存 raw pixels。只证明传输，未把 fixture 当真实云模型视觉理解。
- Execution Worker 1.1.0 增加固定目标 HTTP／WebSocket 预览，256-bit 票据使用两段 32 hex DNS label，绑定原登记任务 UID／process／port。原任务退出或端口复用会撤销旧入口和已有 WS，不转发到新进程。
- 同 nonce 使用原 tab／预览／写入回执；取消封闭迟到操作，不取消兄弟页或独立后台服务。明确重建切换当前 Worker／伴随镜像，普通休眠保留旧镜像与卷，不自动重放未知副作用。
- 联系人和群成员浏览器／电脑页提供实际状态、浏览器读写、下载、接管／归还与登记服务预览；不控制宿主 GUI，不复制现有浏览器 cookies。

| 验证项 | 当前状态与证据 |
| --- | --- |
| 完整本机单元／质量 | 1,355 通过、35 跳过；Node/Web/执行 Worker/浏览器 Worker TypeScript、ESLint、构建、许可／文档／开源／安全检查通过，跳过的 Docker 场景单独启用验证 |
| Worker／代理实际专项 | 21／21、无跳过：8 个真实 Chromium Docker、7 单元、4 localhost HTTP／WS 单元、2 实际代理 Docker；包含六环境同时启动、实际桌面／RFB、profile／Shell 隔离、旧端口复用失效、SPA 绝对路径与 WS |
| 真实 Host／AI 工具链 | 最终 4／4、无跳过：真实 JPEG、Scope、接管、审批、旧回执、Runtime cancel、兄弟页／后台保存；最早一次首启短暂 BROWSER_UNAVAILABLE 原因未确定，后续三次首启正常，保留仅 route/code/OOM 的测试诊断 |
| 图片／CLI 生命周期 | 23／23 通过，验证真实 localhost API payload、MCP 图片块、实际版本 JSON schema 下的 Codex inputImage、过期授权和同 ID 重放；未调用用户真实云模型 |
| 隐藏界面／安装包 | 原 Runtime／200% 缩放／窄屏 14 项通过，真实 Browser 源码 2／2 通过；最终未签名 macOS beta.29 包 13／13（资料库 8、真实环境 3、真实 Browser 2）通过。实查 isPackaged、版本、两套 Worker Resources 与说明文件；RFB 输入采用实际物理键保持／Shift chord，fixture 持久 cookie／真实 listener 就绪与精确清理均保留 |
| 平台／发布 | macOS arm64 与 Linux Docker 真实专项已有证据；Windows Linux Docker 仍未验证；本阶段未晋级或签名发布，master 暂不晋级 |

使用、镜像与边界见[浏览器与电脑说明](BROWSER_COMPUTER.md)。阶段 4–6 仍按顺序实施，不据此声明脚本 Skill、应用连接、多媒体解析、语音和全资源任务能力已完成。

真实焦点修复采用应用自启的隔离 Chromium、私有调试管道与随机能力地址的 loopback WebSocket 桥，再用公开 `connectOverCDP(noDefaults: true)` 保留浏览器真实焦点。原始 Chrome HTTP 调试端口的网页关闭标签页风险已在隔离 probe 中复现并排除；新方案已实证拒绝 HTTP／未知地址／网页 Origin，仍保留真实 CDP 下载事件和文件字节。产品集成与最新 Worker 验收尚在进行，不能把 probe 作为最终包通过证据。

新管道首轮专项 28／30 通过：真实焦点、原生 RFB、旧截图拒绝、同点点击、下载与桥接单元已过；cookie 重启保存和六环境截图两项失败仍在修复。旧包的 13 项通过记录保留为先前证据，最新实现须在修复后重跑。

后续 cookie 持久化通过真实浏览器协议关闭修复；本机剩余八个真实 Docker 场景与 21 个单元共 29 项通过。六环境场景未通过：六个均先到启动屏障，随后多个容器 OOM；截图子进程已实证仅一线程且 RSS 不超过约 12.5 MiB，Docker VM 总内存约 3.83 GiB。未修改 VM、容器内存限额或超时；六并行完整断言继续在原生 Linux CI 启用，并增加仅自有容器的 cgroup memory.events/peak 与进程名/RSS 诊断，以区分单容器限额和整机压力。此处不把本机失败算通过，也不声称更大 VM 必然解决。

## 阶段固定实现与完成条件

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
