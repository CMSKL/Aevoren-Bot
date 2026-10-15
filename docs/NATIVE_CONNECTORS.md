# Native application connections

This guide covers the v0.3.0-beta.31 development candidate: Gmail, Google Drive and Notion reads plus local drafts. External sending and third-party writes are a subsequent delivery. Validation status is recorded in the [implementation plan](IMPLEMENTATION_PLAN.md).

## Configure and authorize

Open **Settings → Application connections (应用连接)**. Configure Gmail or Drive with your own Google desktop OAuth client ID; enter its client secret only if required by that client. Notion uses an internal connection token entered in the trusted settings form. Saved credentials are encrypted by the host and are never returned to the Renderer, product catalog or model.

Click **Authorize** explicitly. Google opens the system browser with PKCE S256 and a random `127.0.0.1` callback port. Cancel or expiry closes the listener and prevents late results from saving credentials. Notion verifies the configured token's identity. Configuring a connection does not authorize a Bot to read it.

- Gmail uses readonly mail access plus identity scopes. Search returns matching message metadata; reading returns selected headers and bounded text, with attachment metadata only. HTML without plain text is identified and displayed as escaped text. This unit does not download attachments or send mail.
- Drive uses its native desktop Picker with exactly `drive.file`, separate from Gmail scopes. Select the files to authorize. Each chat grant can narrow that set further; shortcuts do not broaden access. Google Docs/Sheets/Slides export bounded text, CSV or text respectively.
- Notion uses API version `2026-03-11`, searches page titles and reads bounded page/block text that the token can access. Share the intended pages with that internal connection in Notion. Search is not a full-text index or a complete list of all accessible pages.

These protocols follow the primary [Google native OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [desktop Drive Picker](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) and [Notion versioning](https://developers.notion.com/reference/versioning) documentation.

## Authorize one chat and Bot

Open **Contacts → Applications (应用)**, or the group's **Applications** tab and select the executing member. Choose the verified connection and grant reading access. Reading results can enter that chat's model context; the grant belongs to that chat and Bot. Joining a group does not carry private-chat permission into it.

Account and scope changes advance the authorization version and invalidate previous grants. Normal token refresh preserves that version and verifies the account and scopes. Revoking the connection cancels all its pending reads; unbinding one member affects only that scope. Removing and re-adding a group member does not restore the old grant or its former group drafts.

The interface and AI use the same validated `connectors.*` handlers. Models discover them through `product_catalog → product_describe → product_execute`. Credential configuration is restricted to the trusted form; AI can open that settings view but cannot provide raw secrets through tool metadata. Authorized reads use the current grant and fetch fresh content. Provider text remains untrusted source material.

## Local drafts and versions

Create a local Gmail message, Drive text-file draft or Notion page draft from the application's chat panel. Each draft fixes its account and authorization version. Saving creates an immutable revision; `expectedVersion` conflicts retain the editor's unsaved content. A retry with the same creation identity returns the original draft rather than creating another.

`drafts.*` supports listing, reading, creating, updating, version history and local deletion. Drafts remain local and have state `local-draft`; no send button or network write occurs when saving. After account authorization is revoked, existing local content remains reviewable/editable within its original scope and is marked unauthorized. A repeated AI mutation returns the original saved revision with current authorization status.

## Limits and actual support

Responses are bounded to 2 MiB JSON, 4 MiB binary content and 128,000 text characters. Notion recursion and pagination are bounded; truncation is reported. Only fixed official HTTPS endpoints and supported read operations are permitted; credentialed redirects are rejected.

Binary bytes may be read by the host, but this unit returns metadata and byte count only. It does not save those bytes as media references, provide downloads/previews or send pixels to a model. Attachment metadata likewise does not prove attachment-content retrieval.

Controlled HTTP, real SQLite, real loopback lifecycle and hidden Electron tests verify the implementation. Real Google/Notion accounts require user-supplied credentials and approved test targets; without them, genuine authorization and account data reads remain unverified. Tool metadata and a successful fixture are not substitutes for real provider authorization.
