import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  DecisionAnswer,
  DecisionJournalEntry,
  DecisionProviderKind,
  DecisionRequest,
  DecisionResult,
} from "@shared/contracts";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";
import type { SecretCodec } from "./settings";

const DECISION_API_KEY_SETTING = "decision.jev.apiKey";
const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_JEV_MODEL = "jev-1.13.0";
const DEFAULT_DECISION_TIMEOUT_MS = 10_000;
const MAX_DECISION_TIMEOUT_MS = 120_000;

const decisionRequestSchema = z.object({
  policyId: z.string().trim().min(1).max(120),
  policyVersion: z.number().int().positive(),
  state: z.record(z.string(), z.unknown()),
  questions: z.record(z.string(), z.unknown()),
  model: z.string().trim().min(1).max(120).optional(),
  timeoutMs: z.number().int().min(1).max(MAX_DECISION_TIMEOUT_MS).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).refine((value) => !/[\r\n\0]/u.test(value), "Invalid decision idempotency key"),
}).strict();

type DecisionProviderResult = {
  answers: Record<string, DecisionAnswer>;
  modelVersion: string;
  requestId: string | null;
};

export interface DecisionProvider {
  readonly kind: DecisionProviderKind;
  evaluate(request: DecisionRequest, signal: AbortSignal): Promise<DecisionProviderResult>;
}

export type DecisionEvaluation = {
  disposition: "completed" | "fallback" | "duplicate" | "in-progress";
  result: DecisionResult | null;
  journal: DecisionJournalEntry;
  fallbackReason: string | null;
};

export type JevDecisionProviderOptions = {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
};

export function choiceQuestion(
  criteria: Record<string, unknown>,
  goal: string,
  rules: string | string[],
): Record<string, unknown> {
  return {
    type: "choice",
    criteria,
    instructions: { goal, rules },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

const SENSITIVE_KEY = /(?:api.?key|access.?token|refresh.?token|password|secret|authorization|cookie|credential|private.?key|(?:^|[_-])path$)/iu;

function sanitize(value: unknown, depth = 0, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (depth >= 5) return "[truncated]";
  if (typeof value === "string") return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitize(item, depth + 1, key));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([childKey, childValue]) => [
      childKey,
      sanitize(childValue, depth + 1, childKey),
    ]));
  }
  return String(value);
}

function sanitizeRequest(request: DecisionRequest): DecisionRequest {
  return {
    ...request,
    state: sanitize(request.state) as Record<string, unknown>,
    questions: sanitize(request.questions) as Record<string, unknown>,
  };
}

function digestRequest(request: DecisionRequest): string {
  return createHash("sha256").update(stableJson({
    policyId: request.policyId,
    policyVersion: request.policyVersion,
    state: request.state,
    questions: request.questions,
    model: request.model ?? null,
  }), "utf8").digest("hex");
}

function normalizeAnswer(value: unknown): DecisionAnswer {
  if (!isRecord(value)) return { value: sanitize(value) };
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    ? value.confidence
    : undefined;
  const probabilities = isRecord(value.probabilities)
    ? Object.fromEntries(Object.entries(value.probabilities).flatMap(([key, candidate]) => (
      typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= 1
        ? [[key, candidate]]
        : []
    )))
    : undefined;
  return {
    value: sanitize(
      "value" in value
        ? value.value
        : "choice" in value
          ? value.choice
          : "score" in value
            ? value.score
            : "probability" in value
              ? value.probability
              : value,
    ),
    ...(confidence === undefined ? {} : { confidence }),
    ...(probabilities && Object.keys(probabilities).length > 0 ? { probabilities } : {}),
  };
}

function normalizeAnswers(value: unknown): Record<string, DecisionAnswer> {
  if (!isRecord(value)) throw new AevorenBotError("DECISION_RESPONSE_INVALID");
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, answer]) => [key, normalizeAnswer(answer)]));
}

function confidenceMap(answers: Record<string, DecisionAnswer>): Record<string, number> {
  return Object.fromEntries(Object.entries(answers).flatMap(([key, answer]) => (
    typeof answer.confidence === "number" ? [[key, answer.confidence]] : []
  )));
}

