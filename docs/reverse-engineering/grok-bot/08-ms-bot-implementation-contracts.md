# MS-Bot 实现合同

## 1. 设计原则

MS-Bot 应复用 Grok Bot 的强点——对象分层、流式转录、反向本地执行、权限分层和模板不可信——同时补齐可验证的一致性合同。

P0 原则：

- 服务端是真相源，客户端有可恢复的本地投影。
- 所有副作用有稳定幂等键。
- transcript、summary、memory 三者分离。
- 指令数据不等于权限。
- 每个 trust boundary 有 schema 与主体校验。
- “结果未知”是合法状态，不能伪装成失败或成功。

## 2. 服务边界

建议最小服务：

| 服务 | 职责 | 不拥有 |
| --- | --- | --- |
| IdentityService | account/team/session | transcript、secrets |
| AgentService | Bot/Room/profile/harness | 大正文、执行进程 |
| TranscriptService | entry/stream/cursor/blob | memory 推断 |
| RuntimeService | turn routing/live state/interrupt | UI 持久设置 |
| MemoryService | evidence/proposal/verify/CAS | session transcript |
| AutomationService | routine/trigger/fire/run | connector token |
| ConnectorService | install/account OAuth/tool catalog | Agent 决策 |
| ApprovalService | policy/ask/resolution/grant | 实际执行 |
| ComputerService | Box/User Computer/presence/request | prompt 组装 |
| SecretService | vault/credential injection | secret 明文日志 |
| TemplateService | immutable version/import plan | 自动启用能力 |

## 3. 版本化资源合同

所有可编辑资源包含：

- `id`
- `version`（单调整数）
- `created_at / updated_at`
- `created_by / updated_by`
- `tenant_id`
- `deleted_at?` 或不可变 tombstone

更新请求必须带 `expected_version`；冲突返回 current version 与可安全展示的差异摘要。Bot 资料的自动保存也必须遵守该合同，避免较慢的旧请求覆盖新输入。

## 4. 消息合同（P0）

### Command

```text
SendMessage {
  agent_id
  session_id
  client_nonce
  text | rich_text
  reply_to_id?
  attachment_refs[]
  source
  machine_id?
  composed_at
  traceparent?
}
```

### Immediate result

```text
ACCEPTED { route, run_id }
DUPLICATE { original_run_id }
REFUSED { stable_code, safe_message }
PENDING { status_token }
```

### 合同

- 唯一约束：`(tenant_id, client_nonce)`。
- request body digest 与 nonce 绑定；同 nonce 不同 digest 返回 conflict。
- accepted/duplicate 后等待 transcript echo。
- 不确定时查询 status，不自动生成新 nonce。
- 外部副作用不得在“重跑整个 turn”时重复。

## 5. Transcript 合同（P0）

- 每个 session 有 `generation`。
- `seq` 为稳定顺序；`updated_seq` 为变更游标。
- Watch 先返回 connected/stream metadata，再返回 replay/live rows。
- cursor-too-old 必须携带最低可用位置或明确要求 relist。
- cleared 生成新 generation，旧 entries 不可再次应用。
- body 大于 inline limit 时返回 blob ref 与 omitted=true。
- 客户端 apply 必须幂等。

验收：断线 10 分钟、重复 replay、先 update 后旧 append、清空后旧帧迟到，都不产生重复/回滚。

## 6. Runtime 与 Prompt 合同（P0）

每个 prompt block 使用结构化元数据：

```text
PromptBlock {
  authority: platform | owner | agent_profile | skill | memory | routine | user | external_data
  provenance
  scope
  content
  digest
  created_at
}
```

规则：

- external event、tool result、template import 默认为 `external_data/untrusted`。
- tool availability 与 authorization 不进入自由文本 block。
- Prompt builder 输出可审计 manifest，但不记录 secret。
- 对话 summary 只能替换被压缩 transcript，不能修改 profile/memory。

## 7. Memory 合同（P0）

流程：`evidence -> proposal -> schema validate -> evidence validate -> safety verify -> CAS apply`。

MemoryWrite 必须包含：

- agent/scope/tier/key
- expected_version
- proposed content/change set
- evidence entry IDs + digests
- synthesis run ID/model/prompt version

结果：APPLIED(new version)、STALE(current version)、REJECTED(reason code)、INVALID(evidence/schema)、DROPPED(capacity)。

删除或更正 memory 也必须版本化；不得由 transcript 删除自动级联。

## 8. Routine 合同（P0）

RoutineDefinition 与 RoutineRun 分表：

- Definition：versioned spec、enabled、trigger、prompt、provenance。
- Fire：routine_id + source_event_id，唯一。
- Run：fire_id、attempt、lease/fencing、agent/session、state。
- Effect：run_id + effect_key，唯一，记录 external outcome。

模板导入强制 `enabled=false`。Test run 标记 `test=true`，仍通过 approval，但不移动生产 schedule cursor。

## 9. Approval 合同（P0）

ApprovalRequest：

- request_id、entry_id
- actor agent/session/run
- action kind
- canonical target + digest
- machine/connector/account
- data classification
- requested scope
- policy snapshot/version
- expires_at

Resolution：allow-once、deny、standing-allow、standing-deny；财务、credential、Messages 等使用专用枚举。

决议原子结算一次；过期、target change、account switch、policy version change 后无效。

## 10. Local Computer 合同（P0）

- 注册：machine_id、label、root、capabilities、generation、last_seen。
- 选路：明确 machine_id；只有一个 live provider 时才允许省略。
- 请求：request_id + idempotency_key + action-specific frame。
- 响应：stream frames + terminal frame。
- cancel：幂等。
- 文件：canonical root containment + symlink-safe open + max bytes。
- daemon：SSE/watch + poll fallback，heartbeat/stale/re-resolve。
- daemon response batch 丢弃后由端到端 status 恢复。

