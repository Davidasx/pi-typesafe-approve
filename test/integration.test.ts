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

      const command = body.state?.command ?? "";
      const dangerous = /rm -rf|\/etc\/|curl .*\| sh/u.test(command);
      const choice = dangerous ? "danger" : "safe";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: body.model,
          answers: {
            risk: {
              type: "choice",
              choice,
              probabilities: { safe: dangerous ? 0 : 1, caution: 0, danger: dangerous ? 1 : 0 },
              confidence: 1,
            },
            danger: { type: "noul", noul: dangerous ? 0.93 : 0.01 },
            violates_policy: { type: "noul", noul: dangerous ? 0.8 : 0.02 },
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

test("the extension gates a real Bash tool call through a real HTTP endpoint", async () => {
  const stub = await startStub();
  const agentDir = mkdtempSync(join(tmpdir(), "tsa-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "tsa-work-"));

  const configDir = join(agentDir, "extensions", "pi-typesafe-approve");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      enabled: true,
      baseUrl: stub.url,
      path: "/v1/systemone",
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
  const { default: extension } = await import("../src/index.ts");
  extension({
    on: ((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
      return () => {};
    }) as never,
    registerCommand: ((name: string) => {
      commands.push(name);
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
  assert.match(dangerous?.reason ?? "", /was not run/);
  assert.match(dangerous?.reason ?? "", /danger probability 0\.93/);

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
  assert.deepEqual(Object.keys(first?.body.questions ?? {}).sort(), [
    "danger",
    "risk",
    "violates_policy",
  ]);

  // The decision log is written next to the config, without the API key.
  const log = readFileSync(join(configDir, "decisions.jsonl"), "utf8");
  assert.match(log, /"verdict":"allow"/);
  assert.match(log, /"verdict":"escalate"/);
  assert.match(log, /"action":"block"/);
  assert.equal(statSync(join(configDir, "decisions.jsonl")).mode & 0o777, 0o600);
  assert.ok(!log.includes("sk-integration"));

  await stub.close();
  delete process.env.TSA_TEST_KEY;
  delete process.env.PI_CODING_AGENT_DIR;
});
