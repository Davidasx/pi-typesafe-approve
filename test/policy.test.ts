import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILT_IN_CATEGORIES,
  DEFAULT_STATE,
  renderState,
  POLICY_FILE_NAME,
  loadPolicy,
  parsePolicy,
  policyPath,
  serializePolicy,
} from "../src/policy.ts";

function context(env: Record<string, string | undefined> = {}) {
  const configDir = join(mkdtempSync(join(tmpdir(), "tsa-policy-")), "pi-typesafe-approve");
  return { configDir, env };
}

test("the policy is created from the built-in categories when absent", () => {
  const ctx = context();
  const loaded = loadPolicy(ctx);

  assert.equal(loaded.created, true);
  assert.equal(loaded.fallback, false);
  assert.equal(loaded.path, join(ctx.configDir, POLICY_FILE_NAME));
  assert.equal(loaded.categories.length, BUILT_IN_CATEGORIES.length);
  assert.equal(statSync(loaded.path).mode & 0o777, 0o600);

  const again = loadPolicy(ctx);
  assert.equal(again.created, false);
  assert.deepEqual(again.categories, loaded.categories);
});

test("an existing policy is used as written", () => {
  const ctx = context();
  mkdirSync(ctx.configDir, { recursive: true });
  writeFileSync(
    policyPath(ctx),
    JSON.stringify({
      categories: [
        { id: "stop_this", polarity: "negative", what: "a thing" },
        { id: "routine_work", polarity: "positive", what: "everything else" },
      ],
    }),
  );

  const loaded = loadPolicy(ctx);
  assert.equal(loaded.created, false);
  assert.equal(loaded.fallback, false);
  assert.deepEqual(loaded.categories.map((c) => c.id), ["stop_this", "routine_work"]);
});

test("an existing but empty file is never overwritten", () => {
  const ctx = context();
  mkdirSync(ctx.configDir, { recursive: true });
  writeFileSync(policyPath(ctx), "   \n");

  const loaded = loadPolicy(ctx);
  assert.equal(loaded.created, false);
  assert.equal(loaded.fallback, true);
  assert.equal(loaded.categories.length, BUILT_IN_CATEGORIES.length);
  assert.equal(readFileSync(policyPath(ctx), "utf8"), "   \n");
  assert.match(loaded.problems[0] ?? "", /empty or unreadable/);
});

test("invalid JSON falls back to the built-in categories and says why", () => {
  const ctx = context();
  mkdirSync(ctx.configDir, { recursive: true });
  writeFileSync(policyPath(ctx), "{ not json");

  const loaded = loadPolicy(ctx);
  assert.equal(loaded.fallback, true);
  assert.equal(loaded.categories.length, BUILT_IN_CATEGORIES.length);
  assert.match(loaded.problems[0] ?? "", /not valid JSON/);
});

test("environment references are expanded in text and examples", () => {
  const ctx = context({ SCRATCH: "/tmp/session", HOME: "/home/u" });
  mkdirSync(ctx.configDir, { recursive: true });
  writeFileSync(
    policyPath(ctx),
    JSON.stringify({
      categories: [
        {
          id: "outside",
          polarity: "negative",
          what: "writes outside ${HOME}/x",
          examples: ["echo x > ${HOME}/y"],
        },
        { id: "routine_work", polarity: "positive", what: "scratch goes in ${SCRATCH}" },
      ],
    }),
  );

  const loaded = loadPolicy(ctx);
  assert.equal(loaded.categories[0]?.what, "writes outside /home/u/x");
  assert.deepEqual(loaded.categories[0]?.examples, ["echo x > /home/u/y"]);
  assert.equal(loaded.categories[1]?.what, "scratch goes in /tmp/session");
});

// ── validation ─────────────────────────────────────────────────────────────

function parse(categories: unknown) {
  return parsePolicy(JSON.stringify({ categories }));
}

test("a category without a polarity counts as a violation", () => {
  // Fail-safe: forgetting the field must never weaken the check.
  const result = parse([
    { id: "forgot_polarity", what: "a thing" },
    { id: "routine_work", polarity: "positive", what: "fine" },
  ]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.categories[0]?.polarity, "negative");
});

