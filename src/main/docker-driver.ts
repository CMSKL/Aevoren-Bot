import { spawn } from "node:child_process";
import { ENV_WORKER_VERSION } from "@shared/environment-contracts";

export type DockerPlatform = "linux/arm64" | "linux/amd64";
export type DockerProbe = { status: "missing" | "stopped" | "ready" | "unsupported" | "error"; version: string | null; platform: DockerPlatform | null; reason: string | null };
export type DockerImage = { id: string; ref: string; platform: DockerPlatform; workerVersion: string; bundleSha256: string };
export type DockerContainer = { id: string; name: string; imageId: string; state: string; workerPort: number | null; oomKilled: boolean };
type CommandOptions = { signal?: AbortSignal; timeoutMs?: number; env?: Record<string, string>; output?: (stream: "stdout" | "stderr", text: string) => void };
type CommandResult = { stdout: string; stderr: string };
export type DockerCommandRunner = (args: string[], options?: CommandOptions) => Promise<CommandResult>;

export class DockerCommandError extends Error {
  constructor(readonly code: string, readonly stderr: string) { super(code); }
}

export const EXECUTION_IMAGE_REF = `aevoren-execution-worker:${ENV_WORKER_VERSION}`;
const ROLE_LABEL = "io.aevoren.role";
const ENVIRONMENT_LABEL = "io.aevoren.environment";
const VERSION_LABEL = "io.aevoren.worker-version";
const BUNDLE_LABEL = "io.aevoren.worker-bundle";

function bounded(value: string): string { return value.slice(-262_144); }

async function runCommand(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...options.env };
    if (args[0] === "--context") { delete env.DOCKER_HOST; delete env.DOCKER_CONTEXT; }
    const child = spawn("docker", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "", stderr = "";
    let expired = false;
    const abort = (): void => { child.kill(); };
    const timer = setTimeout(() => { expired = true; child.kill(); }, options.timeoutMs ?? 30_000);
    timer.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => { stdout = bounded(stdout + text); options.output?.("stdout", text); });
    child.stderr.on("data", (text: string) => { stderr = bounded(stderr + text); options.output?.("stderr", text); });
    child.once("error", (error: NodeJS.ErrnoException) => { cleanup(); reject(new DockerCommandError(error.code ?? "DOCKER_COMMAND_FAILED", "")); });
    child.once("close", (code) => {
      cleanup();
      if (options.signal?.aborted) { reject(options.signal.reason ?? new DOMException("Aborted", "AbortError")); return; }
      if (expired) { reject(new DockerCommandError("DOCKER_TIMEOUT", "")); return; }
      if (code !== 0) { reject(new DockerCommandError("DOCKER_COMMAND_FAILED", stderr)); return; }
      resolve({ stdout, stderr });
    });
    if (options.signal?.aborted) abort();
  });
}

function identifier(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new DockerCommandError("DOCKER_ID_INVALID", "");
  return id;
}
function imageId(id: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new DockerCommandError("DOCKER_IMAGE_INVALID", "");
  return id;
}

/** Administration has fixed argument arrays and can connect only to a local Docker endpoint. */
export class DockerDriver {
  private context: string | null = null;
  private platform: DockerPlatform | null = null;
  constructor(private readonly runner: DockerCommandRunner = runCommand) {}

  private async localContext(signal?: AbortSignal): Promise<string> {
    if (process.env.DOCKER_HOST && !/^(unix:\/\/\/|npipe:\/\/)/.test(process.env.DOCKER_HOST)) throw new DockerCommandError("DOCKER_REMOTE_UNSUPPORTED", "");
    const current = (await this.runner(["context", "show"], { signal, timeoutMs: 5_000 })).stdout.trim();
    if (!current || current.length > 200 || /[\r\n\0]/.test(current)) throw new DockerCommandError("DOCKER_CONTEXT_INVALID", "");
    const endpoint = JSON.parse((await this.runner(["context", "inspect", current, "--format", "{{json .Endpoints.docker.Host}}"], { signal, timeoutMs: 5_000 })).stdout) as unknown;
    if (typeof endpoint !== "string" || !/^(unix:\/\/\/|npipe:\/\/)/.test(endpoint)) throw new DockerCommandError("DOCKER_REMOTE_UNSUPPORTED", "");
    this.context = current;
    return current;
  }

  protected async command(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    const context = await this.localContext(options.signal);
    return this.runner(["--context", context, ...args], options);
  }

