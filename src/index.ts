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
import { statSync, writeFileSync } from "node:fs";
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
  shouldAdoptConfig,
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

  const policyContext = {
    configDir: configDir(agentDir),
    env: process.env,
  };

  /**
   * The policy is read when it is needed and never cached.
   *
   * It is a few KB, read once per command, next to a network round trip — the read
   * is free by comparison, and not caching it means a policy edit is live at the
   * next command with no watching, no mtime checks, and no way to be stale. The
   * worst case of catching the file mid-write is that one command is judged by the
   * built-in default, and the file is never written to, so nothing is lost.
   */
  const readPolicy = (): LoadedPolicy => loadPolicy(policyContext);

  /**
   * An identity for the config file, so a change made outside Pi can be noticed.
   *
   * Cheap enough to check on every command (one `stat`), and unlike a watcher it
   * cannot miss an event or need a polling fallback or cleanup.
   */
  function configStamp(): string {
    try {
      const stat = statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "(absent)";
    }
  }
  let configStampNow = configStamp();
  /** Set when a re-read config was refused; surfaced once by the caller. */
  let configProblem: string | undefined;

  /**
   * The live configuration, re-reading the file when it has changed.
   *
   * External edits are adopted only when that cannot disarm the checker — see
   * {@link shouldAdoptConfig}. Edits made through the interface go through
   * {@link persist} instead, which adopts unconditionally because a deliberate
   * change from the settings screen must always take effect.
   */
  function getConfig(): ApproveConfig {
    const stamp = configStamp();
    if (stamp === configStampNow) return loaded.config;

    const candidate = loadConfig(file);
    const verdict = shouldAdoptConfig({
      current: loaded.config,
      currentUsable: isConfigured(loaded.config),
      candidateParsed: candidate.ok,
      candidate: candidate.config,
      candidateUsable: isConfigured(candidate.config),
    });
    if (verdict.adopt) {
      loaded = candidate;
      configProblem = undefined;
      logger.debug("config.reloaded", { path: file });
    } else {
      configProblem = `${file} changed but was not adopted: ${verdict.reason}`;
      logger.debug("config.refused", { path: file, reason: verdict.reason });
    }
    configStampNow = stamp;
    return loaded.config;
  }

  /** Config written by this extension: always adopted, because the user meant it. */
  function persist(config: ApproveConfig): void {
    saveConfig(file, config);
    loaded = { ok: true, config, path: file };
    configProblem = undefined;
    configStampNow = configStamp();
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
    config: getConfig(),
    policy: readPolicy(),
    paths: { config: file, policy: policyPath(policyContext), log: logPath(agentDir) },
    configured: isConfigured(getConfig()),
    configProblem,
  });

  const writePolicyFile = (text: string): void => {
    writeFileSync(policyPath(policyContext), text, { encoding: "utf8", mode: 0o600 });
  };

  const menuDeps = {
    getState: menuState,
    update: (patch: Partial<ApproveConfig>) => persist({ ...getConfig(), ...patch }),
    writePolicy: writePolicyFile,
    restoreDefaultPolicy: () => writePolicyFile(DEFAULT_POLICY),
    connectionReport: () => connectionReport(),
  };

  /** One line describing whether the endpoint answers. Shared with the menu. */
  async function connectionReport(): Promise<string> {
    const config = getConfig();
    if (!isConfigured(config)) {
      return "pi-typesafe-approve: endpoint, model, and API key must all be set.";
    }
    try {
      const client = getClient(config);
      const started = Date.now();
      const response = await client.ask({
        state: buildState("ls -la", sessionCwd, readPolicy().text),
        questions: buildQuestions(),
      });
      return `pi-typesafe-approve: ${response.model ?? config.model} answered OK in ${Date.now() - started} ms (${summarizeUsage(response.usage)}).`;
    } catch (error) {
      return `pi-typesafe-approve: ${redact(message(error), resolveApiKeySafe(config))}`;
    }
  }

  const gate = createGate({
    getConfig,
    getPolicy: () => readPolicy().text,
    getCwd: () => sessionCwd,
    isConfigured: () => isConfigured(getConfig()),
    ask: (request, signal) => getClient(getConfig()).ask(request, signal ? { signal } : {}),
    logger,
  });

  // ── lifecycle ────────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    sessionCwd = ctx.cwd;
    // Trim on startup too, so an oversized log is handled even in a session that
    // runs no shell commands.
    trimLogFile(logPath(agentDir));
    const started = readPolicy();
    logger.debug("session.start", { configPath: file, policyPath: started.path, policyCreated: started.created });

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
        showPolicy(ctx, readPolicy());
        return;
      }
      if (trimmed === "status" || trimmed === "path") {
        ctx.ui.notify(statusLine(getConfig(), readPolicy(), file), "info");
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
          policy: () => readPolicy(),
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

function statusLine(config: ApproveConfig, policy: LoadedPolicy, configFile: string): string {
  const keyEnv = apiKeyEnvReferences(config.apiKey);
  return [
    `enabled=${config.enabled}`,
    endpointLine(config),
    `key=${describeKey(config.apiKey, keyEnv)}`,
    `danger>=${config.thresholds.danger} policy>=${config.thresholds.policy}`,
    `action=${config.action} noUiFallback=${config.noUiFallback} failMode=${config.failMode}`,
    `policy=${policy.path}${policy.created ? " (created)" : ""}${policy.fallback ? " (built-in default)" : ""}`,
    `config=${configFile}`,
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
