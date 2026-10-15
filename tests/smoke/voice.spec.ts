import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult, RoomRuntimeSnapshot } from "../../src/shared/contracts";
import type { ProductViewInput, ProductViewResult } from "../../src/shared/product-view";
import { PRODUCT_VIEW_DOM_EVENT } from "../../src/shared/product-view";
import type { VoiceConfiguration, VoiceConfigurationKind, VoiceTask } from "../../src/shared/voice-contracts";
import { VOICE_CHANGED_CHANNEL, VOICE_CHANNELS } from "../../src/shared/voice-channels";
import { AppRepository } from "../../src/main/database";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";

type Pending = { response: ServerResponse; body: string; authorization: string; released: boolean; aborted: boolean };
type Fixture = {
  application: ElectronApplication; page: Page; bots: { id: string; sessionId: string; name: string; modelId: string }[];
  room: { id: string; sessionId: string; name: string }; historyId: string;
  transcriptions: Pending[]; speeches: Pending[]; models: Map<string, Pending>; errors: string[];
  completeTranscription(index: number, text: string): void; completeSpeech(index: number): void; completeModel(index: number): void;
};
type BrowserFixture = {
  voiceMicFixture?: { requests: MediaStreamConstraints[]; stopped: number };
  voiceAudioFixture?: { plays: number; pauses: number; blocked: boolean; players: { onended: (() => void) | null }[] };
};
type MainFixture = { voiceUiRead?: { entered: boolean; release?: () => void } };
function unwrap<T>(value: ApiResult<T>): T { if (!value.ok) throw new Error(value.error.code); return value.data; }
async function configurations(page: Page): Promise<VoiceConfiguration[]> { return unwrap(await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.voice.configurations())); }
async function tasks(page: Page, sessionId: string): Promise<VoiceTask[]> { return unwrap(await page.evaluate(sessionId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.voice.list({ sessionId }), sessionId)); }
async function configure(page: Page, kinds: VoiceConfigurationKind[] = ["stt", "tts"]): Promise<void> {
  for (const kind of kinds) {
    const current = (await configurations(page)).find(item => item.kind === kind)!;
    unwrap(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.voice.saveConfiguration(input), { kind, expectedVersion: current.version, enabled: true, model: current.model, voice: current.voice, apiKey: `${kind}-fixture-key` }));
  }
}
async function view(page: Page, input: ProductViewInput): Promise<ProductViewResult> {
  return page.evaluate(({ name, input }) => new Promise<ProductViewResult>(resolve => window.dispatchEvent(new CustomEvent(name, { detail: { request: { id: crypto.randomUUID(), input }, respond: resolve } }))), { name: PRODUCT_VIEW_DOM_EVENT, input });
}
async function draft(page: Page): Promise<{ text: string; digest: string; draftVersion: number; mediaRefs: unknown[] }> { const result = await view(page, { action: "draft_get" }); expect(result.status).toBe("completed"); return result.result as { text: string; digest: string; draftVersion: number; mediaRefs: unknown[] }; }
async function select(f: Fixture, index: number): Promise<void> { await f.page.getByRole("listitem", { name: f.bots[index]!.name, exact: true }).click(); await expect(f.page.getByRole("heading", { name: f.bots[index]!.name, exact: true })).toBeVisible(); }
async function holdNextTaskRead(f: Fixture, channel: string = VOICE_CHANNELS.get): Promise<void> {
  await f.application.evaluate(({ ipcMain }, channel) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers.get(channel); if (!original) throw new Error("Missing actual voice task reader");
    (globalThis as MainFixture).voiceUiRead = { entered: false }; ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (...args) => {
      const result = await original(...args), state = (globalThis as MainFixture).voiceUiRead!;
      if (!state.entered) { state.entered = true; await new Promise<void>(resolve => { state.release = resolve; }); }
      return result;
    });
  }, channel);
}

