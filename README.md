# pi-typesafe-approve

A Pi extension that auto-approves routine Bash commands using a **System One /
Jev decision model**, and escalates everything else to a human.

Jev does not generate text. It answers typed questions about a `state` you send
it and returns a probability for every option of a `choice`, plus a confidence.
That makes it a good fit for one specific job — a fast, cheap *triage* layer in
front of every shell command:

- routine commands (`ls`, `git status`, `npm ci`) pass without a prompt;
- commands the model flags — including obfuscated ones it decodes
  (`$'\x72\x6d' -rf /`, `echo … | base64 -d | sh`) — stop and go to you;
- when the model is unreachable, the gate does not wedge the agent.

Model endpoints, API keys, and models are **fully user-supplied**. There are no
provider presets, because the known deployments agree on the request body but
differ in endpoint path and model id, and those details move.

## Install

```bash
pi install git:github.com/Davidasx/pi-typesafe-approve
```

Then run `/typesafe-approve` to set the endpoint, model, and API key.

For development, a local checkout is loaded in place instead, so an edit is live
after `/reload` with no commit in between:

```bash
pi -e ./                 # try one checkout for a single invocation
pi install /path/to/pi-typesafe-approve
```

A git source is cloned and pinned, so it updates when you ask it to; a local path
is read from wherever it lives, so what you run is your working tree, uncommitted
changes included.

## Configuration

Config lives at `<agentDir>/extensions/pi-typesafe-approve/config.json`
(usually `~/.pi/agent/extensions/pi-typesafe-approve/config.json`) and is fully
editable from `/typesafe-approve`. Every key is optional.
See [`config.example.json`](./config.example.json).

Model decisions are logged to `decisions.jsonl` beside the config (mode `0600`).
The file is capped at 20 MB: when it passes that, the newest 10 MB is kept and
the rest is dropped, cut at a record boundary and swapped in atomically. Both
numbers are fixed in code — retention is not a decision worth a config key. At
~3 KB per entry that is about 3400 entries of history, refilled every ~3400
commands, and the trim reads only the 10 MB it keeps rather than the whole file.

### Endpoint

One field, the whole request URL:

```jsonc
"endpoint": "https://api.typesafe.ai/v1/systemone",
"model": "jev-latest",
```

One value rather than a base plus a path: every deployment differs in both, they
are never set independently, and splitting them would only add a precedence rule
to remember.

Known deployments, as of September 2026:

| Deployment | `endpoint` | `model` |
|---|---|---|
| TypeSafe official | `https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| OpenRouter, Decisions API | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` |
| OpenRouter, System One API | `https://openrouter.ai/api/v1/systemone` | `typesafe/jev-1.13` |
| OpenJEV | `https://api.openjev.sh/v1/systemone` | `openjev` |
| A local relay (von / laya / edgejev) | your host and path | your model |

The two OpenRouter surfaces differ exactly here: the **Decisions API** lives on
`/api/alpha/decisions` and names the model `~typesafe/jev-latest`, while the
**System One API** lives on `/api/v1/systemone` and names it
`typesafe/jev-1.13`. The request body (`model`, `state`, `questions`) and the
response body (`answers`, `usage`) are the same on both, and on TypeSafe and
OpenJEV too, so no code path is provider-specific — only these two strings
change.

### API key

`apiKey` is either **entirely** a literal or **entirely** one `${NAME}` reference:

```jsonc
"apiKey": "${TYPESAFE_API_KEY}"   // read the environment variable
"apiKey": "sk-live-abc123"        // a literal key
```

The braces are required. `"$TYPESAFE_API_KEY"` without them is taken at face
value and sent as the literal bearer token `$TYPESAFE_API_KEY` — the same rule
`policy.json` uses, with no second guessing. One syntax, stated here and in the
config comment: if a value starts with `$` and is not `${NAME}`, it is a literal.

The failure is opaque, so it is also made visible: `/typesafe-approve status`
reports `key=literal (! looks like a variable but is not ${TYPESAFE_API_KEY})`.
The bare form is the one mistake this design can produce, and it surfaces in
`status` rather than in a mystery 401.

