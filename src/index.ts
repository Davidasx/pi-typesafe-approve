/**
 * Pi extension entry point.
 *
 * Wires three things together and nothing else:
 *
 *   - the config file under `<agentDir>/extensions/pi-typesafe-approve/`,
 *   - a `tool_call` handler that gates Bash commands (see `gate.ts` for why the
 *     event, and not a re-registered Bash tool),
 *   - a `/typesafe-approve` command for configuration and manual checks.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildQuestions, buildState, decide } from "./classify.ts";
import {
  apiKeyBareReferenceWarning,
  apiKeyEnvReferences,
  configDir,
  configPath,
  loadConfig,
  logPath,
  resolveApiKey,
  resolveEndpoint,
  saveConfig,
} from "./config.ts";
import { createGate, type GateUi } from "./gate.ts";
import { createFileLogger, trimLogFile, type DecisionLogger } from "./log.ts";
import { loadPolicy, policyPath, type LoadedPolicy } from "./policy.ts";
import { createSystemOneClient, redact, type SystemOneClient } from "./systemone.ts";
import type { ApproveConfig, LoadedConfig } from "./types.ts";

export default function typesafeApproveExtension(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const file = configPath(agentDir);

  let loaded: LoadedConfig = loadConfig(file);
  // The session's working directory, reported to the model as a structured field.
  let sessionCwd = process.cwd();
  const logger: DecisionLogger = createFileLogger(logPath(agentDir), () => loaded.config.debug);
  let clientCache: { signature: string; client: SystemOneClient } | undefined;

  const getConfig = (): ApproveConfig => loaded.config;

  const policyContext = {
    configDir: configDir(agentDir),
    env: process.env,
  };
  let policy: LoadedPolicy = loadPolicy(policyContext);

  /** Re-read the config file and the policy file. */
  function reload(cwd?: string): void {
    loaded = loadConfig(file);
    sessionCwd = cwd ?? sessionCwd;
    policy = loadPolicy(policyContext);
  }

  function persist(config: ApproveConfig): void {
    saveConfig(file, config);
    reload();
    clientCache = undefined;
  }

  function getClient(config: ApproveConfig): SystemOneClient {
    const signature = JSON.stringify([
      config.endpoint ?? "",
      config.baseUrl,
      config.path,
      config.model,
      config.headers,
      config.timeoutMs,
      config.apiKey,
    ]);
    if (clientCache?.signature === signature) return clientCache.client;

    const endpoint = resolveEndpoint(config);
    const key = resolveApiKey(config.apiKey);
    if (!key.ok) throw new Error(key.reason);
    const client = createSystemOneClient({
      endpoint,
      apiKey: key.key,
      model: config.model,
      headers: config.headers,
      defaultTimeoutMs: config.timeoutMs,
    });
    clientCache = { signature, client };
    return client;
  }

  const gate = createGate({
    getConfig,
    getPolicy: () => policy.text,
    getCwd: () => sessionCwd,
    isConfigured: () => isConfigured(loaded.config),
    ask: (request, signal) => getClient(getConfig()).ask(request, signal ? { signal } : {}),
    logger,
  });

  // ── lifecycle ────────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    reload(ctx.cwd);
    // Trim on startup too, so an oversized log is handled even in a session that
    // runs no shell commands.
    trimLogFile(logPath(agentDir));
    logger.debug("session.start", { configPath: file, policyPath: policy.path, policyCreated: policy.created });

    if (!loaded.ok) {
      ctx.ui.notify(
        `pi-typesafe-approve: config at ${file} ${loaded.problems.join("; ")}. Using defaults.`,
        "warning",
      );
      return;
    }
    if (loaded.config.enabled && !isConfigured(loaded.config)) {
      ctx.ui.notify(
        "pi-typesafe-approve: not configured yet — run /typesafe-approve to set the endpoint, model, and API key.",
        "info",
      );
    }
  });

  pi.on("tool_call", async (event, ctx) => gate(event, toGateUi(ctx)));

  // ── command ──────────────────────────────────────────────────────────────

  pi.registerCommand("typesafe-approve", {
    description: "Configure and inspect the System One Bash auto-approval gate",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (trimmed === "policy") {
        showPolicy(ctx, policy);
        return;
      }
      if (trimmed === "status" || trimmed === "path") {
        ctx.ui.notify(statusLine(loaded, policy), "info");
        if (trimmed === "path") ctx.ui.notify(`pi-typesafe-approve config: ${file}`, "info");
        return;
      }
      if (trimmed === "on" || trimmed === "off" || trimmed === "toggle") {
        const enabled = trimmed === "toggle" ? !loaded.config.enabled : trimmed === "on";
        persist({ ...loaded.config, enabled });
        ctx.ui.notify(`pi-typesafe-approve: ${enabled ? "enabled" : "disabled"}.`, "info");
        return;
      }
      if (trimmed.startsWith("test")) {
        await runManualTest(trimmed.replace(/^test\s*/u, "").trim(), ctx, {
          getConfig,
          getClient,
          cwd: () => sessionCwd,
          policy: () => policy,
        });
        return;
      }

      await openMenu(ctx, {
        getLoaded: () => loaded,
        file,
        persist,
        policy: () => policy,
        getClient,
      });
    },
  });
}

