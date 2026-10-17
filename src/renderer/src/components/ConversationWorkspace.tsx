import type { Project } from "@shared/contracts";

export type ConversationWorkspaceProps = {
  projects: Project[];
  projectId: string | null;
  pending: boolean;
  error: string | null;
  onChange(projectId: string | null): void;
};

export function ConversationWorkspace({ projects, projectId, pending, error, onChange }: ConversationWorkspaceProps): React.JSX.Element {
  return <section className="conversation-workspace" aria-label="聊天工作区">
    <label className="field">
      <span>当前聊天工作区</span>
      <select aria-label="当前聊天工作区" value={projectId ?? ""} disabled={pending} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">未关联工作区</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
    </label>
    <p className="field-help">切换后仅使用所选工作区。选择未关联会撤销当前聊天的文件访问。</p>
    {pending ? <p className="field-help">操作进行中，完成后可修改工作区。</p> : null}
    {error ? <p className="dialog-error" role="alert">{error}</p> : null}
  </section>;
}
