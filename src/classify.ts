/**
 * Turn a Bash command into one System One request, and the answer into a verdict.
 *
 * ## One question, with a polarity
 *
 * The model chooses one category from the policy, and the verdict is the summed
 * probability of every category that is not positive. That sum is exactly
 * "how likely is it that this command does one of the things we stop".
 *
 * An earlier version asked three questions — a risk tier, a second opinion on
 * danger, and a policy yes/no — and took the strictest answer. Measurements on
 * 304 real decisions showed the risk tier never once changed the outcome on its
 * own: the set of commands it called `danger` was a strict subset of the ones the
 * numeric danger score already crossed. Two signals were not redundancy, though:
 * they disagreed in both directions, and each caught commands the other missed.
 * The category list keeps both kinds of judgment — generic harm and the user's own
 * rules — in a single question, so it keeps the reach of two signals at the cost
 * of one.
 *
 * ## Why the summary is short
 *
 * The model cannot see anything that is not in the request, so the state carries
 * the command, the working directory, and one line saying what this is. That is
 * all it needs: everything it must judge against is in the category list, which is
 * part of the question rather than the state. Earlier versions carried whole rule
 * files here, which cost tokens on every request and, being written for a
 * different reader, made the model hedge.
 */

import type {
  ApproveConfig,
  Category,
  Decision,
  DecisionSignals,
  JevQuestion,
  Policy,
  StateTemplate,
  StructuredValue,
  SystemOneResponse,
} from "./types.ts";
import { polarityOf } from "./types.ts";
import { renderState } from "./policy.ts";

export const OUTCOME_QUESTION = "outcome";

/**
 * The `state` for one request, from the policy's own template.
 *
 * The default template carries the command and its directory; a policy may add
 * the scratch directory or anything else the user knows about their machine. Two
 * values are always substituted from the call rather than from the environment —
 * the command being judged and the working directory — so what the model reviews
 * is what will run, even if the template also mentions them.
 */
export function buildState(
  command: string,
  cwd: string,
  template: StateTemplate,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return renderState(template, command, cwd, env);
}

/** Ids of the categories that count toward the violation total. */
export function negativeIds(categories: readonly Category[]): string[] {
  return categories.filter((category) => polarityOf(category) === "negative").map((category) => category.id);
}

/**
 * The single question: which of these does the command do?
 *
 * Each category becomes one option, described by what it covers plus its examples.
 * The API accepts a string, an object, or an array per option and reserves none of
 * the field names, so `{ what, examples }` is our own shape.
 */
export function buildQuestions(policy: Policy): Record<string, JevQuestion> {
  const criteria: Record<string, StructuredValue | null> = {};
  for (const category of policy.categories) {
    criteria[category.id] = category.examples?.length
      ? { what: category.what, examples: [...category.examples] }
      : category.what;
  }

  return {
    [OUTCOME_QUESTION]: {
      type: "choice",
      instructions:
        "Which one of these does `command` most importantly do? Read the command the way a shell would run it: " +
        "follow pipes, command substitutions, and `&&` / `;` / `||` sequences, and decode anything encoded with " +
        "base64, hex, or ANSI-C escapes. Judge what it actually does, not how alarming the words look: pick the " +
        "category whose description fits best, and prefer a category that describes ordinary or protective work " +
        "when that is what this is.",
      criteria,
    },
  };
}

/**
 * Apply the threshold to the model's answer.
 *
 * The violation total is the sum of every non-positive category's probability.
 * Summing rather than reading the single most likely category matters: a command
 * can be split across two violations at 0.4 each with nothing above the threshold
 * individually, and that is still more violation mass than a 0.5 split with 0.5 of
 * ordinary work.
 */
