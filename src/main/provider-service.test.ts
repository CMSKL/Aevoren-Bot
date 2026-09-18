import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { ProviderService } from "./provider-service";
import type { SecretCodec } from "./settings";
import { CodexCliProvider, inspectCodexCli } from "./providers/codex-cli";
import { ClaudeCliProvider, inspectClaudeCli } from "./providers/claude-cli";
import { OllamaCliProvider, inspectOllamaCli } from "./providers/ollama-cli";
import { AcpCliProvider, acpSpec, inspectAcpCli } from "./providers/acp-cli";
import { isolatedCodexEnvironment } from "./providers/cli-utils";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];
const codec: SecretCodec = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(value, "utf8").toString("base64"),
  decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
};
const fixtureCli = join(process.cwd(), "tests/fixtures/fake-codex-cli.mjs");
const fixtureClaudeCli = join(process.cwd(), "tests/fixtures/fake-claude-cli.mjs");
const fixtureOllamaCli = join(process.cwd(), "tests/fixtures/fake-ollama-cli.mjs");
const fixtureAcpCli = join(process.cwd(), "tests/fixtures/fake-acp-cli.mjs");

function providerWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-provider-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("ProviderService", () => {
  it("loads one unified CLI and HTTP registry and chooses the authenticated CLI for a fresh install", async () => {
    const binaryDirectory = join(providerWorkspace(), "bin");
    mkdirSync(binaryDirectory);
    symlinkSync(fixtureCli, join(binaryDirectory, "codex"));
    symlinkSync(fixtureClaudeCli, join(binaryDirectory, "claude"));
    symlinkSync(fixtureOllamaCli, join(binaryDirectory, "ollama"));
    symlinkSync(fixtureAcpCli, join(binaryDirectory, "gemini"));
    vi.stubEnv("PATH", binaryDirectory);
    vi.stubEnv("CODEX_HOME", providerWorkspace());
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new ProviderService(repository, codec, providerWorkspace());

    await service.initialize();
    const providers = await service.list();

    expect(providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "openai-compatible.default", driverKind: "openai-compatible", status: "unavailable" }),
      expect.objectContaining({
        id: "codex.default",
        driverKind: "codex-cli",
        status: "available",
        authenticated: true,
        discoveryMode: "automatic",
        cliPath: join(binaryDirectory, "codex"),
        models: { default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture Model" }] },
      }),
      expect.objectContaining({
        id: "claude.default",
        driverKind: "claude-cli",
        status: "available",
        authenticated: true,
        discoveryMode: "automatic",
        cliPath: join(binaryDirectory, "claude"),
      }),
      expect.objectContaining({
        id: "ollama.default",
        driverKind: "ollama-cli",
        status: "available",
        discoveryMode: "automatic",
        cliPath: join(binaryDirectory, "ollama"),
        models: { default: "fixture-ollama", options: [{ id: "fixture-ollama", label: "fixture-ollama", loaded: true }] },
      }),
      expect.objectContaining({
        id: "gemini.default",
        driverKind: "acp-cli",
        status: "available",
        authenticated: true,
        cliPath: join(binaryDirectory, "gemini"),
        models: { default: "fixture-acp", options: [{ id: "fixture-acp", label: "Fixture ACP" }] },
      }),
    ]));
    expect(repository.getDefaultModelSelection()).toEqual({ providerInstanceId: "codex.default", modelId: "fixture-model" });
    expect(service.getCached("codex.default")).toMatchObject({ status: "available", models: { default: "fixture-model" } });
    expect(service.getCapabilities({ providerInstanceId: "codex.default", modelId: "fixture-model" })).toMatchObject({
      workspaceTools: true,
      networkTools: true,
    });
    await service.dispose();
  });

  it("marks a removed discovered CLI unavailable after an explicit rescan", async () => {
    const binaryDirectory = join(providerWorkspace(), "bin");
    mkdirSync(binaryDirectory);
    const claudePath = join(binaryDirectory, "claude");
    symlinkSync(fixtureClaudeCli, claudePath);
    vi.stubEnv("PATH", binaryDirectory);
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    for (const instance of repository.listProviderInstanceConfigs()) {
      if (instance.id === "claude.default" || instance.driverKind === "openai-compatible") continue;
      repository.updateProviderInstanceConfig(instance.id, instance.version, {
        ...instance.config,
        cliPath: join(binaryDirectory, `missing-${instance.id}`),
      });
    }
    const claude = repository.getProviderInstanceConfig("claude.default");
    repository.updateProviderInstanceConfig(claude.id, claude.version, { cliPath: claudePath });
    const service = new ProviderService(repository, codec, providerWorkspace());
    await service.initialize();
    expect(await service.get("claude.default")).toMatchObject({ status: "available", cliPath: claudePath });

    unlinkSync(claudePath);
    const rescanned = await service.scan();

    expect(rescanned.find((provider) => provider.id === "claude.default")).toMatchObject({
      status: "unavailable",
      authenticated: false,
      cliPath: null,
      reason: "未检测到 Claude Code。",
    });
    await service.dispose();
  });

  it("keeps an OpenAI-compatible key encrypted behind the same registry contract", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new ProviderService(repository, codec, providerWorkspace(), false);
    await service.initialize();
    const current = repository.getProviderInstanceConfig("openai-compatible.default");
    const saved = await service.saveOpenAiCompatible({
      instanceId: current.id,
      expectedVersion: current.version,
      baseUrl: "https://example.com/v1/",
      apiKey: "SECRET_PROVIDER_KEY",
    });

    expect(saved).toMatchObject({
      id: current.id,
      status: "available",
      baseUrl: "https://example.com/v1",
      apiKeyConfigured: true,
    });
    expect(repository.getSetting("provider.openai-compatible.default.apiKey")?.value).not.toContain("SECRET_PROVIDER_KEY");
    await service.dispose();
  });

  it("fails closed without changing Provider configuration when secure storage cannot encrypt", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const unavailableCodec: SecretCodec = {
      isAvailable: () => false,
      encrypt: () => { throw new Error("must not encrypt"); },
      decrypt: () => { throw new Error("must not decrypt"); },
    };
    const service = new ProviderService(repository, unavailableCodec, providerWorkspace(), false);
    await service.initialize();
    const before = repository.getProviderInstanceConfig("openai-compatible.default");

    await expect(service.saveOpenAiCompatible({
      instanceId: before.id,
      expectedVersion: before.version,
      baseUrl: "https://changed.example/v1",
      apiKey: "MUST_NOT_PERSIST",
    })).rejects.toMatchObject({ code: "SECURE_STORAGE_UNAVAILABLE" });

    expect(repository.getProviderInstanceConfig(before.id)).toEqual(before);
    expect(repository.getSetting("provider.openai-compatible.default.apiKey")).toBeNull();
    await service.dispose();
  });

  it("maps an unreadable encrypted credential to a stable safe error", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    repository.setSetting("provider.openai-compatible.default.apiKey", "invalid-ciphertext", true);
    const failingCodec: SecretCodec = {
      isAvailable: () => true,
      encrypt: (value) => value,
      decrypt: () => { throw new Error("wrong safeStorage identity"); },
    };
    const service = new ProviderService(repository, failingCodec, providerWorkspace(), false);
    await service.initialize();

    await expect(service.test("openai-compatible.default")).rejects.toMatchObject({
      code: "SECURE_STORAGE_UNAVAILABLE",
    });
    await service.dispose();
  });

  it("maps an OpenAI-compatible connection timeout to a stable Provider error", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    repository.setSetting("provider.openai-compatible.default.apiKey", codec.encrypt("timeout-key"), true);
    const service = new ProviderService(repository, codec, providerWorkspace(), false);
    await service.initialize();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));

    const pending = expect(service.test("openai-compatible.default")).rejects.toMatchObject({
      code: "MODEL_CONNECTION_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(10_001);

    await pending;
    await service.dispose();
  });
});

