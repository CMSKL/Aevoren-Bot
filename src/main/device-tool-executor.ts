import type { DeviceToolRequest } from "@shared/contracts";

export class DeviceToolExecutor {
  constructor(
    private readonly readClipboardText: () => string | Promise<string>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(tool: DeviceToolRequest, signal: AbortSignal): Promise<{
    content: string;
    metadata: Record<string, string | number | boolean | null>;
  }> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const raw = await this.readClipboardText();
    const text = raw.slice(0, tool.maxCharacters);
    const retrievedAt = this.now().toISOString();
    return {
      content: JSON.stringify({
        untrusted: true,
        source: "system-clipboard",
        retrievedAt,
        text,
        truncated: raw.length > text.length,
      }),
      metadata: { kind: tool.kind, provider: "system-clipboard", retrievedAt, characters: text.length, truncated: raw.length > text.length },
    };
  }
}
