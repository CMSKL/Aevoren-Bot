import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiResult } from "@shared/contracts";
import type { DemonstrationCapture, DemonstrationDraft } from "@shared/demonstration-contracts";
const edits = new Map<string, { draft: DemonstrationDraft; name: string; body: string; dirty: boolean }>();
type Props = { sessionId: string; executorBotId: string; epoch?: number; userControl: boolean; connected: boolean; active: boolean };
export function DemonstrationPanel({ sessionId, executorBotId, epoch, userControl, connected, active }: Props): React.JSX.Element {
  const key = `${sessionId}:${executorBotId}`;
  const generation = useRef(0), scope = useRef(key), mounted = useRef(false);
  const [capture, setCapture] = useState<DemonstrationCapture | null>(null), [drafts, setDrafts] = useState<DemonstrationDraft[]>([]), [draft, setDraft] = useState<DemonstrationDraft | null>(null);
  const [body, setBody] = useState(""), [name, setName] = useState(""), [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [confirm, setConfirm] = useState(false);
  const [isDirty, setDirty] = useState(false);
  const request = useRef(0), dirty = useRef(false), nonce = useRef<string | null>(null), busy = useRef(false);
  const current = useCallback((scopeKey: string, id: number): boolean => mounted.current && scope.current === scopeKey && generation.current === id, []);
  const load = useCallback(async (): Promise<void> => {
    const id = generation.current, seq = ++request.current;
    const results = await Promise.allSettled([window.aevorenBot.demonstrations.status({ sessionId, executorBotId }), window.aevorenBot.demonstrations.drafts({ sessionId, executorBotId })]);
    if (!current(key, id) || seq !== request.current) return;
    if (results[0]!.status === "fulfilled" && results[0]!.value.ok) setCapture(results[0]!.value.data);
    if (results[1]!.status === "fulfilled" && results[1]!.value.ok) setDrafts(results[1]!.value.data);
  }, [sessionId, executorBotId, key, current]);
  useEffect(() => {
    scope.current = key; mounted.current = true; generation.current++; nonce.current = null; dirty.current = edits.get(key)?.dirty ?? false; busy.current = false;
    const timer = setInterval(() => { if (active) void load(); }, 2000);
    let disposed = false;
    queueMicrotask(() => { if (disposed) return; const edit = edits.get(key); setDirty(edit?.dirty ?? false); setDraft(edit?.draft ?? null); setCapture(null); setDrafts([]); setBody(edit?.body ?? ""); setName(edit?.name ?? ""); setPending(false); setError(null); setConfirm(false); if (active) void load(); });
    const invalidate = (): void => { mounted.current = false; generation.current++; request.current++; };
    return () => { disposed = true; invalidate(); clearInterval(timer); };
  }, [key, active, load]);
  function select(next: DemonstrationDraft): void { if (dirty.current) { setError("当前编辑尚未保存。请保存或点击放弃编辑后再选择草稿。"); return; } edits.set(key, { draft: next, body: next.body, name: next.name, dirty: false }); setDraft(next); setBody(next.body); setName(next.name); setConfirm(false); }
  async function perform<T>(operation: () => Promise<ApiResult<T>>, apply: (data: T) => void): Promise<void> {
    if (busy.current) return; busy.current = true; setPending(true); setError(null); const id = generation.current;
    try { const result = await operation(); if (!current(key, id)) return; if (!result.ok) { setError(result.error.safeMessage); return; } apply(result.data); void load(); }
    catch { if (current(key, id)) setError("操作结果未确认。请刷新当前示范状态，当前编辑仍保留。"); }
    finally { if (current(key, id)) { busy.current = false; setPending(false); } }
  }
  const capturing = capture?.state === "recording";
  return <section className="computer-section" aria-label="示范技能"><h4>示范技能</h4><p className="computer-note">接管并连接电脑后，可以明确开始录制。只保存真实输入的坐标、按钮与导航按键；文字、网址和剪贴板内容以占位符替代，不保存页面内容或截图。停止后先生成草稿，审阅发布后仍为停用状态。</p>
    <div className="computer-actions"><button type="button" className="secondary-button" disabled={!active || pending || !userControl || !connected || capturing || epoch === undefined} onClick={() => { if (epoch === undefined) return; nonce.current ??= crypto.randomUUID(); void perform(() => window.aevorenBot.demonstrations.start({ sessionId, executorBotId, expectedEpoch: epoch, id: nonce.current! }), data => { setCapture(data); nonce.current = null; }); }}>开始示范</button><button type="button" className="secondary-button" disabled={pending || !capture || epoch === undefined || Boolean(draft?.captureId === capture.id)} onClick={() => { if (!capture || epoch === undefined) return; if (dirty.current) { setError("请先保存或放弃当前编辑，再停止并打开新的示范草稿。"); return; } void perform(() => window.aevorenBot.demonstrations.stop({ sessionId, executorBotId, expectedEpoch: epoch, id: capture.id }), next => { select(next); }); }}>停止并生成草稿</button><button type="button" className="text-button" disabled={pending || !capture || epoch === undefined} onClick={() => { if (!capture || epoch === undefined) return; void perform(() => window.aevorenBot.demonstrations.discard({ sessionId, executorBotId, expectedEpoch: epoch, id: capture.id }), () => setCapture(null)); }}>丢弃录制</button></div>
    {capture ? <p role="status" className="computer-note">{capturing ? "录制中" : capture.state === "interrupted" ? "录制已中断" : "录制已停止"} · {capture.eventCount} 步{capture.reason ? ` · ${capture.reason}` : ""}。断线或归还控制权会停止录制，控制权不会自动归还。</p> : null}
    {error ? <p role="alert" className="computer-error">{error}</p> : null}
    {drafts.map(item => <div className="computer-resource-row" key={item.id}><button type="button" className="text-button" disabled={pending} onClick={() => select(item)}>{item.name} · v{item.version} · {item.state === "published" ? "已发布" : "草稿"}</button><button type="button" className="text-button" disabled={pending || epoch === undefined} onClick={() => { if (epoch === undefined) return; void perform(() => window.aevorenBot.demonstrations.discard({ sessionId, executorBotId, expectedEpoch: epoch, id: item.captureId }), () => { if (capture?.id === item.captureId) setCapture(null); }); }}>清理原录制</button><button type="button" className="text-button danger-text-button" disabled={pending || Boolean(isDirty && draft?.id === item.id)} onClick={() => void perform(() => window.aevorenBot.demonstrations.deleteDraft({ sessionId, executorBotId, id: item.id, expectedVersion: item.version }), () => { if (draft?.id === item.id) { edits.delete(key); setDraft(null); setBody(""); setName(""); } })}>删除草稿</button></div>)}
    {draft ? <><label className="field"><span>技能草稿名称</span><input aria-label="技能草稿名称" value={name} maxLength={120} disabled={draft.state === "published"} onChange={event => { dirty.current = true; setDirty(true); setConfirm(false); edits.set(key, { draft, body, name: event.target.value, dirty: true }); setName(event.target.value); }} /></label><label className="field"><span>SKILL.md 草稿</span><textarea aria-label="示范 SKILL.md 草稿" rows={12} value={body} maxLength={64000} disabled={draft.state === "published"} onChange={event => { dirty.current = true; setDirty(true); setConfirm(false); edits.set(key, { draft, body: event.target.value, name, dirty: true }); setBody(event.target.value); }} /></label><div className="computer-actions"><button type="button" className="secondary-button" disabled={pending || draft.state === "published" || !name.trim()} onClick={() => void perform(() => window.aevorenBot.demonstrations.updateDraft({ sessionId, executorBotId, id: draft.id, expectedVersion: draft.version, name, body }), next => { dirty.current = false; setDirty(false); select(next); })}>保存示范草稿</button><button type="button" className="text-button" disabled={pending || draft.state === "published"} onClick={() => { dirty.current = false; setDirty(false); edits.set(key, { draft, body: draft.body, name: draft.name, dirty: false }); setBody(draft.body); setName(draft.name); setError(null); setConfirm(false); }}>放弃编辑</button><button type="button" className="secondary-button" disabled={pending || draft.state === "published" || isDirty} onClick={() => setConfirm(true)}>发布为停用 Skill</button></div>
      {confirm ? <div className="computer-confirm" role="group" aria-label="确认发布示范 Skill"><p>发布当前已保存 v{draft.version} 的 Skill 到当前会话。初始停用；不会授权脚本或运行任务。请先补全占位符并检查步骤。</p><button type="button" className="secondary-button" disabled={pending || isDirty} onClick={() => void perform(() => window.aevorenBot.demonstrations.publish({ sessionId, executorBotId, id: draft.id, expectedVersion: draft.version, expectedDigest: draft.digest }), () => { setConfirm(false); const next = { ...draft, state: "published" as const }; edits.set(key, { draft: next, body, name, dirty: false }); setDraft(next); })}>确认发布停用 Skill</button><button type="button" className="text-button" onClick={() => setConfirm(false)}>继续编辑</button></div> : null}</> : null}
  </section>;
}