  async probe(signal?: AbortSignal): Promise<DockerProbe> {
    try {
      const context = await this.localContext(signal);
      const info = JSON.parse((await this.runner(["--context", context, "info", "--format", "{{json .}}"], { signal, timeoutMs: 8_000 })).stdout) as { OSType?: string; Architecture?: string; ServerVersion?: string };
      if (info.OSType !== "linux") return { status: "unsupported", version: info.ServerVersion ?? null, platform: null, reason: "需要 Docker Linux 容器运行时。" };
      this.platform = /^(?:arm64|aarch64)$/.test(info.Architecture ?? "") ? "linux/arm64" : /^(?:amd64|x86_64)$/.test(info.Architecture ?? "") ? "linux/amd64" : null;
      if (!this.platform) return { status: "unsupported", version: info.ServerVersion ?? null, platform: null, reason: "仅支持 Linux arm64 和 amd64 镜像。" };
      return { status: "ready", version: info.ServerVersion ?? null, platform: this.platform, reason: null };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const code = error instanceof DockerCommandError ? error.code : "DOCKER_RESPONSE_INVALID";
      return { status: code === "ENOENT" ? "missing" : code === "DOCKER_REMOTE_UNSUPPORTED" ? "unsupported" : code === "DOCKER_COMMAND_FAILED" || code === "DOCKER_TIMEOUT" ? "stopped" : "error", version: null, platform: null,
        reason: code === "ENOENT" ? "未找到 Docker，请安装本机 Linux 容器运行时。" : code === "DOCKER_REMOTE_UNSUPPORTED" ? "首期仅支持本机 Docker，不能连接远程上下文。" : "Docker 未就绪，请启动引擎后重新检测。" };
    }
  }

  async inspectImage(ref: string = EXECUTION_IMAGE_REF, signal?: AbortSignal): Promise<DockerImage | null> {
    if (ref !== EXECUTION_IMAGE_REF) imageId(ref);
    try {
      const value = JSON.parse((await this.command(["image", "inspect", ref, "--format", "{{json .}}"], { signal, timeoutMs: 10_000 })).stdout) as { Id: string; Os: string; Architecture: string; Config?: { Labels?: Record<string, string> } };
      const labels = value.Config?.Labels ?? {};
      if (value.Os !== "linux" || !["arm64", "amd64"].includes(value.Architecture) || labels[ROLE_LABEL] !== "execution-worker" || !/^[a-f0-9]{64}$/.test(labels[BUNDLE_LABEL] ?? "")) throw new DockerCommandError("DOCKER_IMAGE_INVALID", "");
      return { id: imageId(value.Id), ref, platform: `linux/${value.Architecture}` as DockerPlatform, workerVersion: labels[VERSION_LABEL] ?? "", bundleSha256: labels[BUNDLE_LABEL]! };
    } catch (error) {
      if (error instanceof DockerCommandError && /No such image|not found/i.test(error.stderr)) return null;
      throw error;
    }
  }

  async initialize(contextPath: string, bundleSha256: string, signal?: AbortSignal, output?: CommandOptions["output"]): Promise<DockerImage> {
    if (!/^[a-f0-9]{64}$/.test(bundleSha256)) throw new DockerCommandError("DOCKER_IMAGE_INVALID", "");
    const probe = await this.probe(signal);
    if (probe.status !== "ready" || !probe.platform) throw new DockerCommandError("DOCKER_NOT_READY", "");
    await this.command(["build", "--platform", probe.platform, "--label", `${ROLE_LABEL}=execution-worker`, "--label", `${VERSION_LABEL}=${ENV_WORKER_VERSION}`, "--label", `${BUNDLE_LABEL}=${bundleSha256}`, "--tag", EXECUTION_IMAGE_REF, contextPath], { signal, timeoutMs: 600_000, output });
    const image = await this.inspectImage(EXECUTION_IMAGE_REF, signal);
    if (!image || image.bundleSha256 !== bundleSha256 || image.workerVersion !== ENV_WORKER_VERSION || image.platform !== probe.platform) throw new DockerCommandError("DOCKER_IMAGE_INVALID", "");
    return image;
  }

