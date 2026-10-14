import type { ControlRecord } from "./state-store";

export type EngineAction = "pages" | "create" | "close-page" | "observe" | "navigate" | "action" | "frame" | "desktop-frame" | "computer-action" | "read-download" | "control" | "cancel" | "shutdown";
export type EngineRequest = { type: "request"; id: string; action: EngineAction; payload: Record<string, unknown> | ControlRecord };
export type EngineResponse = { type: "response"; id: string; ok: true; value: unknown } | { type: "response"; id: string; ok: false; code: string; status: number };
export type EngineEvent = { type: "ready" } | { type: "browser-stopped" } | { type: "download"; download: { id: string; pageId: string; name: string; size: number; sha256: string; createdAt: string } }
  | { type: "download-error"; error: { id: string; pageId: string; name: string; errorCode: string; createdAt: string } };
