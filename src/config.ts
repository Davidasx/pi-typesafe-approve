/**
 * Configuration loading, validation, and persistence.
 *
 * Config lives at `<agentDir>/extensions/pi-typesafe-approve/config.json`
 * (i.e. `~/.pi/agent/extensions/pi-typesafe-approve/config.json` by default),
 * matching the convention used by other Pi permission extensions.
 *
 * Every endpoint field is user-supplied. There are deliberately **no provider
 * presets**: the known deployments (TypeSafe official, OpenRouter Decisions,
 * OpenRouter System One, OpenJEV, self-hosted relays) agree on the request body
 * but differ in endpoint path and model identifier, and those details move.
 * `config.example.json` documents the current values as comments only.
 */

import type { ApproveConfig, LoadedConfig } from "./types.ts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
export const EXTENSION_ID = "pi-typesafe-approve";
export const CONFIG_FILE_NAME = "config.json";
export const LOG_FILE_NAME = "decisions.jsonl";

export const DEFAULT_CONFIG: ApproveConfig = {
  enabled: true,

  baseUrl: "",
  path: "/v1/systemone",
  model: "",
  apiKey: "",
  headers: {},

  timeoutMs: 6000,
  cacheSize: 256,

  thresholds: { danger: 0.3, policy: 0.3 },
  escalateOnTiers: ["danger"],
  minTierConfidence: 0,
  action: "escalate",
  noUiFallback: "block",
  failMode: "open",

  logDecisions: true,
  debug: false,
};

/** Directory that holds this extension's config and logs. */
export function configDir(agentDir: string): string {
  return join(agentDir, "extensions", EXTENSION_ID);
}

export function configPath(agentDir: string): string {
  return join(configDir(agentDir), CONFIG_FILE_NAME);
}

export function logPath(agentDir: string): string {
  return join(configDir(agentDir), LOG_FILE_NAME);
}

/**
 * Load configuration, falling back to defaults for anything missing or
 * invalid. Never throws: a broken config degrades to defaults plus a list of
 * problems the caller can surface.
 */
export function loadConfig(path: string): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { ok: true, config: { ...DEFAULT_CONFIG }, path };
    }
    return {
      ok: false,
      config: { ...DEFAULT_CONFIG },
      path,
      problems: [`could not be read: ${message(error)}`],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      config: { ...DEFAULT_CONFIG },
      path,
      problems: ["is not valid JSON"],
    };
  }
  if (!isRecord(raw)) {
    return {
      ok: false,
      config: { ...DEFAULT_CONFIG },
      path,
      problems: ["must be a JSON object"],
    };
  }

  return { ok: true, config: mergeConfig(raw), path };
}

/**
 * Merge a raw JSON object over the defaults, collecting problems for values of
 * the wrong shape. Unknown keys are ignored rather than rejected so that a
 * config written for a newer version still loads.
 */
/** Merge a raw JSON object over the defaults. Unknown keys are ignored so a
 * config written for a newer version still loads. Use {@link validateConfig}
 * when the caller also needs to report malformed values. */
export function mergeConfig(raw: Record<string, unknown>): ApproveConfig {
  return normalize(raw);
}

/** Validate a raw object, returning the merged config plus every problem. */
export function validateConfig(raw: Record<string, unknown>): {
  config: ApproveConfig;
  problems: string[];
} {
  return { config: normalize(raw), problems: collectProblems(raw) };
}

function normalize(raw: Record<string, unknown>): ApproveConfig {
  const d = DEFAULT_CONFIG;
  const thresholds = isRecord(raw.thresholds) ? raw.thresholds : {};
  return {
    enabled: bool(raw.enabled, d.enabled),
    baseUrl: str(raw.baseUrl, d.baseUrl),
    path: str(raw.path, d.path),
    ...(typeof raw.endpoint === "string" ? { endpoint: raw.endpoint } : {}),
    model: str(raw.model, d.model),
    apiKey: str(raw.apiKey, d.apiKey),
    headers: stringRecord(raw.headers),
    timeoutMs: positiveInt(raw.timeoutMs, d.timeoutMs),
    cacheSize: nonNegativeInt(raw.cacheSize, d.cacheSize),
    thresholds: {
      danger: unitInterval(thresholds.danger, d.thresholds.danger),
      policy: unitInterval(thresholds.policy, d.thresholds.policy),
    },
    escalateOnTiers: stringArray(raw.escalateOnTiers, d.escalateOnTiers),
    minTierConfidence: unitInterval(raw.minTierConfidence, d.minTierConfidence),
    action: oneOf(raw.action, ["escalate", "monitor", "block"], d.action),
    noUiFallback: oneOf(raw.noUiFallback, ["block", "allow"], d.noUiFallback),
    failMode: oneOf(raw.failMode, ["open", "closed"], d.failMode),
    logDecisions: bool(raw.logDecisions, d.logDecisions),
    debug: bool(raw.debug, d.debug),
  };
}

