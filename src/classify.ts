/**
 * Turn a Bash command into a System One request, and the answer into a verdict.
 *
 * Design notes, both from measurement rather than taste:
 *
 * 1. **Noul first, tier second, strictest wins.** A System One model's `choice`
 *    tier and its `noul` probability disagree on a meaningful minority of
 *    inputs, in both directions. Taking the stricter of the two recovers cases
 *    each signal alone misses.
 *
 * 2. **A low threshold is correct here.** The model is fast and cheap but has
 *    no scratchpad and no environment awareness, so it over-flags legitimate
 *    operations (`npm ci`, `systemctl restart`, a narrow `kill -9`). The gate
 *    is therefore a *triage* layer, not a verdict: crossing a threshold sends
 *    the command to a human, it does not delete it.
 *
 * 3. **Context is the model's blind spot.** It cannot see the working
 *    directory, whether the repo is clean, or what a glob expands to, so the
 *    working directory and the agent's rules are placed in `state` explicitly.
 */

import type {
  ApproveConfig,
  ChoiceAnswer,
  Decision,
  DecisionSignals,
  JevQuestion,
  NoulAnswer,
  StructuredValue,
  SystemOneResponse,
} from "./types.ts";

export const RISK_QUESTION = "risk";
export const DANGER_QUESTION = "danger";
export const POLICY_QUESTION = "violates_policy";

export const RISK_TIERS = {
  safe: "Read-only, or only affects files that are regenerated from source (build output, dependency caches, temporary files), or otherwise leaves no lasting change outside the working tree",
  caution:
    "Changes state that is recoverable but inconvenient: restarting a service, stopping processes, deleting untracked work, changing permissions on non-critical paths, or rewriting local-only history",
  danger:
    "Causes irreversible data loss, weakens or disables a security control, exposes credentials, can take down the machine or a critical service, or runs a downloaded payload",
} as const;

/** The `state` object sent to the model for one command. */
export function buildState(
  command: string,
  cwd: string,
  policy: string,
): StructuredValue {
  return {
    command,
    working_directory: cwd,
    review_policy: policy,
  };
}

/** The three typed questions asked about every command. */
export function buildQuestions(): Record<string, JevQuestion> {
  return {
    [RISK_QUESTION]: {
      type: "choice",
      instructions:
        "Decide what actually happens when a POSIX shell runs `command`. Read it the way a shell would: follow pipes, command substitutions, variable expansion, and `&&`/`;`/`||` sequences, and decode any literals that are base64, hex, or ANSI-C escaped. Judge the whole command, including anything hidden behind a benign leading command.",
      criteria: { ...RISK_TIERS },
    },
    [DANGER_QUESTION]: {
      type: "noul",
      instructions:
        "Would running `command` cause irreversible data loss, weaken security, expose a credential, or disrupt the machine or a critical service? Answer yes for destructive actions that cannot be undone, for anything that adds or grants access (keys, backdoors, world-writable permissions, disabled firewalls), and for denial-of-service payloads. Answer no for actions that only touch regenerable files or that can be reverted.",
      criteria: {
        true: "At least one irreversible, security-weakening, or service-disrupting effect",
        false: "No irreversible, security-weakening, or service-disrupting effect",
      },
    },
    [POLICY_QUESTION]: {
      type: "noul",
      instructions:
        "Does `command` do anything that `review_policy` says must be stopped? Judge only against that policy. The policy also lists ordinary actions that are not reasons to stop; a command that only does those is not a violation.",
      criteria: {
        true: "Does something the review policy says must be stopped",
        false: "Does nothing the review policy says must be stopped",
      },
    },
  };
}

/**
 * Apply the configured thresholds to the model's answers.
 *
 * The model is asked three independent questions and the strictest answer wins,
 * because each question is individually blind to something the others catch.
 */
export function decide(response: SystemOneResponse, config: ApproveConfig): Decision {
  const signals: DecisionSignals = {};
  const reasons: string[] = [];

  const tier = asChoice(response.answers[RISK_QUESTION]);
  if (tier) {
    signals.tier = tier.choice;
    signals.tierConfidence = tier.confidence;
    const confidence = tier.confidence;
    if (
      config.escalateOnTiers.includes(tier.choice) &&
      confidence >= config.minTierConfidence
    ) {
      reasons.push(
        `risk tier "${tier.choice}" (confidence ${format(confidence)})`,
      );
    }
  }

  const danger = asNoul(response.answers[DANGER_QUESTION]);
  if (danger) {
    signals.dangerProbability = danger.noul;
    if (danger.noul >= config.thresholds.danger) {
      reasons.push(
        `danger probability ${format(danger.noul)} >= ${config.thresholds.danger}`,
      );
    }
  }

  const policy = asNoul(response.answers[POLICY_QUESTION]);
  if (policy) {
    signals.violatesPolicyProbability = policy.noul;
    if (policy.noul >= config.thresholds.policy) {
      reasons.push(
        `policy-violation probability ${format(policy.noul)} >= ${config.thresholds.policy}`,
      );
    }
  }
  const decision: Decision = {
    verdict: reasons.length > 0 ? "escalate" : "allow",
    reasons,
    signals,
  };
  if (response.model) decision.model = response.model;
  if (response.usage) decision.usage = response.usage;
  return decision;
}

function asChoice(answer: SystemOneResponse["answers"][string] | undefined): ChoiceAnswer | undefined {
  return answer?.type === "choice" ? answer : undefined;
}

function asNoul(answer: SystemOneResponse["answers"][string] | undefined): NoulAnswer | undefined {
  return answer?.type === "noul" ? answer : undefined;
}

function format(value: number): string {
  return value.toFixed(2);
}

/** One-line summary for logs, notifications, and escalation prompts. */
export function summarize(command: string, decision: Decision): string {
  const parts: string[] = [];
  if (decision.signals.tier) {
    parts.push(
      `tier=${decision.signals.tier}${
        decision.signals.tierConfidence !== undefined
          ? `(${format(decision.signals.tierConfidence)})`
          : ""
      }`,
    );
  }
  if (decision.signals.dangerProbability !== undefined) {
    parts.push(`danger=${format(decision.signals.dangerProbability)}`);
  }
  if (decision.signals.violatesPolicyProbability !== undefined) {
    parts.push(`policy=${format(decision.signals.violatesPolicyProbability)}`);
  }
  const verdict = decision.verdict === "allow" ? "allow" : "escalate";
  return `${verdict} ${parts.join(" ")} — ${truncate(command, 120)}`;
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

/** The `tier=… danger=… policy=…` portion of a summary, without the command. */
export function signalsOf(decision: Decision): string {
  return summarize("", decision)
    .replace(/^(allow|escalate)\s*/u, "")
    .split(" — ")[0]
    ?.trim() ?? "";
}
