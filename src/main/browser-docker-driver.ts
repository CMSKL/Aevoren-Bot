import { DockerCommandError, DockerDriver, type DockerContainer, type DockerImage } from "./docker-driver";

export const BROWSER_IMAGE_REF = "aevoren-browser-worker:1.0.0";
function id(value: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw new DockerCommandError("DOCKER_ID_INVALID", "");
  return value;
}
function digest(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new DockerCommandError("DOCKER_IMAGE_INVALID", "");
  return value;
}

export class BrowserDockerDriver extends DockerDriver {
  async inspectBrowserImage(ref = BROWSER_IMAGE_REF, signal?: AbortSignal): Promise<DockerImage | null> {
    if (ref !== BROWSER_IMAGE_REF) digest(ref);
    try {
      const image = JSON.parse((await this.command(["image", "inspect", ref, "--format", "{{json .}}"], { signal })).stdout);
      const labels = image.Config?.Labels ?? {};
      if (image.Os !== "linux" || !["arm64", "amd64"].includes(image.Architecture) || labels["io.aevoren.role"] !== "browser-worker"
        || !/^[a-f0-9]{64}$/.test(labels["io.aevoren.worker-bundle"] ?? "")) throw new DockerCommandError("DOCKER_IMAGE_INVALID", "");
      return { id: digest(image.Id), ref, platform: `linux/${image.Architecture}` as DockerImage["platform"], workerVersion: labels["io.aevoren.worker-version"], bundleSha256: labels["io.aevoren.worker-bundle"] };
    } catch (error) {
      if (error instanceof DockerCommandError && /No such image|not found/i.test(error.stderr)) return null;
      throw error;
    }
  }

  async initializeBrowser(contextPath: string, bundleSha256: string, signal?: AbortSignal): Promise<DockerImage> {
    if (!/^[a-f0-9]{64}$/.test(bundleSha256)) throw new DockerCommandError("DOCKER_IMAGE_INVALID", "");
    const probe = await this.probe(signal);
    if (probe.status !== "ready" || !probe.platform) throw new DockerCommandError("DOCKER_NOT_READY", "");
    await this.command(["build", "--platform", probe.platform, "--label", `io.aevoren.worker-bundle=${bundleSha256}`, "--tag", BROWSER_IMAGE_REF, contextPath], { signal, timeoutMs: 900_000 });
    const image = await this.inspectBrowserImage(BROWSER_IMAGE_REF, signal);
    if (!image || image.bundleSha256 !== bundleSha256 || image.workerVersion !== "1.0.0" || image.platform !== probe.platform) throw new DockerCommandError("DOCKER_IMAGE_INVALID", "");
    return image;
  }

  async inspectBrowser(browserId: string, environmentId: string, signal?: AbortSignal): Promise<DockerContainer | null> {
    const name = `aevoren-browser-${id(browserId)}`;
    try {
      const value = JSON.parse((await this.command(["container", "inspect", name, "--format", "{{json .}}"], { signal })).stdout);
      const labels = value.Config?.Labels ?? {};
      const expected = ["state", "profile", "downloads"];
      const mounts = value.Mounts ?? [];
      if (labels["io.aevoren.role"] !== "browser-environment" || labels["io.aevoren.browser"] !== browserId || labels["io.aevoren.environment"] !== id(environmentId)
        || value.HostConfig?.Privileged || !value.HostConfig?.ReadonlyRootfs || !value.HostConfig?.CapDrop?.includes("ALL") || mounts.length !== 3
        || expected.some(kind => !mounts.some((mount: { Type: string; Name: string; Destination: string }) => mount.Type === "volume"
          && mount.Name === `aevoren-browser-${kind}-${browserId}` && mount.Destination === `/var/lib/aevoren-browser-${kind}`))) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
      const bindings = value.NetworkSettings?.Ports?.["8081/tcp"] ?? [];
      if (bindings.some((binding: { HostIp: string; HostPort: string }) => binding.HostIp !== "127.0.0.1" || !/^\d+$/.test(binding.HostPort))) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
      return { id: value.Id, name, imageId: digest(value.Image), state: value.State.Status, workerPort: bindings[0] ? Number(bindings[0].HostPort) : null, oomKilled: Boolean(value.State.OOMKilled) };
    } catch (error) {
      if (error instanceof DockerCommandError && /No such container|not found/i.test(error.stderr)) return null;
      throw error;
    }
  }

