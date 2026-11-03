import { test } from "node:test";
import assert from "node:assert/strict";
import { askPi } from "../src/pi-backend.ts";
import { SystemOneError } from "../src/systemone.ts";
import type { JevQuestion } from "../src/types.ts";

const request = {
  state: { command: "ls -la" },
  questions: {
    outcome: {
      type: "choice",
      instructions: "Which effect?",
      criteria: { routine: { what: "Routine work", examples: ["ls"] }, danger: "Destruction" },
    },
  } satisfies Record<string, JevQuestion>,
};

function answer() {
  return {
    stopReason: "stop",
    answers: { outcome: { type: "choice", choice: "routine", probabilities: { routine: 1, danger: 0 }, confidence: 1 } },
    usage: { input: 42, output: 3, cost: { total: 0.0001 } },
  };
}

test("Pi backend locks provider and full model ID, converts criteria and maps usage", async () => {
  const model = { type: "classifier", provider: "openrouter", id: "typesafe/jev-1.14" };
  let calls = 0;
  const registry = {
    getModelOfType: (...args: string[]) => {
      assert.deepEqual(args, ["classifier", "openrouter", "typesafe/jev-1.14"]);
      return model;
    },
    classify: async (selected: unknown, context: unknown, options: { signal: AbortSignal; timeoutMs: number; maxRetries: number }) => {
      calls += 1;
      assert.equal(selected, model);
      assert.deepEqual(context, {
        state: request.state,
        questions: { outcome: { ...request.questions.outcome, criteria: {
          routine: JSON.stringify(request.questions.outcome.criteria.routine), danger: "Destruction",
        } } },
      });
      assert.equal(options.timeoutMs, 200);
      assert.equal(options.maxRetries, 0);
      assert.equal(options.signal.aborted, false);
      return answer();
    },
  };
  const response = await askPi(registry, "openrouter/typesafe/jev-1.14", request, { timeoutMs: 200 });
  assert.equal(calls, 1);
  assert.equal(response.model, "openrouter/typesafe/jev-1.14");
  assert.deepEqual(response.usage, { input_tokens: 42, output_tokens: 3, cost: 0.0001 });
  assert.deepEqual(response.answers, answer().answers);
});

test("missing models and old hosts fail explicitly without trying another model", async () => {
  await assert.rejects(askPi({}, "typesafe/jev-latest", request, { timeoutMs: 200 }), /classifier API is unavailable/);
  let calls = 0;
  await assert.rejects(askPi({
    getModelOfType: () => undefined,
    classify: () => { calls += 1; return answer(); },
  }, "typesafe/missing", request, { timeoutMs: 200 }), /classifier not found/);
  assert.equal(calls, 0);
});

test("a malformed selector is an error before any Pi lookup", async () => {
  await assert.rejects(askPi({}, "jev-latest", request, { timeoutMs: 200 }), /provider\/modelId/);
});

test("provider errors and rejected requests never expose provider-owned credentials", async () => {
  for (const classify of [
    async () => ({ stopReason: "error", errorMessage: "provider-secret-value", answers: {} }),
    async () => { throw new Error("Pi classifier provider-secret-value"); },
  ]) {
    await assert.rejects(askPi({ getModelOfType: () => ({}), classify }, "typesafe/jev-latest", request, { timeoutMs: 200 }),
      (error: Error) => {
        assert.ok(error instanceof SystemOneError);
        assert.ok(!error.message.includes("provider-secret-value"));
        assert.match(error.message, /authentication in Pi/);
        return true;
      });
  }
});

test("Pi results still undergo strict answer validation", async () => {
  for (const probabilities of [{ routine: 1 }, { routine: 1.1, danger: -0.1 }]) {
    await assert.rejects(askPi({
      getModelOfType: () => ({}),
      classify: async () => {
        const result = answer();
        result.answers.outcome.probabilities = probabilities as { routine: number; danger: number };
        return result;
      },
    }, "typesafe/jev-latest", request, { timeoutMs: 200 }), SystemOneError);
  }
});

test("total deadline aborts a stalled Pi call even if the host ignores its signal", async () => {
  let observedSignal: AbortSignal | undefined;
  // AbortSignal.timeout is unref'ed; keep the test process alive while checking a stalled host.
  const keepAlive = setTimeout(() => {}, 500);
  try {
    await assert.rejects(askPi({
      getModelOfType: () => ({}),
      classify: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
        observedSignal = options.signal;
        return new Promise(() => {});
      },
    }, "typesafe/jev-latest", request, { timeoutMs: 20 }),
    (error: Error) => error instanceof SystemOneError && error.kind === "timeout");
    assert.equal(observedSignal?.aborted, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("caller cancellation aborts the Pi request", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const work = askPi({
    getModelOfType: () => ({}),
    classify: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
      observedSignal = options.signal;
      return new Promise(() => {});
    },
  }, "typesafe/jev-latest", request, { timeoutMs: 200, signal: controller.signal });
  controller.abort();
  await assert.rejects(work, /aborted/);
  assert.equal(observedSignal?.aborted, true);
});
