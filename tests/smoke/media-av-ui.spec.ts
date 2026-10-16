import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import type { MediaApi, MediaImportResult, MediaItem, MessageMediaReference } from "../../src/shared/media-contracts";
import { inspectAvHeader } from "../../src/shared/media-av-format";
import { MEDIA_CHANNELS } from "../../src/shared/media-channels";
import { PRODUCT_VIEW_DOM_EVENT, type ProductViewInput, type ProductViewResult } from "../../src/shared/product-view";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { wavFixture } from "../fixtures/media-av-data";
import { recording } from "../fixtures/media-av-encoding";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";

type MediaMethod = Exclude<keyof MediaApi, "onChanged">;
type Barrier = { entered: boolean; release?: () => void; returned: boolean };
type Globals = typeof globalThis & { avPreviewBarrier?: Barrier };
function value<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
async function call<T>(page: Page, method: MediaMethod, input: unknown): Promise<T> {
  return value(await page.evaluate(async ({ method, input }) => {
    const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.media as unknown as Record<MediaMethod, (input: unknown) => Promise<ApiResult<T>>>;
    return api[method](input);
  }, { method, input }));
}
async function view(page: Page, input: ProductViewInput): Promise<ProductViewResult> {
  return page.evaluate(({ name, input }) => new Promise<ProductViewResult>(resolve => {
    window.dispatchEvent(new CustomEvent(name, { detail: { request: { id: crypto.randomUUID(), input }, respond: resolve } }));
  }), { name: PRODUCT_VIEW_DOM_EVENT, input });
}