// ── command flows ──────────────────────────────────────────────────────────

interface MenuDeps {
  getLoaded(): LoadedConfig;
  file: string;
  persist(config: ApproveConfig): void;
  policy(): LoadedPolicy;
  getClient(config: ApproveConfig): SystemOneClient;
}

async function openMenu(ctx: ExtensionCommandContext, deps: MenuDeps): Promise<void> {
  for (;;) {
    const loaded = deps.getLoaded();
    const choice = await ctx.ui.select(
      `pi-typesafe-approve — ${loaded.config.enabled ? "enabled" : "disabled"}\n${endpointLine(loaded.config)}`,
      [
        "Status",
        loaded.config.enabled ? "Disable" : "Enable",
        "Set endpoint (base URL)",
        "Set path",
        "Set model",
        "Set API key",
        "Set danger threshold",
        "Set principle threshold",
        "Set action on trigger",
        "Set failure mode",
        "Set no-UI fallback",
        "Test the connection",
        "Show the policy sent to the model",
        "Show config file path",
        "Done",
      ],
    );
    if (choice === undefined || choice === "Done") return;

    /** Prompt for a string field, then persist the trimmed result. */
    const setText = async (key: "baseUrl" | "path" | "model" | "apiKey", title: string, prefill?: string): Promise<void> => {
      const value = await ctx.ui.input(title, prefill ?? String(loaded.config[key] ?? ""));
      if (value === undefined) return;
      deps.persist({ ...deps.getLoaded().config, [key]: value.trim() });
    };

    /** Prompt for a 0..1 threshold, rejecting anything else. */
    const setThreshold = async (key: "danger" | "policy", title: string): Promise<void> => {
      const current = deps.getLoaded().config.thresholds[key];
      const value = await ctx.ui.input(title, String(current));
      if (value === undefined) return;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        ctx.ui.notify("Threshold must be a number between 0 and 1.", "error");
        return;
      }
      const config = deps.getLoaded().config;
      deps.persist({ ...config, thresholds: { ...config.thresholds, [key]: parsed } });
    };

    switch (choice) {
      case "Status":
        ctx.ui.notify(statusLine(loaded, deps.policy()), "info");
        break;
      case "Disable":
      case "Enable":
        deps.persist({ ...loaded.config, enabled: choice === "Enable" });
        break;
      case "Set endpoint (base URL)":
        await setText("baseUrl", "Base URL (e.g. https://api.typesafe.ai)");
        break;
      case "Set path":
        await setText("path", "Request path (e.g. /v1/systemone, /api/alpha/decisions)");
        break;
      case "Set model":
        await setText("model", "Model id (e.g. jev-latest, ~typesafe/jev-latest, typesafe/jev-1.13)");
        break;
      case "Set API key":
        // Never prefill a secret into a dialog: showing it would leak it to the screen.
        await setText(
          "apiKey",
          "API key, or ${TYPESAFE_API_KEY} to read it from the environment",
          "",
        );
        break;
      case "Set danger threshold":
        await setThreshold("danger", "Danger threshold 0..1 (lower flags more)");
        break;
      case "Set principle threshold":
        await setThreshold("policy", "Policy-violation threshold 0..1");
        break;
      case "Set action on trigger": {
        const action = await ctx.ui.select("When a command is flagged", ["escalate", "monitor", "block"]);
        if (action === "escalate" || action === "monitor" || action === "block") {
          deps.persist({ ...deps.getLoaded().config, action });
        }
        break;
      }
      case "Set failure mode": {
        const mode = await ctx.ui.select("When the model is unreachable", ["open", "closed"]);
        if (mode === "open" || mode === "closed") {
          deps.persist({ ...deps.getLoaded().config, failMode: mode });
        }
        break;
      }
      case "Set no-UI fallback": {
        const fallback = await ctx.ui.select(
          "When escalating with no UI to ask (print/JSON mode, subagents)",
          ["block", "allow"],
        );
        if (fallback === "block" || fallback === "allow") {
          deps.persist({ ...deps.getLoaded().config, noUiFallback: fallback });
        }
        break;
      }
      case "Test the connection":
        await testConnection(ctx, deps.getLoaded().config, deps.getClient, deps.policy());
        break;
      case "Show the policy sent to the model":
        showPolicy(ctx, deps.policy());
        break;
      case "Show config file path":
        ctx.ui.notify(`pi-typesafe-approve config: ${deps.file}`, "info");
        break;
      default:
        return;
    }
  }
}


