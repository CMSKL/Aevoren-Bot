import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PRIVATE_ENV_PREFIXES = ["APPLE_", "CSC_", "GITHUB_", "AEVOREN_BOT_"];
const PRIVATE_ENV_SUFFIX = /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL)$/iu;
const PRIVATE_ENV_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "BOX_TOKEN",
  "GH_TOKEN",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENCODE_API_KEY",
  "XAI_API_KEY",
]);

export function standardCliDirectories(platform = process.platform, sourceEnv: NodeJS.ProcessEnv = process.env): string[] {
  const pathJoin = platform === "win32" ? win32.join : join;
  const userHome = homedir();
  const nvmDirectories = (() => {
    try {
      return readdirSync(join(userHome, ".nvm", "versions", "node"))
        .filter((version) => version.startsWith("v"))
        .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }))
        .map((version) => join(userHome, ".nvm", "versions", "node", version, "bin"));
    } catch {
      return [];
    }
  })();
  const common = [
    join(userHome, ".local", "bin"),
    join(userHome, ".npm-global", "bin"),
    join(userHome, ".claude", "local"),
    join(userHome, ".opencode", "bin"),
    join(userHome, ".kimi-code", "bin"),
    join(userHome, ".volta", "bin"),
    join(userHome, ".bun", "bin"),
    join(userHome, ".asdf", "shims"),
    join(userHome, "Library", "pnpm"),
    join(userHome, "bin"),
    ...nvmDirectories,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  if (platform !== "win32") return common;
  const windows = [
    sourceEnv.APPDATA ? pathJoin(sourceEnv.APPDATA, "npm") : null,
    sourceEnv.LOCALAPPDATA ? pathJoin(sourceEnv.LOCALAPPDATA, "Programs") : null,
    sourceEnv.LOCALAPPDATA ? pathJoin(sourceEnv.LOCALAPPDATA, "pnpm") : null,
    sourceEnv.USERPROFILE ? pathJoin(sourceEnv.USERPROFILE, ".local", "bin") : null,
    sourceEnv.USERPROFILE ? pathJoin(sourceEnv.USERPROFILE, ".cargo", "bin") : null,
    sourceEnv.PNPM_HOME,
    sourceEnv.VOLTA_HOME,
    sourceEnv.SCOOP ? pathJoin(sourceEnv.SCOOP, "shims") : null,
    sourceEnv.ChocolateyInstall ? pathJoin(sourceEnv.ChocolateyInstall, "bin") : null,
    sourceEnv.ProgramFiles ? pathJoin(sourceEnv.ProgramFiles, "nodejs") : null,
    sourceEnv.ProgramFiles ? pathJoin(sourceEnv.ProgramFiles, "Ollama") : null,
    sourceEnv["ProgramFiles(x86)"] ? pathJoin(sourceEnv["ProgramFiles(x86)"], "nodejs") : null,
  ].filter((value): value is string => Boolean(value));
  return [...windows, ...common.filter((directory) => !directory.startsWith("/"))];
}

export function cliEnvironment(sourceEnv: NodeJS.ProcessEnv = process.env, platform = process.platform): NodeJS.ProcessEnv {
  const env = { ...sourceEnv };
  for (const name of Object.keys(env)) {
    if (
      PRIVATE_ENV_NAMES.has(name) ||
      PRIVATE_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
      PRIVATE_ENV_SUFFIX.test(name)
    ) delete env[name];
  }
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const directories = [...String(sourceEnv.PATH ?? "").split(pathDelimiter), ...standardCliDirectories(platform, sourceEnv)].filter(Boolean);
  env.PATH = [...new Set(directories)].join(pathDelimiter);
  return env;
}

export function isolatedCodexEnvironment(runtimeHome: string, platform = process.platform): NodeJS.ProcessEnv {
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  const sourceHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const sourceAuth = join(sourceHome, "auth.json");
  const targetAuth = join(runtimeHome, "auth.json");
  if (sourceAuth !== targetAuth && existsSync(sourceAuth)) {
    if (existsSync(targetAuth)) {
      const current = lstatSync(targetAuth);
      if (current.isSymbolicLink()) {
        if (readlinkSync(targetAuth) !== sourceAuth) throw new Error("The isolated Codex credential link is not owned by Aevoren Bot");
      } else if (platform !== "win32" || readFileSync(targetAuth).compare(readFileSync(sourceAuth)) !== 0) {
        throw new Error("The isolated Codex credential copy is not owned by Aevoren Bot");
      }
    } else {
      try {
        symlinkSync(sourceAuth, targetAuth, "file");
      } catch (error) {
        if (platform !== "win32") throw error;
        copyFileSync(sourceAuth, targetAuth);
      }
    }
  }
  const sanitized = readCodexConfiguration(sourceHome);
  if (sanitized.text) writeFileSync(join(runtimeHome, "config.toml"), sanitized.text, { encoding: "utf8", mode: 0o600 });
  const environment: NodeJS.ProcessEnv = { ...cliEnvironment(process.env, platform), CODEX_HOME: runtimeHome };
  for (const name of sanitized.environmentKeys) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

type CodexConfiguration = {
  text: string;
  environmentKeys: string[];
  model: string | null;
  provider: string | null;
  configuredEnvironmentKey: string | null;
};

const CODEX_MODEL_ID = /^[a-z0-9][a-z0-9._:/+-]*$/iu;
const CODEX_PROVIDER_ID = /^[a-z][a-z0-9_-]*$/iu;
const CODEX_ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]{0,100}$/u;

function tomlText(value: string): string {
  return JSON.stringify(value);
}

function tomlValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.split(/\s+#/u, 1)[0]?.trim() ?? "";
}

