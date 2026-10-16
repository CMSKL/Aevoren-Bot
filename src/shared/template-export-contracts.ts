import type { BotAvatarColor, BotAvatarShape } from "./bot-avatar";
import type { ResourceFileRef, ResourceReference } from "./library-contracts";
import type { MessageMediaReference } from "./media-contracts";
export type TemplateContext = { sessionId: string; executorBotId: string; runtimeRunId?: string; signal?: AbortSignal };
export type TemplateProfile = { key: string; name: string; label: string; description: string; instructions: string; avatarShape: BotAvatarShape; avatarColor: BotAvatarColor };
export type TemplateResource = { key: string; kind: "document" | "skill"; name: string; description: string; body: string; files: ResourceFileRef[] };
/** Portable data only: no model connection, credentials, grants, messages or executable state. */
export type TemplateManifest = { format: "aevoren-template"; schemaVersion: 1; name: string; description: string; bots: TemplateProfile[]; room: { name: string; description: string; memberKeys: string[]; leadBotKey: string | null } | null; resources: TemplateResource[] };
export type TemplateBundle = TemplateManifest & { files: { sha256: string; dataBase64: string }[] };
export type TemplateCaptureInput = { sessionId: string; name: string; description?: string; bots: { id: string; expectedVersion: number }[]; room?: { id: string; expectedVersion: number; expectedMembershipVersion: number; memberBotIds: string[] }; resources: { reference: ResourceReference; filePaths: string[] }[] };
export type TemplatePreview = { id: string; digest: string; name: string; botNames: string[]; roomName: string | null; resources: { name: string; kind: "document" | "skill"; fileCount: number }[]; fileCount: number; size: number };
export type TemplateCommitInput = { preparedId: string; expectedDigest: string; id?: string; expectedVersion?: number };
export type TemplateMetadata = { id: string; name: string; description: string; version: number; currentRevisionId: string; ownerSessionId: string | null; createdAt: string; updatedAt: string };
export type TemplateRevision = { id: string; templateId: string; number: number; digest: string; manifest: TemplateManifest; createdAt: string };
export type TemplateRecord = { template: TemplateMetadata; revision: TemplateRevision };
export type TemplateReadInput = { id: string; revisionId?: string };
export type TemplateImportInput = { preparedId: string; expectedDigest: string; clientNonce: string; targetSessionId?: string };
export type TemplateImportResult = { clientNonce: string; digest: string; botIds: string[]; roomId: string | null; sessionIds: string[]; resourceRefs: ResourceReference[]; targetSessionId: string | null };
export type OfflineExportInput = { format: "json" | "html"; name?: string; sessions: { sessionId: string; generation: number; entries: { id: string; digest: string }[] }[]; resources: { sessionId: string; reference: ResourceReference; filePaths: string[] }[]; media: { sessionId: string; reference: MessageMediaReference }[] };

export type OfflineSaveResult={name:string;size:number;sha256:string};
export type TemplateApi={
 list():Promise<import("./contracts").ApiResult<TemplateMetadata[]>>;
 read(input:TemplateReadInput):Promise<import("./contracts").ApiResult<TemplateRecord>>;
 versions(id:string):Promise<import("./contracts").ApiResult<Omit<TemplateRevision,"manifest">[]>>;
 prepareCapture(input:TemplateCaptureInput):Promise<import("./contracts").ApiResult<TemplatePreview>>;
 commitCapture(input:TemplateCommitInput):Promise<import("./contracts").ApiResult<TemplateRecord>>;
 prepareImport(input:{dataBase64:string}):Promise<import("./contracts").ApiResult<TemplatePreview>>;
 pickImport():Promise<import("./contracts").ApiResult<TemplatePreview|null>>;
 reviewPrepared(input:{preparedId:string;expectedDigest:string}):Promise<import("./contracts").ApiResult<TemplateManifest>>;
 commitImport(input:TemplateImportInput):Promise<import("./contracts").ApiResult<TemplateImportResult>>;
 export(input:TemplateReadInput):Promise<import("./contracts").ApiResult<OfflineSaveResult|null>>;
};
export type ExportsApi={save(input:OfflineExportInput):Promise<import("./contracts").ApiResult<OfflineSaveResult|null>>};
export type TemplateApprovalReview={kind:"portable-template";resourceName:string;revisionNumber:number;target:{sessionId:string;executorBotId:string;preparedId:string;expectedDigest:string;operation:"templates.commitCapture"|"templates.commitImport";manifest:TemplateManifest}};
