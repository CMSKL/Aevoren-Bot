/** Preload-safe: runtime validation belongs to the host. */
export const MEDIA_CHANNELS = {
  list: "media:list", available: "media:available", metadata: "media:metadata", read: "media:read",
  preview: "media:preview", pickImport: "media:pick-import", importPath: "media:import-path",
  bind: "media:bind", unbind: "media:unbind", setEnabled: "media:set-enabled", delete: "media:delete", restore: "media:restore",
} as const;
export const MEDIA_CHANGED_CHANNEL = "media:changed";
