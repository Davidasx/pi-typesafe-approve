/**
 * End-to-end wiring test: real config file on disk, real HTTP request to a
 * local stub endpoint, driven through the handlers the extension registers with
 * Pi. Nothing here is mocked except the Pi runtime object itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BUILT_IN_CATEGORIES } from "../src/policy.ts";

interface Captured {
  url: string;
  authorization: string | undefined;
  body: { model?: string; state?: { command?: string }; questions?: Record<string, unknown> };
}

/** A stub System One endpoint that answers each command by its first word. */
async function startStub(): Promise<{
  url: string;
  captured: Captured[];
  close(): Promise<void>;
}> {
  const captured: Captured[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as Captured["body"];
      captured.push({ url: req.url ?? "", authorization: req.headers.authorization, body });

      const command = (body.state as { command?: string } | undefined)?.command ?? "";
      const dangerous = /rm -rf|\/etc\/|curl .*\| sh/u.test(command);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: body.model,
          answers: {
            outcome: {
              type: "choice",
              choice: dangerous ? "irreversible_destruction" : "routine_work",
              probabilities: Object.fromEntries(
                BUILT_IN_CATEGORIES.map((category) => [
                  category.id,
                  category.id === (dangerous ? "irreversible_destruction" : "routine_work")
                    ? 0.97
                    : 0.03 / (BUILT_IN_CATEGORIES.length - 1),
                ]),
              ),
              confidence: 0.97,
            },
          },
          usage: { input_tokens: 500, output_tokens: 60, cost: 0.000021 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    captured,
    close: () =>
      new Promise<void>((resolve) => {
        // Undici keeps connections alive, which would hold close() open.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function harnessContext(cwd: string) {
  const notes: string[] = [];
  return {
    notes,
    ctx: {
      cwd,
      hasUI: false,
      signal: undefined,
      ui: {
        notify: (message: string) => notes.push(message),
        confirm: async () => false,
        select: async () => undefined,
        input: async () => undefined,
      },
    },
  };
}

test("the extension gates Bash through direct HTTP and Pi without backend fallback", async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  t.after(() => {
    delete process.env.TSA_TEST_KEY;
    delete process.env.PI_CODING_AGENT_DIR;
  });
  const agentDir = mkdtempSync(join(tmpdir(), "tsa-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "tsa-work-"));

  const configDir = join(agentDir, "extensions", "pi-typesafe-approve");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      enabled: true,
      endpoint: `${stub.url}/v1/systemone`,
      model: "jev-latest",
      apiKey: "${TSA_TEST_KEY}",
      action: "block",
      logDecisions: true,
    }),
  );

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TSA_TEST_KEY = "sk-integration";

  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands: string[] = [];
  let commandHandler: (args: string, ctx: unknown) => Promise<void>;
  const { default: extension } = await import("../src/index.ts");
  extension({
    on: ((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
      return () => {};
    }) as never,
    registerCommand: ((name: string, command: { handler: typeof commandHandler }) => {
      commands.push(name);
      commandHandler = command.handler;
    }) as never,
  } as never);

  assert.deepEqual([...handlers.keys()].sort(), ["session_start", "tool_call"]);
  assert.deepEqual(commands, ["typesafe-approve"]);

  const { ctx } = harnessContext(cwd);
  await (handlers.get("session_start") as (e: unknown, c: unknown) => unknown)(
    { type: "session_start" },
    ctx,
  );

  const toolCall = handlers.get("tool_call") as (
    e: unknown,
    c: unknown,
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;

  // Safe command: the gate returns nothing, so Pi executes it as usual.
  const safe = await toolCall({ toolName: "bash", input: { command: "ls -la" } }, ctx);
  assert.equal(safe, undefined);

  // Dangerous command: blocked, with evidence, and never reaching a shell here.
  const dangerous = await toolCall(
    { toolName: "bash", input: { command: "rm -rf ~/Documents" } },
    ctx,
  );
  assert.equal(dangerous?.block, true);
  assert.match(dangerous?.reason ?? "", /blocked this command/);
  // Either shape is legitimate for a real answer: one dominant violation is named
  // with its own figure, several sharing the mass are quoted as a sum.
  assert.match(
    dangerous?.reason ?? "",
    /(irreversible_destruction \d+%|(\d+%) of violation mass) ≥ 30%( \([^)]*\))? · stop/,
  );

  // Non-bash tools are never sent to the model.
  const beforeCount = stub.captured.length;
  assert.equal(await toolCall({ toolName: "read", input: { path: "x" } }, ctx), undefined);
  assert.equal(stub.captured.length, beforeCount);

  // The request actually carried the configured model, path, and resolved key.
  assert.equal(stub.captured.length, 2);
  const first = stub.captured[0];
  assert.equal(first?.url, "/v1/systemone");
  assert.equal(first?.authorization, "Bearer sk-integration");
  assert.equal(first?.body.model, "jev-latest");
  assert.deepEqual(Object.keys(first?.body.questions ?? {}), ["outcome"]);

  // The decision log is written next to the config, without the API key.
  const log = readFileSync(join(configDir, "decisions.jsonl"), "utf8");
  assert.match(log, /"verdict":"allow"/);
  assert.match(log, /"verdict":"escalate"/);
  assert.match(log, /"action":"block"/);
  assert.equal(statSync(join(configDir, "decisions.jsonl")).mode & 0o777, 0o600);
  assert.ok(!log.includes("sk-integration"));

  // Switch live to Pi without endpoint/key: same command must not hit the direct cache.
  const writeConfig = (config: Record<string, unknown>) => writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
  writeConfig({ backend: "pi", model: "openrouter/typesafe/jev-1.14", failMode: "closed", logDecisions: true });
  let piCalls = 0;
  let providerFails = false;
  let findModel = true;
  const piContext = {
    ...ctx,
    modelRegistry: {
      getModelOfType: (...args: string[]) => {
        assert.deepEqual(args, ["classifier", "openrouter", "typesafe/jev-1.14"]);
        return findModel ? { type: "classifier", provider: "openrouter", id: "typesafe/jev-1.14" } : undefined;
      },
      classify: async () => {
        piCalls += 1;
        return providerFails ? { stopReason: "error", errorMessage: "private-provider-error" } : {
          stopReason: "stop",
          answers: { outcome: {
            type: "choice", choice: "routine_work", confidence: 1,
            probabilities: Object.fromEntries(BUILT_IN_CATEGORIES.map((category) => [category.id, category.id === "routine_work" ? 1 : 0])),
          } },
          usage: { input: 20, output: 1, cost: { total: 0.001 } },
        };
      },
    },
  };
  assert.equal(await toolCall({ toolName: "bash", input: { command: "ls -la" } }, piContext), undefined);
  assert.equal(piCalls, 1);
  await commandHandler!("test pwd", piContext);
  assert.equal(piCalls, 2, "manual checks use the selected backend too");
  const piLog = readFileSync(join(configDir, "decisions.jsonl"), "utf8");
  assert.match(piLog, /openrouter\/typesafe\/jev-1.14/);
  assert.match(piLog, /"input_tokens":20/);

  providerFails = true;
  const failed = await toolCall({ toolName: "bash", input: { command: "pwd" } }, piContext);
  assert.equal(failed?.block, true);
  assert.match(failed?.reason ?? "", /check unavailable/);
  assert.ok(!failed?.reason?.includes("private-provider-error"));
  assert.equal(stub.captured.length, 2, "Pi errors never fall back to direct HTTP");

  writeConfig({ backend: "pi", model: "openrouter/typesafe/jev-1.14", failMode: "open" });
  assert.equal(await toolCall({ toolName: "bash", input: { command: "pwd" } }, piContext), undefined);
  findModel = false;
  writeConfig({ backend: "pi", model: "openrouter/typesafe/jev-1.14", failMode: "closed", debug: true });
  assert.equal((await toolCall({ toolName: "bash", input: { command: "missing-model" } }, piContext))?.block, true);
  assert.equal((await toolCall({ toolName: "bash", input: { command: "old-host" } }, ctx))?.block, true);
  writeConfig({ backend: "pi", model: "bad-selector", failMode: "closed" });
  assert.equal((await toolCall({ toolName: "bash", input: { command: "bad-selector" } }, piContext))?.block, true);
  assert.equal(stub.captured.length, 2);

});
