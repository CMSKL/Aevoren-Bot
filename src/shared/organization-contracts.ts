import type { ApiResult } from "./contracts";

export type SidebarSection = { id: string; name: string; position: number };
export type SidebarAssignment = { sessionId: string; sectionId: string | null; position: number };
export type OrganizationNotifications = { approvals: boolean; taskCompletion: boolean; taskFailure: boolean; routines: boolean };
export type OrganizationPreferences = { defaultAssistantBotId: string | null; notifications: OrganizationNotifications; sound: boolean };
/** One version covers sections, assignments and preferences; conflicts retain the caller's draft. */
export type OrganizationSnapshot = { version: number; sections: SidebarSection[]; assignments: SidebarAssignment[]; preferences: OrganizationPreferences };
export type OrganizationContext = { sessionId: string; executorBotId: string; runtimeRunId?: string };
export type OrganizationCreateSection = { expectedVersion: number; name: string };
export type OrganizationRenameSection = OrganizationCreateSection & { id: string };
export type OrganizationDeleteSection = { expectedVersion: number; id: string };
export type OrganizationReorderSections = { expectedVersion: number; sectionIds: string[] };
export type OrganizationMoveSession = { expectedVersion: number; sessionId: string; sectionId: string | null; position?: number };
export type OrganizationSavePreferences = { expectedVersion: number; patch: { defaultAssistantBotId?: string | null; notifications?: Partial<OrganizationNotifications>; sound?: boolean } };
export type OrganizationChanged={version:number};
export type OrganizationApi = {
  onChanged(listener:(event:OrganizationChanged)=>void):()=>void;
  snapshot(): Promise<ApiResult<OrganizationSnapshot>>;
  createSection(input: OrganizationCreateSection): Promise<ApiResult<OrganizationSnapshot>>;
  renameSection(input: OrganizationRenameSection): Promise<ApiResult<OrganizationSnapshot>>;
  deleteSection(input: OrganizationDeleteSection): Promise<ApiResult<OrganizationSnapshot>>;
  reorderSections(input: OrganizationReorderSections): Promise<ApiResult<OrganizationSnapshot>>;
  moveSession(input: OrganizationMoveSession): Promise<ApiResult<OrganizationSnapshot>>;
  savePreferences(input: OrganizationSavePreferences): Promise<ApiResult<OrganizationSnapshot>>;
};
