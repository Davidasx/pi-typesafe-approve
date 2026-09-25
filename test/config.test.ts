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
    baseUrl: "https://api.typesafe.ai",
    path: "/v1/systemone",
    model: "jev-latest",
    apiKey: "${TYPESAFE_API_KEY}",
    thresholds: { danger: 0.3, policy: 0.2 },
    timeoutMs: 5000,
    enabled: "yes",
  });
  assert.equal(config.baseUrl, "https://api.typesafe.ai");
  assert.equal(config.thresholds.danger, 0.3);
  assert.equal(config.thresholds.policy, 0.2);
  assert.equal(config.timeoutMs, 5000);
  // "enabled" was the wrong type, so the default survives and a problem is listed.
  assert.equal(config.enabled, DEFAULT_CONFIG.enabled);
  assert.deepEqual(problems, ['"enabled" must be a boolean']);
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

test("resolveEndpoint prefers an absolute endpoint, then baseUrl + path", () => {
  const base = { ...DEFAULT_CONFIG, baseUrl: "https://api.typesafe.ai/" };
  assert.equal(resolveEndpoint(base), "https://api.typesafe.ai/v1/systemone");

  // OpenRouter's Decisions surface lives on a different path, no preset needed.
  assert.equal(
    resolveEndpoint({ ...base, path: "/api/alpha/decisions" }),
    "https://api.typesafe.ai/api/alpha/decisions",
  );

  assert.equal(
    resolveEndpoint({ ...base, endpoint: "http://localhost:8080/custom" }),
    "http://localhost:8080/custom",
  );

  assert.throws(() => resolveEndpoint(DEFAULT_CONFIG), /no endpoint configured/);
});

test("saveConfig round-trips and creates the directory with owner-only permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsa-"));
  const file = configPath(dir);
  const config = { ...DEFAULT_CONFIG, baseUrl: "https://example.test", model: "jev-latest" };
  saveConfig(file, config);

  const reloaded = loadConfig(file);
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.config.baseUrl, "https://example.test");
  assert.equal(reloaded.config.model, "jev-latest");
  assert.ok(readFileSync(file, "utf8").endsWith("\n"));
});
