# Media and documents

The media implementation introduced in beta.36 and extended in the beta.37 local integration draft provides a separate **Media** section to the existing private and Room Library panels. Use the media button beside text attachments to import or select a saved item, then send through the ordinary composer. Text/code attachments keep their existing behavior. This new combination awaits its own acceptance; published beta.33 does not contain these media additions.

## Supported content

| Type | Import limit | Preview / model access |
| --- | --- | --- |
| PNG / JPEG | 2 MiB, 16 million pixels | Actual image pixels |
| PDF | 16 MiB, 200 physical pages | Extracted text with page offsets; bounded page-image preview |
| DOCX | 8 MiB | Escaped extracted text with section offsets; no physical-page or layout fidelity claim |

One import accepts at most six files and 32 MiB total. Extracted text is limited to 512 KiB. An unsupported or rejected file has an explicit failure; accepted items publish together after preparation. Cancellation publishes none of the prepared items. Encrypted PDFs and OCR remain unsupported. The later beta.37 candidate adds bounded audio/video and cloud transcription/speech; see [Voice](VOICE.md).

Imported bytes belong to the application and are checked by size and SHA-256. Moving or deleting the original does not remove an imported item. A message pins the original digest and, when present, the exact extraction ID and digest. A retry uses the original pair. Parsed text is untrusted content, never a new instruction or permission grant.

## Authorization and removal

Private chats and Rooms have separate bindings. Adding a Bot to a Room does not share its private documents. Explicit reuse shares the selected item with the target conversation. List/metadata do not return another conversation's extracted text or pixels.

Each Runtime snapshots its admissible items, including an empty snapshot. Binding an existing item during a task applies to later tasks; approved import may admit only its newly created IDs to that current task. Unbind, disable, delete or member removal blocks further reads. Re-enabling or rebinding does not revive a previous Runtime's lease. Delete is reversible and uses version conflict checks.

UI previews and model transmission recheck current access after asynchronous work. A generated PDF page remains tied to its original item and authorization. Raw model text and image bytes are ephemeral and are excluded from durable tool receipts. They are withheld from later API requests and native-tool cached replies after revocation.

Claude MCP also rechecks each actually included image or private text source at the final HTTP body write. If a batch waits for another tool while access is revoked, that response is refused; independent requests retain their own authorization. A same-ID retry renders a current redaction notice without executing the tool again. A refused response does not undo other completed tools, so inspect their execution records before retrying.

## AI entry points

Use `product_catalog`, `product_describe`, then `product_execute` for `media.list`, `available`, `metadata`, `read`, `preview`, `pickImport`, `importPath`, `bind`, `unbind`, `setEnabled`, `delete` and `restore`. Reads apply the current task's admission; mutations require the normal approval. `available` requires approval and returns reusable metadata only. `importPath` accepts an already authorized Workspace-relative path; arbitrary host paths are rejected. `pickImport` opens the trusted native file chooser.

The API, Claude and Codex adapters carry images through the real tool-result pixel channel. Initial user messages contain references rather than direct images. Transport support does not establish the selected model's vision capability. An unsupported adapter is explicitly identified; extracted text remains available when permitted.

## Parser isolation and packaging

Every parse/preview job has its own hidden sandbox Renderer, nonpersistent session and nonce. It receives bounded bytes, with no Node integration, main application API, business credentials or host paths. Only hash-checked parser assets are served; external requests, downloads, permissions and navigation are denied. Jobs have independent cancellation and a 30-second deadline; app shutdown settles owned jobs before the database closes.

PDF.js, Mammoth and ZIP code are pinned and bundled for the browser. The package uses four unchanged Liberation 2.1.5 OFL fonts, explicit CMap/standard-font/codec licenses, and the exact JSZip MIT alternative. Original GPL fonts and the PDF scripting sandbox are excluded. The actual package resource scan is an acceptance gate; a build configuration alone does not establish its result. See [design details](MEDIA_VOICE_DESIGN.md), [third-party notices](../THIRD_PARTY_NOTICES.md) and [implementation evidence](IMPLEMENTATION_PLAN.md).
