import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTCOME_QUESTION, buildQuestions } from "../src/classify.ts";
import { BUILT_IN_CATEGORIES } from "../src/policy.ts";

const POLICY = { categories: [...BUILT_IN_CATEGORIES] };
import {
  createSystemOneClient,
  normalizeResponse,
  redact,
  SystemOneError,
} from "../src/systemone.ts";

const questions = buildQuestions(POLICY);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const validBody = {
  model: "jev-1.14.0",
  answers: {
    [OUTCOME_QUESTION]: {
      type: "choice",
      choice: "routine_work",
      probabilities: Object.fromEntries(
        [...BUILT_IN_CATEGORIES.map((c) => [c.id, c.id === "routine_work" ? 1 : 0])],
      ),
      confidence: 1,
    },
  },
  usage: { input_tokens: 531, output_tokens: 78, cost: 0.000022302 },
};

test("normalizeResponse reads a well-formed answer set", () => {
  const response = normalizeResponse(validBody, questions);
  assert.equal(response.model, "jev-1.14.0");
  assert.equal(response.answers[OUTCOME_QUESTION]?.type, "choice");
  assert.deepEqual(response.usage, { input_tokens: 531, output_tokens: 78, cost: 0.000022302 });
});

test("normalizeResponse rejects a missing answer for a question that was asked", () => {
  const body = { answers: {} };
  assert.throws(() => normalizeResponse(body, questions), /missing an answer for question "outcome"/);
});

test("normalizeResponse rejects an out-of-range probability", () => {
  const body = {
    answers: {
      [OUTCOME_QUESTION]: {
        ...(validBody.answers[OUTCOME_QUESTION] as object),
        probabilities: Object.fromEntries(BUILT_IN_CATEGORIES.map((c) => [c.id, 1.4])),
      },
    },
  };
  assert.throws(() => normalizeResponse(body, questions), /invalid probability/);
});

test("normalizeResponse rejects a choice outside the asked options", () => {
  const body = {
    answers: {
      [OUTCOME_QUESTION]: {
        type: "choice",
        choice: "catastrophic",
        probabilities: { catastrophic: 1 },
        confidence: 1,
      },
    },
  };
  assert.throws(() => normalizeResponse(body, questions), /unknown choice/);
});

test("the client posts the model, state, and questions to the configured endpoint", async () => {
  let seen: { url: string; init: RequestInit | undefined } | undefined;
  const client = createSystemOneClient({
    endpoint: "https://api.typesafe.ai/v1/systemone",
    apiKey: "sk-secret",
    model: "jev-latest",
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init };
      return jsonResponse(validBody);
    },
  });

  const response = await client.ask({ state: { command: "ls" }, questions });
  assert.equal(response.answers[OUTCOME_QUESTION]?.type, "choice");
  assert.equal(seen?.url, "https://api.typesafe.ai/v1/systemone");
  const headers = seen?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-secret");
  const body = JSON.parse(String(seen?.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(body.state, { command: "ls" });
  assert.deepEqual(Object.keys(body.questions as object), [OUTCOME_QUESTION]);
});

test("the client omits the model field when no model is configured", async () => {
  let body: Record<string, unknown> = {};
  const client = createSystemOneClient({
    endpoint: "http://localhost:1234/systemone",
    apiKey: "k",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(validBody);
    },
  });
  await client.ask({ state: "x", questions });
  assert.equal(Object.hasOwn(body, "model"), false);
});

test("an HTTP error surfaces the provider's message with the key redacted", async () => {
  const client = createSystemOneClient({
    endpoint: "https://api.typesafe.ai/v1/systemone",
    apiKey: "sk-secret",
    fetchImpl: async () =>
      jsonResponse({ error: { message: "bad key sk-secret" } }, 401),
  });
  await assert.rejects(
    () => client.ask({ state: "x", questions }),
    (error: unknown) => {
      assert.ok(error instanceof SystemOneError);
      assert.equal(error.kind, "http");
      assert.equal(error.status, 401);
      assert.ok(!error.message.includes("sk-secret"));
      assert.ok(error.message.includes("[redacted]"));
      return true;
    },
  );
});

test("a slow endpoint becomes a typed timeout", async () => {
  const client = createSystemOneClient({
    endpoint: "https://api.typesafe.ai/v1/systemone",
    apiKey: "k",
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  await assert.rejects(
    () => client.ask({ state: "x", questions }, { timeoutMs: 20 }),
    (error: unknown) => error instanceof SystemOneError && error.kind === "timeout",
  );
});

test("a network failure is reported as a network error, not a crash", async () => {
  const client = createSystemOneClient({
    endpoint: "https://api.typesafe.ai/v1/systemone",
    apiKey: "k",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(
    () => client.ask({ state: "x", questions }),
    (error: unknown) => error instanceof SystemOneError && error.kind === "network",
  );
});

test("redact removes the key and control characters", () => {
  assert.equal(redact("token sk-abc here", "sk-abc"), "token [redacted] here");
  assert.equal(redact("a\nb\u0000c"), "a b c");
});
