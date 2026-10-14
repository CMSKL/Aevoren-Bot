export const NATIVE_CONNECTOR_CHANNELS = {
  list: "connectors:list", configure: "connectors:configure", authorize: "connectors:authorize", cancelAuthorization: "connectors:cancel-authorization",
  revoke: "connectors:revoke", bindings: "connectors:bindings", bind: "connectors:bind", unbind: "connectors:unbind", search: "connectors:search", read: "connectors:read",
} as const;
export const CONNECTOR_DRAFT_CHANNELS = {
  list: "drafts:list", create: "drafts:create", update: "drafts:update", read: "drafts:read", versions: "drafts:versions", delete: "drafts:delete",
} as const;
