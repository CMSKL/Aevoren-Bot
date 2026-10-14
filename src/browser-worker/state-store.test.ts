import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { BrowserStateStore } from "./state-store";

describe("private browser control state", () => {
  it("seals a new lease even for a repeated same-owner control request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aevoren-browser-state-"));
    const store = new BrowserStateStore(join(directory, "state.sqlite"), randomUUID());
    try {
      expect(store.transition("user", 1).epoch).toBe(2);
      expect(store.transition("user", 2)).toEqual({ owner: "user", epoch: 3, needsObservation: true });
      expect(() => store.transition("ai", 2)).toThrow("BROWSER_CONTROL_CHANGED");
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("invalidates old epochs and persists human takeover through restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aevoren-browser-state-"));
    const id = randomUUID(), path = join(directory, "state.sqlite");
    try {
      let store = new BrowserStateStore(path, id);
      expect(store.control()).toEqual({ owner: "ai", epoch: 1, needsObservation: true });
      store.observed(1);
      expect(store.control().needsObservation).toBe(false);
      expect(store.transition("user", 1)).toEqual({ owner: "user", epoch: 2, needsObservation: true });
      expect(() => store.assertAI(2)).toThrow("BROWSER_USER_CONTROL");
      expect(() => store.transition("ai", 1)).toThrow("BROWSER_CONTROL_CHANGED");
      store.close();
      store = new BrowserStateStore(path, id);
      expect(store.control()).toEqual({ owner: "user", epoch: 3, needsObservation: true });
      expect(store.transition("ai", 3)).toEqual({ owner: "ai", epoch: 4, needsObservation: true });
      expect(() => store.observed(1)).toThrow("BROWSER_CONTROL_CHANGED");
      store.observed(4);
      expect(store.control().needsObservation).toBe(false);
      store.close();
      expect(() => new BrowserStateStore(path, randomUUID())).toThrow("BROWSER_IDENTITY_INVALID");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
