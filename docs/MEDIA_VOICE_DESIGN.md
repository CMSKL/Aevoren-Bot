# 阶段 5：媒体与语音实施备忘

**状态：设计准备，阶段 5 尚未实现。** 本文补充 [实施计划](IMPLEMENTATION_PLAN.md)，不代表已发布能力。
阶段 4 跨平台最终检查通过、最新实现合入开发基线后，按 5.1 → 5.2 → 5.3 开发；继续 dev → beta，master 暂不晋级。
沿用聊天、联系人、设置、主题、图标及现有产品目录、审批、Runtime、取消和群并行机制。

## 5.1：应用拥有的媒体、文档与图片

- 保留现有 `MediaRef = { id, name, size, mimeType, sha256 }`；原始字节不可修改，替换文件产生新记录。
- 媒体记录、绑定和解析记录存 SQLite；字节存应用私有 CAS。来源路径不进入公共记录、提示词或 AI 结果。
- 授权按会话绑定；AI 每次访问另验 `assertSessionExecutor(sessionId, executorBotId)`。群共享用户选入的群资料，不继承成员私聊绑定、Skill 或浏览器状态。
- 字节去重不共享授权。删除、禁用、解绑或成员移出阻止后续读取；修改 Document 正文不撤销正在运行任务的固定版本。
- 导入先暂存实际字节，核验格式、摘要和解析结果，再提交记录与绑定；取消不发布半成品。原目录删除后仍可读取。
- `MessageMediaReference` 固定 `mediaId + sha256`，需要解析正文时再固定 `extractionId + extractionDigest`；Host 从记录重建元信息，不信任调用者声明的 MIME、大小或路径。
- 解析记录固定来源摘要、解析器名称/版本、文本摘要、警告及创建时间。解析正文不可变；用户编辑可明确另存现有 Document，复用其版本与冲突处理。
- `SendCommand.mediaRefs` 同时进入 Transcript、私聊 nonce 摘要、群路由摘要、固定发送记录及 `PromptManifest`；成员重试不得换成最新解析版本。
- 相同 nonce 携带不同原始/解析引用必须冲突。允许媒体非空而正文为空，并检查数据库提示词筛选和会话摘要，避免丢弃纯媒体消息。
- UI 导入/选择/查看/移除、AI `media.*` 共用业务层；选择文件仍通过可信界面或已授权工作区，AI 不能提交任意宿主路径。
- 复用 `LibraryService` 的读前/读后权限检查与 CAS 防链接替换模式；不要全局提高 Skill/文本资料的 1 MiB 文件上限。
- 图片沿用 `ModelImageAttachment` 的实际像素与 `isAuthorized()`，通过 API、Codex、Claude 宿主工具桥传递；持久回执只存引用，不存 Base64 或授权闭包。
- 优先让当前任务通过 `media.read` 获取授权图片；若支持直接用户图片输入，须同时补齐三个来源的初始消息传输。传输支持与所选模型视觉理解分开标识。
- PDF/DOCX 返回分页文本及预览；扫描页没有文字时明确无 OCR。路径、占位图和模拟工具结果不算视觉或解析支持。

以下均为首轮**实现决策**，不是模型或供应商承诺：

| 对象 | 首轮范围与预算 |
| --- | --- |
| 图片 | PNG/JPEG，每张 ≤2 MiB，解码 ≤16 MP；不执行 SVG/HTML |
| PDF | 每份 ≤16 MiB、≤200 页；密码保护或无法解析时明确失败 |
| DOCX | 每份 ≤8 MiB；拒绝加密包、宏格式和伪造内容类型 |
| ZIP 预算 | ≤2,000 条目，单条目展开 ≤16 MiB，合计 ≤64 MiB；声明与实际输出都检查 |
| 一次导入 | 最多六份，合计 ≤32 MiB；现有文本附件限制保持独立 |
| 解析 | 每任务 30 秒硬超时；UTF-8 正文 ≤512 KiB；超限不静默当作完整内容发布 |
| AI 读取 | 默认 12,000 字符、最多 32,000，提供总量和后续页位置 |

### 解析器与打包

已从官方发布元数据及包内源码核验，实施时精确锁定并重新执行依赖审计：

