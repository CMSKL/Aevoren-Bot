import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionRequest } from "@shared/contracts";
import { AppRepository } from "./database";
import {
  DecisionService,
  FakeDecisionProvider,
  JevDecisionProvider,
  createConfiguredJevProvider,
} from "./decision-service";
import { AevorenBotError } from "./errors";
import type { SecretCodec } from "./settings";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];

const codec: SecretCodec = {
  isAvailable: () => true,
  encrypt: (value) => `encrypted:${value}`,
  decrypt: (value) => value.replace(/^encrypted:/u, ""),
};

const request: DecisionRequest = {
  policyId: "room-route-shadow",
  policyVersion: 1,
  state: {
    userMessage: "请让策划师列出三个选题",
    apiKey: "must-not-be-persisted",
    nested: { path: "C:\\private\\secret.txt" },
  },
  questions: {
    owner: { type: "choice", options: ["planner", "writer"] },
  },
  model: "jev-1.13.0",
  timeoutMs: 100,
  idempotencyKey: "shadow:room:1",
};

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("DecisionService", () => {
  it("records a disabled decision as a fallback without calling a provider", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const provider = new FakeDecisionProvider(() => {
      throw new Error("provider must not be called");
    });
    const service = new DecisionService(repository, provider, false);

    const result = await service.evaluate(request);

    expect(result.disposition).toBe("fallback");
    expect(result.fallbackReason).toBe("disabled");
    expect(result.journal.state).toBe("fallback");
    expect(repository.listDecisionJournals()).toHaveLength(1);
  });

  it("completes through Fake Provider and reuses an idempotent result", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    let calls = 0;
    const provider = new FakeDecisionProvider(() => {
      calls += 1;
      return {
        answers: { owner: { value: "planner", confidence: 0.91 } },
        modelVersion: "fake-decision-1",
        requestId: "fake-request-1",
      };
    });
    const service = new DecisionService(repository, provider, true);

    const first = await service.evaluate(request);
    const duplicate = await service.evaluate(request);

    expect(first.disposition).toBe("completed");
    expect(first.result?.answers.owner?.value).toBe("planner");
    expect(first.journal.confidence).toEqual({ owner: 0.91 });
    expect(duplicate.disposition).toBe("duplicate");
    expect(duplicate.result).toEqual(first.result);
    expect(calls).toBe(1);
  });

  it("rejects a changed payload that reuses an idempotency key", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const provider = new FakeDecisionProvider(() => ({
      answers: { owner: { value: "planner" } },
      modelVersion: "fake-decision-1",
      requestId: null,
    }));
    const service = new DecisionService(repository, provider, true);
    await service.evaluate(request);

    await expect(service.evaluate({ ...request, state: { userMessage: "different" } })).rejects.toMatchObject({
      code: "DECISION_IDEMPOTENCY_CONFLICT",
    });
  });

  it("falls back and journals a provider timeout without exposing input secrets", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const provider = new FakeDecisionProvider(() => {
      throw new AevorenBotError("DECISION_TIMEOUT");
    });
    const service = new DecisionService(repository, provider, true);

    const result = await service.evaluate(request);
    const serialized = JSON.stringify(result.journal);

    expect(result.disposition).toBe("fallback");
    expect(result.journal.state).toBe("timeout");
    expect(result.journal.lastErrorCode).toBe("DECISION_TIMEOUT");
    expect(serialized).not.toContain("must-not-be-persisted");
    expect(serialized).not.toContain("secret.txt");
  });

  it("uses an encrypted Main-only Jev key and sends no key in the request body", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-decision-config-"));
    temporaryDirectories.push(directory);
    const repository = new AppRepository(join(directory, "app.sqlite"));
    repositories.push(repository);
    repository.setSetting("decision.jev.apiKey", codec.encrypt("jev-secret"), true);
    let captured: { headers: Headers; body: string } | null = null;
    const provider = createConfiguredJevProvider(repository, codec, {
      baseUrl: "https://decision.example.test/v1/systemone",
      fetchFn: async (_input, init) => {
        captured = { headers: new Headers(init?.headers), body: String(init?.body) };
        return new Response(JSON.stringify({
          answers: { owner: { value: "planner", confidence: 0.8 } },
          modelVersion: "jev-test",
          requestId: "jev-request",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    expect(provider).not.toBeNull();
    const result = await provider!.evaluate(request, new AbortController().signal);

    expect(result.modelVersion).toBe("jev-test");
    expect(captured!.headers.get("authorization")).toBe("Bearer jev-secret");
    expect(captured!.body).not.toContain("jev-secret");
    expect(captured!.body).not.toContain("must-not-be-persisted");
  });

  it("maps Jev HTTP and response failures to stable errors", async () => {
    const rateLimited = new JevDecisionProvider("secret", {
      fetchFn: async () => new Response("", { status: 429 }),
    });
    await expect(rateLimited.evaluate(request, new AbortController().signal)).rejects.toMatchObject({ code: "DECISION_RATE_LIMITED" });

    const invalid = new JevDecisionProvider("secret", {
      fetchFn: async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    });
    await expect(invalid.evaluate(request, new AbortController().signal)).rejects.toMatchObject({ code: "DECISION_RESPONSE_INVALID" });
  });
});
