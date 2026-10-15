# Approved external drafts

This guide accompanies the v0.3.0-beta.32 development candidate. Local source and unsigned macOS-package checks have passed; cross-platform CI and signed publication remain pending. This page does not imply a published installer or verified access to a real third-party account. Configure reads and local drafts using [Native connections](NATIVE_CONNECTORS.md).

## Separate writing permission

Reading permission does not permit sending mail or modifying a file/page. Writing grants belong to one conversation, executing Bot, connection account, authorization version, operation and selected targets. Adding a Bot to a group does not copy its private grants.

Gmail sending requires an explicit authorization flow that includes `gmail.send` as well as the existing read and identity scopes. Review the account after authorization and grant the intended recipients separately. Drive writing uses `drive.file`: update targets must be selected or application-created files. Creating a plain text file reserves a provider ID before approval. Notion writing uses the configured internal connection and explicitly selected parent pages.

The first outbound unit covers Gmail messages without attachments/BCC, ordinary Drive text-file creation and replacement, and Notion page creation with a title and paragraph text. Notion page updates, writable MCP and interactive Apps are separate Stage 4 deliveries. It does not create Google Workspace documents by conversion.

## Review a saved revision

Save the draft before preparing an external action. Preparation fixes the saved revision, content digest, verified account, writing-grant version, operation and targets. The approval dialog reads the host's persisted snapshot, including recipients and complete content. Editing the draft or changing/revoking authorization invalidates pending approval; the host does not silently substitute newer content.

Interface actions and AI calls use the same validated host service. AI discovers `outbound.*` through the product catalog and cannot authorize its own writes. Credentials remain encrypted in the host and never enter an approval snapshot or tool result.

## Read the actual result

- `prepared`: the fixed action has not been dispatched.
- `dispatching`: the host durably registered the attempt before contacting the provider.
- `confirmed`: a valid provider receipt or a matching read-only verification proves the action. Gmail confirmation means provider acceptance or a matching sent copy, not delivery to the recipient.
- `rejected`: the action was denied or the provider definitively rejected it.
- `unknown`: the action may have reached the provider. Cancellation, connection loss and restart after dispatch cannot prove that nothing happened.

An unknown result offers read-only verification. It never automatically resends the same draft revision. Missing search results do not prove that mail was unsent. A new explicit draft revision represents a new intent; review whether the previous action took effect before requesting another write.

Drive updates check the observed file version before dispatch, but this is not an atomic provider-side compare-and-swap. Another editor can change the file between that check and the write. Notion may commit a page despite a 503 response; committed-resource hints are used only for read-only verification, never as permission to repeat the write.

External attempt records survive chat history clearing and Runtime removal. Retaining a receipt does not preserve revoked permission or make deleted conversation content readable. Reconciliation requires a current authorized read under the same account. Application shutdown interrupts pending work and recovery reports uncertain dispatched attempts honestly.

## Verification boundary

Controlled provider HTTP, real SQLite, shared-tool tests and hidden Electron scenarios are separate from real-account verification. Actual Gmail/Drive/Notion writes require user-provided credentials and an approved test account, recipients, file or parent page. Without those, real authorization and writes remain unverified. The [implementation record](IMPLEMENTATION_PLAN.md) contains the current test and release evidence.

Provider behavior follows [Gmail sending](https://developers.google.com/workspace/gmail/api/guides/sending), [Drive pre-generated IDs](https://developers.google.com/workspace/drive/api/guides/create-file), and [Notion errors](https://developers.notion.com/reference/status-codes).