function resultFromJournal(journal: DecisionJournalEntry): DecisionResult | null {
  if (journal.state !== "completed" || !journal.modelVersion || journal.latencyMs === null) return null;
  return {
    provider: journal.provider,
    modelVersion: journal.modelVersion,
    answers: journal.answers,
    latencyMs: journal.latencyMs,
    requestId: journal.requestId,
  };
}

function classifyFailure(error: unknown): { state: "timeout" | "rate-limited" | "failed" | "cancelled"; code: string; reason: string } {
  if (error instanceof DOMException && error.name === "AbortError") {
    return { state: "timeout", code: "DECISION_TIMEOUT", reason: "timeout" };
  }
  if (error instanceof AevorenBotError) {
    if (error.code === "DECISION_TIMEOUT") return { state: "timeout", code: error.code, reason: "timeout" };
    if (error.code === "DECISION_RATE_LIMITED") return { state: "rate-limited", code: error.code, reason: "rate-limited" };
    if (error.code === "DECISION_RESPONSE_INVALID") return { state: "failed", code: error.code, reason: "invalid-response" };
    if (error.code === "DECISION_PROVIDER_FAILED") return { state: "failed", code: error.code, reason: "provider-failed" };
    return { state: "failed", code: error.code, reason: "provider-failed" };
  }
  return { state: "failed", code: "DECISION_PROVIDER_FAILED", reason: "provider-failed" };
}

export class FakeDecisionProvider implements DecisionProvider {
  readonly kind = "fake" as const;

  constructor(
    private readonly answer: DecisionProviderResult | ((request: DecisionRequest) => DecisionProviderResult | Promise<DecisionProviderResult>),
  ) {}

  async evaluate(request: DecisionRequest, signal: AbortSignal): Promise<DecisionProviderResult> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return typeof this.answer === "function" ? this.answer(request) : this.answer;
  }
}

export class RulesDecisionProvider implements DecisionProvider {
  readonly kind = "rules" as const;

  constructor(
    private readonly evaluateRules: (request: DecisionRequest) => DecisionProviderResult | Promise<DecisionProviderResult>,
  ) {}

  async evaluate(request: DecisionRequest, signal: AbortSignal): Promise<DecisionProviderResult> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return this.evaluateRules(request);
  }
}

export class JevDecisionProvider implements DecisionProvider {
  readonly kind = "jev" as const;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly apiKey: string,
    options: JevDecisionProviderOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? DEFAULT_JEV_BASE_URL;
    this.model = options.model ?? process.env.AEVOREN_JEV_MODEL?.trim() ?? DEFAULT_JEV_MODEL;
    this.timeoutMs = Math.min(MAX_DECISION_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS));
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async evaluate(request: DecisionRequest, signal: AbortSignal): Promise<DecisionProviderResult> {
    const safeRequest = sanitizeRequest(request);
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", relayAbort, { once: true });
    const timer = setTimeout(() => controller.abort("decision-timeout"), safeRequest.timeoutMs ?? this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(this.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "x-idempotency-key": safeRequest.idempotencyKey,
        },
        body: JSON.stringify({
          state: safeRequest.state,
          model: safeRequest.model ?? this.model,
          questions: safeRequest.questions,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (signal.aborted || controller.signal.aborted) throw new AevorenBotError("DECISION_TIMEOUT");
      throw error instanceof AevorenBotError ? error : new AevorenBotError("DECISION_PROVIDER_FAILED");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", relayAbort);
    }
    if (response.status === 429) throw new AevorenBotError("DECISION_RATE_LIMITED", undefined, true, { status: response.status });
    if (!response.ok) throw new AevorenBotError("DECISION_PROVIDER_FAILED", undefined, response.status >= 500, { status: response.status });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AevorenBotError("DECISION_RESPONSE_INVALID");
    }
    const root = isRecord(body) && isRecord(body.data) ? body.data : body;
    if (!isRecord(root) || !("answers" in root)) throw new AevorenBotError("DECISION_RESPONSE_INVALID");
    const answers = normalizeAnswers(root.answers);
    const modelVersion = typeof root.modelVersion === "string" && root.modelVersion.trim()
      ? root.modelVersion.trim()
      : typeof root.model_version === "string" && root.model_version.trim()
        ? root.model_version.trim()
        : typeof root.model === "string" && root.model.trim()
          ? root.model.trim()
          : safeRequest.model ?? this.model;
    const requestId = typeof root.requestId === "string" ? root.requestId : typeof root.request_id === "string" ? root.request_id : response.headers.get("x-request-id");
    return { answers, modelVersion, requestId };
  }
}

