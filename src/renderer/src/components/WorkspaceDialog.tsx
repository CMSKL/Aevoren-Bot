import { useEffect, useState } from "react";
import type { AppError, Workspace } from "@shared/contracts";
import { CloseIcon, FolderIcon } from "./Icons";
import { ConversationWorkspace, type ConversationWorkspaceProps } from "./ConversationWorkspace";

type WorkspaceDialogProps = {
  open: boolean;
  workspaceId: string | null;
  workspaceIds?: readonly string[];
  conversationWorkspace?: ConversationWorkspaceProps;
  onClose(): void;
};

export function WorkspaceDialog({ open, workspaceId, workspaceIds, conversationWorkspace, onClose }: WorkspaceDialogProps): React.JSX.Element | null {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void window.aevorenBot.workspaces.list().then((result) => {
      if (!active) return;
      if (result.ok) {
        setWorkspaces(result.data);
        setError(null);
      }
      else { setWorkspaces([]); setError(result.error); }
    }).catch((failure) => {
      if (!active) return;
      console.error("Workspace permissions could not be loaded", failure);
      setWorkspaces([]);
      setError({ domain: "workspace", code: "INTERNAL_ERROR", retryable: true, safeMessage: "暂时无法读取文件夹权限，请关闭后重试。" });
    });
    return () => { active = false; };
  }, [open]);

  if (!open) return null;
  const allowedWorkspaces = (workspaces ?? []).filter((workspace) => workspaceIds !== undefined
    ? workspaceIds.includes(workspace.id) : workspace.id === workspaceId);
  const targetId = allowedWorkspaces.length === 1 ? allowedWorkspaces[0]!.id : selectedWorkspaceId;
  const visibleWorkspaces = allowedWorkspaces.filter((workspace) => workspace.id === targetId);

  async function removeWorkspace(workspace: Workspace): Promise<void> {
    setBusy(workspace.id);
    setError(null);
    const result = await window.aevorenBot.workspaces.remove({ id: workspace.id, expectedVersion: workspace.version });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setWorkspaces((current) => (current ?? []).filter((item) => item.id !== workspace.id));
    window.dispatchEvent(new Event("aevoren:workspaces-changed"));
  }

  async function updatePermissions(
    workspace: Workspace,
    patch: Partial<Pick<Workspace, "writeEnabled" | "automationEnabled">>,
  ): Promise<void> {
    const optimistic = { ...workspace, ...patch };
    setWorkspaces((current) => (current ?? []).map((item) => item.id === workspace.id ? optimistic : item));
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
      setWorkspaces((current) => (current ?? []).map((item) => item.id === workspace.id ? workspace : item));
      setError(result.error);
      return;
    }
    setWorkspaces((current) => (current ?? []).map((item) => item.id === result.data.id ? result.data : item));
    window.dispatchEvent(new Event("aevoren:workspaces-changed"));
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && busy === null) onClose(); }}>
      <section className="settings-dialog workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title">
        <header>
          <div>
            <h2 id="workspace-dialog-title">工作区权限</h2>
            <p>管理此工作区的文件访问；取消授权不会删除文件、群聊或 Bot。</p>
          </div>
          <button type="button" className="icon-button dialog-close-button" onClick={onClose} aria-label="关闭工作区权限" title="关闭工作区权限" disabled={busy !== null}><CloseIcon /></button>
        </header>
        {conversationWorkspace ? <ConversationWorkspace {...conversationWorkspace} /> : null}
        <div className="workspace-list settings-list" aria-label="已授权文件夹">
          {workspaces === null ? <p role="status">正在读取文件夹权限…</p> : !error && allowedWorkspaces.length === 0 ? <div className="workspace-empty">
            {workspaceIds !== undefined ? <>
              <p>{workspaceIds.length === 0 ? "当前聊天未关联工作区" : "当前聊天的文件夹授权已不可用"}</p>
              <p>请为当前聊天选择已授权工作区；打开此窗口不会增加文件访问权限。</p>
            </> : "此工作区尚未授权文件夹，可在左侧重新授权。"}
          </div> : null}
          {allowedWorkspaces.length > 1 ? <label className="field">
            <span>当前聊天已授权多个文件夹，请选择要管理的目标</span>
            <select aria-label="选择要管理的工作区" value={allowedWorkspaces.some(workspace => workspace.id === selectedWorkspaceId) ? selectedWorkspaceId : ""} disabled={busy !== null} onChange={event => setSelectedWorkspaceId(event.target.value)}>
              <option value="">请选择文件夹</option>
              {allowedWorkspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </label> : null}
          {visibleWorkspaces.map((workspace) => (
            <div className="workspace-row settings-list-row" key={workspace.id}>
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
                  自动批准此文件夹的受限工具
                </label>
              </div>
              <button
                className="text-button danger-text-button"
                type="button"
                disabled={busy !== null}
                onClick={() => void removeWorkspace(workspace)}
              >
                {busy === workspace.id ? "取消中…" : "取消授权"}
              </button>
            </div>
          ))}
        </div>
        <div className="security-note">自动批准仅适用于该文件夹内经过日志记录的列出、读取、搜索和创建 Markdown/CSV；删除、覆盖、命令执行、浏览器与网络权限不在授权范围内。</div>
        {error ? <div className="dialog-error" role="alert">{error.safeMessage}</div> : null}
        <footer className="workspace-dialog-footer">
          <button className="secondary-button" type="button" onClick={onClose} disabled={busy !== null}>完成</button>
        </footer>
      </section>
    </div>
  );
}
