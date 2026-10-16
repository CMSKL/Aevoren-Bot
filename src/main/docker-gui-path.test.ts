import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockerDriver } from "./docker-driver";

const location = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async importOriginal => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => location.home,
}));

const guiPath = "/usr/bin:/bin:/usr/sbin:/sbin";

function installFixture(directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$AEVOREN_DOCKER_GUI_TRACE"
printf '%s\\n' "$PATH" > "$AEVOREN_DOCKER_GUI_PATH"
case "$1 $2" in
  'context show') printf '%s\\n' 'gui-owned' ;;
  'context inspect') printf '"%s"\\n' "$AEVOREN_DOCKER_GUI_ENDPOINT" ;;
  '--context gui-owned')
    [ "$3" = info ] || exit 2
    case "$0" in */custom-bin/docker) version=existing ;; *) version=fallback ;; esac
    printf '{"OSType":"linux","Architecture":"arm64","ServerVersion":"%s"}\\n' "$version"
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
}

describe.skipIf(process.platform !== "darwin")("Docker discovery from a macOS GUI environment", () => {
  let directory: string, trace: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "aevoren-docker-gui-"));
    location.home = join(directory, "home with spaces");
    trace = join(directory, "calls.log");
    installFixture(join(location.home, ".docker", "bin"));
    vi.stubEnv("PATH", guiPath);
    vi.stubEnv("DOCKER_HOST", "");
    vi.stubEnv("DOCKER_CONTEXT", "");
    vi.stubEnv("AEVOREN_DOCKER_GUI_TRACE", trace);
    vi.stubEnv("AEVOREN_DOCKER_GUI_PATH", join(directory, "child-path"));
    vi.stubEnv("AEVOREN_DOCKER_GUI_ENDPOINT", "unix:///fixture/docker.sock");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("executes the installed user CLI when the inherited GUI PATH omits Docker", async () => {
    expect(await new DockerDriver().probe()).toMatchObject({ status: "ready", version: "fallback", platform: "linux/arm64" });
    expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual([
      "context show", "context inspect gui-owned --format {{json .Endpoints.docker.Host}}",
      "--context gui-owned info --format {{json .}}",
    ]);
    expect(process.env.PATH).toBe(guiPath);
  });

  it("keeps the user's existing PATH executable ahead of standard locations", async () => {
    const custom = join(directory, "custom-bin");
    installFixture(custom);
    const path = `${custom}:${guiPath}`;
    vi.stubEnv("PATH", path);
    expect(await new DockerDriver().probe()).toMatchObject({ status: "ready", version: "existing" });
    expect(process.env.PATH).toBe(path);
  });

  it.each(["", undefined])("finds the CLI without adding a current-directory search for PATH=%s", async path => {
    vi.stubEnv("PATH", path);
    expect(await new DockerDriver().probe()).toMatchObject({ status: "ready", version: "fallback" });
    expect(readFileSync(join(directory, "child-path"), "utf8").trim().split(":")).not.toContain("");
    expect(process.env.PATH).toBe(path);
  });

  it("still rejects a remote context before invoking any daemon command", async () => {
    vi.stubEnv("AEVOREN_DOCKER_GUI_ENDPOINT", "ssh://fixture.invalid");
    expect(await new DockerDriver().probe()).toMatchObject({ status: "unsupported", platform: null });
    expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual([
      "context show", "context inspect gui-owned --format {{json .Endpoints.docker.Host}}",
    ]);
  });
});