export function createConfiguredJevProvider(
  repository: Pick<AppRepository, "getSetting">,
  secretCodec: SecretCodec,
  options: JevDecisionProviderOptions = {},
): JevDecisionProvider | null {
  const stored = repository.getSetting(DECISION_API_KEY_SETTING);
  let apiKey: string | null = null;
  if (stored?.encrypted && secretCodec.isAvailable()) {
    try {
      apiKey = secretCodec.decrypt(stored.value).trim() || null;
    } catch {
      apiKey = null;
    }
  }
  apiKey ??= process.env.AEVOREN_JEV_API_KEY?.trim() || null;
  return apiKey ? new JevDecisionProvider(apiKey, options) : null;
}

export class DecisionService {
  constructor(
    private readonly repository: AppRepository,
    private readonly provider: DecisionProvider | null,
    private readonly enabled = false,
  ) {}

  isEnabled(): boolean {
    return this.enabled && this.provider !== null;
  }

  async evaluate(request: DecisionRequest, signal: AbortSignal = new AbortController().signal): Promise<DecisionEvaluation> {
    const parsed = decisionRequestSchema.parse(request);
    const safeRequest = sanitizeRequest(parsed);
    const provider = this.provider;
    const providerKind = provider?.kind ?? "rules";
    const inputDigest = digestRequest(safeRequest);
    const prepared = this.repository.prepareDecisionJournal({
      idempotencyKey: safeRequest.idempotencyKey,
      policyId: safeRequest.policyId,
      policyVersion: safeRequest.policyVersion,
      provider: providerKind,
      inputDigest,
    });
    if (prepared.disposition === "duplicate") {
      const result = resultFromJournal(prepared.journal);
      const terminalFallback = ["fallback", "timeout", "failed", "rate-limited", "cancelled"].includes(prepared.journal.state);
      return {
        disposition: result ? "duplicate" : terminalFallback ? "fallback" : "in-progress",
        result,
        journal: prepared.journal,
        fallbackReason: prepared.journal.fallbackReason,
      };
    }
    if (!this.enabled || !provider) {
      const journal = this.repository.updateDecisionJournal(prepared.journal.id, {
        state: "fallback",
        fallbackReason: !this.enabled ? "disabled" : "provider-unconfigured",
      });
      return { disposition: "fallback", result: null, journal, fallbackReason: journal.fallbackReason };
    }
    const dispatched = this.repository.updateDecisionJournal(prepared.journal.id, { state: "dispatched" });
    const startedAt = Date.now();
    try {
      const result = await provider.evaluate(safeRequest, signal);
      const answers = normalizeAnswers(result.answers);
      const latencyMs = Math.max(0, Date.now() - startedAt);
      const completed = this.repository.updateDecisionJournal(dispatched.id, {
        state: "completed",
        modelVersion: result.modelVersion,
        answers,
        confidence: confidenceMap(answers),
        requestId: result.requestId,
        latencyMs,
        fallbackReason: null,
        lastErrorCode: null,
      });
      return {
        disposition: "completed",
        result: {
          provider: provider.kind,
          modelVersion: result.modelVersion,
          answers,
          latencyMs,
          requestId: result.requestId,
        },
        journal: completed,
        fallbackReason: null,
      };
    } catch (error) {
      const failure = classifyFailure(error);
      const journal = this.repository.updateDecisionJournal(dispatched.id, {
        state: failure.state,
        fallbackReason: failure.reason,
        latencyMs: Math.max(0, Date.now() - startedAt),
        lastErrorCode: failure.code,
      });
      return { disposition: "fallback", result: null, journal, fallbackReason: failure.reason };
    }
  }
}
