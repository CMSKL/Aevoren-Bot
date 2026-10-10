import { useEffect, useRef, useState } from "react";
import type { UserProfile } from "@shared/contracts";
import { CloseIcon } from "./Icons";
import { UserAvatar } from "./UserAvatar";

type UserProfileDialogProps = {
  profile: UserProfile;
  onClose(): void;
  onSave(profile: UserProfile): Promise<boolean>;
};

const MAX_IMAGE_BYTES = 5 * 1_024 * 1_024;
const MAX_AVATAR_LENGTH = 512 * 1_024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

async function cropAvatar(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const square = Math.min(bitmap.width, bitmap.height);
    if (!square) throw new Error("Invalid image dimensions");
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion unavailable");
    context.drawImage(bitmap, (bitmap.width - square) / 2, (bitmap.height - square) / 2, square, square, 0, 0, 256, 256);
    const avatarUrl = canvas.toDataURL("image/png");
    if (!avatarUrl.startsWith("data:image/png;base64,") || avatarUrl.length > MAX_AVATAR_LENGTH) throw new Error("Avatar conversion failed");
    return avatarUrl;
  } finally {
    bitmap.close();
  }
}

export function UserProfileDialog({ profile, onClose, onSave }: UserProfileDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<UserProfile>(() => ({ ...profile }));
  const [readingImage, setReadingImage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const imageGeneration = useRef(0);
  const savingRef = useRef(false);
  const mountedRef = useRef(false);
  const closeRef = useRef(onClose);

  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    mountedRef.current = true;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = requestAnimationFrame(() => { nameRef.current?.focus(); nameRef.current?.select(); });
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (savingRef.current) return;
      imageGeneration.current += 1;
      closeRef.current();
    }
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      mountedRef.current = false;
      imageGeneration.current += 1;
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", closeOnEscape, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  function close(): void {
    if (savingRef.current) return;
    imageGeneration.current += 1;
    onClose();
  }

  async function selectImage(file: File | undefined): Promise<void> {
    const generation = ++imageGeneration.current;
    setError(null);
    setReadingImage(false);
    if (!file) return;
    if (!ALLOWED_IMAGE_TYPES.has(file.type) || file.size === 0) {
      setError("请选择 PNG、JPEG 或 WebP 图片。");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("图片超过 5 MB，请选择更小的图片。");
      return;
    }
    setReadingImage(true);
    try {
      const avatarUrl = await cropAvatar(file);
      if (mountedRef.current && generation === imageGeneration.current) setDraft((current) => ({ ...current, avatarUrl }));
    } catch {
      if (mountedRef.current && generation === imageGeneration.current) setError("这张图片无法读取，请选择其他图片。");
    } finally {
      if (mountedRef.current && generation === imageGeneration.current) setReadingImage(false);
    }
  }

  async function save(): Promise<void> {
    if (savingRef.current || readingImage) return;
    const name = draft.name.trim();
    if (!name || name.length > 80 || /\p{Cc}/u.test(draft.name)) {
      setError("昵称需为 1～80 个字符。");
      nameRef.current?.focus();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const succeeded = await onSave({ name, avatarUrl: draft.avatarUrl });
      if (!mountedRef.current) return;
      if (succeeded) onClose();
      else setError("保存未完成，草稿已保留，请重试。");
    } catch {
      if (mountedRef.current) setError("保存未完成，草稿已保留，请重试。");
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop user-profile-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section
        ref={dialogRef}
        className="settings-dialog user-profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-profile-title"
        aria-describedby="user-profile-description"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]):not([type='file'])");
          const first = focusable?.[0];
          const last = focusable?.[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
      >
        <header>
          <div><h2 id="user-profile-title">个人资料</h2><p id="user-profile-description">设置聊天中显示的昵称与头像。</p></div>
          <button type="button" className="icon-button" aria-label="关闭个人资料" disabled={saving} onClick={close}><CloseIcon /></button>
        </header>
        <form className="user-profile-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className="user-profile-avatar">
            <UserAvatar name={draft.name} avatarUrl={draft.avatarUrl} size={96} />
            <div className="user-profile-avatar-actions">
              <button type="button" className="secondary-button" disabled={saving} onClick={() => fileRef.current?.click()}>更换头像</button>
              <button type="button" className="text-button" aria-label="重置头像" disabled={saving || (!draft.avatarUrl && !readingImage)} onClick={() => {
                imageGeneration.current += 1;
                setReadingImage(false);
                setError(null);
                setDraft((current) => ({ ...current, avatarUrl: null }));
              }}>恢复默认</button>
              <small>{readingImage ? "正在处理图片…" : "支持 PNG、JPEG、WebP，最大 5 MB。"}</small>
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择个人头像" hidden disabled={saving} onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void selectImage(file);
            }} />
          </div>
          <label className="user-profile-name" htmlFor="user-profile-name">昵称</label>
          <input ref={nameRef} id="user-profile-name" name="name" type="text" maxLength={80} autoComplete="nickname" value={draft.name} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          {error ? <div className="dialog-error" role="alert">{error}</div> : null}
          <footer className="user-profile-footer">
            <button className="secondary-button" type="button" disabled={saving} onClick={close}>取消</button>
            <button className="primary-button" type="submit" disabled={saving || readingImage}>{saving ? "保存中…" : "保存"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
