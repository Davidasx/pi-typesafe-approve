/**
 * Expansion for text in the policy file.
 *
 * Three forms, and nothing else:
 *
 * | Written | Meaning |
 * |---|---|
 * | `${NAME}` | the environment variable `NAME`, if set and non-empty |
 * | `$(pwd)` / `$(pwd -P)` | the session's working directory |
 * | every other `$` | a literal `$` |
 *
 * ## Why `pwd` is a special case and not a shell
 *
 * `$(pwd -P)` cannot be handed to a real shell. This text is file content that
 * the extension creates itself on first run, expansion runs on paths that only
 * *display* it (logging, the settings screen, reporting unresolved references),
 * and "reading a config file runs code" is not a property to introduce into a
 * security check. So `pwd` is recognised as one of two exact strings and answered
 * with a value the process already holds: `process.cwd()` is the physical path,
 * which is what `pwd -P` returns. Nothing is executed, no other command name is
 * recognised, and `$(…)` with anything else is left as written.
 *
 * Requiring the braces on `${NAME}` means no escape syntax is needed at all:
 * `$$`, `$5`, and `$HOME` all mean exactly what they look like, and there is no
 * ambiguity about where a name ends.
 *
 * Case carries no meaning for `${NAME}`: `${HOME}` and `${home}` both name
 * environment variables.
 *
 * An unresolvable reference is left exactly as written, so a typo stays visible
 * in the output instead of silently collapsing to nothing. Callers can report the
 * leftovers with {@link findReferences}, {@link findUnresolved} and
 * {@link findUnsupported}.
 */

export interface ExpandOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** The working directory `$(pwd)` resolves to. */
  cwd?: string;
}

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
/** A bare `$word` that the user may have expected to expand. */
const BARE_REFERENCE = /\$([A-Za-z_][A-Za-z0-9_]*)/gu;
/** Exactly the two command forms that are answered from local state. */
const PWD = /\$\(\s*pwd(?:\s+-P)?\s*\)/gu;
/**
 * The name that also means "the working directory".
 *
 * `${PWD}` is a shell variable, so reading it from the environment would give the
 * *logical* path — whatever string the shell was told — which can differ from the
 * physical one whenever a symlink is involved. Since this is documented as another
 * way to write `$(pwd -P)`, both resolve to the same physical value.
 */
const PWD_NAMES = new Set(["PWD"]);

/** Any `$(…)` at all, so the ones that are not `pwd` can be reported. */
const COMMAND = /\$\([^)]*\)/gu;

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
  return [
    ...new Set(findReferences(text).filter((name) => !env[name] && !PWD_NAMES.has(name))),
  ];
}

/**
 * Bare `$word` occurrences, which this syntax does not expand.
 *
 * Used only to warn: a user who wrote `$HOME` out of habit gets told to write
 * `${HOME}`, instead of silently getting a literal `$HOME`.
 */
export function findBareReferences(text: string): string[] {
  // `${FOO}` cannot match: the `$` there is followed by `{`, not a letter.
  const found: string[] = [];
  for (const match of text.matchAll(BARE_REFERENCE)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return [...new Set(found)];
}

/**
 * `$(…)` fragments that are not the one supported command.
 *
 * Returned so a policy that reaches for `$(date)` or `$(git rev-parse HEAD)` is
 * told that nothing was substituted, rather than silently carrying the literal
 * text into a prompt.
 */
export function findUnsupported(text: string): string[] {
  const supported = new Set([...text.matchAll(PWD)].map((match) => match[0]));
  return [...new Set([...text.matchAll(COMMAND)].map((match) => match[0]))].filter(
    (fragment) => !supported.has(fragment),
  );
}

export function expandVariables(
  text: string,
  options: ExpandOptions = {},
): string {
  const env = options.env ?? {};
  const cwd = options.cwd;
  const withPwd = cwd === undefined ? text : text.replace(PWD, () => cwd);
  return withPwd.replace(REFERENCE, (original, name: string) => {
    // `${PWD}` is another spelling of the working directory, so it answers from the
    // same value as `$(pwd -P)` rather than from the environment.
    if (cwd !== undefined && PWD_NAMES.has(name)) return cwd;
    const value = env[name];
    return value === undefined || value === "" ? original : value;
  });
}
