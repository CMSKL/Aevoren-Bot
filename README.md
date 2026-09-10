# MS-Bot

MS-Bot 是一个本地 macOS Electron 应用。当前开发版在 P0-A 对话闭环之上增加 P0-B Runtime：每次模型调用具有独立、持久化的运行状态，Renderer 重载可重新附着，取消和重试具有明确的安全边界。

## 当前范围

已实现：

- Bot 创建、列表、切换；
- 名称、标签、描述和 Instructions 的版本化保存；
- 每个 Bot 一个 MAIN Session；
- SQLite Transcript 与 Send Journal；
- 稳定 Nonce、Body Digest、Duplicate/Conflict 和中断恢复；
- Fake Provider 与 OpenAI 兼容流式 Provider；
- 模型设置和 Electron `safeStorage` 加密；
- 取消、失败和 Interrupted Unknown 状态；
- Runtime Run、Provider Request ID、Prompt Manifest 和单调 Transcript Cursor；
- Renderer 重载后的 Snapshot/事件版本合并；
- 幂等运行取消，以及失败、取消或中断后的显式重新生成；
- Provider 连接、首事件、流空闲、总运行超时和截断识别；
- 结构化错误域与跨 IPC 允许字段注册表；
- Electron 安全 Preload 和类型化 IPC；
- Unit、Integration 和 Playwright Electron Smoke Test。

Room、Memory synthesis、Summary、Routine、Plugin/MCP、Local Exec、Computer Use 和 Cloud Computer 不在 P0-B 范围。

## 开发环境

- macOS arm64
- Node.js 24+
- pnpm 11

安装依赖：

```bash
pnpm install
```

使用 Fake Provider 启动完整本地闭环：

```bash
MS_BOT_FAKE_PROVIDER=1 pnpm dev
```

使用真实 OpenAI 兼容 Provider：

```bash
pnpm dev
```

启动后进入“模型设置”，填写 Base URL、Model ID 和 API Key。API Key 只在 Renderer 输入期间短暂存在，保存后由 Main 使用系统安全存储加密；应用不会把明文 Key 返回给 Renderer。

## 验证命令

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:smoke
```

一次运行全部静态和单元验证：

```bash
pnpm validate
```

## 数据与安全

- SQLite 数据库位于 Electron `userData` 目录；
- 数据库 v2 会事务化增加 Runtime 表和 Transcript Cursor；旧 Transcript 不会被推断为不存在的 Runtime Run；
- P0-A beta 与 P0-B 并行验证时必须使用不同的 `MS_BOT_USER_DATA_DIR`；不支持用旧代码继续写入已升级的 v2 数据库；
- 可用 `MS_BOT_USER_DATA_DIR` 为测试指定隔离目录；
- 可用 `MS_BOT_DB_PATH` 单独覆盖数据库路径；
- Renderer 启用 Context Isolation、Sandbox，并禁用 Node Integration 与 WebView；
- Preload 不暴露原始 `ipcRenderer`、文件系统、Shell 或数据库；
- P0-A 不具备读取任意本地文件、运行命令或控制桌面的能力。

## 文档

- [P0-A 垂直切片计划](docs/plans/p0-a-vertical-slice.md)
- [P0-A 完整验收标准单](docs/validation/p0-a-acceptance-checklist.md)
- [P0-A 完整验收结果](docs/validation/p0-a-acceptance-results.md)
- [P0-A 缺陷修复与复验报告](docs/validation/p0-a-fix-verification.md)
- [P0-A 验收记录](docs/validation/p0-a-validation.md)
- [P0-A beta 基线验证](docs/validation/p0-a-beta-validation.md)
- [P0-B Runtime 实施计划](docs/plans/p0-b-runtime-recovery.md)
- [P0-B Runtime 验收标准单](docs/validation/p0-b-acceptance-checklist.md)
- [P0-B Runtime 验收结果](docs/validation/p0-b-acceptance-results.md)
- [P0-B 脱敏验收证据](docs/validation/evidence/p0-b/acceptance-evidence.md)
- [Grok Bot 逆向规格包](docs/reverse-engineering/grok-bot/README.md)
- [试用反馈模板](docs/templates/pilot-feedback.md)

## 分支流程

普通开发在 `dev` 或从 `dev` 创建的 Feature 分支进行。完成开发环境验证后才能进入 `beta`，完成测试环境验证后才能进入 `master`。不得从 `dev` 直接进入 `master`。
