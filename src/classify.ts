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
  // One line only, and no repetition of what the summary already says: the number
  // and the category appear once per prompt, not twice.
  const reasons =
    violationMass >= threshold
      ? [`${percent(violationMass)} of violation mass, limit ${percent(threshold)}`]
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

/**
 * One line describing the decision: the category that drove it and how much mass
 * crossed the limit.
 *
 * Deliberately one line, because it is the only text that reliably fits the
 * confirmation dialog, and the dialog cannot scroll.
 */
export function summarize(command: string, decision: Decision): string {
  return `${verdictLine(decision)} — ${truncate(command, 120)}`;
}

/**
 * The decision without the command, for the confirmation prompt.
 *
 * A stopped command reads as `<category> <probability> ≥ <limit>`; the category is
 * the most likely *violation*, which is what explains the stop even when a
 * positive category won the argmax. An allowed command names its own category.
 */
export function verdictLine(decision: Decision): string {
  const signals = decision.signals;
  // A degraded decision never reached the model, so there is no category to name;
  // saying "unknown 0%" would hide the real reason in the one place it matters.
  if (decision.degraded !== undefined) {
    return `check unavailable (${decision.degraded})`;
  }
  if (decision.verdict === "allow") {
    return `allow · ${signals.label ?? "no category"} ${percent(signals.labelConfidence ?? 0)}`;
  }
  // What crossed the limit is the sum of the violation probabilities, not the
  // single largest one. Printing the largest next to "≥ limit" states a false
  // inequality whenever several categories share the mass: 20% + 15% clears a 30%
  // limit, and "20% ≥ 30%" contradicts the very decision being explained.
  const category = signals.worstCategory ?? signals.label ?? "unknown";
  const worst = signals.worstProbability ?? 0;
  const mass = signals.violationMass ?? 0;
  const limit = percent(limitOf(decision));
  const detail =
    signals.labelIsPositive && signals.label
      ? `, ${signals.label} also plausible`
      : "";
  // One violation dominant: name it with its own number, which equals the mass.
  // Mass spread over several: the sum is the honest figure, and the worst category
  // is named without claiming its own probability reached the limit.
  const amount =
    Math.abs(mass - worst) < 0.005
      ? `${category} ${percent(worst)} ≥ ${limit}`
      : `${percent(mass)} of violation mass ≥ ${limit} (${category} the largest at ${percent(worst)})`;
  return `${amount}${detail} · stop`;
}

/** The `violation=… most likely …` portion, without the command. */
export function signalsOf(decision: Decision): string {
  const signals = decision.signals;
  return signals.worstCategory && (signals.worstProbability ?? 0) > 0
    ? `${signals.worstCategory} ${percent(signals.worstProbability ?? 0)}`
    : `${signals.label ?? "unknown"} ${percent(signals.labelConfidence ?? 0)}`;
}

function limitOf(decision: Decision): number {
  const first = decision.reasons[0] ?? "";
  const found = /limit (\d+)%/u.exec(first);
  return found ? Number(found[1]) / 100 : 0;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Reason text handed back to the agent when a command is blocked.
 *
 * The agent sees only this string, so it has to be useful on its own: what was
 * decided, which category drove it, and the rule that category stands for. The
 * rule text matters because the agent can then do something smarter than retrying
 * the same command — avoid the pattern, or ask the user, who is the only one who
 * can change the policy.
 *
 * It still does not enumerate what would let the command through. A blocked
 * command should go back to the human, not teach the caller how to rephrase its
 * way past the gate.
 */
export function blockedReason(decision: Decision, command: string, rule?: string): string {
  return [
    `pi-typesafe-approve blocked this command: ${verdictLine(decision)}.`,
    ...(rule ? [`Rule: ${truncate(rule, 300)}`] : []),
    `Command: ${truncate(command, 300)}`,
    // No claim about who decided. In `block` mode nothing was shown to anyone, so
    // saying "the user declined" would invent a human who never saw this command.
    "Do not retry the same command, and do not rephrase it to get past this check; ask the user what they want instead.",
  ].join("\n");
}