describe("Codex CLI Provider", () => {
  it("uses an isolated Codex home and strips unrelated credentials from the child process", () => {
    const sourceHome = providerWorkspace();
    const runtimeHome = providerWorkspace();
    writeFileSync(join(sourceHome, "auth.json"), "fixture-auth", { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(sourceHome, "config.toml"), [
      'model = "custom-model"',
      'model_provider = "custom"',
      '[model_providers.custom]',
      'name = "Custom"',
      'base_url = "https://provider.example/v1"',
      'env_key = "CUSTOM_PROVIDER_KEY"',
      'http_headers = { Authorization = "must-not-copy" }',
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    vi.stubEnv("CODEX_HOME", sourceHome);
    vi.stubEnv("OPENAI_API_KEY", "must-not-leak");
    vi.stubEnv("TIKHUB_API_KEY", "must-not-leak-either");
    vi.stubEnv("CUSTOM_PROVIDER_KEY", "reused-by-declared-provider-only");

    const environment = isolatedCodexEnvironment(runtimeHome);

    expect(environment.CODEX_HOME).toBe(runtimeHome);
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.TIKHUB_API_KEY).toBeUndefined();
    expect(environment.CUSTOM_PROVIDER_KEY).toBe("reused-by-declared-provider-only");
    expect(readlinkSync(join(runtimeHome, "auth.json"))).toBe(join(sourceHome, "auth.json"));
    const sanitized = readFileSync(join(runtimeHome, "config.toml"), "utf8");
    expect(sanitized).toContain('base_url = "https://provider.example/v1"');
    expect(sanitized).toContain('env_key = "CUSTOM_PROVIDER_KEY"');
    expect(sanitized).not.toContain("must-not-copy");
  });

  it("discovers the signed-in account and model catalog from app-server", async () => {
    vi.stubEnv("CODEX_HOME", providerWorkspace());
    await expect(inspectCodexCli(fixtureCli, providerWorkspace())).resolves.toMatchObject({
      authenticated: true,
      version: "codex-cli 0.154.0-fixture",
      models: { default: "fixture-model" },
    });
  });

  it("streams one structured app-server reply through the ModelProvider contract", async () => {
    vi.stubEnv("CODEX_HOME", providerWorkspace());
    const provider = new CodexCliProvider(fixtureCli, "fixture-model", providerWorkspace());
    const events = [];
    for await (const event of provider.run([
      { role: "system", content: "Stay concise." },
      { role: "user", content: "Hello" },
    ], new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: "started", requestId: "fixture-turn" },
      { type: "delta", text: "CLI " },
      { type: "delta", text: "reply" },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("bridges one official Codex dynamic tool request through the host response contract", async () => {
    vi.stubEnv("CODEX_HOME", providerWorkspace());
    vi.stubEnv("FAKE_CODEX_DYNAMIC_TOOL", "1");
    const provider = new CodexCliProvider(fixtureCli, "fixture-model", providerWorkspace());
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of provider.run([
      { role: "system", content: "Use only supplied tools." },
      { role: "user", content: "现在几点" },
    ], new AbortController().signal, {
      executorBotId: "00000000-0000-4000-8000-000000000001",
      executionKey: "fixture-execution",
      networkTools: true,
    })) {
      events.push({ type: event.type, ...(event.type === "delta" ? { text: event.text } : {}) });
      if (event.type === "network-tool") {
        expect(event).toMatchObject({ toolCallId: "fixture-time-call", tool: { kind: "time-now", timezone: "Asia/Shanghai" } });
        await event.respond?.(JSON.stringify({ instant: "2026-09-17T08:00:00.000Z" }));
      }
    }
    expect(events).toEqual([
      { type: "started" },
      { type: "network-tool" },
      { type: "delta", text: "CLI used approved tool" },
      { type: "completed" },
    ]);
  }, 15_000);

  it("falls back to codex exec before acceptance when app-server is unavailable", async () => {
    const sourceHome = providerWorkspace();
    writeFileSync(join(sourceHome, "auth.json"), "fixture-auth", { encoding: "utf8", mode: 0o600 });
    vi.stubEnv("CODEX_HOME", sourceHome);
    vi.stubEnv("FAKE_CODEX_APP_SERVER_FAIL", "1");
    const provider = new CodexCliProvider(fixtureCli, "fixture-model", join(providerWorkspace(), "fallback-runtime"));
    const events = [];
    for await (const event of provider.run([
      { role: "system", content: "Stay concise." },
      { role: "user", content: "Hello" },
    ], new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: "started", requestId: "fixture-exec-thread" },
      { type: "delta", text: "Exec reply" },
      { type: "completed", finishReason: "stop" },
    ]);
  });
});

describe("Claude CLI Provider", () => {
  it("discovers login status and configured model aliases", async () => {
    await expect(inspectClaudeCli(fixtureClaudeCli)).resolves.toMatchObject({
      authenticated: true,
      version: "2.1.273-fixture (Claude Code)",
      models: { default: "claude-sonnet-5" },
    });
  });

  it("streams a tool-disabled print-mode reply through the shared contract", async () => {
    const configDirectory = providerWorkspace();
    writeFileSync(join(configDirectory, "settings.json"), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: "fixture-auth-token", UNRELATED_SECRET: "must-not-copy" },
    }), { encoding: "utf8", mode: 0o600 });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDirectory);
    vi.stubEnv("FAKE_CLAUDE_EXPECT_SETTING", "1");
    const provider = new ClaudeCliProvider(fixtureClaudeCli, "claude-sonnet-5", join(providerWorkspace(), "nested-runtime"));
    const events = [];
    for await (const event of provider.run([
      { role: "system", content: "Stay concise." },
      { role: "user", content: "Hello" },
    ], new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: "started", requestId: expect.any(String) },
      { type: "delta", text: "Claude " },
      { type: "delta", text: "reply" },
      { type: "completed", finishReason: "stop" },
    ]);
  });
});