async function testConnection(
  ctx: ExtensionCommandContext,
  config: ApproveConfig,
  getClient: (config: ApproveConfig) => SystemOneClient,
  policy: LoadedPolicy,
): Promise<void> {
  if (!isConfigured(config)) {
    ctx.ui.notify("pi-typesafe-approve: endpoint, model, and API key must all be set.", "error");
    return;
  }
  ctx.ui.notify("pi-typesafe-approve: testing the endpoint …", "info");
  try {
    const response = await getClient(config).ask({
      state: buildState("ls -la", ctx.cwd, policy.text),
      questions: buildQuestions(),
    });
    ctx.ui.notify(
      `pi-typesafe-approve: ${response.model ?? config.model} answered OK (${summarizeUsage(response.usage)}).`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(`pi-typesafe-approve: ${redact(message(error), resolveApiKeySafe(config))}`, "error");
  }
}

async function runManualTest(
  command: string,
  ctx: ExtensionCommandContext,
  deps: {
    getConfig(): ApproveConfig;
    getClient(config: ApproveConfig): SystemOneClient;
    cwd(): string;
    policy(): LoadedPolicy;
  },
): Promise<void> {
  if (!command) {
    command = (await ctx.ui.input("Command to check", "rm -rf node_modules")) ?? "";
    if (!command) return;
  }
  const config = deps.getConfig();
  if (!isConfigured(config)) {
    ctx.ui.notify("pi-typesafe-approve: endpoint, model, and API key must all be set.", "error");
    return;
  }
  try {
    const response = await deps.getClient(config).ask({
      state: buildState(command, deps.cwd(), deps.policy().text),
      questions: buildQuestions(),
    });
    const decision = decide(response, config);
    ctx.ui.notify(
      `pi-typesafe-approve: ${decision.verdict} ${JSON.stringify(decision.signals)}` +
        `${decision.reasons.length ? ` — ${decision.reasons.join("; ")}` : ""}`,
      decision.verdict === "allow" ? "info" : "warning",
    );
  } catch (error) {
    ctx.ui.notify(`pi-typesafe-approve: ${redact(message(error), resolveApiKeySafe(config))}`, "error");
  }
}


/**
 * Show the exact policy text the model receives, plus anything about its
 * expansion the user should know: unresolved `${NAME}` references, and bare
 * `$word` forms that this syntax deliberately does not expand.
 */
function showPolicy(ctx: ExtensionCommandContext, loaded: LoadedPolicy): void {
  const notes: string[] = [`policy file: ${loaded.path}`];
  if (loaded.created) notes.push("created on first run from the built-in default");
  if (loaded.fallback) notes.push("unreadable; using the built-in default in memory");
  if (loaded.unresolved.length > 0) {
    notes.push(`unresolved, left as written: ${loaded.unresolved.join(", ")}`);
  }
  if (loaded.bare.length > 0) {
    notes.push(
      `not expanded, this syntax needs braces: ${loaded.bare.map((n) => `$${n}`).join(", ")}`,
    );
  }
  ctx.ui.notify(notes.join(" · "), loaded.fallback ? "warning" : "info");

  const text = loaded.text;
  ctx.ui.notify(text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text, "info");
}

// ── helpers ────────────────────────────────────────────────────────────────

function toGateUi(ctx: ExtensionContext): GateUi {
  return {
    hasUI: ctx.hasUI,
    confirm: (title, message) => ctx.ui.confirm(title, message),
    notify: (message, kind) => ctx.ui.notify(message, kind),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

function isConfigured(config: ApproveConfig): boolean {
  if (!config.model.trim()) return false;
  if (!resolveApiKey(config.apiKey).ok) return false;
  try {
    resolveEndpoint(config);
    return true;
  } catch {
    return false;
  }
}

function endpointLine(config: ApproveConfig): string {
  let endpoint = "(no endpoint configured)";
  try {
    endpoint = resolveEndpoint(config);
  } catch {
    // Keep the placeholder.
  }
  return `${endpoint} · model ${config.model || "(unset)"}`;
}


/** How the key resolves, and a note when it looks like a variable but is literal. */
function describeKey(apiKey: string, envReferences: readonly string[]): string {
  if (!apiKey) return "(unset)";
  if (envReferences.length > 0) return `\${${envReferences[0]}}`;
  const warning = apiKeyBareReferenceWarning(apiKey);
  return warning ? `literal (! ${warning})` : "literal";
}

function statusLine(loaded: LoadedConfig, policy: LoadedPolicy): string {
  const config = loaded.config;
  const keyEnv = apiKeyEnvReferences(config.apiKey);
  return [
    `enabled=${config.enabled}`,
    endpointLine(config),
    `key=${describeKey(config.apiKey, keyEnv)}`,
    `danger>=${config.thresholds.danger} policy>=${config.thresholds.policy}`,
    `action=${config.action} noUiFallback=${config.noUiFallback} failMode=${config.failMode}`,
    `policy=${policy.path}${policy.created ? " (created)" : ""}${policy.fallback ? " (built-in default)" : ""}`,
    `config=${loaded.path}`,
  ].join(" · ");
}

function summarizeUsage(
  usage: { input_tokens?: number; cost?: number } | undefined,
): string {
  if (!usage) return "no usage reported";
  const parts: string[] = [];
  if (usage.input_tokens !== undefined) parts.push(`${usage.input_tokens} input tokens`);
  if (usage.cost !== undefined) parts.push(`$${usage.cost.toFixed(6)}`);
  return parts.join(", ") || "no usage reported";
}

function resolveApiKeySafe(config: ApproveConfig): string | undefined {
  const resolved = resolveApiKey(config.apiKey);
  return resolved.ok ? resolved.key : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

