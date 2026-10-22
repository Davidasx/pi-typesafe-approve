import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  OUTCOME_QUESTION,
  blockedReason,
  buildQuestions,
  buildState,
  decide,
  negativeIds,
  negativeSet,
  signalsOf,
  summarize,
  verdictLine,
} from "../src/classify.ts";
import { BUILT_IN_CATEGORIES, DEFAULT_STATE } from "../src/policy.ts";
import type { Category, Policy, SystemOneResponse } from "../src/types.ts";

const policy: Policy = { categories: [...BUILT_IN_CATEGORIES] };
const negative = negativeSet(policy);
const config = DEFAULT_CONFIG;

/** A choice answer over the built-in categories. */
function answer(label: string, split: Record<string, number> = {}): SystemOneResponse {
  const probabilities: Record<string, number> = {};
  if (Object.keys(split).length === 0) {
    // Saturate the label and leave nothing anywhere else.
    for (const category of policy.categories) probabilities[category.id] = category.id === label ? 1 : 0;
  } else {
    const named = Object.values(split).reduce((sum, value) => sum + value, 0);
    const rest = Math.max(0, 1 - named);
    const unnamed = policy.categories.filter((c) => split[c.id] === undefined);
    for (const category of policy.categories) {
      probabilities[category.id] =
        split[category.id] ?? (unnamed.length > 0 ? rest / unnamed.length : 0);
    }
  }
  return {
    model: "jev-test",
    answers: {
      [OUTCOME_QUESTION]: { type: "choice", choice: label, probabilities, confidence: 1 },
    },
  };
}

// ── the question ───────────────────────────────────────────────────────────

test("one question, one option per category", () => {
  const questions = buildQuestions(policy);
  assert.deepEqual(Object.keys(questions), [OUTCOME_QUESTION]);

  const question = questions[OUTCOME_QUESTION];
  assert.equal(question?.type, "choice");
  const criteria = question?.type === "choice" ? question.criteria : {};
  assert.deepEqual(Object.keys(criteria).sort(), policy.categories.map((c) => c.id).sort());
});

test("each option carries its description, and examples when it has any", () => {
  const question = buildQuestions(policy)[OUTCOME_QUESTION];
  const criteria = question?.type === "choice" ? question.criteria : {};

  const withExamples = criteria.security_weakened;
  assert.deepEqual(withExamples, {
    what: BUILT_IN_CATEGORIES.find((c) => c.id === "security_weakened")?.what,
    examples: ["iptables -F", "chmod -R 777 /usr", "systemctl stop firewalld"],
  });

  const noExamples: Category = { id: "only_text", polarity: "negative", what: "just text" };
  const one = buildQuestions({ categories: [noExamples, ...policy.categories] })[OUTCOME_QUESTION];
  const single = one?.type === "choice" ? one.criteria : {};
  assert.equal(single.only_text, "just text");
});

test("the built-in state is the command, the two directories, and one line of context", () => {
  assert.deepEqual(buildState("ls -la", "/work", DEFAULT_STATE, {}), {
    context: DEFAULT_STATE.context,
    command: "ls -la",
    working_directory: "/work",
    scratch_directory: "/tmp",
  });
});

test("a custom state template adds fields and expands references", () => {
  const state = buildState(
    "ls -la",
    "/work",
    {
      context: "reviewing",
      command: "${command}",
      cwd: "$(pwd -P)",
      scratch: "${PI_TMPDIR}",
    },
    { PI_TMPDIR: "/scratch" },
  );
  assert.deepEqual(state, {
    context: "reviewing",
    command: "ls -la",
    cwd: "/work",
    scratch: "/scratch",
  });
});

test("${command} is always the command being judged, not an environment value", () => {
  const state = buildState("rm -rf x", "/work", { command: "${command}" }, { command: "evil" });
  assert.equal(state.command, "rm -rf x");
});

test("the built-in policy has both polarities, and a routine catch-all", () => {
  const positives = BUILT_IN_CATEGORIES.filter((c) => c.polarity === "positive").map((c) => c.id);
  assert.ok(positives.includes("routine_work"));
  assert.ok(positives.includes("permission_tightened"));
  assert.ok(positives.includes("scoped_process_control"));
  assert.ok(BUILT_IN_CATEGORIES.some((c) => c.polarity === "negative"));
  // Each of the false positives that motivated polarity gets a place to land.
  for (const id of ["permission_tightened", "scoped_process_control"]) {
    assert.ok(negativeIds(policy.categories).includes(id) === false, id);
  }
});

// ── the verdict ────────────────────────────────────────────────────────────

test("a positive category allows the command", () => {
  for (const label of ["routine_work", "permission_tightened", "scoped_process_control"]) {
    const decision = decide(answer(label), config, negative);
    assert.equal(decision.verdict, "allow", label);
    assert.equal(decision.signals.violationMass, 0);
    assert.equal(decision.signals.labelIsPositive, true);
  }
});

test("a negative category escalates the command", () => {
  const decision = decide(answer("irreversible_destruction"), config, negative);
  assert.equal(decision.verdict, "escalate");
  assert.equal(decision.signals.violationMass, 1);
  assert.equal(decision.signals.label, "irreversible_destruction");
  assert.equal(decision.signals.labelIsPositive, false);
  assert.match(decision.reasons[0] ?? "", /^100% of violation mass, limit 30%$/);
});

test("violation mass sums across negative categories, not just the top one", () => {
  // Nothing is individually over 0.3, but together they are 0.6.
  const split: Record<string, number> = {
    irreversible_destruction: 0.2,
    secret_exposure: 0.2,
    security_weakened: 0.2,
    routine_work: 0.4,
  };
  const decision = decide(answer("routine_work", split), config, negative);
  assert.equal(decision.signals.violationMass?.toFixed(2), "0.60");
  assert.equal(decision.verdict, "escalate", "0.6 of violation mass must stop the command");
  // The label is still the most likely single category, which is positive.
  assert.equal(decision.signals.label, "routine_work");
  assert.equal(decision.signals.labelIsPositive, true);
});

