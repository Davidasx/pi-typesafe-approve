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
  /** The policy file exactly as it is on disk, for the editor. */
  readPolicyText(): string;
  /** One-line result of talking to the endpoint, for the diagnostics screen. */
  connectionReport(): Promise<string>;
}

export type ApproveScreenId =
  | "main"
  | "settings"
  | "policy"
  | "policy-view"
  | "diagnostics"
  | "edit-endpoint"
  | "edit-model"
  | "edit-api-key"
  | "edit-timeout"
  | "edit-cache"
  | "edit-violation"
  | "edit-prompt-timeout"
  ;

export type ApproveActionId =
  | "set-enum"
  | "open-edit"
  | "apply-endpoint"
  | "apply-model"
  | "apply-api-key"
  | "apply-timeout"
  | "apply-cache"
  | "apply-violation"
  | "apply-prompt-timeout"

  | "policy-show"
  | "policy-edit"
  | "policy-restore"
  | "policy-back"
  | "test-connection"
  | "show-config-path"
  | "show-log-path";

/** Which input screen each editable text setting opens. */
const EDIT_SCREENS: Record<string, ApproveScreenId> = {
  endpoint: "edit-endpoint",
  model: "edit-model",
  apiKey: "edit-api-key",
  timeoutMs: "edit-timeout",
  cacheSize: "edit-cache",
  "thresholds.violation": "edit-violation",
  promptTimeoutSeconds: "edit-prompt-timeout",
};

/** Enumerated settings: the label shown, and the value it stores. */
const ENUM_VALUES: Record<string, Record<string, unknown>> = {
  enabled: { On: true, Off: false },
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
              description: "Test the endpoint and show file paths.",
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
            textItem(
              "endpoint",
              "Endpoint",
              "The full request URL, path included.",
              config.endpoint || "(unset)",
            ),
            textItem("model", "Model", "e.g. jev-latest, ~typesafe/jev-latest", config.model || "(unset)"),
            textItem("apiKey", "API key", "A literal, or ${NAME} to read an environment variable.", describeKey(config.apiKey)),
            textItem("timeoutMs", "Request timeout", "Milliseconds before the check gives up.", `${config.timeoutMs} ms`),
            textItem("cacheSize", "Cache size", "Decisions remembered per session; 0 disables.", String(config.cacheSize)),
            textItem(
              "thresholds.violation",
              "Threshold",
              "0..1; stop the command when the summed violation probability reaches this.",
              String(config.thresholds.violation),
            ),
            enumItem("action", "Action on a trigger", "What happens when a threshold is crossed.", config.action, "action"),
            enumItem("noUiFallback", "Without a UI", "What escalating does when nobody can be asked.", config.noUiFallback, "noUiFallback"),
            textItem(
              "promptTimeoutSeconds",
              "Prompt timeout",
              "Seconds a prompt waits before refusing on its own; 0 waits forever.",
              `${config.promptTimeoutSeconds} s`,
            ),
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
            `${countCategories(policy, "negative")} stop, ${countCategories(policy, "positive")} allow`,
            policy.created ? "Created on first run from the built-in default." : "",
            policy.fallback ? "Unusable; the built-in categories are in use." : "",
            ...policy.problems,
          ].filter(Boolean),
          items: [
            {
              id: "show",
              label: "Show the categories sent to the model",
              description: "What the model actually chooses between.",
              action: "policy-show",
            },
            {
              id: "edit",
              label: "Edit the categories",
              description: "Opens policy.json in an editor.",
              action: "policy-edit",
            },
            {
              id: "restore",
              label: "Restore the built-in categories",
              description: "Replaces the file.",
              action: "policy-restore",
            },
          ],
          hint: "back",
        };
      },

      "policy-view": () => {
        const { policy } = deps.getState();
        const content = policy.categories
          .map((category) => {
            const polarity = category.polarity === "positive" ? "allow" : "STOP ";
            const examples = category.examples?.length
              ? `\n    examples: ${category.examples.join("; ")}`
              : "";
            return `${polarity} ${category.id}\n    ${category.what}${examples}`;
          })
          .join("\n\n");
        return {
          kind: "review",
          title: "Categories sent to the model",
          lines: [`${policy.categories.length} categories · ${policy.path}`],
          content,
          // Without "adaptive" the kit caps the viewport at a fixed 14 rows, so on
          // a short terminal the text runs past the bottom of the screen instead
          // of scrolling. Adaptive sizes the viewport to the terminal and scrolls.
          viewportSize: "adaptive",
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

      "edit-endpoint": () =>
        input(
          "Endpoint",
          "https://api.typesafe.ai/v1/systemone",
          "apply-endpoint",
          deps.getState().config.endpoint,
          "The full request URL, including the path. Currently: " +
            (deps.getState().config.endpoint || "(unset)"),
        ),
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
      "edit-violation": () =>
        input(
          "Threshold (0..1)",
          "0.3",
          "apply-violation",
          String(deps.getState().config.thresholds.violation),
          "Currently: " +
            String(deps.getState().config.thresholds.violation) +
            ". Lower stops more commands.",
        ),
      "edit-prompt-timeout": () =>
        input(
          "Prompt timeout (seconds)",
          "300",
          "apply-prompt-timeout",
          String(deps.getState().config.promptTimeoutSeconds),
          "How long a prompt waits before it refuses on its own. 0 waits forever.",
        ),
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

      "apply-endpoint": ({ ctx, value }) => {
        deps.update({ endpoint: (value ?? "").trim() });
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
      "apply-violation": ({ ctx, value }) =>
        applyNumber(ctx, value, { min: 0, max: 1, label: "Threshold" }, (violation) => ({
          thresholds: { violation },
        })),
      "apply-prompt-timeout": ({ ctx, value }) =>
        applyNumber(
          ctx,
          value,
          { min: 0, max: 86_400, label: "Prompt timeout" },
          (promptTimeoutSeconds) => ({ promptTimeoutSeconds }),
        ),

      "policy-show": () => ({ kind: "to", screen: "policy-view" }),
      "policy-back": () => back,
      "policy-edit": async ({ ctx }) => {
        const current = deps.readPolicyText();
        const edited = await ctx.ui.editor("policy.json", current);
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

function countCategories(policy: LoadedPolicy, polarity: "negative" | "positive"): number {
  return policy.categories.filter((category) => category.polarity === polarity).length;
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
    `violation >= ${config.thresholds.violation}`,
    `on trigger: ${config.action}`,
    `policy: ${policy.path.split(/[/\\]/u).at(-1) ?? "policy.json"} (${policy.categories.length})`,
  ].join(" · ");
}

/** Describe the key without ever showing it. */
export function describeKey(apiKey: string): string {
  if (!apiKey) return "(unset)";
  const references = apiKeyEnvReferences(apiKey);
  if (references.length > 0) return `\${${references[0]}}`;
  return apiKeyBareReferenceWarning(apiKey) ? "literal (check the syntax)" : "literal";
}