  private async connectScope(environmentId: string, signal?: AbortSignal): Promise<string> {
    const network = `aevoren-scope-${id(environmentId)}`;
    try {
      const data = JSON.parse((await this.command(["network", "inspect", network, "--format", "{{json .}}"], { signal })).stdout);
      if (data.Labels?.["io.aevoren.environment"] !== environmentId) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
    } catch (error) {
      if (!(error instanceof DockerCommandError) || !/not found|No such network/i.test(error.stderr)) throw error;
      await this.command(["network", "create", "--label", `io.aevoren.environment=${environmentId}`, network], { signal });
    }
    if (!(await super.inspect(environmentId, signal))) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
    try { await this.command(["network", "connect", network, `aevoren-execution-${environmentId}`], { signal }); }
    catch (error) { if (!(error instanceof DockerCommandError) || !/already exists/i.test(error.stderr)) throw error; }
    return network;
  }

  private async executionAddress(environmentId: string, network: string, signal?: AbortSignal): Promise<string> {
    const networks = JSON.parse((await this.command(["container", "inspect", `aevoren-execution-${id(environmentId)}`, "--format", "{{json .NetworkSettings.Networks}}"], { signal })).stdout);
    const address: unknown = networks[network]?.IPAddress;
    if (typeof address !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) || address.split(".").some(part => Number(part) > 255)) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
    return address;
  }

  async createBrowser(browserId: string, environmentId: string, image: DockerImage, token: string, signal?: AbortSignal): Promise<DockerContainer> {
    const network = await this.connectScope(environmentId, signal);
    const address = await this.executionAddress(environmentId, network, signal);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new DockerCommandError("DOCKER_ID_INVALID", "");
    const name = `aevoren-browser-${id(browserId)}`;
    await this.command(["run", "--detach", "--init", "--name", name, "--network", network,
      "--label", "io.aevoren.role=browser-environment", "--label", `io.aevoren.browser=${browserId}`, "--label", `io.aevoren.environment=${environmentId}`,
      "--read-only", "--memory", "768m", "--pids-limit", "512", "--cpus", "1", "--cap-drop", "ALL",
      "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "KILL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--publish", "127.0.0.1::8081",
      ...["state", "profile", "downloads"].flatMap(kind => ["--mount", `type=volume,source=aevoren-browser-${kind}-${browserId},target=/var/lib/aevoren-browser-${kind}`]),
      "--env", "AEVOREN_BROWSER_TOKEN", "--env", `AEVOREN_PREVIEW_EXECUTION_IP=${address}`, "--env", `AEVOREN_BROWSER_ENVIRONMENT_ID=${environmentId}`, "--env", `AEVOREN_BROWSER_SESSION_ID=${browserId}`, digest(image.id)],
    { signal, env: { AEVOREN_BROWSER_TOKEN: token }, timeoutMs: 30_000 });
    const created = await this.inspectBrowser(browserId, environmentId, signal);
    if (!created?.workerPort) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
    return created;
  }

  async startBrowser(browserId: string, environmentId: string, signal?: AbortSignal): Promise<DockerContainer> {
    if (!(await this.inspectBrowser(browserId, environmentId, signal))) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
    await this.connectScope(environmentId, signal);
    await this.command(["start", `aevoren-browser-${id(browserId)}`], { signal, timeoutMs: 30_000 });
    return (await this.inspectBrowser(browserId, environmentId, signal))!;
  }
  async stopBrowser(browserId: string, environmentId: string, remove = false): Promise<void> {
    const current = await this.inspectBrowser(browserId, environmentId);
    if (!current) return;
    if (current.state === "running") await this.command(["stop", "--time", "10", current.name], { timeoutMs: 20_000 });
    if (remove) await this.command(["rm", current.name]);
  }
}
