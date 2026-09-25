# pi-typesafe-approve

A Pi extension that auto-approves routine Bash commands using a **System One /
Jev decision model**, and escalates everything else to a human.

Jev does not generate text. It answers typed questions about a `state` you send
it and returns probabilities: a `choice` tier, a `noul` yes/no probability, a
`confidence`. That makes it a good fit for one specific job — a fast, cheap
*triage* layer in front of every shell command:

- routine commands (`ls`, `git status`, `npm ci`) pass without a prompt;
- commands the model flags — including obfuscated ones it decodes
  (`$'\x72\x6d' -rf /`, `echo … | base64 -d | sh`) — stop and go to you;
- when the model is unreachable, the gate does not wedge the agent.

Model endpoints, API keys, and models are **fully user-supplied**. There are no
provider presets, because the known deployments agree on the request body but
differ in endpoint path and model id, and those details move.

## Install

```bash
pi install ./            # from this directory
# or try it for one invocation without installing:
pi -e ./
```

Then run `/typesafe-approve` to set the endpoint, model, and API key.

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

Two ways to point at a deployment:

| Field | Meaning |
|---|---|
| `baseUrl` + `path` | Normal case: `baseUrl` is e.g. `https://api.typesafe.ai`, `path` is e.g. `/v1/systemone`. |
| `endpoint` | Absolute URL. Wins over `baseUrl` + `path`; use it when the path is unusual. |

Then `model` and `apiKey`. Known deployments, as of September 2026:

| Deployment | `baseUrl` | `path` | `model` |
|---|---|---|---|
| TypeSafe official | `https://api.typesafe.ai` | `/v1/systemone` | `jev-latest` |
| OpenRouter, Decisions API | `https://openrouter.ai` | `/api/alpha/decisions` | `~typesafe/jev-latest` |
| OpenRouter, System One API | `https://openrouter.ai` | `/api/v1/systemone` | `typesafe/jev-1.13` |
| OpenJEV | `https://api.openjev.sh` | `/v1/systemone` | `openjev` |
| A local relay (von / laya / edgejev) | your host | your path | your model |

The two OpenRouter surfaces differ exactly here: the **Decisions API** lives on
`/api/alpha/decisions` and names the model `~typesafe/jev-latest`, while the
**System One API** lives on `/api/v1/systemone` and names it
`typesafe/jev-1.13`. The request body (`model`, `state`, `questions`) and the
response body (`answers`, `usage`) are the same on both, and on TypeSafe and
OpenJEV too, so no code path is provider-specific — only these three strings
change.

### API key

`apiKey` is either **entirely** a literal or **entirely** one `${NAME}` reference:

```jsonc
"apiKey": "${TYPESAFE_API_KEY}"   // read the environment variable
"apiKey": "sk-live-abc123"        // a literal key
```

