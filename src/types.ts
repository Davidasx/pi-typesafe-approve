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

// ---- Review policy ------------------------------------------------------

/**
 * What a category means for the decision.
 *
 * `positive` categories are the places a command may legitimately land when it
 * looks alarming but is not a violation, such as tightening permissions or
 * killing one named process. They exist so those commands have somewhere to go:
 * describing the exception *inside* a negative category ("this is not that
 * violation") measurably does not work, while giving it its own category does.
 *
 * Anything that is not `positive` counts as a violation. That direction is
 * deliberate: a category added without a polarity must never weaken the check.
 */
export type Polarity = "negative" | "positive";

export interface Category {
  /** Stable id, sent to the model as the option name and logged as the label. */
  id: string;
  polarity: Polarity;
  /** What this category covers. This is the text the model judges against. */
  what: string;
  /** Concrete commands that belong here, used to separate near neighbours. */
  examples?: string[];
}

/**
 * The review policy: the categories the model chooses between.
 *
 * A flat list rather than nested rules, because the model gets to pick exactly
 * one: every category competes with every other, and the sum of the non-positive
 * probabilities is the answer.
 */
export interface Policy {
  categories: Category[];
}

/** Fill in a polarity that was left out, treating it as a violation. */
export function polarityOf(category: Pick<Category, "polarity">): Polarity {
  return category.polarity === "positive" ? "positive" : "negative";
}

/** Outcome of one classification, after thresholds have been applied. */
export type Verdict = "allow" | "escalate";

/** Per-question signals kept for logging and for the escalation prompt. */
export interface DecisionSignals {
  /**
   * Summed probability of every non-positive category, i.e. how likely the
   * command does one of the things the policy says must be stopped.
   */
  violationMass?: number;
  /** The category with the highest probability, for diagnosis. */
  label?: string;
  /** True when that label is a positive (allowed) category. */
  labelIsPositive?: boolean;
  /** Probability of the chosen category. */
  labelConfidence?: number;
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

  // ---- Endpoint (no presets: the URL is user-supplied) ----
  /**
   * The full request URL, e.g. `https://api.typesafe.ai/v1/systemone`.
   *
   * One value rather than a base plus a path: every known deployment differs in
   * both, they are never set independently, and splitting them only created a
   * precedence rule to remember.
   */
  endpoint: string;
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
  thresholds: { violation: number };
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
