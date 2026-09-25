import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  RISK_TIERS,
  blockedReason,
  buildQuestions,
  buildState,
  decide,
  summarize,
} from "../src/classify.ts";
import type { SystemOneResponse } from "../src/types.ts";

function response(overrides: {
  tier?: string;
  tierConfidence?: number;
  danger?: number;
  principles?: number;
}): SystemOneResponse {
  const tier = overrides.tier ?? "safe";
  const confidence = overrides.tierConfidence ?? 1;
  const others = Object.keys(RISK_TIERS).filter((key) => key !== tier);
  return {
    model: "jev-test",
    answers: {
      risk: {
        type: "choice",
        choice: tier,
        probabilities: Object.fromEntries([
          [tier, confidence],
          ...others.map((key) => [key, (1 - confidence) / others.length]),
        ]),
        confidence,
      },
      danger: { type: "noul", noul: overrides.danger ?? 0 },
      violates_policy: { type: "noul", noul: overrides.principles ?? 0 },
    },
  };
}

const config = DEFAULT_CONFIG;

test("a clean safe answer allows the command", () => {
  const decision = decide(response({}), config);
  assert.equal(decision.verdict, "allow");
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.signals.tier, "safe");
});

test("a danger tier escalates even when both nouls are low", () => {
  const decision = decide(response({ tier: "danger", danger: 0, principles: 0 }), config);
  assert.equal(decision.verdict, "escalate");
  assert.match(decision.reasons[0] ?? "", /risk tier "danger"/);
});

test("a caution tier does not escalate by default", () => {
  assert.equal(decide(response({ tier: "caution" }), config).verdict, "allow");
});

test("a low danger probability still escalates at the default 0.3 threshold", () => {
  // The report's empirical optimum: p >= 0.3 catches ~97% of dangerous
  // commands while producing no false positives on plainly safe ones.
  const decision = decide(response({ danger: 0.31 }), config);
  assert.equal(decision.verdict, "escalate");
  assert.match(decision.reasons[0] ?? "", /danger probability 0\.31 >= 0\.3/);
});

test("a noul just under the threshold does not escalate", () => {
  assert.equal(decide(response({ danger: 0.29 }), config).verdict, "allow");
});

test("a principle violation escalates on its own question", () => {
  const decision = decide(response({ principles: 0.9 }), config);
  assert.equal(decision.verdict, "escalate");
  assert.match(decision.reasons[0] ?? "", /policy-violation probability/);
});

test("the strictest signal wins: contradictory answers still escalate", () => {
  // tier says safe and danger says safe, but the principle question says yes.
  const decision = decide(response({ tier: "safe", danger: 0, principles: 0.8 }), config);
  assert.equal(decision.verdict, "escalate");
  assert.equal(decision.reasons.length, 1);
});

test("multiple triggers are all reported", () => {
  const decision = decide(response({ tier: "danger", danger: 0.9, principles: 0.5 }), config);
  assert.equal(decision.verdict, "escalate");
  assert.equal(decision.reasons.length, 3);
});

test("minTierConfidence suppresses an uncertain tier", () => {
  const cautious = { ...config, minTierConfidence: 0.8 };
  const decision = decide(response({ tier: "danger", tierConfidence: 0.4 }), cautious);
  assert.equal(decision.verdict, "allow");
});

test("thresholds are configurable", () => {
  const permissive = { ...config, thresholds: { danger: 0.95, policy: 0.95 } };
  assert.equal(decide(response({ danger: 0.9 }), permissive).verdict, "allow");
});

test("buildState carries the command, cwd, and policy", () => {
  const state = buildState("rm -rf node_modules", "/home/u/proj", "policy text");
  assert.deepEqual(state, {
    command: "rm -rf node_modules",
    working_directory: "/home/u/proj",
    review_policy: "policy text",
  });
});

test("buildQuestions asks three typed questions with valid criteria shapes", () => {
  const questions = buildQuestions();
  assert.deepEqual(Object.keys(questions).sort(), ["danger", "risk", "violates_policy"]);

  const risk = questions.risk;
  assert.equal(risk?.type, "choice");
  assert.deepEqual(risk?.type === "choice" ? Object.keys(risk.criteria) : [], [
    "safe",
    "caution",
    "danger",
  ]);

  assert.equal(questions.danger?.type, "noul");
  assert.equal(questions.violates_policy?.type, "noul");
});

test("summarize and blockedReason are single-purpose and leak no API details", () => {
  const decision = decide(response({ tier: "danger", danger: 0.8 }), config);
  const line = summarize("rm -rf /", decision);
  assert.match(line, /^escalate tier=danger\(1\.00\) danger=0\.80 policy=0\.00 — rm -rf \//);

  const reason = blockedReason(decision, "rm -rf /");
  assert.match(reason, /was not run/);
  assert.match(reason, /Signals: tier=danger\(1\.00\) danger=0\.80/);
  assert.match(reason, /Command: rm -rf \//);
  assert.ok(!reason.includes("apiKey"));
});
