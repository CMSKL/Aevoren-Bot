import type { MsBotApi } from "@shared/contracts";

declare global {
  interface Window {
    msBot: MsBotApi;
  }
}

export {};
