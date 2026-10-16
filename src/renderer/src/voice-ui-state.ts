import type { VoiceApi, VoiceTask, VoiceTaskInput } from "@shared/voice-contracts";

export async function voiceTextDigest(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function mergeVoiceTask(tasks: VoiceTask[], task: VoiceTask): VoiceTask[] {
  const existing = tasks.find(item => item.id === task.id);
  if (existing && existing.version > task.version) return tasks;
  return [...tasks.filter(item => item.id !== task.id), task].toSorted((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}

/** Subscribe first: completion can arrive while the current-state IPC is pending. */
export async function waitForVoiceTask(api: Pick<VoiceApi, "get" | "onChanged">, input: VoiceTaskInput, signal: AbortSignal): Promise<VoiceTask> {
  let unsubscribe = (): void => {};
  let abort = (): void => {};
  try {
    return await new Promise<VoiceTask>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => { if (!settled) { settled = true; reject(error); } };
      const check = (task: VoiceTask): void => {
        if (settled || task.id !== input.id || task.sessionId !== input.sessionId || ["prepared", "running"].includes(task.state)) return;
        settled = true;
        if (task.state === "completed") resolve(task);
        else reject(new Error(task.lastErrorCode ?? `语音任务${task.state}`));
      };
      unsubscribe = api.onChanged(event => check(event.task));
      abort = () => fail(new DOMException("已停止语音任务", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void api.get(input).then(result => { if (result.ok) check(result.data); else fail(new Error(result.error.safeMessage)); }, fail);
    });
  } finally { signal.removeEventListener("abort", abort); unsubscribe(); }
}
