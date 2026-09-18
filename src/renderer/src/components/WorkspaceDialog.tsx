import { useEffect, useState } from "react";
import type { AppError, Workspace } from "@shared/contracts";
import { FolderIcon } from "./Icons";

type WorkspaceDialogProps = {
  open: boolean;
  onClose(): void;
};

export function WorkspaceDialog({ open, onClose }: WorkspaceDialogProps): React.JSX.Element | null {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState<"add" | string | null>(null);

  useEffect(() => {
    if (!open) return;
    void window.aevorenBot.workspaces.list().then((result) => {
      if (result.ok) {
        setWorkspaces(result.data);
        setError(null);
      }
      else setError(result.error);
    });
  }, [open]);

  if (!open) return null;

  async function addWorkspace(): Promise<void> {
    setBusy("add");
    setError(null);
    const result = await window.aevorenBot.workspaces.add();
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (!result.data) return;
    const registered = result.data;
    setWorkspaces((current) => {
      const withoutCurrent = current.filter((workspace) => workspace.id !== registered.workspace.id);
      return [...withoutCurrent, registered.workspace].toSorted((left, right) => (
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
      ));
    });
    window.dispatchEvent(new Event("aevoren:workspaces-changed"));
  }

  async function removeWorkspace(workspace: Workspace): Promise<void> {
    setBusy(workspace.id);
    setError(null);
    const result = await window.aevorenBot.workspaces.remove({ id: workspace.id, expectedVersion: workspace.version });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
    window.dispatchEvent(new Event("aevoren:workspaces-changed"));
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-dialog workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title">
        <header>
          <div>
            <h2 id="workspace-dialog-title">工作区</h2>
            <p>只授权需要让 Bot 查看的一层文件夹；不会向页面暴露本机路径。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="workspace-list" aria-label="已授权工作区">
          {workspaces.length === 0 ? <div className="workspace-empty">尚未授权工作区。</div> : null}
          {workspaces.map((workspace) => (
            <div className="workspace-row" key={workspace.id}>
              <span className="workspace-icon" aria-hidden="true"><FolderIcon /></span>
              <div className="workspace-copy">
                <strong>{workspace.name}</strong>
                <span>仅在每次明确批准后允许只读访问</span>
              </div>
              <button
                className="text-button danger-text-button"
                type="button"
                disabled={busy !== null}
                onClick={() => void removeWorkspace(workspace)}
              >
                {busy === workspace.id ? "移除中…" : "移除"}
              </button>
            </div>
          ))}
        </div>
        <div className="security-note">当前授权不包含写入、删除、命令执行、浏览器或网络访问。</div>
        {error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>完成</button>
          <button className="primary-button" type="button" onClick={() => void addWorkspace()} disabled={busy !== null}>
            {busy === "add" ? "选择中…" : "添加文件夹"}
          </button>
        </footer>
      </section>
    </div>
  );
}
