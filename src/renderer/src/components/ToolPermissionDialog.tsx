import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ApprovalRequest, ApprovalResolution, ToolInvocation } from "@shared/contracts";
import { isPublicReadTool } from "@shared/tool-automation";
import { CloseIcon } from "./Icons";

type Props = {
  approval: ApprovalRequest;
  invocation: ToolInvocation;
  label: string;
  botName: string;
  onResolve(approval: ApprovalRequest, resolution: ApprovalResolution): Promise<boolean>;
  onRememberPublicRead?(approval: ApprovalRequest): Promise<boolean>;
  onStop(): void;
};

export function ToolPermissionDialog({ approval, invocation, label, botName, onResolve, onRememberPublicRead, onStop }: Props): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const publicRead = isPublicReadTool(invocation.toolKind);
  const localRead = invocation.toolKind === "workspace-read" || invocation.toolKind === "clipboard-read";
  const target = invocation.arguments.kind === "web-search" || invocation.arguments.kind === "workspace-search"
    ? invocation.arguments.query : invocation.targetPath || "文件夹根目录";

  async function decide(resolution: ApprovalResolution | "remember"): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const accepted = resolution === "remember"
        ? publicRead && onRememberPublicRead ? await onRememberPublicRead(approval) : false
        : await onResolve(approval, resolution);
      setFailed(!accepted);
    } catch { setFailed(true); }
    finally { busyRef.current = false; setBusy(false); }
  }

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  return createPortal(
    <div className="tool-permission-backdrop">
      <section
        ref={dialogRef}
        className="tool-permission-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
        data-testid="tool-permission-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void decide("deny"); }
          if (event.key !== "Tab") return;
          const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
          const first = buttons[0];
          const last = buttons.at(-1);
          if (!first || !last) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
        }}
      >
        <header>
          <div><span>{botName}</span><h2 id={titleId}>{publicRead ? "允许公开信息查询？" : `允许${label}？`}</h2></div>
          <button type="button" className="tool-permission-close" aria-label="拒绝" title="拒绝此次操作" disabled={busy} onClick={() => void decide("deny")}><CloseIcon /></button>
        </header>
        <p id={descriptionId}>{invocation.toolKind === "time-now" ? "本次只读取本机系统时间，不会访问外部网络。" : publicRead
          ? "搜索关键词或网页地址会发送至相应服务。你可以记住公开查询授权，后续无需逐次确认。"
          : "仅授权当前操作，不会扩大这个 Bot 的其他权限。"}</p>
        <div className="tool-permission-target"><strong>{label}</strong><span>{target}</span></div>
        {localRead ? <p className="tool-permission-privacy">读取结果会进入模型上下文；使用云端模型时会发送至模型服务。请勿授权密码、密钥等敏感内容。</p> : null}
        {publicRead && onRememberPublicRead ? <p className="tool-permission-privacy">记住的范围仅包括公开网页搜索、抓取、天气与时间。文件、剪贴板、MCP 和外部写操作不包含在内，可在设置中随时关闭。</p> : null}
        {failed ? <p role="alert" className="tool-permission-error">授权未能提交，请重试。未确认的操作不会执行。</p> : null}
        <footer>
          <button type="button" className="text-button" disabled={busy} onClick={onStop}>停止任务</button>
          <div>
            <button type="button" className={publicRead && onRememberPublicRead ? "secondary-button" : "primary-button"} disabled={busy} onClick={() => void decide("allow-once")}>仅允许一次</button>
            {publicRead && onRememberPublicRead ? <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("remember")}>{busy ? "正在保存…" : "允许公开查询并记住"}</button> : null}
          </div>
        </footer>
      </section>
    </div>, document.body,
  );
}
