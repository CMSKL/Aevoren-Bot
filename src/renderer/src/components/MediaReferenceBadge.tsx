import { memo, useEffect, useState } from "react";
import type { MessageMediaReference } from "@shared/media-contracts";
import { AttachmentIcon } from "./Icons";
import { MediaPreviewDialog } from "./MediaPreviewDialog";

export const MediaReferenceBadge = memo(function MediaReferenceBadge({ sessionId, reference, onRemove }: { sessionId: string; reference: MessageMediaReference; onRemove?(): void }): React.JSX.Element {
  const key = `${sessionId}:${JSON.stringify(reference)}`;
  const [metadata, setMetadata] = useState<{ key: string; name: string; available: boolean } | null>(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    let cancelled = false, sequence = 0;
    const load = async (): Promise<void> => {
      const request = ++sequence;
      try {
        const result = await window.aevorenBot.media.metadata({ sessionId, id: reference.mediaId });
        if (cancelled || request !== sequence) return;
        const available = result.ok && result.data.asset.reference.sha256 === reference.sha256 && result.data.asset.enabled && !result.data.asset.deletedAt;
        setMetadata({ key, name: available ? result.data.asset.reference.name : `媒体 ${reference.mediaId.slice(0, 8)}… · 不可读取`, available: Boolean(available) });
      } catch { if (!cancelled && request === sequence) setMetadata({ key, name: `媒体 ${reference.mediaId.slice(0, 8)}… · 不可读取`, available: false }); }
    };
    void load();
    const unsubscribe = window.aevorenBot.media.onChanged(event => {
      if (event.mediaId !== reference.mediaId || (["bound", "unbound"].includes(event.action) && event.sessionId !== sessionId)) return;
      setMetadata(null); void load();
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [sessionId, reference.mediaId, reference.sha256, key]);
  const name = metadata?.key === key ? metadata.name : "媒体引用 · 正在读取";
  return <><span className="media-reference-badge"><button className="message-attachment" type="button" aria-label={`预览媒体 ${name}`} disabled={!metadata?.available || metadata.key !== key} onClick={() => setPreview(true)}><AttachmentIcon /><span>{name}</span></button>{onRemove ? <button className="text-button" type="button" aria-label={`移除媒体引用 ${name}`} onClick={onRemove}>×</button> : null}</span>{preview ? <MediaPreviewDialog key={key} sessionId={sessionId} reference={reference} onClose={() => setPreview(false)} /> : null}</>;
});
