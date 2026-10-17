import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { containsLikelySecret } from "./memory-safety";

export function sanitizeUpdateDiagnostic(value: unknown): string {
  let text: string;
  try {
    text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable update diagnostic]";
  }
  text = text.replace(/https?:\/\/[^\s<>"')]+/giu, "[url redacted]")
    .replace(/(?:file:\/\/)?\/(?:Users|home|private|var|tmp)\/[^\s<>"')]+|[A-Z]:\\[^\r\n<>"']+/giu, "[path redacted]");
  text = text.replace(/\b(?:XML|response body):[\s\S]*/iu, "[response body redacted]");
  if (containsLikelySecret(text) || /\b(?:authorization|cookie|set-cookie|bearer|basic)\b[\s:=]+\S+/iu.test(text) || /"(?:token|api.?key|access.?token|refresh.?token|password|secret|credential|authorization|cookie|set-cookie|client.?secret)"\s*:/iu.test(text)) {
    text = "[sensitive update diagnostic redacted]";
  }
  const code = value instanceof Error ? (value as NodeJS.ErrnoException).code : undefined;
  const prefix = code && /^[A-Z0-9_]{1,80}$/u.test(code) ? `${code}: ` : "";
  return `${prefix}${text}`.slice(0, 4_000);
}

/** Local-only bounded diagnostics. Logging failures must not stop an update. */
export class UpdateLogger {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, private readonly maximumBytes = 1_048_576) {}

  info(message?: unknown): void { this.write("info", message); }
  warn(message?: unknown): void { this.write("warn", message); }
  error(message?: unknown): void { this.write("error", message); }
  debug(message: string): void { this.write("debug", message); }

  flush(): Promise<void> { return this.pending; }

  private write(level: string, message: unknown): void {
    const line = `${JSON.stringify({ time: new Date().toISOString(), level, message: sanitizeUpdateDiagnostic(message) })}\n`;
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = (await stat(this.path)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (size > 0 && size + Buffer.byteLength(line) > this.maximumBytes) await rename(this.path, `${this.path}.previous`);
      await appendFile(this.path, line, { mode: 0o600 });
    }).catch(() => {
      console.warn("[updates] local diagnostic log could not be written");
    });
  }
}
