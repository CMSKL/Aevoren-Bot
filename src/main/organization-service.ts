import type { OrganizationContext, OrganizationCreateSection, OrganizationDeleteSection, OrganizationMoveSession, OrganizationRenameSection, OrganizationReorderSections, OrganizationSavePreferences } from "@shared/organization-contracts";
import type { OrganizationRepository } from "./organization-repository";

/** UI and product handlers share the same validated, transactional repository path. */
export class OrganizationService {
  constructor(private readonly repository: OrganizationRepository) {}
  snapshot(context?: OrganizationContext) { return this.repository.snapshot(context); }
  createSection(input: OrganizationCreateSection, context?: OrganizationContext) { return this.repository.createSection(input, context); }
  renameSection(input: OrganizationRenameSection, context?: OrganizationContext) { return this.repository.renameSection(input, context); }
  deleteSection(input: OrganizationDeleteSection, context?: OrganizationContext) { return this.repository.deleteSection(input, context); }
  reorderSections(input: OrganizationReorderSections, context?: OrganizationContext) { return this.repository.reorderSections(input, context); }
  moveSession(input: OrganizationMoveSession, context?: OrganizationContext) { return this.repository.moveSession(input, context); }
  savePreferences(input: OrganizationSavePreferences, context?: OrganizationContext) { return this.repository.savePreferences(input, context); }
}
