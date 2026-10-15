import type { OrganizationNotifications,OrganizationPreferences } from "@shared/organization-contracts";
export function notificationOptions(preferences:OrganizationPreferences,category:keyof OrganizationNotifications,hidden:boolean,supported:boolean):{silent:boolean}|null{
  return hidden||!supported||!preferences.notifications[category]?null:{silent:!preferences.sound};
}
