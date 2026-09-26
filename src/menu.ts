/**
 * The `/typesafe-approve` interface.
 *
 * Built on `@narumitw/pi-tui-kit`'s `MenuDefinition` so it behaves like the other
 * Pi configuration screens: one `settings` list that shows every option **with its
 * current value**, where enumerated options change in place on Enter and text
 * options open an input screen. Nothing is hidden behind a nested menu, and the
 * kit supplies the navigation, search, back/close handling, and the mode guard
 * for providers that cannot show a dialog.
 *
 * This module is deliberately free of runtime imports outside this extension:
 * the kit is imported for types only, so the whole menu can be unit-tested by
 * driving its data and action handlers directly.
 */

import type { MenuDefinition, MenuScreen, MenuTransition } from "@narumitw/pi-tui-kit";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { apiKeyBareReferenceWarning, apiKeyEnvReferences, resolveEndpoint } from "./config.ts";
import type { LoadedPolicy } from "./policy.ts";
import type { ApproveConfig } from "./types.ts";

export interface MenuPaths {
  config: string;
  policy: string;
  log: string;
}

export interface ApproveMenuState {
  config: ApproveConfig;
  policy: LoadedPolicy;
  paths: MenuPaths;
  /** False when the endpoint, model, or key is unusable. */
  configured: boolean;
  /** Set when a config change on disk was refused; shown on the main screen. */
  configProblem?: string;
}

export interface MenuDeps {
  /** Current state, re-read by the kit before every screen render. */
  getState(): ApproveMenuState;
  /** Merge a patch into the config, persist it, and reload. */
  update(patch: Partial<ApproveConfig>): void;
  /** Replace the policy file with this text. */
  writePolicy(text: string): void;
  /** Put the built-in default policy back. */
  restoreDefaultPolicy(): void;
  /** One-line result of talking to the endpoint, for the diagnostics screen. */
  connectionReport(): Promise<string>;
}

export type ApproveScreenId =
  | "main"
  | "settings"
  | "policy"
  | "policy-view"
  | "diagnostics"
  | "edit-base-url"
  | "edit-path"
  | "edit-model"
  | "edit-api-key"
  | "edit-timeout"
  | "edit-cache"
  | "edit-danger"
  | "edit-policy-threshold"
  | "edit-tier-confidence";

export type ApproveActionId =
  | "set-enum"
  | "open-edit"
  | "apply-base-url"
  | "apply-path"
  | "apply-model"
  | "apply-api-key"
  | "apply-timeout"
  | "apply-cache"
  | "apply-danger"
  | "apply-policy-threshold"
  | "apply-tier-confidence"
  | "policy-show"
  | "policy-edit"
  | "policy-restore"
  | "policy-back"
  | "test-connection"
  | "show-config-path"
  | "show-log-path";