export function decide(
  response: SystemOneResponse,
  config: ApproveConfig,
  negative: ReadonlySet<string>,
): Decision {
  const answer = response.answers[OUTCOME_QUESTION];
  if (!answer || answer.type !== "choice") {
    throw new Error("the answer was not a choice");
  }

  // The response lists option ids but not their polarity, so the caller passes the
  // set of ids that count as violations. Keeping it a parameter rather than module
  // state means two policies can be evaluated in one process without interference.
  const categories = answer.probabilities;
  let violationMass = 0;
  for (const [id, probability] of Object.entries(categories)) {
    if (negative.has(id)) violationMass += probability;
  }

  const label = answer.choice;

  // The single most likely violation, which is what explains a stop when the
  // overall most likely category happens to be an allowed one.
  let worstCategory: string | undefined;
  let worstProbability: number | undefined;
  for (const [id, probability] of Object.entries(categories)) {
    if (!negative.has(id)) continue;
    if (worstProbability === undefined || probability > worstProbability) {
      worstCategory = id;
      worstProbability = probability;
    }
  }

  const signals: DecisionSignals = {
    violationMass,
    label,
    labelIsPositive: !negative.has(label),
    labelConfidence: answer.confidence,
    ...(worstCategory ? { worstCategory } : {}),
    ...(worstProbability !== undefined ? { worstProbability } : {}),
  };

  const threshold = config.thresholds.violation;
  const reasons =
    violationMass >= threshold
      ? [
          `violation probability ${format(violationMass)} >= ${threshold}` +
            (worstCategory ? ` (most likely violation: ${worstCategory} at ${format(worstProbability ?? 0)})` : ""),
        ]
      : [];

  const decision: Decision = {
    verdict: reasons.length > 0 ? "escalate" : "allow",
    reasons,
    signals,
  };
  if (response.model) decision.model = response.model;
  if (response.usage) decision.usage = response.usage;
  return decision;
}

/** The set `decide` wants, derived from a policy. */
export function negativeSet(policy: Policy): ReadonlySet<string> {
  return new Set(negativeIds(policy.categories));
}

function format(value: number): string {
  return value.toFixed(2);
}

/** One-line summary for logs, notifications, and escalation prompts. */
export function summarize(command: string, decision: Decision): string {
  const signals = decision.signals;
  const parts: string[] = [];
  if (signals.violationMass !== undefined) {
    parts.push(`violation=${format(signals.violationMass)}`);
  }
  // When a violation outranks everything else, naming the top category is enough;
  // when a positive category wins the argmax but violations still cross the
  // threshold, the violation is the only thing worth printing.
  const hasViolation = (signals.worstProbability ?? 0) > 0;
  if (
    hasViolation &&
    signals.worstCategory !== undefined &&
    (signals.labelIsPositive || signals.label !== signals.worstCategory)
  ) {
    parts.push(
      `most likely violation ${signals.worstCategory}(${format(signals.worstProbability ?? 0)})` +
        (signals.label ? `, top category ${signals.label}` : ""),
    );
  } else if (signals.label) {
    const confidence = signals.labelConfidence !== undefined ? `(${format(signals.labelConfidence)})` : "";
    parts.push(
      `most likely ${signals.label}${confidence}${signals.labelIsPositive ? "" : " [stop]"}`,
    );
  }
  const verdict = decision.verdict === "allow" ? "allow" : "escalate";
  return `${verdict} ${parts.join(" ")} — ${truncate(command, 120)}`;
}

/** The `violation=… most likely …` portion, without the command. */
export function signalsOf(decision: Decision): string {
  return summarize("", decision)
    .replace(/^(allow|escalate)\s*/u, "")
    .split(" — ")[0]
    ?.trim() ?? "";
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Reason text handed back to the agent when a command is blocked.
 *
 * It states the decision and the evidence, and deliberately does not enumerate
 * what would change the verdict: a blocked command should go back to the human,
 * not teach the caller how to rephrase its way past the gate.
 */
export function blockedReason(decision: Decision, command: string): string {
  return [
    "pi-typesafe-approve: a System One risk check flagged this command, so it was not run.",
    `Signals: ${signalsOf(decision)}.`,
    `Triggers: ${decision.reasons.join("; ") || "n/a"}.`,
    `Command: ${truncate(command, 300)}`,
    "Ask the user to confirm before running it, or choose a safer equivalent.",
  ].join("\n");
}
