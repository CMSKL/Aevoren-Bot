import type { Bot, ConversationSummary } from "@shared/contracts";
import type { OrganizationPreferences, OrganizationSavePreferences, OrganizationSnapshot, SidebarSection } from "@shared/organization-contracts";

export function groupSidebarConversations(items: readonly ConversationSummary[], snapshot?: OrganizationSnapshot | null): { sections: { section: SidebarSection; items: ConversationSummary[] }[]; unassigned: ConversationSummary[] } {
  const sections = [...(snapshot?.sections ?? [])].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  const known = new Set(sections.map(section => section.id)), assignments = new Map(snapshot?.assignments.map(item => [item.sessionId, item]) ?? []);
  const groups = new Map(sections.map(section => [section.id, [] as ConversationSummary[]])), unassigned: ConversationSummary[] = [];
  for (const item of items) {
    const sectionId = assignments.get(item.sessionId)?.sectionId;
    if (sectionId && known.has(sectionId)) groups.get(sectionId)!.push(item);
    else unassigned.push(item);
  }
  return { sections: sections.map(section => ({ section, items: groups.get(section.id)!.sort((left, right) => (assignments.get(left.sessionId)?.position ?? 0) - (assignments.get(right.sessionId)?.position ?? 0) || left.sessionId.localeCompare(right.sessionId)) })), unassigned };
}

/** Only untouched fields follow a newly reviewed baseline; dirty user input stays. */
export function rebaseOrganizationPreferences(base: OrganizationPreferences, draft: OrganizationPreferences, latest: OrganizationPreferences): OrganizationPreferences {
  return { defaultAssistantBotId: draft.defaultAssistantBotId === base.defaultAssistantBotId ? latest.defaultAssistantBotId : draft.defaultAssistantBotId,
    sound: draft.sound === base.sound ? latest.sound : draft.sound,
    notifications: Object.fromEntries(Object.entries(draft.notifications).map(([key, value]) => [key, value === base.notifications[key as keyof typeof base.notifications] ? latest.notifications[key as keyof typeof latest.notifications] : value])) as OrganizationPreferences["notifications"] };
}

export function rebaseSectionNames(base: readonly SidebarSection[], draft: Readonly<Record<string, string>>, latest: readonly SidebarSection[]): Record<string, string> {
  const previous = new Map(base.map(section => [section.id, section.name]));
  const names = Object.fromEntries(latest.map(section => [section.id, draft[section.id] === undefined || draft[section.id] === previous.get(section.id) ? section.name : draft[section.id]!]));
  for (const [id, name] of Object.entries(draft)) if (!latest.some(section => section.id === id) && name !== previous.get(id)) names[id] = name;
  return names;
}

export function organizationPreferencesPatch(base: OrganizationPreferences, draft: OrganizationPreferences): OrganizationSavePreferences["patch"] {
  const patch: OrganizationSavePreferences["patch"] = {};
  if (base.defaultAssistantBotId !== draft.defaultAssistantBotId) patch.defaultAssistantBotId = draft.defaultAssistantBotId;
  if (base.sound !== draft.sound) patch.sound = draft.sound;
  const notifications = Object.fromEntries(Object.entries(draft.notifications).filter(([key, value]) => value !== base.notifications[key as keyof typeof base.notifications]));
  if (Object.keys(notifications).length) patch.notifications = notifications;
  return patch;
}

export function defaultAssistantFallback(bots: readonly Bot[], defaultBotId: string | null, rememberedSelectionValid: boolean): Bot | null {
  return rememberedSelectionValid ? null : bots.find(bot => bot.id === defaultBotId) ?? null;
}
