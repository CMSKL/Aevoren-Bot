import { useEffect, useState, type FormEvent } from "react";
import type { ApiResult, Project } from "@shared/contracts";

type ProjectDialogProps = {
  open: boolean;
  onClose(): void;
  onCreate(name: string): Promise<ApiResult<Project>>;
};

export function ProjectDialog({ open, onClose, onCreate }: ProjectDialogProps): React.JSX.Element | null {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    const result = await onCreate(name.trim());
    setBusy(false);
    if (!result.ok) setError(result.error.safeMessage);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="settings-dialog project-create-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
        <header>
          <div>
            <h2 id="project-dialog-title">新建工作区</h2>
            <p>创建项目来整理群聊和 Bot；本地文件夹授权仍在“文件工作区”中单独管理。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭新建工作区" disabled={busy}>×</button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label className="field">
            <span>工作区名称</span>
            <input
              autoFocus
              aria-label="工作区名称"
              maxLength={80}
              placeholder="例如：产品设计"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
          </label>
          {error ? <div className="dialog-error" role="alert">{error}</div> : null}
          <footer>
            <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button className="primary-button" type="submit" disabled={busy || name.trim().length === 0}>
              {busy ? "创建中…" : "创建工作区"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
