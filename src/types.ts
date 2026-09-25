/**
 * Shared types for pi-typesafe-approve.
 *
 * The request/response shapes mirror the TypeSafe System One contract, which
 * every known deployment (TypeSafe official, OpenRouter's Decisions and System
 * One surfaces, OpenJEV, self-hosted relays) implements field-for-field:
 *
 *   POST <endpoint>  { "model": string, "state": <text|json>, "questions": {...} }
 *   ->               { "model": string, "answers": {...}, "usage": {...} }
 *
 * Only the endpoint path and the model identifier differ between deployments,
 * which is why this extension exposes all three as plain configuration instead
 * of hard-coding provider presets.
 */

/** A value allowed inside a Jev `state` or inside question descriptions. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** `instructions` / option descriptions may be a string or structured JSON. */
export type StructuredValue = string | JsonValue[] | { [key: string]: JsonValue };

export interface NoulQuestion {
  type: "noul";
  instructions: StructuredValue;
  criteria?: { true?: StructuredValue; false?: StructuredValue };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: StructuredValue;
  criteria: Record<string, StructuredValue | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: StructuredValue;
  criteria: StructuredValue[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, StructuredValue>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevUsage {
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
}

export interface SystemOneRequest {
  model?: string;
  state: StructuredValue;
  questions: Record<string, JevQuestion>;
}

export interface SystemOneResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: JevUsage;
}

/** Outcome of one classification, after thresholds have been applied. */
export type Verdict = "allow" | "escalate";

/** Per-question signals kept for logging and for the escalation prompt. */
export interface DecisionSignals {
  /** Chosen tier from the `risk` choice question, when present. */
  tier?: string;
  /** Confidence of the `risk` choice question, when present. */
  tierConfidence?: number;
  /** Probability that the command is dangerous (`danger` noul). */
  dangerProbability?: number;
  /** Probability that the command violates an agent principle. */
  violatesPolicyProbability?: number;
}

export interface Decision {
  verdict: Verdict;
  /** Human-readable reasons, one per triggered threshold. */
  reasons: string[];
  signals: DecisionSignals;
  /** Model identifier echoed by the endpoint. */
  model?: string;
  usage?: JevUsage;
  /** True when the decision came from the in-memory cache. */
  cached?: boolean;
  /** Set when the decision is a fail-mode fallback rather than a model answer. */
  degraded?: "timeout" | "error";
}

export interface ApproveConfig {
  enabled: boolean;

  // ---- Endpoint (no presets: every field is user-supplied) ----
  /** Base URL, e.g. `https://api.typesafe.ai`. */
  baseUrl: string;
  /** Path appended to `baseUrl`, e.g. `/v1/systemone`, or `/api/alpha/decisions`. */
  path: string;
  /** Absolute endpoint URL. When set, wins over `baseUrl` + `path`. */
  endpoint?: string;
  /** Model identifier, e.g. `jev-latest`, `~typesafe/jev-latest`, `typesafe/jev-1.13`. */
  model: string;
  /** Literal key or an environment reference such as `$TYPESAFE_API_KEY`. */
  apiKey: string;
  /** Extra request headers (for gateways that need them). */
  headers: Record<string, string>;

  // ---- Request behaviour ----
  timeoutMs: number;
  cacheSize: number;

  // ---- Decision policy ----
  thresholds: { danger: number; policy: number };
  /** Tiers of the `risk` choice that escalate. */
  escalateOnTiers: string[];
  /** Minimum `risk` confidence before the tier itself escalates. */
  minTierConfidence: number;
  /** What to do when a threshold is crossed. */
  action: "escalate" | "monitor" | "block";
  /** What `escalate` does when there is no UI to ask (print/JSON mode, subagents). */
  noUiFallback: "block" | "allow";
  /** What to do when the model cannot be reached. */
  failMode: "open" | "closed";

  // ---- Observability ----
  logDecisions: boolean;
  debug: boolean;
}

export type LoadedConfig =
  | { ok: true; config: ApproveConfig; path: string }
  | { ok: false; config: ApproveConfig; path: string; problems: string[] };
