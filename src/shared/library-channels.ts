/** Preload-safe channel names: keep this module free of runtime dependencies. */
export const LIBRARY_CHANNELS = {
  list: "library:list", available: "library:available", read: "library:read", create: "library:create",
  importText: "library:import-text", update: "library:update", setEnabled: "library:set-enabled",
  delete: "library:delete", restore: "library:restore", versions: "library:versions",
  restoreVersion: "library:restore-version", bind: "library:bind", unbind: "library:unbind",
  pickImport: "library:pick-import", importPath: "library:import-path", export: "library:export",
} as const;
