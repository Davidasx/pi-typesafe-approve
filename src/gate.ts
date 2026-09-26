/**
 * The `tool_call` gate.
 *
 * ## Why a `tool_call` handler instead of re-registering the Bash tool
 *
 * Pi's extension API offers two ways to stand between the model and a shell
 * command: replace the `bash` tool with `pi.registerTool()`, or attach a
 * handler to the `tool_call` event. This extension uses the event, for four
 * reasons:
 *
 * 1. **`tool_call` is the designated gate.** Pi fires it before execution and
 *    documents that it "can mutate input or block execution". It exists exactly
 *    for permission checks, and the shipped `permission-gate` and
 *    `protected-paths` examples use it for exactly that.
 * 2. **Re-registering means reimplementing.** The built-in Bash tool owns
 *    process spawning, streaming output, timeouts, output truncation, the file
 *    mutation queue, abort handling, and its result renderer. A replacement has
 *    to reproduce all of it and then track upstream changes forever, for no gain
 *    — the gate makes no change to how a command runs.
 * 3. **Gates compose; replacements do not.** Several extensions can each
 *    register a `tool_call` handler and all of them run, in load order. A
 *    re-registered tool would shadow the built-in one instead of layering on it.
 * 4. **The safety direction is right.** A handler can only *add* a block. It
 *    cannot un-block a command another handler refused, so this soft,
 *    probabilistic gate can never weaken a hard policy gate such as
 *    pi-permission-system sitting beside it.
 *    violates the stated review policy?
 * ## What this gate does
 *
 * 1. If the gate is off, the tool is not `bash`, or the endpoint is not
 *    configured, nothing happens at all.
 * 2. Otherwise ask the model, and cache the verdict by request hash.
 * 3. `allow` → return nothing, and the command runs as it would have.
 * 4. Flagged → `monitor` reports and allows; `escalate` asks the human, or
 *    follows `noUiFallback` when there is nobody to ask; `block` blocks.
 * 5. Model unreachable → `failMode`, defaulting to `open`, because this layer
 *    is a triage aid and must not be able to wedge the agent when the network is
 *    down. A hard policy gate next to it still applies.
 *
 * Note what is deliberately **not** here: a pattern allow/deny list. Hard
 * deterministic rules are the policy layer's job (pi-permission-system and
 * friends). Duplicating them would create a second, weaker policy surface that
 * drifts out of sync with the real one. This layer only answers the question a
 * rule engine cannot: does the command's *effect* look dangerous, and does it
 * violate the stated review policy?
 */

import { createHash } from "node:crypto";
import {
  blockedReason,
  buildQuestions,
  buildState,
  decide,
  signalsOf,
} from "./classify.ts";
import type { DecisionLogRecord, DecisionLogger } from "./log.ts";
import { SystemOneError } from "./systemone.ts";
import type {
  ApproveConfig,
  Decision,
  StructuredValue,
  SystemOneResponse,
} from "./types.ts";

/** The subset of Pi's `ToolCallEvent` this gate reads. */
export interface ToolCallLike {
  toolName: string;
  input: unknown;
}

/** The subset of Pi's `ToolCallEventResult` this gate returns. */
export type GateResult = { block: true; reason: string } | undefined;

/** A single decision-log write, with the outcome action already resolved. */
type LogAction = DecisionLogRecord["action"];
type LogExtra = Partial<DecisionLogRecord>;
type LogSink = (decision: Decision, action: LogAction, extra?: LogExtra) => void;

export interface GateUi {
  hasUI: boolean;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, kind?: "info" | "warning" | "error"): void;
  /** The active turn's abort signal, when there is one. */
  signal?: AbortSignal;
}

export interface GateDeps {
  getConfig(): ApproveConfig;
  /** The review policy text sent with every request. */
  getPolicy(): string;
  getCwd(): string;
  /**
   * Whether this configuration is usable. Takes the config rather than fetching
   * it, so one command is judged against one configuration object: the host may
   * re-read the file on change, and asking twice could straddle a change.
   */
  isConfigured(config: ApproveConfig): boolean;
  /** Perform one model request. Implemented by the extension host. */
  ask(
    request: { state: StructuredValue; questions: ReturnType<typeof buildQuestions> },
    signal: AbortSignal | undefined,
    config: ApproveConfig,
  ): Promise<SystemOneResponse>;
  logger: DecisionLogger;
  now?(): number;
}

