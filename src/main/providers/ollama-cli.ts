import { execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { ChatMessage, ModelEvent, ModelProvider } from "../model";
import { AevorenBotError } from "../errors";
import { cliEnvironment, cliShellOptions, resolveCliPath } from "./cli-utils";

const execFileAsync = promisify(execFile);
export type OllamaCliInspection = {
  path: string;
  version: string;
  models: {
    default: string;
    options: Array<{ id: string; label: string }>;
  };
};

export async function inspectOllamaCli(cliCommand: string): Promise<OllamaCliInspection> {
  const environment = cliEnvironment();
  const path = resolveCliPath(cliCommand, environment);
  if (!path) throw new Error("Ollama CLI was not found");
  const [versionResult, listResult, runningResult] = await Promise.all([
    execFileAsync(path, ["--version"], { env: environment, timeout: 8_000, maxBuffer: 64 * 1024, ...cliShellOptions(path) }),
    execFileAsync(path, ["list"], { env: environment, timeout: 8_000, maxBuffer: 1024 * 1024, ...cliShellOptions(path) }),
    execFileAsync(path, ["ps"], { env: environment, timeout: 8_000, maxBuffer: 1024 * 1024, ...cliShellOptions(path) }).catch(() => ({ stdout: "", stderr: "" })),
  ]);
  const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`;
  const version = /(?:client\s+)?version\s+(?:is\s+)?([^\s]+)/iu.exec(versionOutput)?.[1] ?? versionOutput.trim().split(/\r?\n/u).at(-1) ?? "unknown";
  const loaded = new Set(runningResult.stdout.split(/\r?\n/u).slice(1).flatMap((line) => {
    const id = line.trim().split(/\s+/u)[0];
    return id ? [id] : [];
  }));
  const options = listResult.stdout.split(/\r?\n/u).slice(1).flatMap((line) => {
    const id = line.trim().split(/\s+/u)[0];
    return id ? [{ id, label: id, ...(loaded.has(id) ? { loaded: true } : {}) }] : [];
  });
  return { path, version: `Ollama ${version}`, models: { default: options[0]?.id ?? "", options } };
}

function promptText(messages: ChatMessage[]): string {
  return messages.map((message) => {
    if (message.role === "tool") return `[tool ${message.tool_call_id}]\n${message.content}`;
    return `[${message.role}]\n${message.content}`;
  }).join("\n\n");
}

export class OllamaCliProvider implements ModelProvider {
  constructor(
    private readonly cliCommand: string,
    private readonly modelId: string,
    private readonly cwd: string,
  ) {}

  async *run(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<ModelEvent> {
    const path = resolveCliPath(this.cliCommand, cliEnvironment());
    if (!path || !this.modelId) throw new AevorenBotError("MODEL_NOT_CONFIGURED");
    mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    const child = spawn(path, ["run", this.modelId, "--think=false", "--nowordwrap"], {
      cwd: this.cwd,
      env: cliEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      ...cliShellOptions(path),
    });
    const requestId = randomUUID();
    let processError = false;
    let emitted = false;
    child.once("error", () => { processError = true; });
    child.stderr.resume();
    const abort = (): void => { child.kill("SIGTERM"); };
    signal.addEventListener("abort", abort, { once: true });
    child.stdin.end(promptText(messages));
    child.stdout.setEncoding("utf8");
    yield { type: "started", requestId };
    try {
      for await (const chunk of child.stdout) {
        const text = String(chunk).replace(/\r/gu, "");
        if (!text) continue;
        emitted = true;
        yield { type: "delta", text };
      }
      const exitCode = await new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) resolve(child.exitCode);
        else child.once("close", (code) => resolve(code));
      });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (processError) throw new AevorenBotError("MODEL_CLI_INVALID");
      if (exitCode !== 0) throw new AevorenBotError("MODEL_REQUEST_REFUSED", undefined, false, { status: exitCode ?? -1 });
      if (!emitted) throw new AevorenBotError("MODEL_STREAM_TRUNCATED");
      yield { type: "completed", finishReason: "stop" };
    } finally {
      signal.removeEventListener("abort", abort);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }

  async testConnection(_signal: AbortSignal): Promise<void> {
    const inspection = await inspectOllamaCli(this.cliCommand);
    if (!inspection.models.default) {
      throw new AevorenBotError("MODEL_PROVIDER_UNAVAILABLE", undefined, false, { reason: "models" });
    }
  }
}