function collectProblems(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const expect = (
    key: string,
    predicate: (value: unknown) => boolean,
    description: string,
  ): void => {
    if (Object.hasOwn(raw, key) && raw[key] !== undefined && !predicate(raw[key])) {
      problems.push(`"${key}" ${description}`);
    }
  };
  const isBool = (v: unknown): boolean => typeof v === "boolean";
  const isString = (v: unknown): boolean => typeof v === "string";
  const isNumber = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  const isArray = (v: unknown): boolean => Array.isArray(v);

  expect("enabled", isBool, "must be a boolean");
  expect("baseUrl", isString, "must be a string");
  expect("path", isString, "must be a string");
  expect("endpoint", isString, "must be a string");
  expect("model", isString, "must be a string");
  expect("apiKey", isString, "must be a string");
  expect("headers", isRecord, "must be an object of string values");
  expect("timeoutMs", isNumber, "must be a number");
  expect("cacheSize", isNumber, "must be a number");
  expect("thresholds", isRecord, "must be an object");
  expect("escalateOnTiers", isArray, "must be an array of strings");
  expect("minTierConfidence", isNumber, "must be a number");
  expect("action", (v) => isString(v) && ["escalate", "monitor", "block"].includes(v as string), 'must be "escalate", "monitor", or "block"');
  expect("noUiFallback", (v) => isString(v) && ["block", "allow"].includes(v as string), 'must be "block" or "allow"');
  expect("failMode", (v) => isString(v) && ["open", "closed"].includes(v as string), 'must be "open" or "closed"');
  expect("logDecisions", isBool, "must be a boolean");
  expect("debug", isBool, "must be a boolean");

  if (isRecord(raw.thresholds)) {
    for (const key of ["danger", "policy"] as const) {
      const value = raw.thresholds[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        problems.push(`"thresholds.${key}" must be a number`);
      }
    }
  }
  return problems;
}

/** Persist configuration atomically. Creates the directory if needed. */
export function saveConfig(path: string, config: ApproveConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Resolve an API key that may be an environment reference.
 *
 * The rule is the same one the policy file uses: `${NAME}` reads the environment,
 * and **anything else is a literal**, `$` included. There is exactly one
 * syntax, in exactly one place, and no second guessing.
 *
 * So `apiKey: "$TYPESAFE_API_KEY"` is taken at face value and sent as a literal
 * bearer token. That is the correct reading of a rule the docs and the config
 * comment both state plainly: if a value begins with `$` and is not `${NAME}`,
 * the user meant a literal. {@link apiKeyBareReferenceWarning} exists only to
 * make that visible in `/typesafe-approve status`, so the resulting 401 in a
 * log points straight at the cause instead of being a mystery.
 *
 * An unset `${NAME}` *is* an error, because a braced reference is unambiguous:
 * it must fail loudly rather than send an empty bearer token.
 *
 * - `${NAME}` — the environment variable `NAME`,
 * - anything else without a `$` — the literal key,
 * - anything else containing a `$` — an error.
 *
 * Rejecting the bare `$NAME` form rather than expanding it matters: if `$NAME`
 * were treated as a literal, a misconfigured file would send the six-character
 * string `$NAME` as a bearer token and the request would fail with an opaque
 * 401 instead of saying what is wrong. Refusing any stray `$` in a literal key
 * is a deliberate trade — real keys do not contain one — in exchange for never
 * sending a token that was obviously meant to be a variable.
 *
 * An unset or empty reference is an error rather than an empty bearer token, for
 * the same reason: it must fail loudly, not silently send no credentials.
 */
export function resolveApiKey(
  value: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { ok: true; key: string } | { ok: false; reason: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: 'no "apiKey" configured (set a literal value, or an environment reference such as "${TYPESAFE_API_KEY}")',
    };
  }

  const reference = matchEnvReference(trimmed);
  if (reference) {
    const resolved = env[reference];
    if (resolved === undefined || resolved === "") {
      return { ok: false, reason: `environment variable ${reference} referenced by "apiKey" is not set` };
    }
    return { ok: true, key: resolved };
  }


  return { ok: true, key: trimmed };
}

/** Names of every environment variable referenced by the configured key. */
export function apiKeyEnvReferences(value: string): string[] {
  const reference = matchEnvReference(value.trim());
  return reference ? [reference] : [];
}

/** The single braced `${NAME}` form. A bare `$NAME` is a literal, not a reference. */
function matchEnvReference(value: string): string | undefined {
  return /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value)?.[1];
}

/**
 * A non-fatal note for a value that looks like an environment reference but is
 * not written in the one supported form, e.g. `$TYPESAFE_API_KEY`. Returned so
 * `status` can say why the key is being sent verbatim; it never changes what is
 * sent.
 */
export function apiKeyBareReferenceWarning(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.includes("$") || matchEnvReference(trimmed)) return undefined;
  const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(trimmed)?.[1];
  return bare
    ? `looks like a variable but is not \${${bare}}; sending it as a literal`
    : 'contains "$" but is not ${NAME}; sending it as a literal';
}

/** Build the request endpoint from config. Throws when nothing is configured. */
export function resolveEndpoint(config: ApproveConfig): string {
  if (config.endpoint && config.endpoint.trim()) {
    return config.endpoint.trim();
  }
  const base = config.baseUrl.trim();
  if (!base) {
    throw new Error(
      'no endpoint configured: set "baseUrl" (and "path"), or set "endpoint" to a full URL',
    );
  }
  const trimmedBase = base.replace(/\/+$/u, "");
  const path = config.path.trim();
  if (!path || path === "/") {
    return trimmedBase;
  }
  return `${trimmedBase}${path.startsWith("/") ? path : `/${path}`}`;
}

// ── primitive coercion ────────────────────────────────────────────────────


function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function unitInterval(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length ? items : fallback;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
