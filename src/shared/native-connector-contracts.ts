import type { EnvironmentScope } from "./environment-contracts";

export type ConnectorProvider = "gmail" | "drive" | "notion";
export type ConnectorIdentity = { accountId: string; displayName: string; email?: string };
export type NativeConnection = {
  id: string; provider: ConnectorProvider; name: string; state: "configured" | "authorizing" | "connected" | "revoked" | "auth-required";
  version: number; authVersion: number; account: ConnectorIdentity | null; scopes: string[];
  selectedFileIds: string[]; createdFileIds: string[]; createdAt: string; updatedAt: string;
};
/** Credentials are UI input only. They are never returned or described as AI tool arguments. */
export type ConnectorConfigureInput = {
  id?: string; expectedVersion?: number; provider: ConnectorProvider; name: string;
  clientId?: string; clientSecret?: string; token?: string;
};
export type ConnectorIdInput = { id: string; expectedVersion: number };
export type ConnectorListInput = { provider?: ConnectorProvider };
export type ConnectorBinding = EnvironmentScope & {
  id: string; connectionId: string; authVersion: number; version: number; allowedResourceIds: string[];
  createdAt: string; updatedAt: string; revokedAt: string | null;
};
export type ConnectorBindingsInput = EnvironmentScope & { includeRevoked?: boolean };
export type ConnectorBindInput = EnvironmentScope & { connectionId: string; expectedAuthVersion: number; allowedResourceIds?: string[]; expectedVersion?: number };
export type ConnectorUnbindInput = EnvironmentScope & { id: string; expectedVersion: number };
export type ConnectorAccessInput = EnvironmentScope & { connectionId: string; expectedAuthVersion: number; expectedBindingVersion: number };
export type ConnectorSearchInput = ConnectorAccessInput & { query: string; cursor?: string; limit?: number };
export type ConnectorReadInput = ConnectorAccessInput & { resourceId: string };
export type ConnectorSearchResult = {
  items: { id: string; title: string; kind: string; modifiedAt?: string }[]; nextCursor: string | null; scopeNotice: string;
};
export type ConnectorReadResult = {
  id: string; title: string; mimeType: string; text: string; truncated: boolean;
  metadata: Record<string, string | number | boolean | null>;
  attachments?: { id: string; filename: string; mimeType: string; size: number }[];
  binaryContentAvailable: boolean;
};
export type ConnectorDraftContent =
  | { kind: "gmail-message"; to: string[]; cc: string[]; subject: string; body: string }
  | { kind: "drive-text"; targetFileId: string | null; title: string; text: string }
  | { kind: "notion-page"; parentPageId: string; title: string; text: string };
export type ConnectorDraft = EnvironmentScope & {
  id: string; connectionId: string; accountId: string; authVersion: number; version: number; latestRevisionId: string;
  createdAt: string; updatedAt: string; deletedAt: string | null; state: "local-draft";
};
export type ConnectorDraftRevision = { id: string; draftId: string; number: number; digest: string; content: ConnectorDraftContent; createdAt: string };
export type ConnectorDraftResult = { draft: ConnectorDraft; revision: ConnectorDraftRevision; authorized: boolean };
export type ConnectorDraftCreateInput = ConnectorAccessInput & { content: ConnectorDraftContent; clientNonce?: string };
export type ConnectorDraftUpdateInput = EnvironmentScope & { id: string; expectedVersion: number; content: ConnectorDraftContent };
export type ConnectorDraftReadInput = EnvironmentScope & { id: string; revisionId?: string };
export type ConnectorDraftDeleteInput = EnvironmentScope & { id: string; expectedVersion: number };

export type NativeConnectorsApi = {
  list(input?: ConnectorListInput): Promise<import("./contracts").ApiResult<NativeConnection[]>>;
  configure(input: ConnectorConfigureInput): Promise<import("./contracts").ApiResult<NativeConnection>>;
  authorize(input: ConnectorIdInput): Promise<import("./contracts").ApiResult<NativeConnection>>;
  cancelAuthorization(input: ConnectorIdInput): Promise<import("./contracts").ApiResult<NativeConnection>>;
  revoke(input: ConnectorIdInput): Promise<import("./contracts").ApiResult<NativeConnection>>;
  bindings(input: ConnectorBindingsInput): Promise<import("./contracts").ApiResult<ConnectorBinding[]>>;
  bind(input: ConnectorBindInput): Promise<import("./contracts").ApiResult<ConnectorBinding>>;
  unbind(input: ConnectorUnbindInput): Promise<import("./contracts").ApiResult<ConnectorBinding>>;
  search(input: ConnectorSearchInput): Promise<import("./contracts").ApiResult<ConnectorSearchResult>>;
  read(input: ConnectorReadInput): Promise<import("./contracts").ApiResult<ConnectorReadResult>>;
};
export type ConnectorDraftsApi = {
  list(input: EnvironmentScope): Promise<import("./contracts").ApiResult<ConnectorDraft[]>>;
  create(input: ConnectorDraftCreateInput): Promise<import("./contracts").ApiResult<ConnectorDraftResult>>;
  update(input: ConnectorDraftUpdateInput): Promise<import("./contracts").ApiResult<ConnectorDraftResult>>;
  read(input: ConnectorDraftReadInput): Promise<import("./contracts").ApiResult<ConnectorDraftResult>>;
  versions(input: Omit<ConnectorDraftReadInput, "revisionId">): Promise<import("./contracts").ApiResult<Omit<ConnectorDraftRevision, "content">[]>>;
  delete(input: ConnectorDraftDeleteInput): Promise<import("./contracts").ApiResult<ConnectorDraft>>;
};
