# Events and local Webhooks

Source delivery: `v0.3.0-beta.43`. This guide describes the local implementation; current acceptance and publication evidence is recorded in [the implementation plan](IMPLEMENTATION_PLAN.md). A source guide does not establish that a signed installer has shipped.

## Configure a subscription

1. Save and enable a Bot or group **MAIN** [Routine](GROUP_ROUTINES.md). Review its instruction, fixed members, selected resources and version.
2. Open **Settings → 事件与 Webhook**. Enter a name, choose **本机 Webhook**, **任务完成**, or **任务失败**, then explicitly select the saved Routine. Internal events also require an explicitly selected source conversation; trusted settings can select a TASK source.
3. Review the actual Routine instruction, version, target session and group roster. Save as paused or explicitly enable the subscription. No new tool or resource permission is granted.
4. For a Webhook, choose **更换密钥** and confirm the target. Copy the once-displayed Bearer token and close its display. It is encrypted by the host key store; snapshots, AI operations and delivery receipts do not contain it.
5. Explicitly start the local listener. Port `0` chooses an available port. The page displays the real `127.0.0.1` port and current versioned path. The listener is stopped by default and after every application restart. It never binds a public network interface.

Every configuration edit changes the subscription version, invalidates the previous URL and requests cancellation of its active deliveries. Token rotation also invalidates the old token immediately. Pause and revoke apply to this subscription's runs; they do not cancel unrelated Bot or group work. A completed handoff cannot be undone.

An open editor retains its draft if another UI or AI operation changes the subscription. A stale save reports a conflict. **读取最新版本，保留编辑** explicitly accepts the new base version while retaining entered fields; a changed Routine still requires separate review.

## Send a local event

Use a local client with the current URL, `Content-Type: application/json`, `Authorization: Bearer <copied-token>` and an explicit `Idempotency-Key` header. The body must be a UTF-8 JSON object, at most 65,536 bytes. Compressed bodies and browser-origin requests are rejected. Parsed objects are bounded to 32 nesting levels and 10,000 values.

The same subscription and key with canonically identical JSON return the original durable receipt. A changed payload conflicts. Authentication is checked before parsing and again before acceptance, so a token rotated while a body arrives cannot admit that request. Old paths also fail after configuration changes.

Only the saved Routine prompt is instruction text. Event JSON is persisted before dispatch as the ordinary **untrusted** `automation-event.json` attachment. Fields named `approval`, `credentials`, `instruction` or `toolMeta` remain data; they are never human approval, key configuration or tool metadata. Existing tool approvals and grants still apply.

The target Routine version, subscription version, source and target admission snapshot are fixed at acceptance. If the saved definition or authority changes before admission, the event fails rather than silently running the newer definition. A subscription requires an enabled Routine; its ordinary schedule remains active as configured. A busy Routine produces a failed receipt instead of an automatic queue/retry.

## Internal Runtime events

Internal events are emitted by the host only for actual `completed` or `failed` Runtime records, including individual group-member Runtimes. The envelope contains opaque event/session/Runtime IDs and terminal status. It does not contain user or assistant text, Memory, tool arguments or credentials. A TASK source therefore does not share its private conversation with the target MAIN Routine.

Origin is recovered from durable Routine messages, group-turn batch nonces and host-created delegation roots. Event ancestry rejects a repeated subscription and stops at four hops, including an A → B → A cycle. A model cannot supply its own event origin or emit an internal event through the product catalog.

## Receipts, cancellation and recovery

**已交给 Routine** means the host verified a durable Routine receipt; execution results remain in **主动服务 → Routine history**. The event history shows metadata and payload digest only. **正在取消** remains visible while the actual owned run stops. **结果未知** is retained when acceptance cannot be established.

After restart the host queries the original trigger receipt. It does not invoke dispatch again for uncertain or interrupted events. Reusing an idempotency key is not a request to replay an unknown result. Inspect the existing Routine and delivery records before deciding whether to create a genuinely new event.

AI access is through `product_catalog → product_describe → product_execute` with `automationEvents.snapshot/create/update/revoke/cancel/startListener/stopListener`. Both source and target must belong to the AI's current admitted MAIN session. TASK AI access is unsupported. AI listener start/stop require a separate approval showing the fixed nonzero port, the application-wide effect on all conversations, and the reviewed current listener state. The UI can still choose port 0 for automatic allocation. UI and AI share one resource controller; a concurrent change invalidates stale approval. Completed receipts are reused without restoring prior listener state, and uncertain old requests are not replayed. Stopping ingress leaves dispatched Routine tasks running. Token rotation remains trusted credential management outside the AI catalog. Existing `events` remains the Runtime/tool event namespace; the new Preload namespace is `automationEvents`.

Local limits are 100 subscriptions and 100 concurrently accepted/dispatching deliveries; the UI displays up to 500 recent receipts. No new package dependency is introduced. Remote ingress, public forwarding, hosted schedulers and account-based event services are outside this delivery. Real user endpoints, third-party accounts and remote deployment are not part of controlled local acceptance.