// These shims replace microphone permission, capture and audible playback only.
// Real trusted IPC, scoped media parsing/storage, voice HTTP and task persistence remain active.
async function installAudioFixtures(f: Fixture): Promise<void> {
  await f.application.evaluate(({ systemPreferences }) => {
    Object.defineProperty(systemPreferences, "getMediaAccessStatus", { configurable: true, value: () => "not-determined" });
    Object.defineProperty(systemPreferences, "askForMediaAccess", { configurable: true, value: async () => true });
  });
  await f.page.evaluate(() => {
    const globals = window as unknown as BrowserFixture;
    globals.voiceMicFixture = { requests: [], stopped: 0 };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async (constraints: MediaStreamConstraints) => {
      globals.voiceMicFixture!.requests.push(constraints);
      let stopped = false;
      return { getTracks: () => [{ stop() { if (!stopped) { stopped = true; globals.voiceMicFixture!.stopped += 1; } } }] };
    } } });
    class FixtureRecorder {
      static isTypeSupported(type: string): boolean { return type === "audio/wav"; }
      state = "inactive"; mimeType = "audio/wav";
      ondataavailable: ((event: { data: Blob }) => void) | null = null; onstop: (() => void) | null = null; onerror: (() => void) | null = null;
      start(): void { this.state = "recording"; }
      stop(): void {
        if (this.state === "inactive") return; this.state = "inactive";
        const bytes = new Uint8Array(4844), data = new DataView(bytes.buffer);
        const write = (at: number, text: string): void => { [...text].forEach((character, index) => { bytes[at + index] = character.charCodeAt(0); }); };
        write(0, "RIFF"); data.setUint32(4, bytes.length - 8, true); write(8, "WAVEfmt "); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, 24000, true); data.setUint32(28, 48000, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true); write(36, "data"); data.setUint32(40, 4800, true);
        queueMicrotask(() => { this.ondataavailable?.({ data: new Blob([bytes], { type: "audio/wav" }) }); this.onstop?.(); });
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FixtureRecorder });
    globals.voiceAudioFixture = { players: [], plays: 0, pauses: 0, blocked: false };
    class FixtureAudio {
      onended: (() => void) | null = null; onerror: (() => void) | null = null;
      constructor(readonly src: string) { globals.voiceAudioFixture!.players.push(this); }
      async play(): Promise<void> { const state = globals.voiceAudioFixture!; state.plays += 1; if (state.blocked) { state.blocked = false; throw new DOMException("Fixture autoplay requires a user click", "NotAllowedError"); } }
      pause(): void { globals.voiceAudioFixture!.pauses += 1; }
      removeAttribute(): void {}
      load(): void {}
    }
    Object.defineProperty(window, "Audio", { configurable: true, value: FixtureAudio });
  });
}

