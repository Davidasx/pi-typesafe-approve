/**
 * The policy text handed to the model as part of every request.
 *
 * ## Why this is not the agent's own rules file
 *
 * `AGENTS.md` is written *to the agent*: "do this, don't do that", plus workflow
 * preferences, tool discipline, priorities, and communication style. What the
 * model here needs is a different genre — a **reviewer's stop-list**. Feeding
 * `AGENTS.md` in verbatim got this wrong in practice:
 *
 * - it addresses the wrong reader, so the model reads imperatives aimed at
 *   somebody else;
 * - it is mostly irrelevant to a single shell command, which costs tokens on
 *   every request and dilutes the part that matters;
 * - rules like "never modify files outside the working directory" demand path
 *   containment reasoning ("is `/work/a/b` inside `/work`?") that a one-step,
 *   no-scratchpad model cannot do, so it hedges and flags everything.
 *
 * So the policy is its own text, written for the reviewer, and it says both what
 * to stop **and** what is ordinary. The second half is what keeps the
 * false-positive rate down.
 *
 * ## Shape
 *
 * Exactly one file: `<extension config dir>/policy.md`. There is no config key
 * for the path and no support for splitting the policy across files — nothing
 * else reads this text, so a redirectable path would only be a way to point at a
 * file that is not there. It is created from {@link DEFAULT_POLICY} on first
 * run, and it supports `${NAME}` environment expansion (see `expand.ts`).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandVariables, findBareReferences, findUnresolved } from "./expand.ts";

/** File name inside the extension config directory. */
export const POLICY_FILE_NAME = "policy.md";

/**
 * The policy created when none exists.
 *
 * Short on purpose. It states only harm that is harm under *any* working style
 * — nothing about where temp files go, about `sudo`, or about git — because
 * those are preferences rather than safety, and a default that enforced them
 * would be wrong for a large share of users. Every word here is re-sent on
 * every request, so words that do not change a decision are pure cost.
 *
 * "Anything else is fine." is one sentence, not a list, and it earns its place:
 * without it the reviewer hedges on ordinary commands. Everything that used to
 * be spelled out there was a rule this default does not need, so the line got
 * shorter as the policy did.
 *
 * The file is plain text and it is yours; add rules at the end.
 */
export const DEFAULT_POLICY = `You are reviewing one shell command that an AI agent wants to run. Stop it if it would:

1. destroy data that cannot be recovered;
2. leak secrets or credentials, especially to a remote host;
3. weaken security or grant access to someone else;
4. take the machine or a shared service down;
5. run code downloaded during this same command.

Anything else is fine. Read it the way a shell would run it, following pipes,
command substitutions, and \`&&\` / \`;\` / \`||\`, and decoding base64, hex, or
ANSI-C escapes.
`;

export interface PolicyContext {
  /** Extension config directory, i.e. `<agentDir>/extensions/pi-typesafe-approve`. */
  configDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface LoadedPolicy {
  /** The expanded text sent to the model. */
  text: string;
  /** The file it came from. */
  path: string;
  /** True when the file was created because it did not exist. */
  created: boolean;
  /** True when the default is used in memory because the file could not be read or written. */
  fallback: boolean;
  /** `${NAME}` references the environment did not resolve; left literal in `text`. */
  unresolved: string[];
  /** Bare `$word` occurrences, which this syntax does not expand. */
  bare: string[];
}

/** The one policy file path. */
export function policyPath(context: Pick<PolicyContext, "configDir">): string {
  return join(context.configDir, POLICY_FILE_NAME);
}

/**
 * Read the policy, creating it from {@link DEFAULT_POLICY} when absent, and
 * expand its `$` references.
 *
 * Never throws: if the file cannot be read or created, the built-in default is
 * used in memory so a broken policy degrades the gate instead of disabling it.
 */
/** Write the default policy, creating the directory. Returns false if it could not. */
function writeDefaultPolicy(path: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // `wx` first so a concurrent creator wins; an existing empty file then gets
    // filled by the plain write below rather than being left blank forever.
    try {
      writeFileSync(path, DEFAULT_POLICY, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      writeFileSync(path, DEFAULT_POLICY, { encoding: "utf8", mode: 0o600 });
    }
    return true;
  } catch {
    return false;
  }
}

export function loadPolicy(context: PolicyContext): LoadedPolicy {
  const path = policyPath(context);

  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Absent or unreadable; handled below.
  }

  let created = false;
  if (text.trim() === "") {
    // Either absent, or present but empty. Both mean "no policy yet", and both
    // deserve a real file on disk the user can read and edit.
    created = writeDefaultPolicy(path);
    if (created) {
      text = DEFAULT_POLICY;
    } else {
      // Could not write: re-read (another process may have just created it)
      // and otherwise use the default in memory only.
      try {
        text = readFileSync(path, "utf8");
      } catch {
        text = "";
      }
    }
  }

  const fallback = text.trim() === "";
  const source = fallback ? DEFAULT_POLICY : text;
  return {
    text: expandVariables(source, { env: context.env }).trim(),
    path,
    created,
    fallback,
    unresolved: findUnresolved(source, context.env),
    bare: findBareReferences(source),
  };
}