An unset or empty `${NAME}` *is* an error, not an empty bearer token, because a
braced reference is unambiguous. The key is never written to the log, never
included in an error message, and never prefilled into a dialog.

### Decision policy

```jsonc
{
  "thresholds": { "violation": 0.3 },
  "action": "escalate",
  "noUiFallback": "block",
  "failMode": "open"
}
```

One question. The model picks the single category from `policy.json` that best
describes the command, and the verdict is the **summed probability of every
category that is not positive**:

| | |
|---|---|
| `violation` | the summed probability that the command does one of the things you stop |
| stop when | `violation >= thresholds.violation` |
| the threshold | 0.3 by default |

Summing rather than reading the top category matters: a command can be split
across two violations at 0.4 each with nothing individually over the line, and
that is still more violation mass than a 0.5/0.5 split with ordinary work.

Measured on 16 commands against the live model, the two groups do not overlap
much: violations came back at **1.00** and ordinary work at **0.00–0.01**, so any
threshold from 0.3 to 0.7 gives the same verdicts. The threshold is a knob for
taste, not a delicate tuning parameter.

`action` decides what crossing a threshold means:

| `action` | Behavior |
|---|---|
| `escalate` | Ask the user in the TUI; with no UI to ask, follow `noUiFallback`. Default. |
| `monitor` | Report the finding but let the command run. Never prompts. Good for tuning thresholds. |
| `block` | Block outright, never prompting. Ignores `noUiFallback`. |

`noUiFallback` refines `escalate` for the headless cases — print/JSON mode and
subagents, where `hasUI` is false and there is nobody to ask:

| `noUiFallback` | Behavior |
|---|---|
| `block` | Block the command. Default, and the safe choice. |
| `allow` | Report the finding and let the command run, the same as `monitor`. |

These are two genuinely different axes, not one knob spelled twice: `escalate`
with a UI *prompts*, `monitor` never prompts even with a UI, and `block` ignores
`noUiFallback` entirely.

`failMode` decides what happens when the model cannot be reached:

| `failMode` | Behavior |
|---|---|
| `open` | The command runs, and the user is warned once per minute. Default. |
| `closed` | The command is blocked with the network error attached. |

`open` is the default because this is a triage aid layered on top of a policy
gate, and it must not be able to stall an agent whenever the network is down. A
hard policy extension beside it still applies either way.

#### No pattern rules here, on purpose

This extension has no allow/deny pattern list. Hard deterministic rules are the
policy layer's job — pi-permission-system already does that well, with path
patterns, whole-command policies, and a richer escape hatch. Re-implementing a
weaker version of it here would create a second policy surface that drifts out
of sync with the real one, and would invite putting a security rule in a place
whose whole premise is "the model might be wrong".

Rules that must hold belong in the policy layer, where a bug cannot be a
probability. This layer only answers the question a rule engine cannot: does
the command's *effect* look dangerous, and does it violate the stated policy?

### Policy: the categories the model chooses between

One JSON file, `<extension config dir>/policy.json`, created from the built-in
categories on first run. Each category has an `id`, a `polarity`, what it covers,
and optional `examples`:

```json
{
  "categories": [
    {
      "id": "secret_exposure",
      "polarity": "negative",
      "what": "Reads, prints, copies, or transmits a credential, private key, token, ...",
      "examples": ["cat ~/.ssh/id_ed25519", "env | sort"]
    },
    {
      "id": "permission_tightened",
      "polarity": "positive",
      "what": "Makes a file less accessible than it was, on a path already the user's: chmod 600 or 700. This is a safety improvement.",
      "examples": ["chmod 600 ~/.ssh/id_ed25519"]
    }
  ]
}
```

- **`negative`** means doing this must stop the command.
- **`positive`** means the command may run.
- **A category with no `polarity` counts as negative.** Forgetting the field can
  never weaken the check.
- **At least one positive category is required**, otherwise every command would be
  a violation and the file is rejected with that reason.

`${NAME}` is replaced by the environment variable `NAME` if it is set, in `what`
and in every example — which is how a category names your real home directory
without hard-coding it.

