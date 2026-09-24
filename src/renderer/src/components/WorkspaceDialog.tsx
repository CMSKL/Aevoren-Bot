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
  const [busy, setBusy] = useState<string | null>(null);

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

  async function updatePermissions(
    workspace: Workspace,
    patch: Partial<Pick<Workspace, "writeEnabled" | "automationEnabled">>,
  ): Promise<void> {
    const optimistic = { ...workspace, ...patch };
    setWorkspaces((current) => current.map((item) => item.id === workspace.id ? optimistic : item));
    setBusy(workspace.id);
    setError(null);
    const result = await window.aevorenBot.workspaces.updatePermissions({
      id: workspace.id,
      expectedVersion: workspace.version,
      writeEnabled: patch.writeEnabled ?? workspace.writeEnabled,
      automationEnabled: patch.automationEnabled ?? workspace.automationEnabled,
    });
    setBusy(null);
    if (!result.ok) {
      setWorkspaces((current) => current.map((item) => item.id === workspace.id ? workspace : item));
      setError(result.error);
      return;
    }
    setWorkspaces((current) => current.map((item) => item.id === result.data.id ? result.data : item));
    window.dispatchEvent(new Event("aevoren:workspaces-changed"));
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-dialog workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title">
        <header>
          <div>
            <h2 id="workspace-dialog-title">工作区</h2>
            <p>授权 Bot 使用的一层文件夹；路径只在 Main 进程内处理，不会暴露给页面。</p>
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
                <span>默认只读；写入仅限新建 Markdown/CSV，绝不覆盖现有文件</span>
                <label className="workspace-permission-toggle">
                  <input
                    type="checkbox"
                    checked={workspace.writeEnabled}
                    disabled={busy !== null}
                    onChange={(event) => void updatePermissions(workspace, { writeEnabled: event.target.checked })}
                  />
                  允许 Bot 新建 Markdown/CSV
                </label>
                <label className="workspace-permission-toggle">
                  <input
                    type="checkbox"
                    checked={workspace.automationEnabled}
                    disabled={busy !== null}
                    onChange={(event) => void updatePermissions(workspace, { automationEnabled: event.target.checked })}
                  />
                  自动批准此工作区的受限工具
                </label>
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
        <div className="security-note">自动批准仅适用于该工作区内经过日志记录的列出、读取、搜索和创建 Markdown/CSV；删除、覆盖、命令执行、浏览器与网络权限不在授权范围内。</div>
        {error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>完成</button>
        </footer>
      </section>
    </div>
  );
}
