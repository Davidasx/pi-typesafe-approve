/**
 * The `/typesafe-approve` menu is pure data plus action handlers, so it can be
 * driven directly: no TUI, no terminal, no mocks of the kit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runMenu } from "@narumitw/pi-tui-kit";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { BUILT_IN_CATEGORIES, DEFAULT_STATE } from "../src/policy.ts";
import {
  createApproveMenu,
  describeKey,
  endpointLine,
  statusLine,
  type ApproveActionId,
  type ApproveMenuState,
  type ApproveScreenId,
  type MenuDeps,
} from "../src/menu.ts";
import type { ApproveConfig } from "../src/types.ts";

const SECRET = "sk-live-must-never-be-shown";

function state(overrides: Partial<ApproveConfig> = {}): ApproveMenuState {
  return {
    config: { ...DEFAULT_CONFIG, ...overrides },
    policy: {
      categories: [...BUILT_IN_CATEGORIES],
      state: DEFAULT_STATE,
      path: "/agent/extensions/pi-typesafe-approve/policy.json",
      created: false,
      fallback: false,
      problems: [],
      enabled: true,
    },
    paths: {
      config: "/agent/extensions/pi-typesafe-approve/config.json",
      policy: "/agent/extensions/pi-typesafe-approve/policy.json",
      log: "/agent/extensions/pi-typesafe-approve/decisions.jsonl",
    },
    configured: true,
  };
}

interface Harness {
  deps: MenuDeps;
  updates: Array<Partial<ApproveConfig>>;
  policies: string[];
  restores: number;
  notices: Array<{ message: string; kind?: string }>;
  current: ApproveMenuState;
  ctx: { ui: Record<string, unknown>; mode: string; hasUI: boolean };
  run(action: ApproveActionId, context?: { itemId?: string; value?: string }): unknown;
}

function harness(overrides: Partial<ApproveConfig> = {}, options: {
  editorResult?: string | undefined;
  confirmResult?: boolean;
} = {}): Harness {
  const h: Partial<Harness> = {};
  h.updates = [];
  h.policies = [];
  h.restores = 0;
  h.notices = [];
  h.current = state(overrides);

  h.ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string, kind?: string) => h.notices?.push({ message, kind }),
      confirm: async () => options.confirmResult ?? true,
      editor: async () => options.editorResult,
      input: async () => undefined,
    },
  };

  const deps: MenuDeps = {
    getState: () => h.current as ApproveMenuState,
    update: (patch) => {
      h.updates?.push(patch);
      h.current = { ...(h.current as ApproveMenuState), config: { ...(h.current as ApproveMenuState).config, ...patch } };
    },
    writePolicy: (text) => h.policies?.push(text),
    restoreDefaultPolicy: () => {
      h.restores = (h.restores ?? 0) + 1;
      h.policies?.push(JSON.stringify({ categories: BUILT_IN_CATEGORIES }));
    },
    connectionReport: async () => "report",
    readPolicyText: () => "{}",
  };
  h.deps = deps;

  const menu = createApproveMenu(deps);
  h.run = (action, context = {}) =>
    menu.actions[action]({
      ctx: h.ctx,
      state: h.current,
      signal: new AbortController().signal,
      itemId: context.itemId ?? "",
      value: context.value,
    } as never);

  return h as Harness;
}

function screen(h: Harness, id: ApproveScreenId) {
  return createApproveMenu(h.deps).screens[id]({ state: h.current } as never);
}

// ── structure ──────────────────────────────────────────────────────────────

test("every screen the menu links to exists", () => {
  const h = harness();
  const menu = createApproveMenu(h.deps);
  const known = new Set(Object.keys(menu.screens));

  for (const id of known) {
    const built = screen(h, id as ApproveScreenId) as unknown as { items?: Array<{ to?: string }> };
    for (const item of built.items ?? []) {
      if (item.to !== undefined) {
        assert.ok(known.has(item.to), `${id} links to unknown screen ${item.to}`);
      }
    }
  }
  assert.equal(menu.start, "main");
});

test("the settings screen lists every option, enums with values and text without", () => {
  const h = harness();
  const built = screen(h, "settings");
  assert.equal(built.kind, "settings");
  const items = (built as unknown as { items: Array<{ id: string; currentValue: string; values?: readonly string[] }> }).items;

  assert.deepEqual(
    items.map((item) => item.id),
    [
      "enabled",
      "backend",
      "endpoint",
      "model",
      "apiKey",
      "timeoutMs",
      "cacheSize",
      "thresholds.violation",
      "action",
      "noUiFallback",
      "promptTimeoutSeconds",
      "failMode",
      "logDecisions",
      "debug",
    ],
  );

  // Enumerations can be changed in place; everything else opens an editor.
  assert.deepEqual(items.find((i) => i.id === "action")?.values, ["escalate", "monitor", "block"]);
  assert.deepEqual(items.find((i) => i.id === "noUiFallback")?.values, ["block", "allow"]);
  assert.deepEqual(items.find((i) => i.id === "enabled")?.values, ["On", "Off"]);
  assert.equal(items.find((i) => i.id === "thresholds.danger")?.values, undefined);
  assert.equal(items.find((i) => i.id === "model")?.values, undefined);
});

test("every enumerated item's stored value is reachable from its labels", async () => {
  const cases: Array<[string, string, unknown]> = [
    ["enabled", "Off", false],
    ["backend", "pi", "pi"],
    ["logDecisions", "On", true],
    ["action", "monitor", "monitor"],
    ["noUiFallback", "allow", "allow"],
    ["failMode", "closed", "closed"],
  ];
  for (const [itemId, label, expected] of cases) {
    const h = harness();
    await h.run("set-enum", { itemId, value: label });
    assert.deepEqual(h.updates.at(-1), { [itemId]: expected }, `${itemId} = ${label}`);
  }
});

test("an unknown label changes nothing", async () => {
  const h = harness();
  await h.run("set-enum", { itemId: "action", value: "launch" });
  await h.run("set-enum", { itemId: "not-a-setting", value: "On" });
  assert.deepEqual(h.updates, []);
});

test("text rows transition to the matching editor screen", () => {
  const cases: Record<string, ApproveScreenId> = {
    endpoint: "edit-endpoint",
    model: "edit-model",
    apiKey: "edit-api-key",
    timeoutMs: "edit-timeout",
    cacheSize: "edit-cache",
    "thresholds.violation": "edit-violation",
    promptTimeoutSeconds: "edit-prompt-timeout",
  };
  const h = harness();
  for (const [itemId, expected] of Object.entries(cases)) {
    assert.deepEqual(h.run("open-edit", { itemId }), { kind: "to", screen: expected }, itemId);
  }
  assert.deepEqual(h.run("open-edit", { itemId: "unknown" }), { kind: "stay" });
});

test("switching backend immediately rebuilds fields, hints and status without losing direct values", async () => {
  const h = harness({ endpoint: "https://direct.test/systemone", apiKey: "${DIRECT_KEY}", model: "jev-latest" });
  const menu = createApproveMenu(h.deps);
  const settings = () => {
    const built = menu.screens.settings({ state: h.current } as never);
    assert.equal(built.kind, "settings");
    if (built.kind !== "settings") throw new Error("Expected settings screen");
    return built;
  };
  assert.ok(settings().items.some((item) => item.id === "endpoint"));
  assert.deepEqual(await h.run("set-enum", { itemId: "backend", value: "pi" }), { kind: "stay" });
  assert.ok(!settings().items.some((item) => item.id === "endpoint" || item.id === "apiKey"));
  assert.match(settings().items.find((item) => item.id === "model")?.description ?? "", /first slash/);
  assert.match(JSON.stringify(screen(h, "edit-model")), /provider\/modelId/);
  assert.ok(!statusLine(h.current).includes("DIRECT_KEY"));
  assert.equal(endpointLine(h.current.config), "Pi classifier · model jev-latest");
  await h.run("set-enum", { itemId: "backend", value: "direct" });
  assert.ok(settings().items.some((item) => item.id === "endpoint"));
  assert.ok(settings().items.some((item) => item.id === "apiKey"));
  assert.equal(h.current.config.endpoint, "https://direct.test/systemone");
  assert.equal(h.current.config.apiKey, "${DIRECT_KEY}");
});

test("the actual TUI runtime rebuilds the settings component immediately after backend changes", async () => {
  const h = harness({ endpoint: "https://direct.test/systemone", apiKey: "${DIRECT_KEY}" });
  const definition = createApproveMenu(h.deps);
  const originalSettings = definition.screens.settings;
  const renderedFields: string[][] = [];
  definition.start = "settings";
  definition.screens.settings = (context) => {
    const built = originalSettings(context);
    if (built.kind === "settings") renderedFields.push(built.items.map((item) => item.id));
    return built;
  };
  let screens = 0;
  const ctx = {
    ...h.ctx,
    ui: {
      ...h.ctx.ui,
      custom: async (factory: Function) => new Promise((resolve, reject) => {
        const matches = (data: string, action: string) =>
          (data === "\r" && action === "tui.select.confirm") ||
          (data === "\u001b[B" && action === "tui.select.down") ||
          (data === "\u001b" && action === "tui.select.cancel");
        const component = factory({ requestRender() {} }, {}, { matches }, resolve);
        screens += 1;
        if (screens === 1) component.handleInput("\u001b[B"); // Enabled -> Backend
        component.handleInput(screens <= 2 ? "\r" : "\u001b");
        component.waitForPending().catch(reject);
      }),
    },
  };
  const result = await runMenu(ctx as never, definition, { getState: () => h.current });
  assert.equal(result.kind, "closed");
  assert.equal(screens, 3);
  assert.ok(renderedFields[0]?.includes("endpoint"));
  assert.ok(!renderedFields[1]?.includes("endpoint"));
  assert.ok(!renderedFields[1]?.includes("apiKey"));
  assert.ok(renderedFields[2]?.includes("endpoint"));
  assert.deepEqual(h.updates, [{ backend: "pi" }, { backend: "direct" }]);
});

// ── edits ──────────────────────────────────────────────────────────────────

test("text fields are written trimmed", async () => {
  const h = harness();
  await h.run("apply-endpoint", { value: "  https://example.test/v1/systemone  " });
  await h.run("apply-model", { value: " jev-latest " });
  assert.deepEqual(h.updates, [
    { endpoint: "https://example.test/v1/systemone" },
    { model: "jev-latest" },
  ]);
});

test("an out-of-range number is refused with a message and changes nothing", async () => {
  const h = harness();
  await h.run("apply-violation", { value: "7" });
  await h.run("apply-timeout", { value: "abc" });
  assert.deepEqual(h.updates, []);
  assert.equal(h.notices.length, 2);
  assert.deepEqual(h.notices.map((n) => n.kind), ["error", "error"]);
  assert.match(h.notices[0]?.message ?? "", /between 0 and 1/);
  assert.match(h.notices[1]?.message ?? "", /must be a number/);
});

test("a valid number is written, and thresholds keep their sibling", async () => {
  const h = harness();
  await h.run("apply-violation", { value: "0.45" });
  assert.deepEqual(h.updates.at(-1), { thresholds: { violation: 0.45 } });

  await h.run("apply-violation", { value: "0" });
  assert.deepEqual(h.updates.at(-1), { thresholds: { violation: 0 } });

  await h.run("apply-cache", { value: "0" });
  assert.deepEqual(h.updates.at(-1), { cacheSize: 0 });

  // 0 is meaningful for the prompt timeout — it means wait forever — so it must be
  // accepted here even though 0 is a nonsensical request timeout.
  await h.run("apply-prompt-timeout", { value: "0" });
  assert.deepEqual(h.updates.at(-1), { promptTimeoutSeconds: 0 });
  await h.run("apply-prompt-timeout", { value: "90" });
  assert.deepEqual(h.updates.at(-1), { promptTimeoutSeconds: 90 });
});

// ── secrets ────────────────────────────────────────────────────────────────

test("no screen ever renders the API key", () => {
  const h = harness({ apiKey: SECRET });
  const menu = createApproveMenu(h.deps);
  const rendered: string[] = [];

  for (const id of Object.keys(menu.screens)) {
    rendered.push(JSON.stringify(screen(h, id as ApproveScreenId)));
  }
  // The policy text is rendered too, and must not be a route to the key either.
  const joined = rendered.join("\n");
  assert.ok(!joined.includes(SECRET), "the API key must never appear in the interface");
  assert.match(joined, /literal/, "the key is described instead of shown");
});

test("the API key editor is not prefilled with the current key", () => {
  const h = harness({ apiKey: SECRET });
  const built = screen(h, "edit-api-key");
  assert.ok(!JSON.stringify(built).includes(SECRET));
});

test("a bare $NAME key is saved but flagged, and describeKey explains it", async () => {
  const h = harness();
  await h.run("apply-api-key", { value: "$TYPESAFE_API_KEY" });
  assert.deepEqual(h.updates.at(-1), { apiKey: "$TYPESAFE_API_KEY" });
  assert.equal(h.notices.at(-1)?.kind, "warning");
  assert.equal(describeKey("$TYPESAFE_API_KEY"), "literal (check the syntax)");
  assert.equal(describeKey("${TYPESAFE_API_KEY}"), "${TYPESAFE_API_KEY}");
  assert.equal(describeKey(""), "(unset)");
});

test("clearing the key warns that the check goes inert", async () => {
  const h = harness({ apiKey: SECRET });
  await h.run("apply-api-key", { value: "   " });
  assert.deepEqual(h.updates.at(-1), { apiKey: "" });
  assert.match(h.notices.at(-1)?.message ?? "", /inert/);
});

test("an edit that leaves the endpoint unusable is reported", async () => {
  const h = harness();
  h.current = { ...h.current, configured: false };
  await h.run("apply-model", { value: "jev-latest" });
  assert.equal(h.notices.at(-1)?.kind, "warning");
  assert.match(h.notices.at(-1)?.message ?? "", /inert/);
});

// ── policy ─────────────────────────────────────────────────────────────────

test("editing the policy saves the new text", async () => {
  const h = harness({}, { editorResult: "my new rules\n" });
  await h.run("policy-edit");
  assert.deepEqual(h.policies, ["my new rules\n"]);
  assert.match(h.notices.at(-1)?.message ?? "", /saved/i);
});

test("cancelling the policy editor writes nothing", async () => {
  const h = harness({}, { editorResult: undefined });
  await h.run("policy-edit");
  assert.deepEqual(h.policies, []);
});

test("restoring the default asks first, and does nothing when declined", async () => {
  const declined = harness({}, { confirmResult: false });
  await declined.run("policy-restore");
  assert.equal(declined.restores, 0);

  const accepted = harness({}, { confirmResult: true });
  await accepted.run("policy-restore");
  assert.equal(accepted.restores, 1);
});

test("the policy screen reports unresolved and brace-less references", () => {
  const h = harness();
  h.current = {
    ...h.current,
    policy: { ...h.current.policy, created: true, fallback: true, problems: ["the file is unreadable"] },
  };
  const lines = ((screen(h, "policy") as unknown as { lines?: readonly string[] }).lines ?? []).join("\n");
  assert.match(lines, /unreadable/);
  assert.match(lines, /Created on first run/);
  assert.match(lines, /stop, \d+ allow/);
});

// ── diagnostics ────────────────────────────────────────────────────────────

test("the main screen surfaces a refused config change", () => {
  const h = harness();
  assert.ok(!(screen(h, "main") as unknown as { lines: string[] }).lines.join("\n").includes("not adopted"));
  h.current = { ...h.current, configProblem: "/x/config.json changed but was not adopted: it does not parse" };
  assert.match((screen(h, "main") as unknown as { lines: string[] }).lines.join("\n"), /not adopted/);
});

test("the status lines describe rather than dump", () => {
  const line = statusLine(state({ apiKey: SECRET, model: "jev-latest" }));
  assert.ok(!line.includes(SECRET));
  assert.match(line, /configured/);
  assert.match(line, /policy\.json/);

  assert.equal(
    endpointLine({ ...DEFAULT_CONFIG, endpoint: "https://a.test/v1/x", model: "m" }),
    "https://a.test/v1/x · model m",
  );
  assert.equal(endpointLine(DEFAULT_CONFIG), "(no endpoint configured) · model (unset)");
});