#### The state the model sees

`state` is what the request carries about the command. The default is three
fields and no more:

```json
"state": {
  "context": "One shell command that an AI coding agent wants to run ...",
  "command": "${command}",
  "working_directory": "$(pwd -P)"
}
```

Add whatever else the model needs to read your categories correctly. On a machine
where scratch files have a designated home, naming it turns "put scratch files in
the scratch directory" from prose into a fact:

```json
"state": {
  "context": "...",
  "command": "${command}",
  "working_directory": "$(pwd -P)",
  "scratch_directory": "${PI_TMPDIR}",
  "home": "${HOME}"
}
```

Values are flat strings. Three substitutions happen, and nothing else:

| Written | Becomes |
|---|---|
| `${NAME}` | the environment variable `NAME`, if set and non-empty |
| `${command}` | the command being judged, always, whatever the environment says |
| `$(pwd)` / `$(pwd -P)` | the session's working directory |

`$(…)` with any other command is **not** executed and is rejected at load with
the fragment named. Handing config text to a shell would make editing
`policy.json` equivalent to running code, and expansion also runs on paths that
only display it. `pwd` is answered from `process.cwd()`, which is already the
physical path `pwd -P` would print, so the common case works without a shell.

A template with no `${command}` anywhere is rejected: the command would never
reach the model, and the extension would be judging nothing.

#### Why polarities, and not exceptions in prose

A rule and its exception in the same sentence do not work. "Absolute paths need
approval, but tightening permissions on a file that is already yours is not this
violation" still stops `chmod 600 ~/.ssh/id_ed25519`: the same three tokens —
`chmod`, an absolute path, `~/.ssh` — appear in both halves, and lexical overlap
beats the negation.

A separate **positive** category for the exception fixes it. The model never has
to reason about a negation; it picks between two descriptions that are each true
on their own, and `chmod 600` lands on `permission_tightened` while
`chmod -R 777 /usr` still lands on `security_weakened`.

So if a command keeps getting stopped and you believe it is fine, do not add a
"this is not a violation" clause to a category — **give it a positive category of
its own**. That is the lever that works.

#### The built-in categories

Nine stop categories — unrecoverable destruction, secret exposure, weakened
security, code fetched from elsewhere and run, privilege escalation, service
disruption, writes outside the allowed paths, scripted in-place file edits, and
misplaced scratch files — and three allowed ones: `permission_tightened`,
`scoped_process_control`, and `routine_work`, the catch-all for ordinary work.

Nothing in the built-ins mandates a working style beyond the paths rule, which
names `${HOME}/.pi` and `${HOME}/.agents` explicitly. There is no rule about
`/tmp` beyond the scratch category, and none about git.

### Commands

| Command | Effect |
|---|---|
| `/typesafe-approve` | The settings screen. |
| `/typesafe-approve status` | One-line status. |
| `/typesafe-approve path` | Print the config path. |
| `/typesafe-approve policy` | Print the categories the model chooses between. |
| `/typesafe-approve on` / `off` | Toggle the gate. |
| `/typesafe-approve test <command>` | Classify one command and show the raw signals and verdict. |

### The settings screen