| 包 | 版本 | 许可与用途 |
| --- | --- | --- |
| [pdfjs-dist](https://registry.npmjs.org/pdfjs-dist/6.4.299) | 6.4.299 | Apache-2.0；PDF 文本、受限页渲染；Node ≥22.13 或 ≥24 |
| [mammoth](https://registry.npmjs.org/mammoth/1.13.0) | 1.13.0 | BSD-2-Clause；浏览器 `extractRawText({ arrayBuffer })` |
| [@zip.js/zip.js](https://registry.npmjs.org/@zip.js%2fzip.js/2.23.0) | 2.23.0 | BSD-3-Clause；有界 ZIP 检查与规范化 |

- 解析使用专用隐藏 Electron sandbox Renderer、非持久 session、无 Node/主应用 Preload；Node worker 或 utility process 单独使用不等于安全沙箱。
- 采用独立 `media-parser.vite.config.ts`；构建 HTML/资产，再以单入口、内联依赖的 CJS 构建窄 `preload.cjs`。不把主 Preload 改为会产生共享 require chunk 的多入口。
- 窄 Preload 只导入纯 channel 常量和类型，不导入 Zod/业务运行时；Main 验证 exact sender、mainFrame、预期页面 URL、job nonce、资源摘要和有界结果。
- 开发也使用本地构建的解析页，不允许整个 Vite origin、`/@fs`、任意 `file://` 或第三方 URL；开发命令先构建 parser。
- 参照现有 Worker 输出 `out/media-parser`，从 ASAR 的 `out/**/*` 中排除并整体作为 `media-parser` extraResource；不改现有执行/浏览器 Worker，不在签名后生成文件。
- manifest 确定性记录应用/parser/PDF.js 版本及入口、相对路径、MIME、大小、SHA-256；将 Main 专用 Preload 与可供页面读取的资产分开，不公开 manifest/Preload。
- 专用标准安全协议仅服务 manifest 精确清单，在 parser session 注册；不启用 `bypassCSP`。外部网络、任意本地文件、导航、新窗口和设备权限均拒绝。[Electron 协议](https://www.electronjs.org/docs/latest/api/protocol)
- 从同一精确 PDF.js 依赖复制 Worker、`cmaps/`、`standard_fonts/`、`wasm/`；显式建立 module Worker 并设置 `GlobalWorkerOptions.workerPort`，不用 CDN。[Vite 资产导入](https://vite.dev/guide/assets)
- PDF `getDocument` 只收字节及固定本地资源 URL，设置 `stopAtErrors:true`、`enableXfa:false` 和像素预算；不实例化脚本管理器/通用 Viewer。6.4.299 已无 `isEvalSupported`，不能沿用旧参数。[PDF.js API](https://mozilla.github.io/pdf.js/api/draft/api.js.html)
- CSP 只开放必要本地脚本/Worker/字体；若使用打包 WASM，使用 `wasm-unsafe-eval` 而非 JavaScript `unsafe-eval`。取消调用 loading task `destroy()` 并销毁所属解析窗口/Worker。
- 保留 PDF.js 主许可、`cmaps/LICENSE`、`standard_fonts/LICENSE_*`、`wasm/LICENSE_*`；许可生成器补充内嵌资产说明，正常生成 notices/SBOM，不把 npm 包标识当作全部资产许可。

### DOCX 的 ZIP/XML 边界

- 用 zip.js 原生浏览器入口，`useWebWorkers:false`、`useCompressionStream:true`；只接收存储/Deflate。实测 Electron 对 `deflate-raw` 的支持，不静默换解码实现。
- `ZipReader` 用 `strictness:"strict"`、`filenameValidation:"strict"`，先用 `getEntriesGenerator()` 检查目录、数量、声明尺寸和普通 OOXML 类型，再顺序解压。[目录 API](https://gildas-lormeau.github.io/zip.js/api/classes/ZipReader.html)
- 在 `WritableStream.write()` 中先检查实际字节预算再保存，传递 AbortSignal，检查 CRC、本地头、重叠及实际/声明尺寸；不要依赖进度回调抛错实施安全限制。[读取选项](https://gildas-lormeau.github.io/zip.js/api/interfaces/EntryGetDataOptions.html)
- 拒绝重复、绝对、越界路径及非法名称；只将已核验条目重建为唯一名称、无压缩的临时规范 ZIP，再交给 Mammoth，避免两个 ZIP 解析器对原包解释不一致。
- XML/`.rels` 先严格解码再检测 DTD；首轮接受 UTF-8、UTF-16LE/BE，拒绝其他声明编码、非法编码、DOCTYPE、ENTITY 和 XML 错误，规范为 UTF-8；不能只扫描原始 ASCII 字节。
- Mammoth 采用 browser 映射，外部文件读取适配器拒绝链接文件；宿主和协议层仍禁止外部资源解析。超链接最多作为不可信文本，不自动抓取或注入转换 HTML。[源码及安全说明](https://github.com/mwilliamson/mammoth.js#security)
- 导入超时、取消或崩溃不得发布解析记录；只终止所属任务。内存采样属于补充防护，不能声称等同 OS 硬内存上限。

### 首交付分工与验收

| 负责人 | 独占工作 |
| --- | --- |
| Root | 先固定合同；共享 schema/channel/catalog、数据库迁移与发送摘要、Room/Prompt/Runtime、Main IPC/gateway 集成 |
| 存储 Agent | 新媒体 CAS、Repository/Service、事务/绑定/不可变解析记录及真实 SQLite 测试 |
| 解析 Agent | 隔离解析器、专用 Preload、构建/依赖/manifest/许可与生产解析器测试 |
| UI Agent | 选择/预览/移除、纯媒体发送、会话切换/迟到结果处理和隐藏 UI QA；公共 Preload 接入与 Root 顺序集成 |

Root 固定合同后再并行；同一时刻由一人编辑 `database.ts`、gateway 或公共 Preload。避免新增通用资源框架。
验收包括旧库升级、移动来源后读取、nonce 冲突、固定重试、跨会话隔离、撤销期间迟到结果、六成员先全部启动及单成员取消。
用小型确定性 PDF/DOCX 验证真实解析、文本/像素、字体/CMap/WASM；覆盖扫描件、DTD/UTF-16、损坏 CRC、歧义 ZIP、压缩炸弹、网络/文件诱饵、取消/崩溃。
macOS arm64 与 Windows x64 的实际安装包均验证资产、独立解析进程和 API/Codex/Claude 的真实像素传输；不以模拟返回替代。

### 5.1 集成核对点（代码修改前清单）

- 固定内容引用与授权准入分开：公开引用为 `{ mediaId, sha256, extraction?: { id, digest } }`；宿主保存独立绑定 incarnation。原发送事务保存所选引用的原准入；Runtime 建立时快照会话内可用媒体，所选引用必须覆盖为原发送准入。重试不能换成重绑后的 incarnation。UI 读取另捕获当前租约，异步读及实际传输重验。
- `runtime_media_admissions` 限定此用途，只有创建 Runtime 和批准导入的新记录可写入；不提供通用 upsert。已有媒体的绑定／重绑只供后续 Runtime，审批回执重放不刷新旧准入。批准导入可在同一事务将本次新建媒体 ID 准入当前仍有效的 Runtime；CAS 字节去重不把既存媒体记录变成新记录。
- 导入先准备全部有效文件并收集明确失败项，再用一个 SAVEPOINT 发布有效集合及其解析、绑定和允许的新导入准入；提交前取消则该集合全部不发布。无静默正文截断。PDF spans 对应真实页；DOCX 对应文本分节，不承诺物理分页或版式还原。PDF 页预览按需生成有界派生图，使用独立图片 SHA，保留原文件引用不变。
- `shared/contracts.ts` 的 `SendCommand`、`TranscriptEntry`、`CreateRoomRunInput` 与 `shared/product-view.ts` 的草稿操作一起增加固定媒体引用；公开 Transcript 只含引用，不能带解析正文、原始字节或主进程授权闭包。
- `shared/schemas.ts` 当前 `sendCommandSchema.text` 为非空，且群 Schema 由其扩展。改为允许空文本并在对象级检查文本／附件／资料／媒体至少一项；保留 `.extend()` 的组合能力，分别验证私聊与群路由，不能仅修 UI 按钮。
- `main/database.ts` 的 `digestMessage` 与 `digestRoomCommand` 在媒体为空时必须保持旧摘要字节一致；增加媒体引用后，同 nonce 的不同原图或解析版本应冲突。私聊及群的 prepare 路径都在同一事务写入引用。
- `main/database.ts` 现有非空用户正文筛选有迁移 SQL 和运行时查询两处。新迁移重新建立受影响触发器／视图，运行时筛选同时接受媒体，覆盖纯媒体用户消息及重启恢复，不能改写已发布迁移。
- `main/runtime-executor.ts` 当前只在本轮用户条目加入 `resourceContents`；媒体固定版本在相同位置解析当前会话及执行者权限，避免把历史所有媒体或其他成员私聊媒体一起加载。
- `main/prompt.ts` 当前最高 Manifest 版本为 5；媒体元信息、原始摘要和所选解析摘要形成不可信数据块并进入新版本 Manifest。图片模型调用仍由实际像素传输验收，文本块只证明引用和来源。
- `main/model-image.ts` 已校验 PNG/JPEG 字节、摘要与即时授权，但回执文字使用“工具画面／旧画面”。媒体复用时补充准确来源文案，保留浏览器的 epoch 与授权检查，不能将普通上传伪装成浏览器观察。
- `main/library-blob-store.ts` 固定每文件 1 MiB。媒体使用独立预算与私有目录，沿用逐文件身份／摘要核验，不修改文本 Skill 的上限或把调用者路径作为 CAS key。
- AI 第一批操作拟为 `media.list/read/importPath/bind/unbind/delete`；可信文件选择为独立 `pickImport` IPC。预览页只读取宿主已授权的有界字节；解析任务绑定发起会话、nonce、摘要与取消信号，不能借解析页获得主应用能力。
- 三来源首批以 `media.read` 工具返回图片走实际像素通道；当前 API 初始消息、Codex `turn/start` 和 Claude stdin 仍是文本，不能仅增加发送引用便声明直接初始图片支持。能力快照独立报告媒体传输与模型模态，不依赖浏览器启动状态。
- 媒体读取加入 `ProductOperationService` 的 scoped 路由与只读集合，绕过普通永久工具回执缓存。模型派发前再次检查原绑定版本、Runtime、当前成员及删除／撤销状态；解绑再绑定不能使原任务读取复活。解析正文同样需要来源与即时授权，不能作为无来源普通工具文本永久留在后续 API 对话或 MCP 同 ID 重送中。已发送到供应商的内容不能由本地撤销收回。
- 实施时采用窄用途的宿主文本授权回调，与现有图片 side channel 并列：`ProductOperationService`／工具 Coordinator 只在内存传递；`ChatMessage` 的工具条目携带该回调；API 序列化先检查并从线上 JSON 去除回调字段；`ModelToolResponder.respond` 的可选第三参数传至 Codex 和 Claude。Claude 现有同请求 ID 缓存保存渲染闭包，须在每次渲染时重验；Codex 在实际答复时检查。授权失效返回固定提示并移除正文／图片，不能写入永久回执。扩展现有图片线协议测试验证三个来源，不另建通用数据权限框架。
- 特别注意 `WorkspaceToolExecutor.completeProductToolInvocation` 会持久保存 `result.content`。因此 `media.read` 的 `content` 从一开始只含引用、分页及摘要；正文用独立 `ModelTextAttachment { text, isAuthorized() }` 传递至两条 Coordinator 分支和 Runtime，仅在实际模型序列化／CLI 回答时与安全元信息合成。不能先把正文放进 `content` 再仅增加 guard，否则已进入永久回执和 shadow 记录。
- 导入／解析归属 `MediaService` 的任务集合；Main 正常退出先取消并等待所属解析窗口和任务结束，再关闭数据库。关闭后、超时、撤权、取消或迟到的解析结果都不得提交媒体与绑定；CAS 中无记录引用的暂存字节不算已发布资料。

这些是已核对源码的集成位置与拟定合同，仍不表示阶段 5 已编码或验收。

## 5.2：音视频引用、转写与朗读

- 复用媒体 CAS/会话绑定增加受支持音视频引用与本地预览；明确实际 codec 限制。视频预览不等于模型理解视频。
- STT、TTS、Realtime 各自独立配置 provider/model/key；密钥留在宿主 SecretCodec，可信设置 IPC 写入，不复用 Bot 密钥或向 AI 返回凭据。
- 普通转写/朗读继续使用当前 Bot Runtime 承接业务任务。音频任务记录源媒体/消息摘要、配置版本、scope、nonce、状态和结果；崩溃不自动重放未知调用。
- OpenAI 参考 STT 为 `/v1/audio/transcriptions`；已录音文件与实时输入是不同路径，当前指南推荐 `gpt-transcribe`。供应商上限 25 MB；本地限额另行明确。[文件转写](https://developers.openai.com/api/docs/guides/speech-to-text)
- 文件流式转写处理 `transcript.text.delta` / `transcript.text.done`。局部文字显示在独立转录状态，不覆盖输入框。
- 插入转写须同时匹配捕获 session、captureId、单调递增 draftVersion 与 baseDigest；防止草稿 A→B→A 后旧结果误插。冲突时保留转录供用户主动插入。
- TTS `/v1/audio/speech` 返回真实音频；参考 `gpt-4o-mini-tts`，模型/音色由显式配置决定。PCM 为 24 kHz、16-bit signed little-endian。[朗读接口](https://developers.openai.com/api/docs/guides/text-to-speech)
- 群模型任务保持并行，朗读按回复完成顺序排队。停止立即停止播放、丢弃所属队列/迟到片段、取消对应生成并释放资源；不重放已外发的业务操作。
- UI 显示 AI 合成语音身份；源条目修改/撤销、会话切换和重启后的播放恢复均有明确状态，不自动开麦。

## 5.3：Realtime V1 与宿主委派

- 固定适配协议为 `realtime-v1`，连接 `wss://api.openai.com/v1/realtime?model=...`，处理 `session.created` → `session.update` / `session.updated`。
- 当前部分文档默认展示 GPT-Live：`/v1/live/sessions`、`session.start` / `session.started` 属于另一协议；不混用、不自动迁移模型或配置。[Realtime 分支](https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime)
- 使用嵌套 `session.audio.input/output.format = { type:"audio/pcm", rate:24000 }`，不照搬旧版扁平格式字段。实际采集样本须下混/重采样到约定格式，不能只相信设备请求值。
- 输入 `input_audio_buffer.append`；手动分段 commit 后 `response.create`。输出字节来自 `response.output_audio.delta`，不是 `response.done`。[会话事件](https://developers.openai.com/api/docs/guides/realtime-conversations)
- `response.cancel` 的终态是 **`response.done` 且 `response.status="cancelled"`**，不等待 `response.cancelled`。[事件参考](https://developers.openai.com/api/reference/resources/realtime/client-events#response.cancel)
- 打断立即停止本地音频，按实际已播放样本/播放时钟计算 `audio_end_ms`，发 `conversation.item.truncate` 并处理确认；收到字节量不能代替播放量。[截断参考](https://developers.openai.com/api/reference/resources/realtime/client-events#conversation.item.truncate)
- VAD 的 `create_response` / `interrupt_response` 独立处理；只静音不代表取消后台业务。[VAD](https://developers.openai.com/api/docs/guides/realtime-vad)
- 语音模型只配置有界宿主委派函数；Main 固定当前 session/executor，持久化 voice session/turn/call_id、参数摘要、确定性 nonce 与关联 Runtime，再走现有私聊/群发送及工具审批。
- 保存口述转录与模型委派参数的不同来源；不能伪造现有 `DelegationOrigin` 所需的父 Runtime，须新增经宿主校验的语音触发来源，不能把模型参数当成人类批准。
- 完成后以原 `call_id` 返回 `function_call_output` 再创建语音回复。取消只影响所属任务；外发已 dispatch 的结果仍按 unknown/只读核验处理。
- 断线关闭输入与播放；恢复时重新检查配置/授权，不自动重发工具或恢复麦克风。

## 麦克风与实际支持边界

- 5.2 开麦前修改当前会删除麦克风描述的 `build/after-pack.cjs`，保留 `NSMicrophoneUsageDescription`；为实际采集的签名进程配置 `com.apple.security.device.audio-input`，检查最终 App/Helper。[Apple entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)
- macOS 由明确用户操作触发媒体权限；拒绝后显示真实状态，不循环请求。[Electron 媒体许可](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesaskformediaaccessmediatype-macos)
- 同时实现 permission request/check handlers，仅允许确切应用 WebContents、主 frame、预期 URL、当前用户捕获 intent 的 audio；拒绝 camera/display-capture、预览、第三方 App 与子 frame，不能仅凭 origin 为 `null` 放行。[Electron session](https://www.electronjs.org/docs/latest/api/session)
- 本阶段尚无真实云语音账号、硬件麦克风、实时音频或 Windows 安装包/其 Docker 环境验收。将来缺少真实凭据或设备时标为未验证，不以 fixture 通过补写真实支持。
- 本文不安装依赖、不启用麦克风，也不表示阶段 5 已开始编码；阶段 4 门禁及更新基线先完成。