export function createGate(deps: GateDeps) {
  const cache = new Map<string, Decision>();
  /** Last time a fail-open warning was shown, to avoid one notice per command. */
  let lastDegradedNotice = 0;

  const now = (): number => deps.now?.() ?? Date.now();

  function cacheGet(key: string): Decision | undefined {
    const hit = cache.get(key);
    if (hit === undefined) return undefined;
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  function cacheSet(key: string, decision: Decision, limit: number): void {
    if (limit <= 0) return;
    cache.set(key, decision);
    while (cache.size > limit) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  return async function gate(event: ToolCallLike, ui: GateUi): Promise<GateResult> {
    // The tool and command checks come first so that reading the configuration —
    // which stats the file to notice changes — only happens for a Bash call that
    // actually has something to judge.
    if (event.toolName !== "bash") return undefined;
    const command = readCommand(event.input);
    if (!command) return undefined;

    // Read the configuration once, and use this one object for the whole
    // decision, so a change on disk cannot be half-applied to a single command.
    const config = deps.getConfig();
    if (!config.enabled) return undefined;

    // A globally installed but unconfigured gate is inert: no model calls, no
    // warnings per command. `session_start` says so once per session instead.
    if (!deps.isConfigured(config)) {
      deps.logger.debug("gate.not-configured", { command });
      return undefined;
    }

    const cwd = deps.getCwd();
    const log: LogSink = (decision, action, extra = {}) => {
      if (!config.logDecisions) return;
      deps.logger.record({
        time: new Date(now()).toISOString(),
        command,
        cwd,
        verdict: decision.verdict,
        action,
        reasons: decision.reasons,
        signals: decision.signals,
        ...(decision.model ? { model: decision.model } : {}),
        ...(decision.usage ? { usage: decision.usage } : {}),
        ...(decision.cached ? { cached: true } : {}),
        ...(decision.degraded ? { degraded: decision.degraded } : {}),
        ...extra,
      });
    };
    const state = buildState(command, cwd, deps.getPolicy());
    const questions = buildQuestions();
    const cacheKey = hashRequest(config, state);
    const cached = cacheGet(cacheKey);
    if (cached) {
      const decision: Decision = { ...cached, cached: true };
      return finish(
        decision,
        decision.verdict === "allow" ? "allow" : escalationAction(config, ui),
        command,
        config,
        ui,
        log,
      );
    }

    const started = now();
    let response: SystemOneResponse;
    try {
      deps.logger.debug("gate.request", { cacheKey });
      response = await deps.ask({ state, questions }, ui.signal, config);
    } catch (error) {
      const degraded = error instanceof SystemOneError && error.kind === "timeout" ? "timeout" : "error";
      const reason = error instanceof Error ? error.message : String(error);
      const decision: Decision = {
        verdict: config.failMode === "closed" ? "escalate" : "allow",
        reasons: [`model unavailable (${degraded}): ${reason}`],
        signals: {},
        degraded,
      };
      if (config.failMode === "closed") {
        return finish(decision, "block", command, config, ui, log, { durationMs: now() - started });
      }
      log(decision, "fail-open", { durationMs: now() - started });
      const sinceNotice = now() - lastDegradedNotice;
      if (sinceNotice > 60_000) {
        lastDegradedNotice = now();
        ui.notify(
          `pi-typesafe-approve: the risk model is unreachable (${degraded}), so commands run unchecked. ${reason}`,
          "warning",
        );
      }
      return undefined;
    }

    const decision = decide(response, config);
    cacheSet(cacheKey, decision, config.cacheSize);

    return finish(
      decision,
      decision.verdict === "allow" ? "allow" : escalationAction(config, ui),
      command,
      config,
      ui,
      log,
      { durationMs: now() - started },
    );
  };

  /**
   * Apply the configured action for a flagged command, and write exactly one
   * log entry with the outcome that actually happened.
   */
  async function finish(
    decision: Decision,
    action: EscalationAction,
    command: string,
    config: ApproveConfig,
    ui: GateUi,
    log: LogSink,
    extra: LogExtra = {},
  ): Promise<GateResult> {
    if (action === "allow") {
      log(decision, "allow", extra);
      return undefined;
    }

    const summary = signalsOf(decision);

    if (action === "monitor" || action === "allow-no-ui") {
      const why = action === "monitor" ? "monitor" : "escalate, no UI to ask";
      ui.notify(`pi-typesafe-approve (${why}): ${summary} — ${oneLine(command)}`, "warning");
      log(decision, action === "monitor" ? "monitor" : "no-ui-allow", extra);
      return undefined;
    }

    if (action === "prompt") {
      const approved = await ui.confirm(
        "Run this command?",
        [
          `Command: ${command}`,
          `Signals: ${summary || "unknown"}`,
          `Triggers: ${decision.reasons.join("; ") || "n/a"}`,
        ].join("\n"),
      );
      log(decision, approved ? "allow" : "block", extra);
      return approved
        ? undefined
        : { block: true, reason: "The user declined this command at the pi-typesafe-approve risk check." };
    }

    log(decision, "block", extra);
    return { block: true, reason: blockedReason(decision, command) };
  }
}

/**
 * The resolved behavior for a flagged command.
 *
 * `action` is the user's intent and `noUiFallback` only refines the case where
 * `escalate` has nobody to ask. The two are not redundant: `escalate` with a UI
 * prompts, `monitor` never prompts even with one, and `block` never prompts and
 * ignores `noUiFallback`.
 */
export type EscalationAction =
  | "allow"
  | "prompt"
  | "block"
  | "monitor"
  | "allow-no-ui";

export function escalationAction(
  config: ApproveConfig,
  ui: Pick<GateUi, "hasUI">,
): EscalationAction {
  if (config.action === "monitor") return "monitor";
  if (config.action === "block") return "block";
  if (ui.hasUI) return "prompt";
  return config.noUiFallback === "allow" ? "allow-no-ui" : "block";
}

/** Collapse a possibly multi-line command into one bounded log/prompt line. */
function oneLine(value: string): string {
  const single = value.replace(/\s+/gu, " ").trim();
  return single.length > 160 ? `${single.slice(0, 160)}…` : single;
}


function readCommand(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  return trimmed.length > 0 ? command : undefined;
}

function hashRequest(config: ApproveConfig, state: StructuredValue): string {
  // The endpoint and model are part of the key because a different model can
  // legitimately answer the same state differently.
  const material = JSON.stringify({
    endpoint: config.endpoint ?? "",
    baseUrl: config.baseUrl,
    path: config.path,
    model: config.model,
    state,
  });
  return createHash("sha256").update(material).digest("hex");
}
