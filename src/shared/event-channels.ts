export const AUTOMATION_EVENT_CHANNELS = {
  snapshot: "automation-events:snapshot", create: "automation-events:create", update: "automation-events:update", revoke: "automation-events:revoke", cancel: "automation-events:cancel",
  rotateToken: "automation-events:rotate-token", startListener: "automation-events:start-listener", stopListener: "automation-events:stop-listener",
} as const;
export const AUTOMATION_EVENTS_CHANGED = "automation-events:changed";
