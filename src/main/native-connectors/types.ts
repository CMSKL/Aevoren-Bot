// Credentials and binary content remain in the main process. These types must
// never be re-exported by the renderer/preload or included in tool metadata.
export type NativeConnectorProvider = "gmail" | "drive" | "notion";

export type GoogleCredentials = {
  kind: "google";
  provider: "gmail" | "drive";
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
};
export type NativeCredentials = GoogleCredentials | { kind: "notion"; token: string };
export type NativeIdentity = { accountId: string; displayName: string; email?: string };
export type NativeAuthorization = {
  credentials: NativeCredentials;
  // The host checks the persisted connection/grant versions, scope, account
  // and running task both before dispatch and before releasing the result.
  assertCurrent(): void;
  signal?: AbortSignal;
};
export type NativeSearchItem = { id: string; title: string; kind: string; modifiedAt?: string };
export type NativeSearchResult = { items: NativeSearchItem[]; nextCursor: string | null; scopeNotice: string };
export type NativeReadResult = {
  id: string;
  title: string;
  mimeType: string;
  text: string;
  truncated: boolean;
  metadata: Record<string, string | number | boolean | null>;
  attachments?: { id: string; filename: string; mimeType: string; size: number }[];
  // The host imports owned bytes before exposing a MediaRef. No byte array or
  // third-party signed download URL is returned to the model or renderer.
  bytes?: Uint8Array;
};

export type NativeConnectorErrorCode = "AUTH_REQUIRED" | "AUTH_INVALID" | "AUTH_CANCELLED" | "AUTH_TIMEOUT"
  | "REQUEST_FAILED" | "RESPONSE_INVALID" | "RESOURCE_NOT_ALLOWED" | "TOO_LARGE";
export class NativeConnectorError extends Error {
  constructor(public readonly code: NativeConnectorErrorCode, public readonly status?: number) {
    // Do not retain a provider error body, URL, token, or thrown fetch cause.
    super(`Native connector: ${code}`);
    this.name = "NativeConnectorError";
  }
}