/** Which input screen each editable text setting opens. */
const EDIT_SCREENS: Record<string, ApproveScreenId> = {
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

/** Enumerated settings: the label shown, and the value it stores. */
const ENUM_VALUES: Record<string, Record<string, unknown>> = {
  enabled: { On: true, Off: false },
  escalateOnTiers: { danger: ["danger"], "danger and caution": ["danger", "caution"] },
  action: { escalate: "escalate", monitor: "monitor", block: "block" },
  noUiFallback: { block: "block", allow: "allow" },
  failMode: { open: "open", closed: "closed" },
  logDecisions: { On: true, Off: false },
  debug: { On: true, Off: false },
};

export function createApproveMenu(
  deps: MenuDeps,
): MenuDefinition<ApproveMenuState, ApproveScreenId, ApproveActionId, ExtensionCommandContext> {
  const stay: MenuTransition<ApproveScreenId> = { kind: "stay" };
  const back: MenuTransition<ApproveScreenId> = { kind: "back" };

  /** Validate a numeric field and report the reason when it is not acceptable. */
  const number = (
    raw: string | undefined,
    bounds: { min: number; max: number; label: string },
  ): number | string => {
    const value = Number((raw ?? "").trim());
    if (!Number.isFinite(value)) return `${bounds.label} must be a number.`;
    if (value < bounds.min || value > bounds.max) {
      return `${bounds.label} must be between ${bounds.min} and ${bounds.max}.`;
    }
    return value;
  };

  /** Apply a numeric input, keeping the settings screen open on a bad value. */
  const applyNumber = (
    ctx: ExtensionCommandContext,
    raw: string | undefined,
    bounds: { min: number; max: number; label: string },
    patch: (value: number) => Partial<ApproveConfig>,
  ): MenuTransition<ApproveScreenId> => {
    const result = number(raw, bounds);
    if (typeof result === "string") {
      ctx.ui.notify(result, "error");
      return stay;
    }
    deps.update(patch(result));
    return stay;
  };

  return {
    start: "main",

    screens: {
      main: () => {
        const state = deps.getState();
        return {
          kind: "actions",
          title: "typesafe-approve",
          lines: [
            statusLine(state),
            endpointLine(state.config),
            state.configured ? "" : "Not configured yet: set the endpoint, model, and API key.",
            state.configProblem ?? "",
          ].filter(Boolean),
          items: [
            { id: "settings", label: "Settings", description: "Every option with its current value.", to: "settings" },
            { id: "policy", label: "Policy", description: "The rules the model judges against.", to: "policy" },
            {
              id: "diagnostics",
              label: "Diagnostics",
              description: "Test the endpoint, reload from disk, show file paths.",
              to: "diagnostics",
            },
            { id: "close", label: "Close", close: true },
          ],
          hint: "close",
        };
      },

      settings: () => {
        const { config } = deps.getState();
        const bool = (value: boolean): string => (value ? "On" : "Off");
        return {
          kind: "settings",
          title: "typesafe-approve settings",
          lines: ["Enter changes enumerated options in place; others open an editor."],
          items: [
            enumItem("enabled", "Enabled", "Run the check at all.", bool(config.enabled), "enabled"),
            textItem("baseUrl", "Base URL", "e.g. https://api.typesafe.ai", config.baseUrl || "(unset)"),
            textItem("path", "Request path", "e.g. /v1/systemone, /api/alpha/decisions", config.path || "(empty)"),
            textItem("model", "Model", "e.g. jev-latest, ~typesafe/jev-latest", config.model || "(unset)"),
            textItem("apiKey", "API key", "A literal, or ${NAME} to read an environment variable.", describeKey(config.apiKey)),
            textItem("timeoutMs", "Request timeout", "Milliseconds before the check gives up.", `${config.timeoutMs} ms`),
            textItem("cacheSize", "Cache size", "Decisions remembered per session; 0 disables.", String(config.cacheSize)),
            textItem("thresholds.danger", "Danger threshold", "0..1; lower flags more commands.", String(config.thresholds.danger)),
            textItem("thresholds.policy", "Policy threshold", "0..1; lower flags more commands.", String(config.thresholds.policy)),
            enumItem("escalateOnTiers", "Tiers that escalate", "Which risk tiers stop the command.", config.escalateOnTiers.join(" and "), "escalateOnTiers"),
            textItem("minTierConfidence", "Minimum tier confidence", "0..1; how sure the tier must be to act on it.", String(config.minTierConfidence)),
            enumItem("action", "Action on a trigger", "What happens when a threshold is crossed.", config.action, "action"),
            enumItem("noUiFallback", "Without a UI", "What escalating does when nobody can be asked.", config.noUiFallback, "noUiFallback"),
            enumItem("failMode", "If the model is unreachable", "The check cannot run.", config.failMode, "failMode"),
            enumItem("logDecisions", "Log decisions", "Append each verdict to decisions.jsonl.", bool(config.logDecisions), "logDecisions"),
            enumItem("debug", "Debug logging", "Also log request traces for troubleshooting.", bool(config.debug), "debug"),
          ],
        };
      },

      policy: () => {
        const { policy } = deps.getState();
        return {
          kind: "actions",
          title: "Policy",
          lines: [
            `File: ${policy.path}`,
            policy.created ? "Created on first run from the built-in default." : "",
            policy.fallback ? "Unreadable or empty; the built-in default is in use." : "",
            policy.unresolved.length ? `Unresolved, left as written: ${policy.unresolved.join(", ")}` : "",
            policy.bare.length ? `Needs braces to expand: ${policy.bare.join(", ")}` : "",
          ].filter(Boolean),
          items: [
            { id: "show", label: "Show the policy sent to the model", action: "policy-show" },
            { id: "edit", label: "Edit the policy", description: "Opens the full text in an editor.", action: "policy-edit" },
            { id: "restore", label: "Restore the built-in default", description: "Replaces the file.", action: "policy-restore" },
          ],
          hint: "back",
        };
      },

      "policy-view": () => {
        const { policy } = deps.getState();
        return {
          kind: "review",
          title: "Policy sent to the model",
          lines: [`${policy.text.length} characters · ${policy.path}`],
          content: policy.text,
          confirm: { id: "done", label: "Back", action: "policy-back" },
        };
      },

      diagnostics: () => {
        const { paths, policy } = deps.getState();
        return {
          kind: "actions",
          title: "Diagnostics",
          lines: [`Config: ${paths.config}`, `Policy: ${policy.path}`, `Log: ${paths.log}`],
          items: [
            { id: "test", label: "Test the connection", description: "Send one harmless check request.", action: "test-connection", busyLabel: "Checking…" },
            { id: "config-path", label: "Show the config path", action: "show-config-path" },
            { id: "log-path", label: "Show the log path and size", action: "show-log-path" },
          ],
          hint: "back",
        };
      },

      "edit-base-url": () => input("Base URL", "https://api.typesafe.ai", "apply-base-url", deps.getState().config.baseUrl),
      "edit-path": () => input("Request path", "/v1/systemone", "apply-path", deps.getState().config.path),
      "edit-model": () => input("Model", "jev-latest", "apply-model", deps.getState().config.model),
      "edit-api-key": () =>
        input(
          "API key",
          "${TYPESAFE_API_KEY}",
          "apply-api-key",
          // Never prefill a secret into a dialog: showing it would leak it to the
          // screen and into the terminal scrollback.
          "",
          "A literal, or ${NAME} to read an environment variable.",
        ),
      "edit-timeout": () => input("Request timeout (ms)", "6000", "apply-timeout", String(deps.getState().config.timeoutMs)),
      "edit-cache": () => input("Cache size", "256", "apply-cache", String(deps.getState().config.cacheSize)),
      "edit-danger": () => input("Danger threshold (0..1)", "0.3", "apply-danger", String(deps.getState().config.thresholds.danger)),
      "edit-policy-threshold": () => input("Policy threshold (0..1)", "0.3", "apply-policy-threshold", String(deps.getState().config.thresholds.policy)),
      "edit-tier-confidence": () => input("Minimum tier confidence (0..1)", "0", "apply-tier-confidence", String(deps.getState().config.minTierConfidence)),
    },

    actions: {
      "set-enum": ({ itemId, value }) => {
        const mapping = ENUM_VALUES[itemId];
        if (!mapping) return stay;
        const stored = mapping[value ?? ""];
        if (stored === undefined) return stay;
        deps.update({ [itemId]: stored } as Partial<ApproveConfig>);
        return stay;
      },

      "open-edit": ({ itemId }) => {
        const screen = EDIT_SCREENS[itemId];
        return screen ? { kind: "to", screen } : stay;
      },

      "apply-base-url": ({ ctx, value }) => {
        deps.update({ baseUrl: (value ?? "").trim() });
        return flagConfiguration(ctx, deps.getState());
      },
      "apply-path": ({ ctx, value }) => {
        deps.update({ path: (value ?? "").trim() });
        return flagConfiguration(ctx, deps.getState());
      },
      "apply-model": ({ ctx, value }) => {
        deps.update({ model: (value ?? "").trim() });
        return flagConfiguration(ctx, deps.getState());
      },
      "apply-api-key": ({ ctx, value }) => {
        const apiKey = (value ?? "").trim();
        deps.update({ apiKey });
        const warning = apiKeyBareReferenceWarning(apiKey);
        if (warning) {
          ctx.ui.notify(`API key: ${warning}.`, "warning");
        } else if (!apiKey) {
          ctx.ui.notify("API key cleared; the check stays inert until one is set.", "info");
        }
        return flagConfiguration(ctx, deps.getState());
      },
      "apply-timeout": ({ ctx, value }) =>
        applyNumber(ctx, value, { min: 100, max: 600_000, label: "Timeout" }, (timeoutMs) => ({ timeoutMs })),
      "apply-cache": ({ ctx, value }) =>
        applyNumber(ctx, value, { min: 0, max: 100_000, label: "Cache size" }, (cacheSize) => ({ cacheSize })),
      "apply-danger": ({ ctx, value }) =>
        applyNumber(ctx, value, { min: 0, max: 1, label: "Danger threshold" }, (danger) => ({
          thresholds: { ...deps.getState().config.thresholds, danger },
        })),
      "apply-policy-threshold": ({ ctx, value }) =>
        applyNumber(ctx, value, { min: 0, max: 1, label: "Policy threshold" }, (policy) => ({
          thresholds: { ...deps.getState().config.thresholds, policy },
        })),
      "apply-tier-confidence": ({ ctx, value }) =>
        applyNumber(
          ctx,
          value,
          { min: 0, max: 1, label: "Minimum tier confidence" },
          (minTierConfidence) => ({ minTierConfidence }),
        ),

      "policy-show": () => ({ kind: "to", screen: "policy-view" }),
      "policy-back": () => back,
      "policy-edit": async ({ ctx }) => {
        const current = deps.getState().policy.text;
        const edited = await ctx.ui.editor("Policy sent to the model", current);
        if (edited === undefined) return stay;
        deps.writePolicy(edited);
        ctx.ui.notify("Policy saved.", "info");
        return stay;
      },
      "policy-restore": async ({ ctx }) => {
        const confirmed = await ctx.ui.confirm(
          "Restore the built-in default policy?",
          "This replaces the contents of the policy file. Your edits to it are lost.",
        );
        if (!confirmed) return stay;
        deps.restoreDefaultPolicy();
        ctx.ui.notify("Policy restored to the built-in default.", "info");
        return stay;
      },

      "test-connection": async ({ ctx }) => {
        ctx.ui.notify(await deps.connectionReport(), "info");
        return stay;
      },
      "show-config-path": ({ ctx }) => {
        ctx.ui.notify(deps.getState().paths.config, "info");
        return stay;
      },
      "show-log-path": ({ ctx }) => {
        ctx.ui.notify(deps.getState().paths.log, "info");
        return stay;
      },
    },
  };
}

// ── screen helpers ─────────────────────────────────────────────────────────

function input(
  title: string,
  placeholder: string,
  action: ApproveActionId,
  current: string,
  hint?: string,
): MenuScreen<ApproveScreenId, ApproveActionId> {
  return {
    kind: "input",
    title,
    lines: [hint ?? `Currently: ${current || "(unset)"}`],
    placeholder,
    action,
    hint: "back",
  };
}

function enumItem(
  id: string,
  label: string,
  description: string,
  currentValue: string,
  enumKey: string,
): { id: string; label: string; description: string; currentValue: string; values: string[]; action: ApproveActionId } {
  return {
    id,
    label,
    description,
    currentValue,
    values: Object.keys(ENUM_VALUES[enumKey] ?? {}),
    action: "set-enum",
  };
}

function textItem(
  id: string,
  label: string,
  description: string,
  currentValue: string,
): { id: string; label: string; description: string; currentValue: string; action: ApproveActionId } {
  // No `values`, so the kit treats the row as "open the editor for this field".
  return { id, label, description, currentValue, action: "open-edit" };
}

/** Tell the user right away when an edit left the endpoint unusable. */
function flagConfiguration(
  ctx: ExtensionCommandContext,
  state: ApproveMenuState,
): MenuTransition<ApproveScreenId> {
  if (!state.configured) {
    ctx.ui.notify(
      "Saved, but the endpoint, model, and API key are not all usable yet, so the check stays inert.",
      "warning",
    );
  }
  return { kind: "stay" };
}

// ── display helpers (exported for tests and the status subcommand) ──────────

export function endpointLine(config: ApproveConfig): string {
  let endpoint = "(no endpoint configured)";
  try {
    endpoint = resolveEndpoint(config);
  } catch {
    // Keep the placeholder.
  }
  return `${endpoint} · model ${config.model || "(unset)"}`;
}

export function statusLine(state: ApproveMenuState): string {
  const { config, policy } = state;
  return [
    config.enabled ? "enabled" : "disabled",
    state.configured ? "configured" : "not configured",
    `key ${describeKey(config.apiKey)}`,
    `danger >= ${config.thresholds.danger}, policy >= ${config.thresholds.policy}`,
    `on trigger: ${config.action}`,
    `policy: ${policy.path.split(/[/\\]/u).at(-1) ?? "policy.md"}`,
  ].join(" · ");
}

/** Describe the key without ever showing it. */
export function describeKey(apiKey: string): string {
  if (!apiKey) return "(unset)";
  const references = apiKeyEnvReferences(apiKey);
  if (references.length > 0) return `\${${references[0]}}`;
  return apiKeyBareReferenceWarning(apiKey) ? "literal (check the syntax)" : "literal";
}