test("actual local audio/video controls decode owned bytes without autoplay and purge playback plus late replies on revoke", async () => {
  test.setTimeout(process.platform === "win32" ? 120_000 : 60_000);
  const data = mkdtempSync(join(tmpdir(), "aevoren-av-ui-")), source = join(data, "source"); mkdirSync(source); writeFileSync(join(source, "own.wav"), wavFixture(1_000));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite")), workspace = await new WorkspaceService(repository).registerRoot(source), created = repository.createBot(workspace.project.id);
  repository.updateBot(created.bot.id, created.bot.version, { name: "本地媒体验证" }); repository.setSetting("memory.capture.enabled", "false", false); repository.close();
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: { ...process.env,
    AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" } });
  try {
    if (executablePath) expect(await application.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))).toEqual({ packaged: true, version: JSON.parse(readFileSync("package.json", "utf8")).version });
    const page = await application.firstWindow(); await expect(page.locator(".app-shell")).toBeVisible(); await page.getByRole("listitem", { name: "本地媒体验证", exact: true }).click();
    writeFileSync(join(source, "own.webm"), await recording(application, true));
    const imported: MediaItem[] = [];
    for (const path of ["own.wav", "own.webm"]) {
      const result = await call<MediaImportResult>(page, "importPath", { sessionId: created.session.id, workspaceId: workspace.workspace.id, path });
      if (result.failed.length) {
        const bytes = readFileSync(join(source, path)); let header: ReturnType<typeof inspectAvHeader> | "invalid";
        try { header = inspectAvHeader(bytes); } catch { header = "invalid"; }
        await test.info().attach("controlled-av-import-failure", { body: JSON.stringify({ name: path, byteSize: bytes.length, header, failed: result.failed }), contentType: "application/json" });
      }
      expect(result.failed, `Import failures for controlled ${path}`).toEqual([]);
      imported.push(...result.imported);
    }
    expect(imported.map(item => item.asset.kind)).toEqual(["audio", "video"]); expect(imported.every(item => item.asset.durationMs! > 100)).toBe(true);
    const draft = (await view(page, { action: "draft_get" })).result as { digest: string; draftVersion: number };
    expect((await view(page, { action: "draft_update", expectedDigest: draft.digest, expectedDraftVersion: draft.draftVersion, mediaRefs: imported.map(item => item.reference) })).status).toBe("completed");
    const dialog = page.getByRole("dialog", { name: "媒体预览", exact: true });
    await page.getByRole("button", { name: "预览媒体 own.webm", exact: true }).click();
    const video = dialog.locator("video"); await expect(video).toHaveCount(1);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => ({ width: element.videoWidth, height: element.videoHeight, paused: element.paused, autoplay: element.autoplay }))).toEqual({ width: 32, height: 24, paused: true, autoplay: false });
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    // A readyState alone does not attest a presented frame in a hidden window.
    // Seek the paused preview and wait for a real compositor frame before readback.
    const presented = await video.evaluate(async (element: HTMLVideoElement) => {
      const frame = new Promise<VideoFrameCallbackMetadata>(resolve => element.requestVideoFrameCallback((_time, metadata) => resolve(metadata)));
      const seeked = new Promise<void>((resolve, reject) => { element.addEventListener("seeked", () => resolve(), { once: true }); element.addEventListener("error", reject, { once: true }); });
      element.currentTime = Math.min(0.1, element.duration / 2); await seeked; const metadata = await frame;
      const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 24; const ctx = canvas.getContext("2d")!; ctx.drawImage(element, 0, 0);
      return { pixel: [...ctx.getImageData(16, 12, 1, 1).data], paused: element.paused, mediaTime: metadata.mediaTime, frames: metadata.presentedFrames };
    });
    await test.info().attach("av-presented-frame", { body: JSON.stringify(presented), contentType: "application/json" });
    expect(presented.paused).toBe(true); expect(presented.frames).toBeGreaterThan(0);
    const pixel = presented.pixel;
    expect(pixel[0]).toBeGreaterThan(180); expect(pixel[1]).toBeLessThan(80); expect(pixel[2]).toBeLessThan(80);
    await video.evaluate((element: HTMLVideoElement) => { (window as unknown as { heldAvVideo: HTMLMediaElement }).heldAvVideo = element; });
    await dialog.getByRole("button", { name: "关闭媒体预览", exact: true }).click();
    expect(await page.evaluate(() => { const held = (window as unknown as { heldAvVideo: HTMLMediaElement }).heldAvVideo; return { paused: held.paused, src: held.getAttribute("src") }; })).toEqual({ paused: true, src: null });
    await page.getByRole("button", { name: "预览媒体 own.wav", exact: true }).click(); const audio = dialog.locator("audio"); await expect(audio).toHaveCount(1);
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(2); expect(await audio.evaluate((element: HTMLAudioElement) => element.paused && !element.autoplay)).toBe(true);
    await audio.evaluate(async (element: HTMLAudioElement) => { (window as unknown as { heldAvPlayer: HTMLMediaElement }).heldAvPlayer = element; element.muted = true; await element.play(); });
    const reference = imported[0]!.reference, input = { sessionId: created.session.id, id: reference.mediaId };
    await call(page, "unbind", input); await expect(dialog.getByRole("alert")).toContainText("预览内容已清除"); await expect(audio).toHaveCount(0);
    expect(await page.evaluate(() => { const held = (window as unknown as { heldAvPlayer: HTMLMediaElement }).heldAvPlayer; return { paused: held.paused, src: held.getAttribute("src") }; })).toEqual({ paused: true, src: null });
    await dialog.getByRole("button", { name: "关闭媒体预览", exact: true }).click(); await call(page, "bind", input);
    const rebound = await call<MediaItem>(page, "metadata", input), currentDraft = (await view(page, { action: "draft_get" })).result as { digest: string; draftVersion: number };
    const currentRefs = [rebound.reference, imported[1]!.reference];
    expect((await view(page, { action: "draft_update", expectedDigest: currentDraft.digest, expectedDraftVersion: currentDraft.draftVersion, mediaRefs: currentRefs })).status).toBe("completed");
    await application.evaluate(({ ipcMain }, channel) => {
      const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers, original = map.get(channel)!;
      const state = globalThis as Globals; state.avPreviewBarrier = { entered: false, returned: false }; ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => { const result = await original(...args); if (!(result as { ok?: boolean }).ok) throw new Error("Expected actual authorized playback bytes before the barrier"); state.avPreviewBarrier!.entered = true; await new Promise<void>(resolve => { state.avPreviewBarrier!.release = resolve; }); state.avPreviewBarrier!.returned = true; return result; });
    }, MEDIA_CHANNELS.preview);
    await page.getByRole("button", { name: "预览媒体 own.wav", exact: true }).click();
    await expect.poll(() => application.evaluate(() => Boolean((globalThis as Globals).avPreviewBarrier?.entered))).toBe(true);
    await call(page, "unbind", input); await expect(dialog.getByRole("alert")).toContainText("预览内容已清除"); await application.evaluate(() => (globalThis as Globals).avPreviewBarrier?.release?.());
    await expect.poll(() => application.evaluate(() => Boolean((globalThis as Globals).avPreviewBarrier?.returned))).toBe(true); await expect(dialog.locator("audio,video")).toHaveCount(0);
    const current = (await view(page, { action: "draft_get" })).result as { mediaRefs: MessageMediaReference[] }; expect(current.mediaRefs).toEqual(currentRefs);
    await dialog.getByRole("button", { name: "关闭媒体预览", exact: true }).click();
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))).toBe(false);
  } finally { await closeTestApplication(application); removeTestDirectory(data); }
});
