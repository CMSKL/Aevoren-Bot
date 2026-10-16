import { describe, expect, it } from "vitest";
import type { ConnectorDraftResult } from "@shared/native-connector-contracts";
import { ConnectorRequestGate, connectorDraftDirty, connectorDraftTitle, connectorEditorContent, emptyConnectorDraft, emptyNotionDraft } from "./connector-ui-state";

describe("native connector UI request and draft state", () => {
  it("rejects a late read after a scope change or connection revocation", async () => {
    const gate = new ConnectorRequestGate();
    const valid = gate.begin();
    let resolve!: (value: string) => void;
    const reply = new Promise<string>(done => { resolve = done; });
    const visible: string[] = [];
    const pending = reply.then(value => { if (valid()) visible.push(value); });
    gate.invalidate();
    resolve("private mailbox content");
    await pending;
    expect(visible).toEqual([]);
    const current = gate.begin();
    expect(current()).toBe(true);
    gate.begin();
    expect(current()).toBe(false);
  });

  it("detects changed local content without mutating an immutable saved revision", () => {
    const content = { kind: "gmail-message" as const, to: ["reader@example.com"], cc: [], subject: "original", body: "saved" };
    const saved: ConnectorDraftResult = { draft: { id: "draft-1", sessionId: "private", executorBotId: "bot-1", connectionId: "connection-1", accountId: "account-1", authVersion: 1, version: 2, latestRevisionId: "revision-2", createdAt: "", updatedAt: "", deletedAt: null, state: "local-draft" }, revision: { id: "revision-2", draftId: "draft-1", number: 2, digest: "digest", content, createdAt: "" }, authorized: false };
    const editor = { connectionId: "connection-1", saved, content: { ...content, body: "my unsaved text" } };
    expect(connectorDraftDirty(editor)).toBe(true);
    expect(editor.saved.draft.version).toBe(2);
    expect(editor.content.body).toBe("my unsaved text");
    expect(saved.revision.content).toEqual(content);
  });

  it("keeps typed recipient separators until save and parses all recipients", () => {
    const editor = { connectionId: "connection", saved: null, content: emptyConnectorDraft("gmail"), toText: "first@example.com, ", ccText: "" };
    expect(editor.toText).toBe("first@example.com, ");
    expect(connectorEditorContent({ ...editor, toText: `${editor.toText}second@example.com` })).toMatchObject({ to: ["first@example.com", "second@example.com"], cc: [] });
    expect(connectorDraftDirty(editor)).toBe(true);
  });

  it("does not treat empty new drafts as unsaved content", () => {
    for (const provider of ["gmail", "drive", "notion"] as const) {
      expect(connectorDraftDirty({ connectionId: "connection", saved: null, content: emptyConnectorDraft(provider) })).toBe(false);
    }
    for (const kind of ["notion-page", "notion-page-title", "notion-page-append"] as const) {
      expect(connectorDraftDirty({ connectionId: "connection", saved: null, content: emptyNotionDraft(kind) })).toBe(false);
    }
  });
  it("preserves the saved Notion operation and detects title or append edits", () => {
    const content = { kind: "notion-page-title" as const, pageId: "page-1", title: "Saved title" };
    const saved: ConnectorDraftResult = { draft: { id: "draft-1", sessionId: "private", executorBotId: "bot-1", connectionId: "connection-1", accountId: "account-1", authVersion: 1, version: 2, latestRevisionId: "revision-2", createdAt: "", updatedAt: "", deletedAt: null, state: "local-draft" }, revision: { id: "revision-2", draftId: "draft-1", number: 2, digest: "digest", content, createdAt: "" }, authorized: true };
    expect(connectorDraftDirty({ connectionId: "connection-1", saved, content: { ...content, title: "Changed title" } })).toBe(true);
    expect(saved.revision.content).toEqual(content);
    const append = { kind: "notion-page-append" as const, pageId: "page-2", text: "Append only" };
    expect(connectorDraftDirty({ connectionId: "connection-1", saved: null, content: append })).toBe(true);
    expect(connectorDraftTitle(append)).toContain("page-2");
  });
});
