# Bot 与群聊 Routine

Routine 保存用户编写的指令，并通过现有 SendWorker / RoomCoordinator 执行。Bot 目标保留旧 `botId` 创建格式；群聊目标使用真实 Room MAIN 会话，`botId` 为 `null`，不借用某个成员作为所有者。本轮不支持 TASK 目标。

## 固定范围

保存目标时记录会话代次、授权版本、成员版本、成员配置版本和明确选择的资料/媒体版本。默认 `everyone` 必须明确保存当前全部成员；`explicit` 保存选定成员。成员增加、移除或移除后重新加入，均使原目标失效，需要用户重新选择并保存。正文编辑生成的新资料版本不替换已接受运行中的原引用。

运行另存名称、提示词、计划、目标及授权快照、原始 nonce。后续修改 Routine 不改写历史运行。授权撤销、资源停用或删除后，即使重新启用，旧运行仍不能取得新授权。当前实现保守比较 MCP 配置和凭据指纹，凭据轮换或刷新也需要重新选择目标后保存。密钥、完整授权明细和事件附件不进入公开 RoutineRun DTO。

## 执行与恢复

- `RoutineService(repo, worker, notify, clock, rooms)` 接收现有群调度器。
- `runNow(id)` 和宿主内部 `createTriggerRun(input)` 先持久化运行，再提交消息。六成员 `everyone` 使用现有并行执行路径。
- `cancelRun({runId, expectedVersion})` 只取消该运行登记的 Runtime 或 Room batch；等待中的运行直接取消。接受期间取消不会产生晚到的新 batch。
- `getByTriggerKey(key)` 返回原始持久化回执。相同 key 的不同请求摘要被拒绝。
- 重启发现 `dispatching` 时只核对原始 nonce、消息来源、正文、引用和真实执行回执；找不到接受记录或记录不符则标记 `unknown`，不重放。
- 后台时钟推进使用 `next_run_at` CAS，不改变用户配置版本。失效授权产生失败回执；同一规则已有运行时，本次计划产生 `missed`，不阻塞其他规则。
- 应用退出时先等待 `service.shutdown()`，再关闭 Worker 和 RoomCoordinator。

## 后续事件桥接

宿主内部可调用 `createTriggerRun(input, eventAttachment?)`。第二参数不属于公开输入 schema，不通过产品工具或 Renderer 暴露。附件必须为 UTF-8 JSON，名称 `automation-event.json`，MIME 为 `application/json`，实际内容不超过 64 KiB，大小和 SHA-256 与元信息一致；只允许事件触发。

附件在提交执行前原子保存，重复 key 的不同附件摘要被拒绝。消息正文始终为保存的 Routine 指令，事件内容仅通过既有不可信附件通道进入模型，不构成操作批准。本交付不实现 HTTP、Webhook、事件订阅或真实第三方写入。

## 验收证据

真实 SQLite 的 Routine、数据库、Room、TASK Runtime、TASK 产品范围和搜索回归共 83 项通过；Node TypeScript、修改文件 ESLint 与 diff 检查通过。覆盖六成员并行、兄弟运行隔离取消、接受中取消、固定成员与资料版本、撤销后禁止工具审批、事件回执幂等、重启不重放和 v45 历史迁移。界面/IPC 接入、隐藏 Electron 场景及安装包验收由后续集成交付完成。

数据库迁移使用版本 47，必须按发布顺序在组织设置迁移 46 之后合入。