async function withVoice(work: (f: Fixture) => Promise<void>, realModels = false): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), "aevoren-voice-ui-"));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const bots = Array.from({ length: 6 }, (_, index) => {
    const created = repository.createBot(); const modelId = `voice-model-${index}`; const name = `语音成员${index + 1}`;
    const bot = repository.updateBot(created.bot.id, created.bot.version, { name, mcpServerIds: [], modelSelection: { providerInstanceId: "openai-compatible.default", modelId } });
    return { id: bot.id, sessionId: created.session.id, name, modelId };
  });
  const detail = repository.createRoom({ name: "语音并行群", memberBotIds: bots.map(bot => bot.id), leadBotId: null });
  const history = repository.createAssistantEntry(bots[0]!.sessionId); repository.updateTranscriptEntry(history.id, "历史原文 <script>\n保留原始空白。 ", "completed");
  repository.setSetting("memory.capture.enabled", "false", false); repository.close();
  const transcriptions: Pending[] = [], speeches: Pending[] = [], models = new Map<string, Pending>(), errors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const parts: Buffer[] = []; for await (const chunk of request) parts.push(Buffer.from(chunk));
      const body = Buffer.concat(parts).toString("utf8"), path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const pending: Pending = { body, authorization: String(request.headers.authorization ?? ""), response, released: false, aborted: false };
      response.on("close", () => { if (!pending.released) pending.aborted = true; });
      if (path === "/v1/audio/transcriptions") { if (pending.authorization !== "Bearer stt-fixture-key") throw new Error("STT key isolation failed"); transcriptions.push(pending); response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`data: ${JSON.stringify({ type: "transcript.text.delta", delta: "独立的" })}\n\n`); }
      else if (path === "/v1/audio/speech") { if (pending.authorization !== "Bearer tts-fixture-key") throw new Error("TTS key isolation failed"); const command = JSON.parse(body); if (command.response_format !== "pcm" || command.stream_format !== "audio") throw new Error("Unexpected speech wire format"); speeches.push(pending); }
      else if (path === "/v1/chat/completions") { const command = JSON.parse(body) as { model: string }; if (!bots.some(bot => bot.modelId === command.model) || pending.authorization !== "Bearer bot-fixture-key") throw new Error("Unexpected model request"); models.set(command.model, pending); }
      else throw new Error(`Unexpected fixture request ${path}`);
    } catch (error) { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Voice fixture unavailable");
  let application: ElectronApplication | undefined;
  try {
    const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("AEVOREN_BOT_"))), AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_FAKE_PROVIDER: realModels ? "0" : "1", AEVOREN_BOT_VOICE_TEST_ORIGIN: `http://127.0.0.1:${address.port}`,
    } });
    const expectedUrl = pathToFileURL(join(await application.evaluate(({ app }) => app.getAppPath()), "out/renderer/index.html")).href;
    const page = await application.firstWindow(); await page.waitForURL(expectedUrl, { waitUntil: "domcontentloaded" }); await expect(page.locator(".app-shell")).toBeVisible();
    page.on("pageerror", error => errors.push(error.message));
    if (executablePath) {
      const actual = await application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, version: app.getVersion() }));
      expect(actual).toEqual({ isPackaged: true, version: JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version });
      await test.info().attach("actual-voice-package", { body: JSON.stringify(actual), contentType: "application/json" });
    }
    const f: Fixture = { application, page, bots, room: { id: detail.room.id, sessionId: detail.session.id, name: detail.room.name }, historyId: history.id, transcriptions, speeches, models, errors,
      completeTranscription(index, text) { const pending = transcriptions[index]!; pending.released = true; pending.response.end(`data: ${JSON.stringify({ type: "transcript.text.delta", delta: "转写" })}\n\ndata: ${JSON.stringify({ type: "transcript.text.done", text })}\n\n`); },
      completeSpeech(index) { const pending = speeches[index]!; pending.released = true; pending.response.writeHead(200, { "content-type": "application/octet-stream" }); pending.response.end(Buffer.alloc(4800)); },
      completeModel(index) { const pending = models.get(bots[index]!.modelId)!; pending.released = true; pending.response.writeHead(200, { "content-type": "text/event-stream" }); pending.response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `${bots[index]!.name}完成` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`); },
    };
    await installAudioFixtures(f);
    if (realModels) {
      const listed = unwrap(await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.providers.list())); const current = listed.find(item => item.id === "openai-compatible.default")!;
      unwrap(await page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.providers.saveOpenAiCompatible(input), { instanceId: current.id, expectedVersion: current.version, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "bot-fixture-key" }));
    }
    await select(f, 0); await work(f);
    expect(errors).toEqual([]); expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally { server.closeAllConnections(); if (application) await closeTestApplication(application); await new Promise<void>(resolve => server.close(() => resolve())); removeTestDirectory(data); }
}

test("saves three independent editable voice configurations without echoing keys or connecting Realtime", async () => {
  test.setTimeout(90_000);
  await withVoice(async f => {
    await f.page.getByRole("button", { name: "设置", exact: true }).click(); await f.page.getByRole("button", { name: "语音", exact: true }).click();
    const labels = { stt: "转写 STT", tts: "朗读 TTS", realtime: "实时语音 Realtime" };
    for (const kind of ["stt", "tts", "realtime"] as const) {
      const label = labels[kind], card = f.page.getByRole("region", { name: `${label} 配置`, exact: true });
      await card.getByLabel(`${label} 模型`, { exact: true }).fill(`explicit-${kind}-model`);
      await card.getByLabel(`${label} API Key`, { exact: true }).fill(`${kind}-fixture-key`); await card.getByLabel(/启用此配置/u).check();
      await card.getByRole("button", { name: `保存${label}配置`, exact: true }).click(); await expect(card.getByLabel(`${label} API Key`, { exact: true })).toHaveValue("");
      await expect(card).toContainText("已安全保存");
    }
    const metadata = await configurations(f.page); expect(metadata.map(item => [item.kind, item.model, item.enabled, item.keyConfigured])).toEqual([["stt", "explicit-stt-model", true, true], ["tts", "explicit-tts-model", true, true], ["realtime", "explicit-realtime-model", true, true]]);
    expect(JSON.stringify(metadata)).not.toContain("fixture-key"); expect(f.transcriptions).toHaveLength(0); expect(f.speeches).toHaveLength(0); await expect(f.page.getByText(/实时连接与通话尚未启用/u)).toBeVisible();
    const stt = f.page.getByRole("region", { name: "转写 STT 配置", exact: true }); await stt.getByLabel(/启用此配置/u).uncheck(); await stt.getByLabel("清除此配置保存的密钥", { exact: true }).check(); await stt.getByRole("button", { name: "保存转写 STT配置", exact: true }).click();
    await expect(stt).toContainText("尚未配置"); expect((await configurations(f.page)).filter(item => item.kind !== "stt").every(item => item.enabled && item.keyConfigured)).toBe(true);
    expect(await f.page.evaluate(() => (window as unknown as BrowserFixture).voiceMicFixture!.requests)).toEqual([]);
  });
});

test("keeps streamed transcription separate from an ABA-edited draft and inserts only after an explicit fresh choice", async () => {
  test.setTimeout(90_000);
  await withVoice(async f => {
    await configure(f.page); await select(f, 1); await select(f, 0);
    const input = f.page.getByLabel("消息", { exact: true }); await input.fill("原草稿"); const original = await draft(f.page);
    await f.page.getByRole("button", { name: "录音转写", exact: true }).click(); await expect(f.page.getByText("正在录音 · 仅麦克风", { exact: true })).toBeVisible();
    await f.page.getByRole("button", { name: "停止录音并转写", exact: true }).click(); await expect.poll(() => f.transcriptions.length).toBe(1);
    const panel = f.page.getByRole("region", { name: "语音任务", exact: true }); await expect(panel).toContainText("独立的"); await expect(input).toHaveValue("原草稿");
    f.transcriptions[0]!.response.write(`data: ${JSON.stringify({ type: "transcript.text.delta", delta: "分段文字" })}\n\n`); await expect(panel).toContainText("独立的分段文字");
    await input.fill("中间草稿"); await input.fill("原草稿"); const aba = await draft(f.page); expect(aba.digest).toBe(original.digest); expect(aba.draftVersion).toBeGreaterThan(original.draftVersion);
    f.completeTranscription(0, "转写结果 <script>不会执行</script>"); await expect(panel.getByRole("button", { name: "插入转写", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "插入转写", exact: true }).click(); await expect(panel).toContainText("转写仍保留，未覆盖或发送"); await expect(input).toHaveValue("原草稿");
    await holdNextTaskRead(f); await panel.getByRole("button", { name: "插入当前草稿", exact: true }).click(); await expect.poll(() => f.application.evaluate(() => Boolean((globalThis as MainFixture).voiceUiRead?.entered))).toBe(true);
    await input.fill("读取期间修改"); await input.fill("原草稿"); await f.application.evaluate(() => (globalThis as MainFixture).voiceUiRead?.release?.()); await expect(panel.getByRole("button", { name: "插入当前草稿", exact: true })).toBeEnabled(); await expect(input).toHaveValue("原草稿");
    await panel.getByRole("button", { name: "插入当前草稿", exact: true }).click(); await expect(input).toHaveValue("原草稿\n转写结果 <script>不会执行</script>");
    expect((await draft(f.page)).mediaRefs).toEqual([]); const transcript = unwrap(await f.page.evaluate(id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.transcript.list(id), f.bots[0]!.sessionId)); expect(transcript.filter(entry => entry.role === "user")).toEqual([]);
    expect(await f.page.evaluate(() => (window as unknown as BrowserFixture).voiceMicFixture)).toEqual({ requests: [{ audio: true, video: false }], stopped: 1 });
    await f.page.getByRole("button", { name: "录音转写", exact: true }).click(); await expect(f.page.getByText("正在录音 · 仅麦克风", { exact: true })).toBeVisible(); await select(f, 1);
    expect(await f.page.evaluate(() => (window as unknown as BrowserFixture).voiceMicFixture!.stopped)).toBe(2); expect(f.transcriptions).toHaveLength(1);
    await select(f, 0); await expect(input).toHaveValue("原草稿\n转写结果 <script>不会执行</script>"); const recorded = (await tasks(f.page, f.bots[0]!.sessionId))[0]!; expect(recorded.capture).toMatchObject({ draftVersion: original.draftVersion, baseDigest: original.digest });
    await f.page.getByRole("button", { name: "录音转写", exact: true }).click(); await expect(f.page.getByText("正在录音 · 仅麦克风", { exact: true })).toBeVisible();
    await f.page.getByRole("listitem", { name: f.bots[0]!.name, exact: true }).click({ button: "right" }); await f.page.getByRole("menuitem", { name: "清空聊天记录", exact: true }).click();
    await expect.poll(() => f.page.evaluate(() => (window as unknown as BrowserFixture).voiceMicFixture!.stopped)).toBe(3);
    const clear = f.page.getByRole("alertdialog", { name: "清空聊天记录？", exact: true }); await clear.getByRole("button", { name: "清空记录", exact: true }).click(); await expect(clear).toBeHidden();
    await expect.poll(async () => unwrap(await f.page.evaluate(id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.sessions.getMain(id), f.bots[0]!.id)).generation).toBe(recorded.inputGeneration + 1);
    await expect(f.page.getByRole("button", { name: "语音任务 · 0", exact: true })).toBeVisible();
    // Replay a real earlier completion as if it had been queued at the IPC
    // boundary before clearing. The new generation must not display it.
    await f.application.evaluate(({ BrowserWindow }, input) => BrowserWindow.getAllWindows()[0]!.webContents.send(input.channel, { task: input.task }), { channel: VOICE_CHANGED_CHANNEL, task: recorded });
    await f.page.getByRole("button", { name: "语音任务 · 0", exact: true }).click(); await expect(f.page.getByRole("region", { name: "语音任务", exact: true }).locator(".voice-task")).toHaveCount(0);
    expect(f.transcriptions).toHaveLength(1);
  });
});

test("plays actual scoped WAV output through an explicit blocked-play action and discards cancelled queued output", async () => {
  test.setTimeout(90_000);
  await withVoice(async f => {
    await configure(f.page); await select(f, 1); await select(f, 0);
    expect(f.speeches).toHaveLength(0); await expect(f.page.getByLabel("自动朗读本会话新回复", { exact: true })).not.toBeChecked();
    await f.page.evaluate(() => { (window as unknown as BrowserFixture).voiceAudioFixture!.blocked = true; });
    await f.page.getByRole("button", { name: `朗读 ${f.bots[0]!.name} 的回复`, exact: true }).click(); await expect.poll(() => f.speeches.length).toBe(1);
    expect(JSON.parse(f.speeches[0]!.body).input).toBe("历史原文 <script>\n保留原始空白。 "); f.completeSpeech(0);
    await expect(f.page.getByRole("button", { name: "播放语音", exact: true })).toBeVisible();
    const spoken = (await tasks(f.page, f.bots[0]!.sessionId)).find(task => task.kind === "speech")!;
    const audio = unwrap(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.voice.audio(input), { sessionId: f.bots[0]!.sessionId, id: spoken.id }));
    const bytes = Buffer.from(audio.dataBase64, "base64"); expect(bytes.toString("ascii", 0, 4)).toBe("RIFF"); expect(bytes.toString("ascii", 8, 12)).toBe("WAVE"); expect(bytes.readUInt32LE(24)).toBe(24_000); expect(bytes.length).toBe(audio.reference.size);
    await f.page.getByRole("button", { name: "播放语音", exact: true }).click(); expect(await f.page.evaluate(() => (window as unknown as BrowserFixture).voiceAudioFixture!.plays)).toBe(2);
    await f.page.getByRole("button", { name: `朗读 ${f.bots[0]!.name} 的回复`, exact: true }).click(); await f.page.getByRole("button", { name: "停止朗读", exact: true }).click();
    expect(f.speeches).toHaveLength(1); expect(await f.page.evaluate(() => (window as unknown as BrowserFixture).voiceAudioFixture!.pauses)).toBe(1);
    await f.page.getByRole("button", { name: `朗读 ${f.bots[0]!.name} 的回复`, exact: true }).click(); await expect.poll(() => f.speeches.length).toBe(2);
    await f.page.getByRole("button", { name: "停止朗读", exact: true }).click(); await expect.poll(() => f.speeches[1]!.aborted).toBe(true); f.completeSpeech(1);
    await expect.poll(async () => (await tasks(f.page, f.bots[0]!.sessionId)).filter(task => task.kind === "speech" && task.state === "cancelled").length).toBe(1);
    expect(await f.page.evaluate(() => (window as unknown as BrowserFixture).voiceAudioFixture!.players.length)).toBe(1);
    await select(f, 1); await select(f, 0); await expect(f.page.getByLabel("自动朗读本会话新回复", { exact: true })).not.toBeChecked(); expect(f.speeches).toHaveLength(2);
    await f.page.getByRole("button", { name: `朗读 ${f.bots[0]!.name} 的回复`, exact: true }).click(); await expect.poll(() => f.speeches.length).toBe(3);
    await holdNextTaskRead(f, VOICE_CHANNELS.audio); f.completeSpeech(2); await expect.poll(() => f.application.evaluate(() => Boolean((globalThis as MainFixture).voiceUiRead?.entered))).toBe(true);
    await f.page.getByRole("button", { name: "停止朗读", exact: true }).click(); await f.application.evaluate(() => (globalThis as MainFixture).voiceUiRead?.release?.());
    await expect(f.page.getByRole("button", { name: "停止朗读", exact: true })).toHaveCount(0); expect(await f.page.evaluate(() => (window as unknown as BrowserFixture).voiceAudioFixture!.players.length)).toBe(1);
    await f.page.getByRole("button", { name: `朗读 ${f.bots[0]!.name} 的回复`, exact: true }).click(); await expect.poll(() => f.speeches.length).toBe(4); f.completeSpeech(3);
    await expect.poll(() => f.page.evaluate(() => (window as unknown as BrowserFixture).voiceAudioFixture!.players.length)).toBe(2); await f.page.getByRole("button", { name: `朗读 ${f.bots[0]!.name} 的回复`, exact: true }).click();
    await f.page.getByLabel("消息", { exact: true }).fill("清空时保留的草稿");
    // Call the same committed mutation used by AI, without the UI clear dialog
    // or an explicit reopen. The typed Session event must stop local playback.
    unwrap(await f.page.evaluate(id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.conversations.clear(id), f.bots[0]!.sessionId));
    await expect.poll(() => f.page.evaluate(() => (window as unknown as BrowserFixture).voiceAudioFixture!.pauses)).toBe(2);
    await expect(f.page.getByRole("button", { name: "语音任务 · 0", exact: true })).toBeVisible(); expect(f.speeches).toHaveLength(4); await expect(f.page.getByRole("button", { name: "停止朗读", exact: true })).toHaveCount(0);
    await expect(f.page.getByRole("heading", { name: f.bots[0]!.name, exact: true })).toBeVisible(); await expect(f.page.getByLabel("消息", { exact: true })).toHaveValue("清空时保留的草稿");
  });
});

test("queues group speech by live member completion while all six model requests run independently", async () => {
  test.setTimeout(90_000);
  await withVoice(async f => {
    await configure(f.page); await f.page.getByRole("listitem", { name: f.room.name, exact: true }).click(); await expect(f.page.getByRole("heading", { name: f.room.name, exact: true })).toBeVisible();
    await f.page.getByLabel("自动朗读本会话新回复", { exact: true }).check(); const input = f.page.getByLabel("消息", { exact: true }); await input.fill("@"); await f.page.getByRole("option").filter({ hasText: "所有人" }).click(); await input.fill("每位成员分别回复。"); await f.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => f.models.size, { timeout: 15_000 }).toBe(6); expect(f.speeches).toHaveLength(0);
    const order = [5, 3, 1, 4, 2, 0];
    for (let index = 0; index < order.length; index++) { f.completeModel(order[index]!); await expect(f.page.locator('article.message-assistant[data-status="completed"]')).toHaveCount(index + 1); }
    await expect.poll(() => f.speeches.length).toBe(1); expect(JSON.parse(f.speeches[0]!.body).input).toBe(`${f.bots[5]!.name}完成`);
    const snapshot = unwrap(await f.page.evaluate(id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.roomRuntime.getSnapshot(id), f.room.id)) as RoomRuntimeSnapshot;
    expect(snapshot.turns).toHaveLength(6); expect(snapshot.turns.every(turn => turn.state === "completed")).toBe(true);
    f.completeSpeech(0); await expect.poll(async () => f.page.evaluate(() => (window as unknown as BrowserFixture).voiceAudioFixture!.players.length)).toBe(1);
    await f.page.evaluate(() => (window as unknown as BrowserFixture).voiceAudioFixture!.players[0]!.onended?.()); await expect.poll(() => f.speeches.length).toBe(2); expect(JSON.parse(f.speeches[1]!.body).input).toBe(`${f.bots[3]!.name}完成`);
    await f.page.getByRole("button", { name: "停止朗读", exact: true }).click(); await expect.poll(() => f.speeches[1]!.aborted).toBe(true); f.completeSpeech(1); expect(f.speeches).toHaveLength(2);
    await expect(f.page.getByLabel("自动朗读本会话新回复", { exact: true })).not.toBeChecked();
    // Cancelling an active Room batch also clears speech already queued by its
    // completed members, without waiting for the other five model responses.
    f.models.clear(); await f.page.getByLabel("自动朗读本会话新回复", { exact: true }).check();
    await input.fill("@"); await f.page.getByRole("option").filter({ hasText: "所有人" }).click(); await input.fill("第二批独立回复。"); await f.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => f.models.size, { timeout: 15_000 }).toBe(6); f.completeModel(4); await expect.poll(() => f.speeches.length).toBe(3);
    await f.page.getByRole("button", { name: "停止群聊回复", exact: true }).click(); await expect.poll(() => f.speeches[2]!.aborted).toBe(true);
    await expect(f.page.getByLabel("自动朗读本会话新回复", { exact: true })).not.toBeChecked(); expect([...f.models.values()].filter(item => !item.released)).toHaveLength(5);
  }, true);
});
