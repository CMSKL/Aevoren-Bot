import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerCommandError, DockerDriver, EXECUTION_IMAGE_REF, type DockerCommandRunner } from "./docker-driver";

afterEach(() => vi.unstubAllEnvs());
const digest = `sha256:${"a".repeat(64)}`;
const bundle = "b".repeat(64);

function fixture() {
  vi.stubEnv("DOCKER_HOST", "");
  let endpoint = "unix:///local/docker.sock";
  let os = "linux", architecture = "aarch64";
  let inspect: object | null = null;
  const calls: Array<{ args: string[]; env: Record<string, string> | undefined }> = [];
  const runner: DockerCommandRunner = vi.fn(async (args, options) => {
    calls.push({ args, env: options?.env });
    if (args[0] === "context" && args[1] === "show") return { stdout: "desktop-linux\n", stderr: "" };
    if (args[0] === "context" && args[1] === "inspect") return { stdout: JSON.stringify(endpoint), stderr: "" };
    const command = args.slice(2);
    if (command[0] === "info") return { stdout: JSON.stringify({ OSType: os, Architecture: architecture, ServerVersion: "29.5.3" }), stderr: "" };
    if (command[0] === "image") return { stdout: JSON.stringify({ Id: digest, Os: "linux", Architecture: architecture === "aarch64" ? "arm64" : "amd64", Config: { Labels: {
      "io.aevoren.role": "execution-worker", "io.aevoren.worker-version": "1.0.0", "io.aevoren.worker-bundle": bundle,
    } } }), stderr: "" };
    if (command[0] === "container") {
      if (!inspect) throw new DockerCommandError("DOCKER_COMMAND_FAILED", "No such container");
      return { stdout: JSON.stringify(inspect), stderr: "" };
    }
    if (command[0] === "run") inspect = container(command[command.indexOf("--name") + 1]!.slice("aevoren-execution-".length));
    return { stdout: "created", stderr: "" };
  });
  const driver = new DockerDriver(runner);
  return { driver, calls, setEndpoint(value: string) { endpoint = value; }, setPlatform(type: string, arch: string) { os = type; architecture = arch; }, setContainer(value: object) { inspect = value; } };
}

function container(id: string) {
  return { Id: "container-owned", Image: digest, Config: { Labels: { "io.aevoren.role": "execution-environment", "io.aevoren.environment": id } },
    State: { Status: "running", OOMKilled: false }, HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"] },
    Mounts: [{ Type: "volume", Name: `aevoren-work-${id}`, Destination: "/workspace" }, { Type: "volume", Name: `aevoren-state-${id}`, Destination: "/var/lib/aevoren" }],
    NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "43117" }] } } };
}

describe("local Docker administration", () => {
  it("rejects remote contexts before inspection, build or execution", async () => {
    const f = fixture(); f.setEndpoint("ssh://remote-host");
    expect(await f.driver.probe()).toMatchObject({ status: "unsupported", platform: null });
    expect(f.calls.every(call => call.args[0] === "context")).toBe(true);
    await expect(f.driver.initialize("/owned/context", bundle)).rejects.toMatchObject({ code: "DOCKER_NOT_READY" });
    expect(f.calls.some(call => call.args.includes("build"))).toBe(false);
  });

  it("rejects a remote DOCKER_HOST override without invoking the CLI", async () => {
    const f = fixture(); vi.stubEnv("DOCKER_HOST", "tcp://remote-host:2375");
    expect(await f.driver.probe()).toMatchObject({ status: "unsupported" });
    expect(f.calls).toEqual([]);
  });

  it("accepts local named pipes but rejects Windows container mode", async () => {
    const f = fixture(); f.setEndpoint("npipe:////./pipe/docker_engine"); f.setPlatform("windows", "x86_64");
    expect(await f.driver.probe()).toMatchObject({ status: "unsupported", platform: null });
    f.setPlatform("linux", "x86_64");
    expect(await f.driver.probe()).toMatchObject({ status: "ready", platform: "linux/amd64" });
  });

  it("pins the observed image id and publishes only a loopback control port with owned volumes", async () => {
    const f = fixture();
    const image = await f.driver.initialize("/owned/context", bundle);
    expect(image).toMatchObject({ id: digest, ref: EXECUTION_IMAGE_REF, platform: "linux/arm64", bundleSha256: bundle });
    const id = randomUUID(), token = "c".repeat(64);
    expect(await f.driver.create(id, image, token)).toMatchObject({ imageId: digest, workerPort: 43117, state: "running" });
    const call = f.calls.find(item => item.args.includes("run"))!;
    expect(call.args).toContain("127.0.0.1::8080");
    expect(call.args.at(-1)).toBe(digest);
    expect(call.args).toContain("--read-only");
    expect(call.args).toContain("no-new-privileges");
    expect(call.args).not.toContain("--privileged");
    expect(call.args.filter((_, index) => call.args[index - 1] === "--mount")).toEqual([
      `type=volume,source=aevoren-work-${id},target=/workspace`, `type=volume,source=aevoren-state-${id},target=/var/lib/aevoren`,
    ]);
    expect(call.args.some(value => value.includes(token))).toBe(false);
    expect(call.env).toEqual({ AEVOREN_WORKER_TOKEN: token });
  });

  it.each(["host-mount", "public-port", "different-owner"])("refuses to stop or delete an unowned container: %s", async (mutation) => {
    const f = fixture(), id = randomUUID();
    const value = container(id);
    if (mutation === "host-mount") value.Mounts.push({ Type: "bind", Name: "", Destination: "/home/user" });
    if (mutation === "public-port") value.NetworkSettings.Ports["8080/tcp"][0]!.HostIp = "0.0.0.0";
    if (mutation === "different-owner") value.Config.Labels["io.aevoren.environment"] = randomUUID();
    f.setContainer(value);
    await expect(f.driver.stop(id)).rejects.toMatchObject({ code: "DOCKER_OWNERSHIP_INVALID" });
    await expect(f.driver.remove(id)).rejects.toMatchObject({ code: "DOCKER_OWNERSHIP_INVALID" });
    expect(f.calls.some(call => call.args.includes("stop") || call.args.includes("rm"))).toBe(false);
  });
});
