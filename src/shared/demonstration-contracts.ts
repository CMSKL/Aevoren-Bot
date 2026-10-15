import type { ApiResult } from "./contracts";
import type { BrowserScope } from "./browser-contracts";
import type { LibraryContent } from "./library-contracts";
export const DEMONSTRATION_MAX_EVENTS = 500;
export type DemonstrationEvent = { kind: "pointer"; x: number; y: number; buttons: number } | { kind: "key"; key: "Enter" | "Tab" | "Escape" | "Backspace" | "Delete" | "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End" | "PageUp" | "PageDown"; down: boolean } | { kind: "redacted-text" };
export type DemonstrationCapture = { id: string; browserSessionId: string; epoch: number; state: "recording" | "stopped" | "interrupted"; reason: "disconnect" | "control-changed" | "restart" | "limit" | "unsupported-input" | null; eventCount: number; createdAt: string; updatedAt: string };
export type DemonstrationSnapshot = DemonstrationCapture & { events: DemonstrationEvent[] };
export type DemonstrationDraft = BrowserScope & { id: string; captureId: string; browserSessionId: string; epoch: number; state: "draft" | "published"; version: number; name: string; body: string; digest: string; captureState: DemonstrationCapture["state"]; publishedResourceId: string | null; createdAt: string; updatedAt: string };
export type DemonstrationRecordInput = BrowserScope & { expectedEpoch: number; id?: string };
export type DemonstrationDraftInput = BrowserScope & { id: string };
export type DemonstrationUpdateInput = DemonstrationDraftInput & { expectedVersion: number; name: string; body: string };
export type DemonstrationPublishInput = DemonstrationDraftInput & { expectedVersion: number; expectedDigest: string };
export type DemonstrationApi = {
  status(input: BrowserScope): Promise<ApiResult<DemonstrationCapture | null>>;
  start(input: DemonstrationRecordInput & { id: string }): Promise<ApiResult<DemonstrationCapture>>;
  stop(input: DemonstrationRecordInput & { id: string }): Promise<ApiResult<DemonstrationDraft>>;
  discard(input: DemonstrationRecordInput & { id: string }): Promise<ApiResult<boolean>>;
  drafts(input: BrowserScope): Promise<ApiResult<DemonstrationDraft[]>>;
  deleteDraft(input: DemonstrationDraftInput & { expectedVersion: number }): Promise<ApiResult<boolean>>;
  readDraft(input: DemonstrationDraftInput): Promise<ApiResult<DemonstrationDraft>>;
  updateDraft(input: DemonstrationUpdateInput): Promise<ApiResult<DemonstrationDraft>>;
  publish(input: DemonstrationPublishInput): Promise<ApiResult<LibraryContent>>;
};

export type DemonstrationApprovalReviewSnapshot = { kind: "demonstration-skill"; resourceName: string; revisionNumber: number; target: BrowserScope & { draftId: string; draftVersion: number; draftDigest: string; body: string; initiallyEnabled: false } };