test("a policy with no positive category is rejected", () => {
  const result = parse([{ id: "a", polarity: "negative", what: "x" }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no positive category/);
});

test("structural problems are named, not silently dropped", () => {
  const cases: Array<[unknown, RegExp]> = [
    [[{ id: "a", polarity: "positive", what: "x" }, { what: "no id" }], /has no "id"/],
    [[{ id: "a", polarity: "positive", what: "x" }, { id: "a", polarity: "negative", what: "dup" }], /appears more than once/],
    [[{ id: "a", polarity: "positive", what: "" }], /has no "what"/],
    [[{ id: "a", polarity: "maybe", what: "x" }], /polarity that is not/],
    [[], /empty/],
  ];
  for (const [categories, pattern] of cases) {
    const result = parse(categories);
    assert.equal(result.ok, false, JSON.stringify(categories));
    if (!result.ok) assert.match(result.reason, pattern);
  }
});

test("a non-object or non-array document is rejected", () => {
  assert.equal(parsePolicy("[]").ok, false);
  assert.equal(parsePolicy("null").ok, false);
  assert.equal(parsePolicy('{"categories": {}}').ok, false);
});

test("examples are optional and non-strings are dropped", () => {
  const result = parse([
    {
      id: "mixed",
      polarity: "positive",
      what: "x",
      examples: ["keep", 42, "", null, "also keep"],
    },
    { id: "no_examples", polarity: "positive", what: "y" },
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.categories[0]?.examples, ["keep", "also keep"]);
    assert.equal(result.categories[1]?.examples, undefined);
  }
});

test("the default file carries the state template", () => {
  const ctx = context();
  const loaded = loadPolicy(ctx);
  const written = JSON.parse(readFileSync(loaded.path, "utf8")) as { state?: Record<string, string> };
  assert.deepEqual(written.state, DEFAULT_STATE);
  assert.deepEqual(loaded.state, DEFAULT_STATE);
});

test("every state value expands, context included", () => {
  const ctx = context({ HOME: "/home/u", SCRATCH: "/s" });
  const rendered = renderState(
    {
      context: "the agent may write inside ${SCRATCH}",
      command: "${command}",
      cwd: "$(pwd -P)",
      scratch: "${SCRATCH}",
    },
    "ls",
    "/home/u/proj",
    ctx.env,
  );
  assert.equal(rendered.context, "the agent may write inside /s");
  assert.equal(rendered.command, "ls");
  assert.equal(rendered.cwd, "/home/u/proj");
  assert.equal(rendered.scratch, "/s");
});

test("the bare form stays literal, which is what prose about a syntax uses", () => {
  // The escape for writing about the syntax is the syntax: only ${NAME} expands,
  // so "$SCRATCH" is text.
  const ctx = context({ SCRATCH: "/s" });
  const rendered = renderState(
    {
      context: "also known as $SCRATCH, and ~ is the home directory",
      scratch: "${SCRATCH} — also known as $SCRATCH",
      command: "${command}",
    },
    "ls",
    "/w",
    ctx.env,
  );
  assert.equal(rendered.context, "also known as $SCRATCH, and ~ is the home directory");
  assert.equal(rendered.scratch, "/s — also known as $SCRATCH");
});

test("a custom state template is kept and a missing one falls back", () => {
  const ctx = context();
  mkdirSync(ctx.configDir, { recursive: true });
  writeFileSync(
    policyPath(ctx),
    JSON.stringify({
      state: { command: "${command}", cwd: "$(pwd -P)", scratch: "${PI_TMPDIR}" },
      categories: [{ id: "routine_work", polarity: "positive", what: "x" }],
    }),
  );
  const loaded = loadPolicy(ctx);
  assert.deepEqual(loaded.state, { command: "${command}", cwd: "$(pwd -P)", scratch: "${PI_TMPDIR}" });

  writeFileSync(policyPath(ctx), JSON.stringify({ categories: [{ id: "routine_work", polarity: "positive", what: "x" }] }));
  assert.deepEqual(loadPolicy(ctx).state, DEFAULT_STATE);
});

test("a state template that could never send the command is rejected", () => {
  const result = parsePolicy(JSON.stringify({
    state: { context: "reviewing" },
    categories: [{ id: "routine_work", polarity: "positive", what: "x" }],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /never reach the model/);
});

test("a state template with an unsupported command is rejected, naming it", () => {
  const result = parsePolicy(JSON.stringify({
    state: { command: "${command}", now: "$(date)" },
    categories: [{ id: "routine_work", polarity: "positive", what: "x" }],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /\$\(date\)/);
});

test("a non-string or empty state value is rejected", () => {
  for (const state of [{ command: 1 }, {}, { command: "${command}", x: null }]) {
    const result = parsePolicy(JSON.stringify({
      state,
      categories: [{ id: "routine_work", polarity: "positive", what: "x" }],
    }));
    assert.equal(result.ok, false, JSON.stringify(state));
  }
});

test("the serializer round-trips through the parser", () => {
  const text = serializePolicy(BUILT_IN_CATEGORIES);
  const result = parsePolicy(text);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.categories.map((c) => [c.id, c.polarity]),
      BUILT_IN_CATEGORIES.map((c) => [c.id, c.polarity]),
    );
  }
});

test("the built-in policy itself is valid and has a positive catch-all", () => {
  const result = parsePolicy(serializePolicy(BUILT_IN_CATEGORIES));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.categories.some((c) => c.id === "routine_work" && c.polarity === "positive"));
  }
});
