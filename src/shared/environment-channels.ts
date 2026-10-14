export const ENVIRONMENT_CHANNELS = {
  probe: "environments:probe", initialize: "environments:initialize", list: "environments:list", get: "environments:get",
  start: "environments:start", stop: "environments:stop", rebuild: "environments:rebuild",
} as const;
export const EXECUTION_CHANNELS = {
  list: "execution:list", get: "execution:get", run: "execution:run", cancel: "execution:cancel", logs: "execution:logs",
  listFiles: "execution:list-files", readFile: "execution:read-file", writeFile: "execution:write-file",
  pickUpload: "execution:pick-upload", downloadFile: "execution:download-file", wait: "execution:wait",
} as const;
export const PROCESS_CHANNELS = {
  list: "processes:list", start: "processes:start", stop: "processes:stop", registerPort: "processes:register-port", listPorts: "processes:list-ports",
} as const;
/** All three APIs subscribe to the same bus; the UI only needs one subscription. */
export const ENVIRONMENT_EVENTS = { changed: "environments:changed" } as const;
