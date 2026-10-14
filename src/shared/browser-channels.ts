export const BROWSER_CHANNELS = {
  get: "browser:get", start: "browser:start", stop: "browser:stop", tabs: "browser:tabs", newTab: "browser:newTab", closeTab: "browser:closeTab",
  navigate: "browser:navigate", read: "browser:read", observe: "browser:observe", click: "browser:click", type: "browser:type", key: "browser:key",
  scroll: "browser:scroll", downloads: "browser:downloads", download: "browser:download",
} as const;
export const COMPUTER_CHANNELS = { view: "computer:view", screenshot: "computer:screenshot", click: "computer:click", type: "computer:type",
  key: "computer:key", scroll: "computer:scroll", takeover: "computer:takeover", returnControl: "computer:returnControl", vncTicket: "computer:vncTicket" } as const;
export const PREVIEW_CHANNELS = { list: "preview:list", open: "preview:open", close: "preview:close" } as const;
export const BROWSER_EVENTS = { changed: "browser:changed" } as const;
