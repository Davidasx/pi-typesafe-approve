/**
 * The `/typesafe-approve` menu is pure data plus action handlers, so it can be
 * driven directly: no TUI, no terminal, no mocks of the kit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { DEFAULT_POLICY } from "../src/policy.ts";
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
      text: DEFAULT_POLICY.trim(),
      path: "/agent/extensions/pi-typesafe-approve/policy.md",
      created: false,
      fallback: false,
      unresolved: [],
      bare: [],
    },
    paths: {
      config: "/agent/extensions/pi-typesafe-approve/config.json",
      policy: "/agent/extensions/pi-typesafe-approve/policy.md",
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
  reloads: number;
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
  h.reloads = 0;
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
    reloadFromDisk: () => {
      h.reloads = (h.reloads ?? 0) + 1;
    },
    writePolicy: (text) => h.policies?.push(text),
    restoreDefaultPolicy: () => {
      h.restores = (h.restores ?? 0) + 1;
      h.policies?.push(DEFAULT_POLICY);
    },
    connectionReport: async () => "report",
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
      "baseUrl",
      "path",
      "model",
      "apiKey",
      "timeoutMs",
      "cacheSize",
      "thresholds.danger",
      "thresholds.policy",
      "escalateOnTiers",
      "minTierConfidence",
      "action",
      "noUiFallback",
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
    ["logDecisions", "On", true],
    ["action", "monitor", "monitor"],
    ["noUiFallback", "allow", "allow"],
    ["failMode", "closed", "closed"],
    ["escalateOnTiers", "danger and caution", ["danger", "caution"]],
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
    baseUrl: "edit-base-url",
    path: "edit-path",
    model: "edit-model",
    apiKey: "edit-api-key",
    timeoutMs: "edit-timeout",
    cacheSize: "edit-cache",
    "thresholds.danger": "edit-danger",
    "thresholds.policy": "edit-policy-threshold",
    minTierConfidence: "edit-tier-confidence",
  };
  const h = harness();
  for (const [itemId, expected] of Object.entries(cases)) {
    assert.deepEqual(h.run("open-edit", { itemId }), { kind: "to", screen: expected }, itemId);
  }
  assert.deepEqual(h.run("open-edit", { itemId: "unknown" }), { kind: "stay" });
});

// ── edits ──────────────────────────────────────────────────────────────────

test("text fields are written trimmed", async () => {
  const h = harness();
  await h.run("apply-base-url", { value: "  https://example.test  " });
  await h.run("apply-model", { value: " jev-latest " });
  assert.deepEqual(h.updates, [{ baseUrl: "https://example.test" }, { model: "jev-latest" }]);
});

test("an out-of-range number is refused with a message and changes nothing", async () => {
  const h = harness();
  await h.run("apply-danger", { value: "7" });
  await h.run("apply-timeout", { value: "abc" });
  assert.deepEqual(h.updates, []);
  assert.equal(h.notices.length, 2);
  assert.deepEqual(h.notices.map((n) => n.kind), ["error", "error"]);
  assert.match(h.notices[0]?.message ?? "", /between 0 and 1/);
  assert.match(h.notices[1]?.message ?? "", /must be a number/);
});

test("a valid number is written, and thresholds keep their sibling", async () => {
  const h = harness();
  await h.run("apply-danger", { value: "0.45" });
  assert.deepEqual(h.updates.at(-1), { thresholds: { danger: 0.45, policy: DEFAULT_CONFIG.thresholds.policy } });

  await h.run("apply-policy-threshold", { value: "0" });
  assert.deepEqual(h.updates.at(-1), { thresholds: { danger: 0.45, policy: 0 } });

  await h.run("apply-cache", { value: "0" });
  assert.deepEqual(h.updates.at(-1), { cacheSize: 0 });
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
    policy: { ...h.current.policy, created: true, unresolved: ["MISSING"], bare: ["HOME"] },
  };
  const lines = ((screen(h, "policy") as unknown as { lines?: readonly string[] }).lines ?? []).join("\n");
  assert.match(lines, /MISSING/);
  assert.match(lines, /HOME/);
  assert.match(lines, /Created on first run/);
});

// ── diagnostics ────────────────────────────────────────────────────────────

test("reload-from-disk reaches the dependency", async () => {
  const h = harness();
  await h.run("reload-from-disk");
  assert.equal(h.reloads, 1);
});

test("the status lines describe rather than dump", () => {
  const line = statusLine(state({ apiKey: SECRET, model: "jev-latest" }));
  assert.ok(!line.includes(SECRET));
  assert.match(line, /configured/);
  assert.match(line, /policy\.md/);

  assert.equal(endpointLine({ ...DEFAULT_CONFIG, baseUrl: "https://a.test", path: "/v1/x", model: "m" }), "https://a.test/v1/x · model m");
  assert.equal(endpointLine(DEFAULT_CONFIG), "(no endpoint configured) · model (unset)");
});
