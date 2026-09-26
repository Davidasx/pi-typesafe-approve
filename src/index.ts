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
import { writeFileSync } from "node:fs";
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
import { createApproveMenu, type ApproveMenuState } from "./menu.ts";
import { runMenu } from "@narumitw/pi-tui-kit";
import { createGate, type GateUi } from "./gate.ts";
import { createFileLogger, trimLogFile, type DecisionLogger } from "./log.ts";
import { DEFAULT_POLICY, loadPolicy, policyPath, type LoadedPolicy } from "./policy.ts";
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

  const menuState = (): ApproveMenuState => ({
    config: loaded.config,
    policy,
    paths: { config: file, policy: policyPath(policyContext), log: logPath(agentDir) },
    configured: isConfigured(loaded.config),
  });

  /** Replace the policy file's contents and pick the change up immediately. */
  const writePolicyFile = (text: string): void => {
    writeFileSync(policyPath(policyContext), text, { encoding: "utf8", mode: 0o600 });
    reload();
  };

  const menuDeps = {
    getState: menuState,
    update: (patch: Partial<ApproveConfig>) => persist({ ...loaded.config, ...patch }),
    reloadFromDisk: () => reload(),
    writePolicy: writePolicyFile,
    restoreDefaultPolicy: () => writePolicyFile(DEFAULT_POLICY),
    connectionReport: () => connectionReport(),
  };

  /** One line describing whether the endpoint answers. Shared with the menu. */
  async function connectionReport(): Promise<string> {
    const config = loaded.config;
    if (!isConfigured(config)) {
      return "pi-typesafe-approve: endpoint, model, and API key must all be set.";
    }
    try {
      const client = getClient(config);
      const started = Date.now();
      const response = await client.ask({
        state: buildState("ls -la", sessionCwd, policy.text),
        questions: buildQuestions(),
      });
      return `pi-typesafe-approve: ${response.model ?? config.model} answered OK in ${Date.now() - started} ms (${summarizeUsage(response.usage)}).`;
    } catch (error) {
      return `pi-typesafe-approve: ${redact(message(error), resolveApiKeySafe(config))}`;
    }
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

      await runMenu(ctx, createApproveMenu(menuDeps), {
        getState: menuState,
        onUnsupportedMode: (unsupported, mode) =>
          unsupported.ui.notify(
            `pi-typesafe-approve: the settings screen needs TUI or RPC mode (this is ${mode}). Use /typesafe-approve status, on, off, policy, or test <command>.`,
            "info",
          ),
      });
    },
  });
}

// ── command flows ──────────────────────────────────────────────────────────

/** One line describing the endpoint, for status output and for the menu. */
function endpointLine(config: ApproveConfig): string {
  let endpoint = "(no endpoint configured)";
  try {
    endpoint = resolveEndpoint(config);
  } catch {
    // Keep the placeholder.
  }
  return `${endpoint} · model ${config.model || "(unset)"}`;
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

function describeKey(apiKey: string, envReferences: readonly string[]): string {
  if (!apiKey) return "(unset)";
  if (envReferences.length > 0) return `\${${envReferences[0]}}`;
  const warning = apiKeyBareReferenceWarning(apiKey);
  return warning ? `literal (! ${warning})` : "literal";
}

/** Print the exact policy text the model receives, with its expansion notes. */
function showPolicy(ctx: ExtensionCommandContext, loaded: LoadedPolicy): void {
  const notes: string[] = [`policy file: ${loaded.path}`];
  if (loaded.created) notes.push("created on first run from the built-in default");
  if (loaded.fallback) notes.push("unreadable; using the built-in default in memory");
  if (loaded.unresolved.length > 0) notes.push(`unresolved, left as written: ${loaded.unresolved.join(", ")}`);
  if (loaded.bare.length > 0) {
    notes.push(`not expanded, this syntax needs braces: ${loaded.bare.map((n) => `$${n}`).join(", ")}`);
  }
  ctx.ui.notify(notes.join(" · "), loaded.fallback ? "warning" : "info");

  const text = loaded.text;
  ctx.ui.notify(text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text, "info");
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

function summarizeUsage(usage: { input_tokens?: number; cost?: number } | undefined): string {
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