function readCodexConfiguration(sourceHome: string): CodexConfiguration {
  let source: string;
  try {
    source = readFileSync(join(sourceHome, "config.toml"), "utf8");
  } catch {
    return { text: "", environmentKeys: [], model: null, provider: null, configuredEnvironmentKey: null };
  }
  let section: "root" | "other" | string = "root";
  let model: string | null = null;
  let provider: string | null = null;
  const providers = new Map<string, Record<string, string>>();
  const environmentKeys = new Set<string>();
  for (const line of source.split(/\r?\n/u)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      const match = /^\[model_providers\.([a-z][a-z0-9_-]*)\]$/iu.exec(stripped);
      section = match && CODEX_PROVIDER_ID.test(match[1]!) ? match[1]! : "other";
      if (section !== "other" && section !== "root" && !providers.has(section)) providers.set(section, {});
      continue;
    }
    const separator = stripped.indexOf("=");
    if (separator < 0) continue;
    const key = stripped.slice(0, separator).trim();
    const value = tomlValue(stripped.slice(separator + 1));
    if (!value) continue;
    if (section === "root") {
      if (key === "model" && CODEX_MODEL_ID.test(value)) model = value;
      if (key === "model_provider" && CODEX_PROVIDER_ID.test(value)) provider = value;
      continue;
    }
    if (section === "other") continue;
    const target = providers.get(section)!;
    if (key === "name" && value.length <= 120) target.name = value;
    if (key === "base_url") {
      try {
        const url = new URL(value);
        if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) target.base_url = value;
      } catch {
        // Ignore an invalid custom Provider URL.
      }
    }
    if (key === "env_key" && CODEX_ENVIRONMENT_KEY.test(value)) {
      target.env_key = value;
    }
    if (key === "wire_api" && ["responses", "chat"].includes(value)) target.wire_api = value;
    if (key === "requires_openai_auth" && ["true", "false"].includes(value)) target.requires_openai_auth = value;
  }
  const output: string[] = [];
  if (model) output.push(`model = ${tomlText(model)}`);
  if (provider) output.push(`model_provider = ${tomlText(provider)}`);
  for (const [id, values] of providers) {
    if (!values.base_url) continue;
    if (values.env_key) environmentKeys.add(values.env_key);
    output.push("", `[model_providers.${id}]`);
    for (const key of ["name", "base_url", "env_key", "wire_api"] as const) {
      if (values[key]) output.push(`${key} = ${tomlText(values[key]!)}`);
    }
    if (values.requires_openai_auth) output.push(`requires_openai_auth = ${values.requires_openai_auth}`);
  }
  return {
    text: output.length ? `${output.join("\n")}\n` : "",
    environmentKeys: [...environmentKeys],
    model,
    provider,
    configuredEnvironmentKey: provider ? providers.get(provider)?.env_key ?? null : null,
  };
}

export function readCodexConfiguredSelection(): { model: string; provider: string } | null {
  const sourceHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const configuration = readCodexConfiguration(sourceHome);
  if (!configuration.model || !configuration.provider) return null;
  if (configuration.configuredEnvironmentKey && !process.env[configuration.configuredEnvironmentKey]) return null;
  return { model: configuration.model, provider: configuration.provider };
}

function windowsExecutableCandidates(path: string, env: NodeJS.ProcessEnv): string[] {
  if (/[.]\w+$/u.test(path)) return [path];
  const extensions = String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [path, ...extensions.map((extension) => `${path}${extension.toLowerCase()}`)];
}

function canAccessCli(path: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findCliCandidates(command: string, env: NodeJS.ProcessEnv = cliEnvironment(), platform = process.platform): string[] {
  const trimmed = command.trim();
  if (!trimmed || /[\r\n\0]/u.test(trimmed)) return [];
  if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    return (platform === "win32" ? windowsExecutableCandidates(trimmed, env) : [trimmed]).filter((candidate) => canAccessCli(candidate, platform));
  }
  const candidates: string[] = [];
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const pathJoin = platform === "win32" ? win32.join : join;
  for (const directory of String(env.PATH ?? "").split(pathDelimiter).filter(Boolean)) {
    for (const path of platform === "win32" ? windowsExecutableCandidates(pathJoin(directory, trimmed), env) : [pathJoin(directory, trimmed)]) {
      if (canAccessCli(path, platform) && !candidates.includes(path)) candidates.push(path);
    }
  }
  if (candidates.length === 0 && platform === "win32") {
    for (const directory of standardCliDirectories(platform, env)) {
      for (const path of windowsExecutableCandidates(pathJoin(directory, trimmed), env)) {
        if (canAccessCli(path, platform) && !candidates.includes(path)) candidates.push(path);
      }
    }
  }
  return candidates;
}

export function resolveCliPath(command: string, env: NodeJS.ProcessEnv = cliEnvironment(), platform = process.platform): string | null {
  return findCliCandidates(command, env, platform)[0] ?? null;
}

/**
 * Windows installs commonly expose npm/ pnpm based CLIs as .cmd or .bat
 * wrappers. Node cannot execute those wrappers directly without a shell. Keep
 * the shell opt-in and limited to an already-resolved wrapper path so Unix
 * providers retain their current execution semantics.
 */
export function cliShellOptions(path: string, platform = process.platform): { shell?: boolean } {
  return platform === "win32" && /\.(?:cmd|bat)$/iu.test(path) ? { shell: true } : {};
}

export async function probeCliVersion(command: string): Promise<{ path: string; version: string }> {
  const env = cliEnvironment();
  const path = resolveCliPath(command, env);
  if (!path) throw new Error("CLI executable was not found");
  const result = await execFileAsync(path, ["--version"], {
    env,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    ...cliShellOptions(path),
  });
  const version = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/u)[0]?.slice(0, 200) ?? "";
  if (!version) throw new Error("CLI did not report a version");
  return { path, version };
}