  async inspect(environmentId: string, signal?: AbortSignal): Promise<DockerContainer | null> {
    const name = `aevoren-execution-${identifier(environmentId)}`;
    try {
      const value = JSON.parse((await this.command(["container", "inspect", name, "--format", "{{json .}}"], { signal, timeoutMs: 10_000 })).stdout) as {
        Id: string; Image: string; Config: { Labels?: Record<string, string> }; State: { Status: string; OOMKilled: boolean };
        HostConfig: { Privileged?: boolean; ReadonlyRootfs?: boolean; CapDrop?: string[] }; Mounts?: { Type: string; Name?: string; Destination: string }[];
        NetworkSettings: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> };
      };
      const labels = value.Config.Labels ?? {};
      const mounts = value.Mounts ?? [];
      if (labels[ROLE_LABEL] !== "execution-environment" || labels[ENVIRONMENT_LABEL] !== environmentId || value.HostConfig.Privileged || !value.HostConfig.ReadonlyRootfs || !value.HostConfig.CapDrop?.includes("ALL")
        || mounts.some(mount => mount.Type !== "volume" || !["/workspace", "/var/lib/aevoren"].includes(mount.Destination))
        || !mounts.some(mount => mount.Name === `aevoren-work-${environmentId}` && mount.Destination === "/workspace")
        || !mounts.some(mount => mount.Name === `aevoren-state-${environmentId}` && mount.Destination === "/var/lib/aevoren")) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
      const bindings = value.NetworkSettings.Ports?.["8080/tcp"] ?? [];
      if (bindings.some(binding => binding.HostIp !== "127.0.0.1" || !/^\d+$/.test(binding.HostPort))) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
      const port = bindings[0] ? Number(bindings[0].HostPort) : null;
      if (port !== null && (port < 1 || port > 65_535)) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
      return { id: value.Id, name, imageId: imageId(value.Image), state: value.State.Status, workerPort: port, oomKilled: Boolean(value.State.OOMKilled) };
    } catch (error) {
      if (error instanceof DockerCommandError && /No such (?:object|container)/i.test(error.stderr)) return null;
      throw error;
    }
  }

  async create(environmentId: string, image: DockerImage, token: string, signal?: AbortSignal): Promise<DockerContainer> {
    identifier(environmentId); imageId(image.id);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new DockerCommandError("DOCKER_TOKEN_INVALID", "");
    const existing = await this.inspect(environmentId, signal);
    if (existing) throw new DockerCommandError("DOCKER_ENVIRONMENT_EXISTS", "");
    await this.command(["run", "--detach", "--init", "--name", `aevoren-execution-${environmentId}`, "--platform", image.platform,
      "--label", `${ROLE_LABEL}=execution-environment`, "--label", `${ENVIRONMENT_LABEL}=${environmentId}`,
      "--read-only", "--memory", "768m", "--pids-limit", "256", "--cpus", "1", "--cap-drop", "ALL",
      "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "KILL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--publish", "127.0.0.1::8080",
      "--mount", `type=volume,source=aevoren-work-${environmentId},target=/workspace`, "--mount", `type=volume,source=aevoren-state-${environmentId},target=/var/lib/aevoren`,
      "--env", `AEVOREN_WORKER_ENVIRONMENT_ID=${environmentId}`, "--env", "AEVOREN_WORKER_TOKEN", image.id], { signal, timeoutMs: 60_000, env: { AEVOREN_WORKER_TOKEN: token } });
    const container = await this.inspect(environmentId, signal);
    if (!container || container.imageId !== image.id || container.state !== "running" || !container.workerPort) throw new DockerCommandError("DOCKER_START_FAILED", "");
    return container;
  }

  async start(environmentId: string, signal?: AbortSignal): Promise<DockerContainer> {
    if (!await this.inspect(environmentId, signal)) throw new DockerCommandError("DOCKER_ENVIRONMENT_MISSING", "");
    await this.command(["start", `aevoren-execution-${identifier(environmentId)}`], { signal, timeoutMs: 60_000 });
    const container = await this.inspect(environmentId, signal);
    if (!container || container.state !== "running" || !container.workerPort) throw new DockerCommandError("DOCKER_START_FAILED", "");
    return container;
  }

  async stop(environmentId: string, signal?: AbortSignal): Promise<void> {
    const existing = await this.inspect(environmentId, signal);
    if (!existing || existing.state !== "running") return;
    await this.command(["stop", "--time", "10", `aevoren-execution-${identifier(environmentId)}`], { signal, timeoutMs: 30_000 });
  }

  async remove(environmentId: string, signal?: AbortSignal): Promise<void> {
    if (!await this.inspect(environmentId, signal)) return;
    await this.command(["rm", "--force", `aevoren-execution-${identifier(environmentId)}`], { signal, timeoutMs: 30_000 });
  }
}
