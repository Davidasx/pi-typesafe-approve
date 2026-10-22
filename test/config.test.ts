import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  configPath,
  loadConfig,
  resolveApiKey,
  resolveEndpoint,
  saveConfig,
  shouldAdoptConfig,
  validateConfig,
  apiKeyBareReferenceWarning,
} from "../src/config.ts";

test("loadConfig returns defaults when the file is missing", () => {
  const loaded = loadConfig(join(mkdtempSync(join(tmpdir(), "tsa-")), "config.json"));
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
});

test("loadConfig reports invalid JSON without throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsa-"));
  const file = join(dir, "config.json");
  writeFileSync(file, "{ not json");
  const loaded = loadConfig(file);
  assert.equal(loaded.ok, false);
  assert.ok(loaded.ok === false && loaded.problems[0]?.includes("not valid JSON"));
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
});

test("validateConfig merges values and reports wrong types", () => {
  const { config, problems } = validateConfig({
    endpoint: "https://a.test/v1/systemone",
    model: "jev-latest",
    apiKey: "${TYPESAFE_API_KEY}",
    thresholds: { danger: 0.3, policy: 0.2 },
    timeoutMs: 5000,
    enabled: "yes",
  });
  assert.equal(config.endpoint, "https://a.test/v1/systemone");
  assert.equal(config.thresholds.danger, 0.3);
  assert.equal(config.thresholds.policy, 0.2);
  assert.equal(config.timeoutMs, 5000);
  // "enabled" was the wrong type, so the default survives and a problem is listed.
  assert.equal(config.enabled, DEFAULT_CONFIG.enabled);
  assert.deepEqual(problems, ['"enabled" must be a boolean']);
});

test("validateConfig names the keys that were merged away", () => {
  const { config, problems } = validateConfig({
    baseUrl: "https://api.typesafe.ai",
    path: "/v1/systemone",
    model: "jev-latest",
  });
  // Without this the gate would be inert and the user would have nothing to read.
  assert.equal(config.endpoint, "");
  assert.equal(problems.length, 2);
  assert.match(problems[0] ?? "", /"baseUrl" is no longer used/);
  assert.match(problems[1] ?? "", /"path" is no longer used/);
  assert.match(problems[0] ?? "", /"endpoint"/);
});

test("validateConfig rejects an out-of-range threshold silently by falling back", () => {
  const { config } = validateConfig({ thresholds: { danger: 4 } });
  assert.equal(config.thresholds.danger, DEFAULT_CONFIG.thresholds.danger);
});

test("resolveApiKey accepts literals and env references", () => {
  const env = { TYPESAFE_API_KEY: "sk-secret" };
  assert.deepEqual(resolveApiKey("sk-literal", env), { ok: true, key: "sk-literal" });
  assert.deepEqual(resolveApiKey("${TYPESAFE_API_KEY}", env), { ok: true, key: "sk-secret" });
});

test("resolveApiKey treats a bare $NAME as a literal, exactly as written", () => {
  // One rule, in one place: `${NAME}` reads the environment, everything else is
  // literal. A user who wrote `$KEY` was told the format; we do not second guess
  // them, and we do not silently swallow their key.
  const env = { TYPESAFE_API_KEY: "sk-secret" };
  assert.deepEqual(resolveApiKey("$TYPESAFE_API_KEY", env), {
    ok: true,
    key: "$TYPESAFE_API_KEY",
  });
  assert.deepEqual(resolveApiKey("sk-$-key", env), { ok: true, key: "sk-$-key" });
});

test("apiKeyBareReferenceWarning explains a literal that looks like a variable", () => {
  assert.match(apiKeyBareReferenceWarning("$TYPESAFE_API_KEY") ?? "", /\$\{TYPESAFE_API_KEY\}/);
  assert.equal(apiKeyBareReferenceWarning("${TYPESAFE_API_KEY}"), undefined);
  assert.equal(apiKeyBareReferenceWarning("sk-plain-literal"), undefined);
});

