import type { ConnectorDraftContent, ConnectorDraftResult, ConnectorProvider } from "@shared/native-connector-contracts";

export const connectorLabels: Record<ConnectorProvider, string> = { gmail: "Gmail", drive: "Google Drive", notion: "Notion" };
export const connectorStateLabels = { configured: "待授权", authorizing: "正在授权", connected: "已连接", revoked: "已撤销", "auth-required": "需要重新授权" } as const;

export type ConnectorEditor = { connectionId: string; saved: ConnectorDraftResult | null; content: ConnectorDraftContent; clientNonce?: string; toText?: string; ccText?: string };

export function connectorEditorContent(editor: ConnectorEditor): ConnectorDraftContent {
  if (editor.content.kind !== "gmail-message") return editor.content;
  const addresses = (value: string): string[] => value.split(/[,;，]/u).map(item => item.trim()).filter(Boolean);
  return { ...editor.content, to: editor.toText === undefined ? editor.content.to : addresses(editor.toText), cc: editor.ccText === undefined ? editor.content.cc : addresses(editor.ccText) };
}

export function emptyConnectorDraft(provider: ConnectorProvider): ConnectorDraftContent {
  if (provider === "gmail") return { kind: "gmail-message", to: [], cc: [], subject: "", body: "" };
  if (provider === "drive") return { kind: "drive-text", targetFileId: null, title: "", text: "" };
  return { kind: "notion-page", parentPageId: "", title: "", text: "" };
}

export function connectorDraftDirty(editor: ConnectorEditor | null): boolean {
  if (!editor) return false;
  const baseline = editor.saved?.revision.content ?? emptyConnectorDraft(editor.content.kind === "gmail-message" ? "gmail" : editor.content.kind === "drive-text" ? "drive" : "notion");
  return JSON.stringify(baseline) !== JSON.stringify(connectorEditorContent(editor));
}

export function connectorDraftTitle(content: ConnectorDraftContent): string {
  return content.kind === "gmail-message" ? content.subject || "无主题邮件草稿" : content.title || "未命名草稿";
}

/** Invalidate old scope, connection and read replies without cancelling unrelated host tasks. */
export class ConnectorRequestGate {
  private generation = 0;
  invalidate(): void { this.generation += 1; }
  begin(): () => boolean {
    const generation = ++this.generation;
    return () => this.generation === generation;
  }
}
