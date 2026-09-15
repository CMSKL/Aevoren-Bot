import type { AevorenBotApi } from "@shared/contracts";

declare global {
  interface Window {
    aevorenBot: AevorenBotApi;
  }
}

export {};