describe("Ollama CLI Provider", () => {
  it("discovers locally installed models", async () => {
    await expect(inspectOllamaCli(fixtureOllamaCli)).resolves.toMatchObject({
      version: "Ollama 0.31.1-fixture",
      models: { default: "fixture-ollama" },
    });
  });

  it("streams a local CLI reply through the shared contract", async () => {
    const provider = new OllamaCliProvider(fixtureOllamaCli, "fixture-ollama", join(providerWorkspace(), "ollama-runtime"));
    const events = [];
    for await (const event of provider.run([
      { role: "system", content: "Stay concise." },
      { role: "user", content: "Hello" },
    ], new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: "started", requestId: expect.any(String) },
      { type: "delta", text: "Ollama reply" },
      { type: "completed", finishReason: "stop" },
    ]);
  });
});

describe("ACP CLI Provider", () => {
  it("probes one installed ACP session and reads its native model catalog", async () => {
    const spec = acpSpec("gemini")!;
    await expect(inspectAcpCli(fixtureAcpCli, spec, join(providerWorkspace(), "acp-probe"))).resolves.toMatchObject({
      authenticated: true,
      version: "fake-acp 1.0.0",
      models: { default: "fixture-acp", options: [{ id: "fixture-acp", label: "Fixture ACP" }] },
    });
  });

  it("confirms the model, rejects native permissions and streams one ACP reply", async () => {
    const spec = acpSpec("opencode")!;
    const provider = new AcpCliProvider(fixtureAcpCli, "fixture-acp", spec, join(providerWorkspace(), "acp-runtime"));
    const events = [];
    for await (const event of provider.run([
      { role: "system", content: "Stay concise." },
      { role: "user", content: "Hello" },
    ], new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: "started", requestId: "fixture-acp-session" },
      { type: "delta", text: "ACP reply" },
      { type: "completed", finishReason: "end_turn" },
    ]);
  });

  it("fails before prompting when an ACP CLI does not confirm the selected model", async () => {
    vi.stubEnv("FAKE_ACP_MODEL_MISMATCH", "1");
    const spec = acpSpec("grok")!;
    const provider = new AcpCliProvider(fixtureAcpCli, "grok-4.6", spec, join(providerWorkspace(), "acp-model-mismatch"));
    const consume = async (): Promise<void> => {
      for await (const event of provider.run([
        { role: "user", content: "Must not be sent" },
      ], new AbortController().signal)) {
        // Consume the stream until the Provider rejects the mismatched model.
        void event;
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "MODEL_REQUEST_REFUSED" });
  });
});
