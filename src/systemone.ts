/**
 * Minimal System One (Jev) HTTP client.
 *
 * Implements the one contract every deployment shares:
 *
 *   POST <endpoint>
 *   Authorization: Bearer <key>
 *   { "model": "...", "state": <text|json>, "questions": { ... } }
 *
 *   -> { "model": "...", "answers": { ... }, "usage": { ... } }
 *
 * TypeSafe official, OpenRouter's Decisions and System One surfaces, OpenJEV,
 * and the community relays all speak this body; only the endpoint path and the
 * model identifier differ, and both are configuration. There is therefore no
 * provider-specific branching here.
 *
 * The client is deliberately dependency-free (`fetch`, `AbortSignal`) and never
 * throws a value that could contain the API key: every error path is passed
 * through {@link redact}.
 */

import type {
  JevAnswer,
  JevQuestion,
  JevUsage,
  StructuredValue,
  SystemOneRequest,
  SystemOneResponse,
} from "./types.ts";
import { isRecord } from "./config.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_CHARS = 300;

export interface SystemOneClientOptions {
  endpoint: string;
  apiKey: string;
  model?: string;
  headers?: Record<string, string>;
  defaultTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SystemOneCallOptions {
  /** Caller-owned signal; combined with the internal timeout. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class SystemOneError extends Error {
  readonly kind: "timeout" | "http" | "network" | "invalid";
  readonly status?: number;

  constructor(kind: SystemOneError["kind"], message: string, status?: number) {
    super(message);
    this.name = "SystemOneError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export function createSystemOneClient(options: SystemOneClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 6000;

  async function ask(
    request: { state: StructuredValue; questions: Record<string, JevQuestion> },
    call: SystemOneCallOptions = {},
  ): Promise<SystemOneResponse> {
    const body = JSON.stringify({
      ...(options.model ? { model: options.model } : {}),
      state: request.state,
      questions: request.questions,
    } satisfies SystemOneRequest);

    const timeoutMs = call.timeoutMs ?? defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = call.signal
      ? AbortSignal.any([call.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetchImpl(options.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
          ...(options.headers ?? {}),
        },
        body,
        signal,
      });
    } catch (error) {
      if (timeoutSignal.aborted && !call.signal?.aborted) {
        throw new SystemOneError("timeout", `request timed out after ${timeoutMs}ms`);
      }
      throw new SystemOneError("network", redact(describe(error), options.apiKey));
    }

    const text = await readBounded(response, signal, options.apiKey);

    if (!response.ok) {
      throw new SystemOneError(
        "http",
        redact(detailFrom(text) || `HTTP ${response.status} ${response.statusText}`.trim(), options.apiKey),
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new SystemOneError("invalid", "response was not JSON");
    }

    try {
      return normalizeResponse(payload, request.questions);
    } catch (error) {
      throw new SystemOneError("invalid", redact(describe(error), options.apiKey));
    }
  }

  return { ask };
}

export type SystemOneClient = ReturnType<typeof createSystemOneClient>;

/**
 * Validate and normalize a System One response against the questions that were
 * asked, so a malformed answer becomes a typed error instead of an undefined
 * read somewhere downstream.
 */
export function normalizeResponse(
  payload: unknown,
  questions: Record<string, JevQuestion>,
): SystemOneResponse {
  if (!isRecord(payload)) {
    throw new Error("response was not a JSON object");
  }
  const rawAnswers = payload.answers;
  if (!isRecord(rawAnswers)) {
    throw new Error('response had no "answers" object');
  }

  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = rawAnswers[id];
    if (raw === undefined) {
      throw new Error(`response is missing an answer for question "${id}"`);
    }
    answers[id] = normalizeAnswer(id, question, raw);
  }

  const result: SystemOneResponse = { answers };
  if (typeof payload.model === "string") result.model = payload.model;
  const usage = normalizeUsage(payload.usage);
  if (usage) result.usage = usage;
  return result;
}

function normalizeAnswer(id: string, question: JevQuestion, raw: unknown): JevAnswer {
  if (!isRecord(raw)) {
    throw new Error(`answer for "${id}" was not an object`);
  }
  switch (question.type) {
    case "noul": {
      const noul = raw.noul;
      if (!isProbability(noul)) {
        throw new Error(`answer for "${id}" was not a noul probability`);
      }
      return { type: "noul", noul };
    }
    case "choice": {
      const choice = raw.choice;
      if (typeof choice !== "string" || !(choice in question.criteria)) {
        throw new Error(`answer for "${id}" selected an unknown choice`);
      }
      return {
        type: "choice",
        choice,
        probabilities: probabilities(id, raw.probabilities, Object.keys(question.criteria)),
        confidence: confidence(id, raw.confidence),
      };
    }
    case "score": {
      const score = raw.score;
      if (typeof score !== "number" || !Number.isFinite(score)) {
        throw new Error(`answer for "${id}" was not a score`);
      }
      const legend = isRecord(raw.legend) ? (raw.legend as Record<string, StructuredValue>) : {};
      return {
        type: "score",
        score,
        legend,
        probabilities: probabilities(
          id,
          raw.probabilities,
          question.criteria.map((_, index) => String(index)),
        ),
        confidence: confidence(id, raw.confidence),
      };
    }
  }
}

function probabilities(
  id: string,
  value: unknown,
  expectedKeys: string[],
): Record<string, number> {
  if (!isRecord(value)) {
    throw new Error(`answer for "${id}" had no probabilities`);
  }
  const result: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    if (!isProbability(probability)) {
      throw new Error(`answer for "${id}" had an invalid probability`);
    }
    result[key] = probability;
  }
  for (const key of expectedKeys) {
    if (!(key in result)) {
      throw new Error(`answer for "${id}" is missing probability "${key}"`);
    }
  }
  return result;
}

function confidence(id: string, value: unknown): number {
  if (!isProbability(value)) {
    throw new Error(`answer for "${id}" had no confidence`);
  }
  return value;
}

function normalizeUsage(value: unknown): JevUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: JevUsage = {};
  for (const key of ["input_tokens", "output_tokens", "cost"] as const) {
    const item = value[key];
    if (typeof item === "number" && Number.isFinite(item)) usage[key] = item;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

async function readBounded(
  response: Response,
  signal: AbortSignal,
  apiKey: string,
): Promise<string> {
  if (!response.body) return "";
  const length = response.headers.get("content-length");
  if (length && /^\d+$/u.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new SystemOneError("invalid", `response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SystemOneError("invalid", `response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof SystemOneError) throw error;
    if (signal.aborted) throw new SystemOneError("timeout", "request was aborted");
    throw new SystemOneError("network", redact(describe(error), apiKey));
  } finally {
    reader.releaseLock();
  }
}

function detailFrom(text: string): string {
  if (!text) return "";
  try {
    const payload: unknown = JSON.parse(text);
    if (isRecord(payload)) {
      if (typeof payload.error === "string") return payload.error;
      if (isRecord(payload.error) && typeof payload.error.message === "string") {
        return payload.error.message;
      }
      if (typeof payload.message === "string") return payload.message;
    }
  } catch {
    // Fall through to the raw text.
  }
  return text;
}

/** Strip the key, control characters, and newlines from anything user-facing. */
export function redact(value: string, apiKey?: string): string {
  let text = value;
  if (apiKey) text = text.split(apiKey).join("[redacted]");
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  text = text.replace(/\s+/gu, " ").trim();
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