test("resolveApiKey fails loudly for an unset reference", () => {
  const unset = resolveApiKey("${MISSING_KEY}", {});
  assert.equal(unset.ok, false);
  assert.ok(unset.ok === false && unset.reason.includes("MISSING_KEY"));
});

test("resolveApiKey fails when nothing is configured", () => {
  assert.equal(resolveApiKey("", {}).ok, false);
});

test("resolveEndpoint returns the configured URL, trimmed", () => {
  assert.equal(
    resolveEndpoint({ ...DEFAULT_CONFIG, endpoint: "https://api.typesafe.ai/v1/systemone" }),
    "https://api.typesafe.ai/v1/systemone",
  );
  // Any URL shape is fine: the user supplies the whole thing.
  assert.equal(
    resolveEndpoint({ ...DEFAULT_CONFIG, endpoint: "  https://openrouter.ai/api/alpha/decisions  " }),
    "https://openrouter.ai/api/alpha/decisions",
  );
  assert.throws(() => resolveEndpoint(DEFAULT_CONFIG), /no endpoint configured/);
});

test("saveConfig round-trips and creates the directory with owner-only permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsa-"));
  const file = configPath(dir);
  const config = { ...DEFAULT_CONFIG, endpoint: "https://a.test/v1/systemone", model: "jev-latest" };
  saveConfig(file, config);

  const reloaded = loadConfig(file);
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.config.endpoint, "https://a.test/v1/systemone");
  assert.equal(reloaded.config.model, "jev-latest");
  assert.ok(readFileSync(file, "utf8").endsWith("\n"));
});

// ── adopting a config that changed on disk ─────────────────────────────────

test("shouldAdoptConfig refuses a file that does not parse", () => {
  const current = { ...DEFAULT_CONFIG, endpoint: "https://a.test/v1/systemone", model: "m", apiKey: "k" };
  const verdict = shouldAdoptConfig({
    current,
    currentUsable: true,
    candidateParsed: false,
    candidate: DEFAULT_CONFIG,
    candidateUsable: false,
  });
  assert.equal(verdict.adopt, false);
  assert.match(verdict.reason ?? "", /does not parse/);
});

test("shouldAdoptConfig adopts a usable configuration", () => {
  const verdict = shouldAdoptConfig({
    current: DEFAULT_CONFIG,
    currentUsable: false,
    candidateParsed: true,
    candidate: { ...DEFAULT_CONFIG, endpoint: "https://a.test/v1/systemone", model: "m", apiKey: "k" },
    candidateUsable: true,
  });
  assert.deepEqual(verdict, { adopt: true });
});

test("shouldAdoptConfig adopts a deliberate disable", () => {
  const verdict = shouldAdoptConfig({
    current: { ...DEFAULT_CONFIG, endpoint: "https://a.test/v1/systemone", model: "m", apiKey: "k" },
    currentUsable: true,
    candidateParsed: true,
    candidate: { ...DEFAULT_CONFIG, enabled: false },
    candidateUsable: false,
  });
  assert.deepEqual(verdict, { adopt: true });
});

test("shouldAdoptConfig adopts anything while nothing is configured yet", () => {
  // Setting the extension up: there is no working configuration to protect, so a
  // half-finished file must not be treated as a reason to refuse everything.
  const verdict = shouldAdoptConfig({
    current: DEFAULT_CONFIG,
    currentUsable: false,
    candidateParsed: true,
    candidate: { ...DEFAULT_CONFIG, endpoint: "https://a.test/v1/systemone" },
    candidateUsable: false,
  });
  assert.deepEqual(verdict, { adopt: true });
});

test("shouldAdoptConfig refuses to trade a working config for an unusable one", () => {
  // The case that matters: a half-written file parses to the defaults, and the
  // defaults leave the checker inert. Keeping the working one fails safe.
  const verdict = shouldAdoptConfig({
    current: { ...DEFAULT_CONFIG, endpoint: "https://a.test/v1/systemone", model: "m", apiKey: "k" },
    currentUsable: true,
    candidateParsed: true,
    candidate: DEFAULT_CONFIG,
    candidateUsable: false,
  });
  assert.equal(verdict.adopt, false);
  assert.match(verdict.reason ?? "", /kept/);
});