The braces are required. `"$TYPESAFE_API_KEY"` without them is taken at face
value and sent as the literal bearer token `$TYPESAFE_API_KEY` — the same rule
the policy file uses, with no second guessing. That is a deliberate choice: one
syntax, stated in the docs and in the config comment, and if a value starts with
`$` and is not `${NAME}` then the user meant a literal.

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
  "thresholds": { "danger": 0.3, "policy": 0.3 },
  "escalateOnTiers": ["danger"],
  "minTierConfidence": 0,
  "action": "escalate",
  "noUiFallback": "block",
  "failMode": "open"
}
```

Every command is judged by **three independent questions**, and the **strictest
answer wins**:

1. `risk` — a `choice` over `safe` / `caution` / `danger`.
2. `danger` — a `noul`: "would this cause irreversible data loss, weaken
   security, or disrupt a service?"
3. `violates_policy` — a `noul` against the review policy in `state`.

Both primitives are needed because they disagree in both directions on a real
minority of inputs; taking the strictest of the two recovers cases either signal
alone misses. A live `typesafe/jev-1.13-20260917` run makes the point: for the
obfuscated `a=rm; b='-rf'; c=/tmp/x; $a $b $c`, the tier came back `danger` at
only **0.20** confidence — too weak to act on alone — while the two `noul`s
returned `0.65` and `0.80`, both well clear of the threshold. Either signal by
itself would have been the wrong call.

The default `danger` threshold of **0.3** is deliberately low. Measured against
a 52-command set, `p ≥ 0.3` caught ~97% of the dangerous commands **with zero
false positives on plainly safe ones**; the cost was false positives on
*scary-but-routine* commands (`npm ci`, `systemctl restart nginx`,
`kubectl delete pod`). That is the right trade for a gate whose escalation is
"ask a human", not "delete the command".

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

### Policy: what the reviewer is told

The rules the model judges against live in **one file**,
`<extension config dir>/policy.md`, created from a minimal default on first run.
There is no config key for the path and no support for splitting it across
files: nothing else reads this text, so a redirectable path would only be a way
to point at a file that is not there.

#### A reviewer's stop-list is not the agent's rules file

This is the single most important thing to get right, and getting it wrong is
what made an earlier version flag almost everything.

`AGENTS.md` is written *to the agent*: "do this, don't do that", plus workflow
preferences, tool discipline, priorities, and communication style. Feeding it in
verbatim went wrong three ways:

- it addresses the wrong reader, so the model reads imperatives aimed at somebody
  else;
- it is mostly irrelevant to one shell command, which costs tokens on every
  request and dilutes the part that matters;
- rules like "never modify files outside the working directory" demand path
  containment reasoning — *is `/work/a/b` inside `/work`?* — that a one-step,
  no-scratchpad model cannot do. Faced with that, it hedges, and hedging on
  every command means flagging everything. Measured: 10 of 17 commands in one
  session escalated, all of them on the policy signal alone, 8 of them with the
  tier at `safe`.

So the policy is written for the reviewer and says two things: what to stop, and
what is ordinary. The second half is what keeps the false-positive rate down, and
it is why the default is short.

#### The default is short, and only about baseline safety

It is five lines, 509 characters, and states only harm that is harm under *any*
working style: unrecoverable data loss, leaked secrets, weakened security or
granted access, taking a machine or service down, and running code downloaded in
the same command. Nothing about where temp files go, about `sudo`, or about git
— those are preferences rather than safety, and a default that enforced them
would be wrong for a large share of users. Add your own rules at the end; it is
plain text and it is yours.

It ends with one short sentence — "Anything else is fine." — and not the long
list of non-reasons an earlier version carried. That sentence earns its place:
without some such signal the reviewer hedges on ordinary commands. But once the
rules got short there was nothing left for the enumeration to correct, so it
shrank with them. A test pins the length and asserts the default mentions none of
`sudo`, `git`, `/tmp`, or `AGENTS.md` at all: length is paid on every request,
and a mandated working style is a false positive for everyone who does not share
it.

#### Writing your own: two rules that measurably matter

Both come from measuring against the real model, and both are about removing the
need for reasoning the model cannot do.

**Name literal prefixes, not abstract areas.** "Never modify files outside the
working directory" demands path containment — *is `/work/a/b` inside `/work`?* —
which a one-step, no-scratchpad model cannot answer, so it hedges and flags
everything. Naming `${HOME}/.pi` as a concrete prefix, and stating the
string-level test in words (a path with no leading slash and no tilde is inside
the working directory), removes the question entirely. Measured: `echo x >
src/new-file.txt` scored 0.71, flagged, under the abstract wording, and 0.07,
allowed, once the rule was stated as prefixes plus the relative-path case.

**State the correspondence when a command may use a variable.** A policy that
names `${PI_TMPDIR}` gets the real path, but a command writes `$PI_TMPDIR` — a
form the model cannot equate with the absolute path it was handed. One sentence
saying the same directory may appear through the environment variable
`PI_TMPDIR` took that compliant command from 0.74, flagged, to 0.27, allowed.

#### `${NAME}` expansion

The policy supports exactly one syntax:

| Written | Meaning |
|---|---|
| `${NAME}` | the environment variable `NAME`, if set and non-empty |
| anything else | literal, `$` included |

No escape syntax is needed, because a `$` that is not followed by `{NAME}` is
already literal. Case carries no meaning. There are deliberately **no** built-in
dynamic values such as `${cwd}`: facts like the working directory are structured
fields on the request `state`, so the model receives them exactly, and repeating
them in the prose would be duplicate information and a second thing to maintain.
`${PI_TMPDIR}` and `${HOME}` work because they are environment variables.

An unresolved `${NAME}` is left as written so a typo stays visible, and
`/typesafe-approve policy` prints the exact text the model receives along with
any unresolved reference or habitual bare `$word`.

### Commands

| Command | Effect |
|---|---|
| `/typesafe-approve` | Interactive menu: endpoint, path, model, key, thresholds, action, failure mode, connection test. |
| `/typesafe-approve status` | One-line status. |
| `/typesafe-approve path` | Print the config path. |
| `/typesafe-approve policy` | Print the exact policy text sent to the model, with expansion notes. |
| `/typesafe-approve on` / `off` | Toggle the gate. |
| `/typesafe-approve test <command>` | Classify one command and show the raw signals and verdict. |

## Architecture

```text
src/
├── index.ts        Pi entry: config lifecycle, tool_call wiring, /typesafe-approve
├── gate.ts         The tool_call handler: model → cache → action
├── systemone.ts    HTTP client, response normalization, secret redaction
├── policy.ts       the policy file, its minimal default, and its expansion
├── expand.ts       ${NAME} expansion, one rule, no escapes
├── classify.ts     state + questions construction, thresholds, verdict
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
what runs. rtk's rewrites are semantically preserving by design, so "first" is
the recommended order, and it is the order this project's `settings.json` uses.

### Request flow

```text
bash tool call
      │
      ├─ gate disabled / not bash / empty command ──────────────► pass through
      │
      ├─ endpoint not configured ─────────────────────────────────► pass through
      │
      ├─ cache hit (sha256 of endpoint+model+state) ────────────► replay verdict
      │
      ├─ POST {model, state, questions}
      │     state     = { command, working_directory, review_policy }
      │     questions = risk (choice) + danger (noul) + violates_policy (noul)
      │
      ├─ strictest signal wins, thresholds applied ─────────────► allow / escalate
      │
      └─ network failure ──────────────────────────────────────► failMode
```

The request is bounded (1 MiB response cap, `timeoutMs` plus the turn's abort
signal), and a repeated command within a session is served from an LRU cache, so
cost stays near zero on the commands you run most.

## Tests

```bash
npm test          # 68 tests: unit + an end-to-end test against a local stub
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
  layer (a path or command rule), or in `policy.md` — not in a pattern list
  bolted onto a probabilistic gate.
- It **over-flags scary-but-routine operations.** That is why the default action
  is "ask the user", not "block".
- Confidence is informative, not a guarantee. Tune thresholds against your own
  commands using `/typesafe-approve test <command>` and `action: "monitor"`.
- `decisions.jsonl` is capped at 20 MB, so older history is dropped; each call costs one input-token
  charge on your account.

## License

MIT