test("positive mass never counts toward the violation total", () => {
  const split: Record<string, number> = {
    permission_tightened: 0.5,
    routine_work: 0.4,
    scratch_misplaced: 0.1,
  };
  const decision = decide(answer("routine_work", split), config, negative);
  assert.equal(decision.signals.violationMass?.toFixed(2), "0.10");
  assert.equal(decision.verdict, "allow");
});

test("the threshold is configurable", () => {
  const cautious = { ...config, thresholds: { violation: 0.1 } };
  assert.equal(decide(answer("routine_work"), cautious, negative).verdict, "allow");
  const split = { routine_work: 0.8, secret_exposure: 0.2 };
  assert.equal(decide(answer("routine_work", split), config, negative).verdict, "allow");
  assert.equal(decide(answer("routine_work", split), cautious, negative).verdict, "escalate");
});

test("a non-choice answer is an error, not a silent allow", () => {
  const wrong: SystemOneResponse = {
    answers: { [OUTCOME_QUESTION]: { type: "noul", noul: 0.1 } },
  };
  assert.throws(() => decide(wrong, config, negative), /not a choice/);
});

test("two policies can be judged in one process without interference", () => {
  // The negative set is a parameter, not module state.
  const otherCategories: Category[] = [
    { id: "nothing_else", polarity: "positive", what: "everything is fine" },
    { id: "scratch_misplaced", polarity: "negative", what: "scratch in the wrong place" },
  ];
  const other: Policy = { categories: otherCategories };
  const response: SystemOneResponse = {
    answers: {
      [OUTCOME_QUESTION]: {
        type: "choice",
        choice: "nothing_else",
        probabilities: { nothing_else: 0.9, scratch_misplaced: 0.1 },
        confidence: 0.9,
      },
    },
  };
  assert.equal(decide(response, config, negativeSet(other)).signals.violationMass?.toFixed(2), "0.10");
  // Under the built-in policy `scratch_misplaced` is negative and `nothing_else`
  // is unknown, so only the former counts.
  assert.equal(decide(response, config, negative).signals.violationMass?.toFixed(2), "0.10");
});

// ── presentation ───────────────────────────────────────────────────────────

test("one line per decision, for the prompt and the log", () => {
  const decision = decide(answer("secret_exposure"), config, negative);
  assert.equal(
    summarize("cat ~/.ssh/id_ed25519", decision),
    "secret_exposure 100% ≥ 30% · stop — cat ~/.ssh/id_ed25519",
  );
  assert.equal(verdictLine(decision), "secret_exposure 100% ≥ 30% · stop");
  assert.equal(signalsOf(decision), "secret_exposure 100%");

  const allowed = decide(answer("routine_work"), config, negative);
  assert.equal(verdictLine(allowed), "allow · routine_work 100%");
});

test("a stop names the most likely violation, not the overall argmax", () => {
  // The case that motivated this: 0.45 of violation mass spread out, with a
  // positive category winning the argmax. "most likely routine_work" explains
  // nothing to the person being asked to approve.
  const decision = decide(
    answer("routine_work", {
      routine_work: 0.51,
      write_outside_allowed: 0.3,
      secret_exposure: 0.15,
      irreversible_destruction: 0,
    }),
    config,
    negative,
  );
  assert.equal(decision.verdict, "escalate");
  assert.equal(decision.signals.worstCategory, "write_outside_allowed");
  assert.equal(decision.signals.worstProbability?.toFixed(2), "0.30");
  // The reason line no longer repeats what the verdict line says.
  assert.match(decision.reasons[0] ?? "", /^48% of violation mass, limit 30%$/);

  const line = summarize("hostile", decision);
  assert.match(line, /^write_outside_allowed 30% ≥ 30%/);
  assert.match(line, /routine_work also plausible/);
  assert.match(line, /· stop — hostile$/);
});

test("an allowed command names its own category and no violation", () => {
  const decision = decide(answer("routine_work"), config, negative);
  assert.equal(decision.signals.worstProbability, 0);
  assert.equal(summarize("ls", decision), "allow · routine_work 100% — ls");
  assert.doesNotMatch(summarize("ls", decision), /stop/);
});

test("a clear violation reads as one line, category first", () => {
  const decision = decide(answer("secret_exposure"), config, negative);
  assert.equal(summarize("cat key", decision), "secret_exposure 100% ≥ 30% · stop — cat key");
});

test("the blocked reason is self-contained for the agent", () => {
  const decision = decide(answer("irreversible_destruction"), config, negative);
  const reason = blockedReason(decision, "rm -rf ~/Documents", BUILT_IN_CATEGORIES[0]?.what);

  assert.match(reason, /^pi-typesafe-approve blocked this command: irreversible_destruction 100% ≥ 30% · stop\./);
  // The rule text is included, so the agent can avoid the pattern rather than
  // guess at it.
  assert.match(reason, /Rule: Destroys data that cannot be recovered/);
  assert.match(reason, /Command: rm -rf ~\/Documents/);
  // And it explicitly refuses the rephrase-and-retry loop.
  assert.match(reason, /do not rephrase it to get past this check/);
  // It must not claim a human made this decision. Under `action: block` the
  // command is stopped automatically and nobody is ever shown it, so telling the
  // agent "the user declined" invents a person who never saw it — and invites the
  // agent to go ask them about something they were never asked.
  assert.ok(!/the user (must approve|declined|rejected|denied)/i.test(reason));
  assert.ok(!reason.includes("apiKey"));
});
