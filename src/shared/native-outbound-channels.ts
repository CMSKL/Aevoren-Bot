export const NATIVE_OUTBOUND_CHANNELS = { writeGrants: "outbound:write-grants", grantWrite: "outbound:grant-write", revokeWrite: "outbound:revoke-write",
  enableSend: "outbound:enable-send", prepare: "outbound:prepare", get: "outbound:get", list: "outbound:list", send: "outbound:send",
  reconcile: "outbound:reconcile", cancel: "outbound:cancel", reject: "outbound:reject" } as const;
export const NATIVE_OUTBOUND_REQUEST_APPROVAL_CHANNEL = "outbound:request-approval";