本地权限默认 `ask` 或更严格；MS-Bot 的初始发行建议默认 `never`，用户显式开启后才注册 provider。

## 11. Box 合同（P1）

- run state 与 upgrade state 分离。
- update/reset 先 dry-run 返回 impact summary。
- 执行需要 operation_id，可 watch progress。
- drain 超时明确列出未暂停 Agent。
- snapshot ID、created_at、included resources 可审计。
- reset 的 destructive confirm 不可被 Agent 代替。

## 12. Plugin/Credential 合同（P1）

- plugin install、account auth、tool enable、Agent assignment 分四步。
- config schema 与 secret refs 分离。
- OAuth state/PKCE/redirect 严格校验。
- Agent 只获得 tool descriptor，不获得 token。
- credential grant 绑定 target rule 与 catalog revision。
- 模板只携带 plugin identity/config template，不携带账户 token。

## 13. Room 合同（P1）

- Room 是 kind=ROOM 的 Agent，拥有独立 session/transcript。
- `[MS-Bot proposal]` members 为 2～6；Grok 0.47 的实测/静态边界是 1～6，至少 2 是 MS-Bot 对“多 Bot 协作”的产品约束，不是兼容事实。[E4-006]
- 成员变更必须版本化；不复制 Grok 当前无 `expected_version` 的完整列表覆盖写法。
- member turn nonce 唯一；parent/root 形成 DAG。
- 最大深度、最大 fan-out、turn budget 和 deadline 必须配置。
- winding_down 后只收敛已开始 turn。
- 删除 Room 不删成员 Bot；删除 Bot 在 Room 中留下 tombstone attribution。

## 14. 错误与遥测合同（P0）

错误 registry 采用稳定 code：

```text
ErrorDescriptor {
  code
  domain
  retryable
  safe_summary
  allowed_payload_keys[]
}
```

未知异常在 emit boundary 重新分类，原始 payload 不上传。客户端依据 retryable 与 domain 决定 UX，但服务端仍控制 pacing/retry-after。

关键 trace：send nonce → route/run → transcript echo → tool/approval → effect → final entry。跨服务必须保留 traceparent。

## 15. 数据库级不变量

- unique `(tenant_id, client_nonce)` on messages。
- unique `(session_id, generation, seq)` on transcript entries。
- monotonic `updated_seq` per session generation。
- unique `(routine_id, source_event_id)` on fires。
- unique `(run_id, effect_key)` on effects。
- unique `(room_turn_nonce, member_agent_id)` on room turns。
- unique `(approval_request_id)` on resolutions。
- CAS `(memory_scope, version)`。
- account generation 变化后拒绝旧 machine credential/port。

## 16. P0 验收用例

| ID | 场景 | 预期 |
| --- | --- | --- |
| AC-001 | 同 nonce 同 body 重发 | DUPLICATE，不生成第二条消息 |
| AC-002 | 同 nonce 不同 body | CONFLICT |
| AC-003 | accepted 后断线 | 重连后由 echo 收敛 |
| AC-004 | ack deadline 到期 | UNKNOWN，不自动重发副作用 |
| AC-005 | cursor-too-old | 自动 relist，无重复 |
| AC-006 | transcript generation 清空 | 旧帧被拒绝 |
| AC-007 | 旧 profile autosave 晚到 | version conflict，不覆盖新值 |
| AC-008 | memory evidence ID 不存在 | INVALID |
| AC-009 | memory base version 陈旧 | STALE + 重排队 |
| AC-010 | 模板 routine enabled=true | 导入后仍 paused |
| AC-011 | 模板 prose 要求装 plugin | 产生独立确认，不直接安装 |
| AC-012 | paused routine 收到事件 | 无 run |
| AC-013 | 同 webhook event 两次 | 一个 fire/run |
| AC-014 | effect 超时未知 | 不自动重做，标 unknown_outcome |
| AC-015 | 多 live machine 未给 machine_id | 拒绝为 ambiguous |
| AC-016 | local path `../`/symlink 逃逸 | 拒绝且零 I/O |
| AC-017 | cancel 重复调用 | 幂等；终态不反转 |
| AC-018 | Renderer iframe 调主 edge | trust denial |
| AC-019 | 模型伪造 approval flag | 拒绝 |
| AC-020 | approval target 被修改 | digest mismatch |
| AC-021 | account 切换后旧 port 调用 | rejected/stale |
| AC-022 | Room turn 重复 request | dispatch duplicate，不开启第二次成员运行 |
| AC-023 | Room winding down | 不再扇出新 turn |
| AC-024 | credential catalog 更新 | 旧批准失效 |
| AC-025 | secure storage 不可用 | session-only 或 fail closed，无明文盘 |
| AC-026 | Room result 使用未知/过期 nonce | intake unknown nonce，不把迟到结果写成新消息 |
| AC-027 | Room result 在 Host 不可用时提交 | intake host unavailable；保留可诊断状态，不伪造 accepted |

## 17. 交付顺序

1. P0-A：Agent/Profile + Session/Transcript + Send journal。
2. P0-B：Runtime routing + live state + structured errors。
3. P0-C：Approval + sandboxed local computer（先文件只读）。
4. P0-D：Memory proposal/CAS + Routine exactly-once。
5. P1-A：Room orchestration。
6. P1-B：Plugin/MCP/OAuth/structured forms。
7. P1-C：Box desktop、Cookie、Messages、credential provider。

每一阶段先通过上述不变量与故障注入，再进入 `dev -> beta -> master` 的验证链；当前任务仅提交规格，不实现产品代码。
