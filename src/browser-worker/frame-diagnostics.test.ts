import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { CDPSession, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserEngine } from "./engine";

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

type Phase = "focus-before" | "document-version-before" | "focus-after" | "document-version-after";
async function fixture(phase: Phase) {
  const engine = new BrowserEngine({ browserSessionId: randomUUID(), profileDirectory: "PRIVATE_PROFILE", downloadsDirectory: "PRIVATE_DOWNLOADS" });
  await engine.perform("control", { owner: "ai", epoch: 7, needsObservation: false });
  let focused = phase !== "focus-before", focusChecks = 0;
  const record = { id: randomUUID(), version: 4, createdAt: "PRIVATE_CREATED_AT", page: null as unknown as Page, session: null as unknown as CDPSession };
  record.page = {
    bringToFront: vi.fn(async () => {}), isClosed: () => false,
    evaluate: vi.fn(async () => { if (phase === "document-version-before") record.version++; return { text: "PRIVATE_DOM_BODY", truncated: false }; }),
    $$: vi.fn(async () => []), url: () => "https://private.invalid/?token=PRIVATE_CAPABILITY", title: async () => "PRIVATE_TITLE",
  } as unknown as Page;
  record.session = { send: vi.fn(async (method: string, input?: Record<string, unknown>) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "PRIVATE_FRAME_ID" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 17 };
    if (method === "Runtime.evaluate") {
      if (input?.expression === "document.hasFocus()") { focusChecks++; return { result: { value: focused } }; }
      return { result: { value: input?.awaitPromise ? false : null } };
    }
    throw new Error("Unexpected controlled CDP request");
  }) } as unknown as CDPSession;
  const internals = engine as unknown as { pages: Map<string, typeof record>; runProgram(): Promise<Buffer> };
  internals.pages.set(record.id, record);
  const capture = vi.spyOn(internals, "runProgram").mockImplementation(async () => {
    if (phase === "focus-after") focused = false;
    if (phase === "document-version-after") record.version++;
    return Buffer.from("PRIVATE_CAPTURE_BYTES");
  });
  return { engine, record, capture, focusChecks: () => focusChecks };
}

describe("opt-in stale frame diagnostics", () => {
  it.each<Phase>(["focus-before", "document-version-before", "focus-after", "document-version-after"])("reports %s without weakening its 409 guard or reading extra focus data", async phase => {
    vi.stubEnv("AEVOREN_BROWSER_DIAGNOSTICS", "1");
    const f = await fixture(phase);
    await expect(f.engine.perform("desktop-frame", { actor: "ai", expectedEpoch: 7, pageId: f.record.id })).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_STALE", status: 409 });
    expect(f.capture).toHaveBeenCalledTimes(phase.endsWith("before") ? 0 : 1);
    expect(f.focusChecks()).toBe(phase.endsWith("before") ? 1 : 2);
    expect(writeFile).toHaveBeenCalledOnce();
    const [path, bytes, options] = vi.mocked(writeFile).mock.calls[0]!;
    expect(path).toBe("/tmp/aevoren-frame-diagnostics.json"); expect(options).toEqual({ mode: 0o600 });
    const diagnostic = JSON.parse(String(bytes)) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({ phase, desktop: true, ai: true, expectedEpoch: 7, currentEpoch: 7, ownerIsAi: true,
      pageKnown: true, pageClosed: false, pageCount: 1, versionBefore: 4, versionAfter: phase.startsWith("document-version") ? 5 : 4 });
    const { focusChecks, ...scalar } = diagnostic;
    expect(Object.values(scalar).every(value => value === phase || value === null || typeof value === "boolean" || typeof value === "number")).toBe(true);
    expect(focusChecks).toEqual([{ focused: phase !== "focus-before" && phase !== "focus-after", closed: false, stage: 3, exception: false }]);
    expect(String(bytes)).not.toContain("PRIVATE_");
  });

  it.each(["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate"])("classifies an existing %s failure without recording provider error text", async method => {
    vi.stubEnv("AEVOREN_BROWSER_DIAGNOSTICS", "1");
    const f = await fixture("focus-before"), original = vi.mocked(f.record.session.send).getMockImplementation()!;
    vi.mocked(f.record.session.send).mockImplementation(async (name, ...args) => {
      if (name === method) throw new Error("PRIVATE_CDP_ERROR_WITH_URL_AND_TOKEN");
      return Reflect.apply(original, f.record.session, [name, ...args]);
    });
    await expect(f.engine.perform("desktop-frame", { actor: "ai", expectedEpoch: 7, pageId: f.record.id })).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_STALE", status: 409 });
    const diagnostic = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1]));
    expect(diagnostic.focusChecks).toEqual([{ focused: false, closed: false, stage: ["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate"].indexOf(method), exception: false }]);
    expect(f.capture).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_");
  });

  it("records only the presence of a JavaScript exception in the trusted focus result", async () => {
    vi.stubEnv("AEVOREN_BROWSER_DIAGNOSTICS", "1");
    const f = await fixture("focus-before"), original = vi.mocked(f.record.session.send).getMockImplementation()!;
    vi.mocked(f.record.session.send).mockImplementation(async (name, ...args) => name === "Runtime.evaluate"
      ? { result: { value: false }, exceptionDetails: { text: "PRIVATE_FOCUS_EXCEPTION" } }
      : Reflect.apply(original, f.record.session, [name, ...args]));
    await expect(f.engine.perform("desktop-frame", { actor: "ai", expectedEpoch: 7, pageId: f.record.id })).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_STALE", status: 409 });
    const diagnostic = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1]));
    expect(diagnostic.focusChecks).toEqual([{ focused: false, closed: false, stage: 3, exception: true }]);
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_");
    expect(f.capture).not.toHaveBeenCalled();
  });

  it("does not write diagnostics unless explicitly enabled", async () => {
    vi.stubEnv("AEVOREN_BROWSER_DIAGNOSTICS", "0");
    const f = await fixture("focus-before");
    await expect(f.engine.perform("desktop-frame", { actor: "ai", expectedEpoch: 7, pageId: f.record.id })).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_STALE", status: 409 });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("does not replace a control-epoch rejection with stale-frame diagnostics", async () => {
    vi.stubEnv("AEVOREN_BROWSER_DIAGNOSTICS", "1");
    const f = await fixture("focus-before");
    await expect(f.engine.perform("desktop-frame", { actor: "ai", expectedEpoch: 6, pageId: f.record.id })).rejects.toMatchObject({ code: "BROWSER_CONTROL_CHANGED", status: 409 });
    expect(writeFile).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled();
  });
});
