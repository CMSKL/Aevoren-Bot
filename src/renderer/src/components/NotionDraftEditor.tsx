import type { ConnectorDraftContent } from "@shared/native-connector-contracts";
import type { NotionDraftKind } from "../connector-ui-state";

type NotionContent = Extract<ConnectorDraftContent, { kind: NotionDraftKind }>;
type Props = { content: NotionContent; saved: boolean; busy: boolean; onChange(content: NotionContent): void; onKindChange(kind: NotionDraftKind): void };

export function NotionDraftEditor({ content, saved, busy, onChange, onKindChange }: Props): React.JSX.Element {
  return <>
    <label className="field"><span>Notion 草稿操作</span><select aria-label="Notion 草稿操作" value={content.kind} disabled={busy || saved} onChange={event => onKindChange(event.target.value as NotionDraftKind)}><option value="notion-page">创建子页面</option><option value="notion-page-title">仅修改页面标题</option><option value="notion-page-append">在页面末尾追加正文</option></select></label>
    {saved ? <p className="connector-note">已保存草稿的操作类型固定。如需其他操作，请新建草稿。</p> : null}
    {content.kind === "notion-page" ? <label className="field"><span>父页面 ID</span><input aria-label="Notion 草稿父页面" maxLength={36} value={content.parentPageId} disabled={busy} onChange={event => onChange({ ...content, parentPageId: event.target.value })} /></label> : <label className="field"><span>目标页面 ID</span><input aria-label="Notion 草稿目标页面" maxLength={36} value={content.pageId} disabled={busy} onChange={event => onChange({ ...content, pageId: event.target.value })} /></label>}
    {content.kind !== "notion-page-append" ? <label className="field"><span>{content.kind === "notion-page-title" ? "新标题" : "标题"}</span><input aria-label={content.kind === "notion-page-title" ? "Notion 草稿新标题" : "文件草稿标题"} maxLength={1024} value={content.title} disabled={busy} onChange={event => onChange({ ...content, title: event.target.value })} /></label> : null}
    {content.kind !== "notion-page-title" ? <label className="field"><span>{content.kind === "notion-page-append" ? "追加正文" : "正文"}</span><textarea aria-label={content.kind === "notion-page-append" ? "Notion 草稿追加正文" : "文件草稿正文"} maxLength={100_000} value={content.text} disabled={busy} onChange={event => onChange({ ...content, text: event.target.value })} /></label> : null}
    {content.kind === "notion-page-title" ? <p className="connector-note">此次操作仅修改目标页面的标题属性，不修改正文。</p> : content.kind === "notion-page-append" ? <p className="connector-note">此次操作在目标页面末尾追加段落，保留已有正文；不会覆盖页面内容。</p> : null}
  </>;
}
