# Aevoren Bot macOS 自动更新

## 目标与边界

Aevoren Bot 使用 Main 进程中的 `electron-updater` 完成 macOS 应用更新。Renderer 不能设置下载地址、版本或校验规则，只能读取状态、手动检查、失败重试和请求重启安装。

macOS 的 Squirrel.Mac 会先下载并验证更新，再暂存可安装版本。应用不会在用户工作过程中强制退出：下载完成后可点击“重启更新”，也可在下一次正常退出时自动安装。下载、校验或安装准备失败不会覆盖当前应用包。

完全无交互的中途重启会打断用户工作，因此不采用。若一个已正确签名且成功安装的新版本自身存在业务缺陷，运行中的旧进程无法保证对一个无法启动的新包实施自动二进制回滚；此类事故需要暂停更新元数据并发布更高版本的修复包。当前实现所称“安全回滚”是指 Squirrel.Mac 的暂存/替换边界：下载、完整性、签名或替换失败时保留当前可用版本，不是任意已安装版本降级。

## 状态与时序

- 应用启动 15 秒后首次检查；之后每 6 小时检查一次。
- 同一时间最多存在一个检查或下载 Promise。
- 只有严格高于当前版本的合法 SemVer 才进入下载。
- 新版本自动下载并展示整数百分比进度。
- 下载完成后写入结构化 `update.pendingReceipt` 收据，记录目标版本、原版本、下载时间、安装请求时间和尝试次数；新版本成功启动且版本不低于收据时，显示“已更新”并清除收据。
- 旧版本再次启动且收据目标版本仍更高时，显示 `install-interrupted`，保留当前可用版本并由用户明确重新下载，不自动循环退出安装。
- 更新下载完成前不能调用安装；运行中的 Direct/Room 任务会禁用“重启更新”。
- Profile 在请求重启前先 Flush；保存失败时不会发起重启。
- 现有 SQLite Schema 需要升级时，Migration 前先生成经过 `PRAGMA integrity_check` 的一致性备份及版本元数据；备份失败时拒绝迁移。
- 错误状态只暴露稳定错误码和安全文案，不向 Renderer 或日志泄露 feed URL、令牌或原始异常。

## 渠道

| 构建 | 判定 | 更新元数据 | 行为 |
| --- | --- | --- | --- |
| Development | 未打包、未嵌入 `app-update.yml`，或设置紧急禁用开关 | 无 | 更新完全禁用，不发网络请求 |
| Beta | 已打包且版本包含 SemVer prerelease，例如 `0.2.0-beta.1` | `beta-mac.yml` | 允许 Beta，禁止降级 |
| Stable | 已打包且版本无 prerelease，例如 `0.2.0` | `latest-mac.yml` | 仅稳定版本，禁止 prerelease 与降级 |

Beta/Stable 都使用构建时固化的公开 GitHub Provider，固定为 `CMSKL/Aevoren-Bot`。客户端不嵌入 GitHub PAT，也不允许 Renderer 修改 owner、repo、频道或下载地址。仓库公开前正式更新保持禁用。

## 可信发布链

`build/electron-builder.config.cjs` 生成 macOS `dmg + zip`、blockmap 和频道元数据。ZIP 是 Squirrel.Mac 更新所需目标，元数据包含包大小与 SHA-512。GitHub Actions 创建 Draft Release，上传并重新下载校验全部资产后才发布。

正式发布必须同时满足：

1. `package.json` SemVer 与 Git tag 完全一致；
2. Beta tag 所在提交已进入 `beta`，Stable tag 所在提交已进入 `master`；
3. 使用 `Developer ID Application` 签名并启用 Hardened Runtime；
4. App 公证成功且 ticket 已 stapled；DMG 单独公证后执行 `release:finalize:mac`，装订 ticket、重建 DMG blockmap 并刷新频道 manifest 的 SHA-512/size；
5. App 的 `codesign --verify`、Gatekeeper `spctl` 和 `stapler validate` 均通过，DMG 的 `codesign --verify`、`stapler validate` 与 `spctl --type open` 均通过；
6. Draft Release 同时包含 ZIP、DMG、blockmap、`beta-mac.yml` 或 `latest-mac.yml`、`SHASUMS256.txt`；
7. Draft 资产重新下载后必须同时通过 SHA-256 清单和 manifest SHA-512 校验；
8. 发布后 Release 必须为非 Draft、预发布/稳定渠道标记与 tag 策略一致，并包含完整的资产集合；
9. Release 资产生成 GitHub Artifact Attestation；工作流通过资产 attestation 上传、SHA-256 清单和 manifest SHA-512 校验完成发布门禁。`gh release verify` 查询的是 Release 级 attestation，与本项目按资产生成的 attestation 口径不一致，不作为门禁。

CI 所需 Secrets：

- `CSC_LINK`、`CSC_KEY_PASSWORD`
- `APPLE_TEAM_ID`
- 公证凭据二选一：
  - 推荐：`APPLE_API_KEY_P8_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`
  - 兼容：`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`

API Key 模式优先；Key 只在 Runner 临时目录解码并设置为 `0600`，不会写入仓库或发布资产。任一所选凭据组不完整，或两组均未配置时，发布任务 Fail Closed，不会创建或发布正式 Release。`GITHUB_TOKEN` 使用 GitHub Actions 自动提供的短期令牌，不写入客户端。

## 本地命令

本地无签名目录包（不含更新 feed，不会自动联网）：

```bash
pnpm package:mac
```

本地 Release 资产结构验证：

```bash
pnpm release:prepare
```

当项目目录位于 iCloud/File Provider 管理路径时，构建目录可能在签名前被重新附加 FinderInfo 或 File Provider 扩展属性。发布构建应将 `AEVOREN_DIST_DIR` 指向 `/tmp` 等非 File Provider 目录；CI 未设置时仍默认使用仓库 `dist`。DMG 获得 Apple Accepted 状态后，必须先执行 `release:finalize:mac`，再执行 `release:prepare`，不得发布 manifest 与已 stapled DMG 字节不一致的资产。

正式 Release 由 `v*` Tag 触发 GitHub Actions。Release 构建必须提供签名和公证环境变量；本地 Development 不需要、也不应伪装成已公证发布包。
