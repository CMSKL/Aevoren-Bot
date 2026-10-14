import type { ApiResult } from "./contracts";

export type LibraryResourceKind = "document" | "skill";

export type LibraryResource = {
  id: string;
  kind: LibraryResourceKind;
  name: string;
  description: string;
  version: number;
  currentRevisionId: string;
  enabled: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Relative paths refer to application-owned immutable bytes, never source paths. */
export type ResourceFileRef = {
  relativePath: string;
  size: number;
  mimeType: string;
  sha256: string;
};

/** Immutable application-owned media metadata; content is retrieved through its scoped host operation. */
export type MediaRef = { id: string; name: string; size: number; mimeType: string; sha256: string };

export type ResourceRevision = {
  id: string;
  resourceId: string;
  number: number;
  name: string;
  description: string;
  body: string;
  digest: string;
  files: ResourceFileRef[];
  createdAt: string;
};

export type ResourceRevisionSummary = Omit<ResourceRevision, "body" | "files"> & { fileCount: number };
export type ResourceReference = { resourceId: string; revisionId: string; digest: string };
export type SessionResourceBinding = {
  sessionId: string;
  resourceId: string;
  version: number;
  createdAt: string;
};
export type LibraryContent = { resource: LibraryResource; revision: ResourceRevision; reference: ResourceReference };

export type LibraryVisibility = { includeDisabled?: boolean; includeDeleted?: boolean };
export type LibraryListInput = LibraryVisibility & { sessionId: string; kind?: LibraryResourceKind; query?: string };
export type LibraryAvailableInput = LibraryVisibility & { kind?: LibraryResourceKind; query?: string };
export type LibraryReadInput = LibraryVisibility & { sessionId: string; id: string; revisionId?: string };
export type LibraryCreateInput = {
  sessionId: string;
  kind: LibraryResourceKind;
  name: string;
  description?: string;
  body: string;
};
export type LibraryUpdateInput = {
  sessionId: string;
  id: string;
  expectedVersion: number;
  name?: string;
  description?: string;
  body?: string;
};
export type LibraryMutationInput = { sessionId: string; id: string; expectedVersion: number };
export type LibraryBindingInput = { sessionId: string; id: string };
export type LibraryVersionsInput = LibraryVisibility & { sessionId: string; id: string };
export type LibraryRestoreVersionInput = LibraryMutationInput & { revisionId: string };
export type LibraryImportResult = { imported: LibraryContent[]; skipped: { name: string; reason: string }[] };
export type LibraryExportResult = { resourceId: string; revisionId: string; path: string };
export type LibraryChangedEvent = { sessionId: string; resourceId: string; action: "created" | "updated" | "enabled" | "deleted" | "restored" | "bound" | "unbound" };

export type LibraryApi = {
  readFile(input: { sessionId: string; id: string; revisionId: string; path: string }): Promise<ApiResult<ResourceFileRef & { encoding: "utf8" | "base64"; data: string }>>;
  list(input: LibraryListInput): Promise<ApiResult<LibraryResource[]>>;
  available(input?: LibraryAvailableInput): Promise<ApiResult<LibraryResource[]>>;
  read(input: LibraryReadInput): Promise<ApiResult<LibraryContent>>;
  create(input: LibraryCreateInput): Promise<ApiResult<LibraryContent>>;
  importText(input: LibraryCreateInput): Promise<ApiResult<LibraryContent>>;
  update(input: LibraryUpdateInput): Promise<ApiResult<LibraryContent>>;
  setEnabled(input: LibraryMutationInput & { enabled: boolean }): Promise<ApiResult<LibraryResource>>;
  delete(input: LibraryMutationInput): Promise<ApiResult<LibraryResource>>;
  restore(input: LibraryMutationInput): Promise<ApiResult<LibraryResource>>;
  versions(input: LibraryVersionsInput): Promise<ApiResult<ResourceRevisionSummary[]>>;
  restoreVersion(input: LibraryRestoreVersionInput): Promise<ApiResult<LibraryContent>>;
  bind(input: LibraryBindingInput): Promise<ApiResult<SessionResourceBinding>>;
  unbind(input: LibraryBindingInput): Promise<ApiResult<boolean>>;
  pickImport(input: { sessionId: string; kind: LibraryResourceKind; directory?: boolean }): Promise<ApiResult<LibraryImportResult | null>>;
  importPath(input: { sessionId: string; kind: LibraryResourceKind; workspaceId: string; path: string }): Promise<ApiResult<LibraryImportResult>>;
  export(input: { sessionId: string; id: string; revisionId?: string }): Promise<ApiResult<LibraryExportResult | null>>;
  onChanged(listener: (event: LibraryChangedEvent) => void): () => void;
};
