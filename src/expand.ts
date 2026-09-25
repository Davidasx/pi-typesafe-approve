/**
 * `${NAME}` expansion for the policy file.
 *
 * Exactly one rule:
 *
 * - `${NAME}`, where `NAME` is `[A-Za-z_][A-Za-z0-9_]*`, is replaced by the
 *   environment variable of that name, if it is set and non-empty;
 * - **every other `$` is a literal `$`.**
 *
 * Requiring the braces buys two things. A bare `$` in ordinary prose stays
 * literal, so no escape syntax is needed at all — `$$`, `$5`, and `$HOME` all
 * mean exactly what they look like. And there is no ambiguity about where a name
 * ends, which the bare form has to guess at.
 *
 * Case carries no meaning: `${HOME}` and `${home}` both name environment
 * variables. There is deliberately **no** built-in set of dynamic values such as
 * `${cwd}`. Facts like the working directory are structured fields on the
 * request `state` (`{command, working_directory, review_policy}`), so the model
 * receives them exactly; repeating them inside the prose would be duplicate
 * information and a second thing for this extension to maintain. The environment
 * is the one expansion that earns its place, because it is already how a machine
 * names things a policy might want to mention — `$HOME`, `$PI_TMPDIR`, and
 * whatever else the user exports.
 *
 * Also deliberately not supported: `$(command)` or backticks. Running a shell
 * command read out of a config file would make editing it code execution.
 *
 * An unresolvable `${NAME}` is left exactly as written, so a typo stays visible
 * in the text instead of silently collapsing to nothing. Callers can report the
 * leftovers with {@link findReferences} and {@link findUnresolved}.
 */

export interface ExpandOptions {
  env?: Readonly<Record<string, string | undefined>>;
}

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
/** A bare `$word` that the user may have expected to expand. */
const BARE_REFERENCE = /\$([A-Za-z_][A-Za-z0-9_]*)/gu;

/** Every `${NAME}` in a text, in order and including duplicates. */
export function findReferences(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

/** `${NAME}` references that the environment does not resolve. */
export function findUnresolved(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return [...new Set(findReferences(text).filter((name) => !env[name]))];
}

/**
 * Bare `$word` occurrences, which this syntax does not expand.
 *
 * Used only to warn: a user who wrote `$HOME` out of habit gets told to write
 * `${HOME}`, instead of silently getting a literal `$HOME` in the policy.
 */
export function findBareReferences(text: string): string[] {
  // `${FOO}` cannot match: the `$` there is followed by `{`, not a letter.
  const found: string[] = [];
  for (const match of text.matchAll(BARE_REFERENCE)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return [...new Set(found)];
}

export function expandVariables(
  text: string,
  options: ExpandOptions = {},
): string {
  const env = options.env ?? {};
  return text.replace(REFERENCE, (original, name: string) => {
    const value = env[name];
    return value === undefined || value === "" ? original : value;
  });
}