Built on [`@narumitw/pi-tui-kit`](https://www.npmjs.com/package/@narumitw/pi-tui-kit),
the same menu framework the other Pi configuration screens use, so it behaves the
way you already expect:

```text
typesafe-approve
  enabled · configured · key ${TYPESAFE_API_KEY} · violation >= 0.3 …
  https://openrouter.ai/api/alpha/decisions · model ~typesafe/jev-latest

  Settings     Every option with its current value.
  Policy       The rules the model judges against.
  Diagnostics  Test the endpoint, show file paths.
  Close
```

`Settings` is one list, not a menu you descend into: **every option is visible at
once with its current value**. Enumerated options change in place on Enter (on/off,
the action, the no-UI fallback, the failure mode, the two log toggles); everything
else opens a single-field editor, and an invalid number is reported without leaving
the screen. `Policy` lists the categories as they are sent, opens `policy.json` in
a full editor, and can restore the built-in set after asking. `Diagnostics` runs a
real request against the endpoint and shows the file paths.

No screen ever renders the API key: it is shown as `${NAME}` or `literal`, and
the key editor is deliberately not prefilled, because a prefill would put the
secret on screen and into the terminal scrollback.

### When changes take effect

Everything applies by itself; there is no reload step.

| You change | It applies |
|---|---|
| anything through `/typesafe-approve` | immediately, to the next command |
| `policy.json` in an editor | immediately, to the next command |
| `config.json` in an editor | when the gate next runs, or when the settings screen re-renders |

The two files are handled differently on purpose, because they can fail
differently.

**The policy is never cached.** It is a few KB read once per command, next to a
network round trip, so the read is free by comparison — and not caching it means
an edit is live at the next command with no watching, no mtime check, and no way
to be stale. A policy caught mid-write resolves to the built-in default for that
one command, and the file is never written to, so nothing is lost either way.

**The configuration is re-read when it changes**, detected with one `stat` per
command rather than a file watcher: that cannot miss an event, and it needs no
polling fallback, no debounce, and no cleanup on shutdown. What a re-read must
never do is quietly disarm the checker, so adoption is guarded:

- a file that does not parse is refused — a half-written file is the common case,
  and a truncated JSON body parses as nothing;
- a usable configuration is always adopted;
- an unusable one is adopted when that is what you asked for (`enabled: false`),
  or when nothing is being lost because the running configuration was unusable
  too, which is normal while setting the extension up;
- otherwise the working configuration is kept and the settings screen says why.

The asymmetry is deliberate: the cheaper mistake is "your edit was ignored for a
moment", not "the check silently stopped running". An edit made *through* the
settings screen bypasses all of this and is adopted unconditionally, because it is
a deliberate action and must always take effect.

One related consequence: `policy.json` is never overwritten once it exists, even if
you empty it. An empty or unparseable policy file means the built-in categories are
used in memory and reported as such, rather than your in-progress edit being
replaced.

## Architecture

```text
src/
├── index.ts        Pi entry: config lifecycle, tool_call wiring, /typesafe-approve
├── gate.ts         The tool_call handler: model → cache → action
├── systemone.ts    HTTP client, response normalization, secret redaction
├── menu.ts         the /typesafe-approve settings screen
├── policy.ts       the category file, built-in categories, validation (read per request)
├── expand.ts       ${NAME} expansion, one rule, no escapes
├── classify.ts     state, the one question, violation mass, verdict
├── config.ts       config schema, load/save, $ENV resolution, endpoint building
├── log.ts          JSONL decision log, self-trimming at 20 MB
└── types.ts        shared request/response/decision types
```

One rule shapes the whole design: **the gate never executes anything and never
changes how a command runs.** It only decides whether to let Pi continue.

### Interception: `tool_call`, not a re-registered Bash tool

This is the question the design turns on, and the answer is **intercept**.

Pi offers two ways to stand between the model and a shell command:

- `pi.registerTool()` — replace the built-in `bash` tool with your own; or
- `pi.on("tool_call", handler)` — observe each call before execution, and
  return `{ block: true, reason }` to stop it or mutate `event.input` to patch
  it.

**[pi-permission-system](https://github.com/gotgenes/pi-packages) does not
override the Bash tool.** It registers exactly one `tool_call` handler (plus
`input` and session handlers) and enforces its policy there. Before running any
command, it returns `{ block: true, reason }` or lets the call through. The
shipped `permission-gate.ts` and `protected-paths.ts` examples do the same. A
grep of that package's source finds no `registerTool` call for `bash`.

This extension follows the same route, for four reasons:

1. **`tool_call` is the designated gate.** Pi documents that it "can mutate
   input or block execution". It exists precisely for permission checks.
2. **Re-registering means reimplementing.** The built-in Bash tool owns process
   spawning, streaming output, timeouts, output truncation, the file-mutation
   queue, abort handling, and its result renderer. A replacement must reproduce
   all of it and then track upstream changes forever — for a feature that
   changes nothing about how a command runs.
3. **Gates compose; replacements do not.** Every extension's `tool_call` handler
   runs, in load order. A re-registered tool would *shadow* the built-in one
   instead of layering on it.
4. **The safety direction is right.** A `tool_call` handler can only *add* a
   block; it cannot un-block a command another handler refused. So this soft,
   probabilistic gate can never weaken a hard policy gate — such as
   pi-permission-system — sitting next to it. Run both: that one enforces
   rules, this one clears routine prompts.

### What the gate actually sees, and extension load order

`tool_call` handlers run in extension load order, and each sees the mutations
made by the handlers before it (`event.input` is mutable, and Pi documents that
"later `tool_call` handlers see earlier mutations"). So the text this gate
judges depends on **where this package sits in `packages`**.

This matters because a shell-optimizer extension can rewrite the command first.
`pi-rtk-optimizer`, for example, does exactly that — it registers its own
`tool_call` handler and assigns `event.input.command = …`, rewriting `cat X`
into `rtk read X` and injecting an `export RTK_DB_PATH='/tmp/…'` prefix.
Two consequences, both measurable:

- the model is asked to judge a dialect it has never seen, and a `/tmp` path
  that appears in *every* command, which reads as suspicious. Measured on the
  same command: `policy=0.28` for the rewritten `rtk read /etc/hostname` versus
  `policy=0.03` for the original `cat /etc/hostname`;
- a human is shown a command they did not write, when the escalation prompt or
  the block reason quotes it.

Listing this package **before** the rewriting extension in `settings.json` makes
the gate judge the command as written. Listing it after makes the gate judge
what will actually execute. Both are defensible: the first reviews intent, the
second reviews the final artifact. What is not acceptable is being unsure which
one you have, so either way the block reason and the prompt quote the exact text
that was judged — nothing is hidden behind a rewrite.

The trade-off in one line: first = approve what was asked for, last = approve
what runs. Since rtk's rewrites are semantically preserving by design, **listing
this package first is the recommended order** — it judges the command the agent
actually wrote.

### Request flow

```text
bash tool call
      │
      ├─ gate disabled / not bash / empty command ──────────────► pass through
      │
      ├─ endpoint not configured ─────────────────────────────────► pass through
      │
      ├─ cache hit (sha256 of endpoint+model+state+categories) ──► replay verdict
      │
      ├─ POST {model, state, questions}
      │     state     = { context, command, working_directory }
      │     question  = outcome (choice over every category in policy.json)
      │
      ├─ sum the non-positive probabilities, compare to the threshold ─► allow / escalate
      │
      └─ network failure ──────────────────────────────────────► failMode
```

The request is bounded (1 MiB response cap, `timeoutMs` plus the turn's abort
signal), and a repeated command within a session is served from an LRU cache, so
cost stays near zero on the commands you run most.

## Tests

```bash
npm test          # 115 tests: unit + an end-to-end test against a local stub
npm run typecheck
npm run check     # both
```

The integration test writes a real config, starts a real HTTP server that speaks
the System One contract, drives the handlers the extension registers with a mock
Pi runtime, and asserts that a dangerous command is blocked, that the request
carried the configured model and resolved `$ENV` key, and that no key reaches the
log.

## Limitations

- A System One model has roughly **one step of reasoning depth** and no
  scratchpad, and it sees only the command text. It cannot tell a legitimate
  domain from a malicious one, and it cannot know what a glob expands to or
  whether a `staging` namespace is disposable. Those facts belong in the policy
  layer (a path or command rule), or in `policy.json` as a category — not in a
  pattern list bolted onto a probabilistic gate.
- It **over-flags scary-but-routine operations.** That is why the default action
  is "ask the user", not "block".
- Confidence is informative, not a guarantee. Tune against your own commands with
  `/typesafe-approve test <command>` and `action: "monitor"`, then promote a
  repeated false stop to a positive category rather than raising the threshold.
- `decisions.jsonl` is capped at 20 MB, so older history is dropped; each call costs one input-token
  charge on your account.

## License

MIT
