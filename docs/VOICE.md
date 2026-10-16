# Voice and audio/video media

The beta.37 development candidate adds independent cloud transcription and AI speech, plus local audio/video references and playback. Its UI, SQLite and controlled-service tests are distinct from live cloud or microphone verification. Realtime configuration can be saved; the persistent realtime connection belongs to the next delivery.

## Configure services

Open **Settings → Voice**. Transcription, speech and Realtime each have their own key, model, enable switch and configuration version. A saved key is encrypted by the host and never returned to the UI or model; the form shows only whether a key is configured. Configuration changes cancel the affected in-flight service. Completed local results remain available under their original conversation/source authorization.

The first adapter uses OpenAI's file [Transcriptions API](https://developers.openai.com/api/docs/guides/speech-to-text) with `gpt-transcribe`, and [Speech API](https://developers.openai.com/api/docs/guides/text-to-speech) with an explicitly selected model/voice. The initial speech reference is `gpt-4o-mini-tts`; its named snapshots and `tts-1`/`tts-1-hd` have a January 6, 2027 sunset. The documented replacement uses a different Realtime path, so it must be configured with the appropriate adapter. See [official deprecations](https://developers.openai.com/api/docs/deprecations). Saved configuration is not proof of account/model availability; actual requests report their outcome.

## Record and transcribe

Open **Voice** in the composer toolbar to show the controls; they stay collapsed during ordinary chat. Closing them stops their owned recording/playback and invalidates a pending transcript insertion. Already-dispatched transcription tasks keep their own status and history; reopen the controls to query or stop an individual task.

Click **Record** yourself to request microphone permission. Only the current main document with a short user-initiated intent may request audio; camera, display capture, subframes and unrelated documents are denied. Recording negotiates a supported browser format and stops at two minutes or 16 MiB. Stop/cancel, navigation, application closure and conversation-generation changes release the owned tracks.

The captured media is saved before cloud transcription. Partial text appears in its task card. A completed transcript is inserted only after an explicit click; the captured session, draft version and digest protect against A→B→A edits and late replies. A conflict keeps the result and offers an explicit insertion into the new current draft. Inserting text does not send a message or automatically attach the original audio. The saved recording can be selected separately from the media Library.

Connected AI uses `product_catalog → product_describe → product_execute` for `voice.configurations`, `configure`, `transcribe`, `speak`, `get`, `list`, `stop` and `audio`. Cloud requests require the existing approval. Source references/configuration versions are fixed and host-generated nonces are canonical across omitted/explicit current scope. Repeating an unknown request returns its durable state without another dispatch. AI configuration changes preserve the current key reference and use version checks; credential writes/clearing and microphone activation use trusted UI IPC outside that catalog.

## Listen and stop

Completed replies have a **Read aloud** action. The optional current-session auto-read queue observes new reply completions in arrival order; it never replays a restored snapshot. Group model requests continue in parallel. The player identifies **AI-generated speech**, the Bot and voice. If the browser blocks playback, click Play explicitly.

Stop cancels owned generation requests, clears the queue, pauses the local player and rejects late bytes. Switching conversations, clearing history or cancelling the current Room batch stops its corresponding playback resources. Saved speech is real PCM24kHz/16-bit mono wrapped as WAV, checked by size and digest. Voice task details provide the transcript/audio result and cancellation state. Model tool receipts store metadata; authorized transcript text uses the revocable ephemeral text channel, and audio bytes are not passed into the model protocol.

## Audio/video support and limits

The media Library accepts WAV, MP3, Ogg, WebM and MP4/M4A only when their container and actual Chromium decoder validate. Codec availability depends on the platform. Imports are limited to six items/32 MiB total, with 16 MiB and ten minutes per audio/video file. Decoded duration and dimensions are persisted. Video is a local preview; file transcription can process authorized audio where supported by the cloud service. No model video-understanding claim is made.

Speech input is limited to 8,000 characters, transcript output to 100,000 characters and generated WAV to 16 MiB. A selected cloud model can impose an earlier limit. Parser jobs remain independently isolated, cancelled and bounded by a 30-second deadline. Revoking an original binding clears playback and blocks subsequent reads; rebinding does not revive the original task lease.

## Packaging and verification

macOS packaging retains the microphone usage description and declares audio-input permission for the App and Helpers. An unsigned package check proves its declaration; the signed release gate separately checks actual App/Renderer Helper entitlements. Permission declarations alone do not prove a physical microphone works.

Current controlled acceptance uses local HTTP, deterministic WAV and generated WebM, fixture microphone tracks and fixture playback devices. Actual cloud accounts, physical microphone/output devices and final cross-platform/signed packages remain separate gates. Evidence and failures are recorded in the [implementation plan](IMPLEMENTATION_PLAN.md); the underlying import/authorization model is documented in [Media](MEDIA.md).
