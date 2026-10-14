import type { ResourceReference } from "./library-contracts";

export type ProductViewInput = {
  action: "open_chats" | "open_contacts" | "open_workspaces" | "open_settings" | "open_profile" | "open_bot" | "open_room" | "open_bot_profile" | "open_room_settings" | "task_details" | "sidebar_search" | "sidebar_expand" | "sidebar_select" | "model_search" | "draft_get" | "draft_update" | "choose_avatar" | "window_show" | "window_hide" | "app_exit" | "dismiss_update" | "draft_remove_attachment" | "draft_add_attachments" | "room_members" | "expand_record";
  botId?: string; roomId?: string; sessionId?: string; query?: string; unreadOnly?: boolean;
  section?: "general" | "capabilities" | "memory" | "mcp" | "routines" | "updates";
  tab?: "artifacts" | "records"; group?: "hidden" | "archived" | "workspaces" | "project" | "bot_group" | "room_group";
  projectId?: string; expanded?: boolean; botIds?: string[]; roomIds?: string[];
  attachmentId?: string; recordId?: string;
  text?: string; expectedDigest?: string; routingMode?: "automatic" | "explicit" | "everyone"; targetBotIds?: string[];
  resourceRefs?: ResourceReference[];
};
export type ProductViewResult = { status: "completed" | "running" | "waiting_user" | "cancelled" | "failed"; result?: unknown; reason?: string };
export type ProductViewRequest = { id: string; input: ProductViewInput };
export type ProductViewEvent = { request: ProductViewRequest; respond(result: ProductViewResult): void };
export const PRODUCT_VIEW_DOM_EVENT = "aevoren:product-view";
