# pi-typesafe-approve

**English** | [中文](README.zh-CN.md)

> **Promotion statement**: this project is fully open source (MIT) and is promoted on public boards under the [LINUX DO](https://linux.do) community open-source promotion rules. Thanks to the community for the feedback behind it.

Auto-approve routine Bash commands with a **System One** decision model, and send everything else to you.

A System One model does not write text. It answers typed questions about a state you give it and returns a probability for every option. That makes it a cheap, fast triage layer in front of every shell command:

- `ls`, `git status`, `npm ci` run with no prompt;
- anything it flags stops and asks you — including obfuscated commands it can decode (`$'\x72\x6d' -rf /`, `echo … | base64 -d | sh`);
- an unreachable model never wedges the agent.

Endpoints, keys, and models are yours to supply. There are no provider presets.

## Install

```bash
pi install git:github.com/Davidasx/pi-typesafe-approve
```

Then `/typesafe-approve` to set the endpoint, model, and key. For development, `pi -e ./` runs a checkout for one invocation, and `pi install ./path` loads it in place so an edit is live after `/reload`.

## Configure

Config is `<agentDir>/extensions/pi-typesafe-approve/config.json`, every key optional, all of it editable from `/typesafe-approve`. See [`config.example.json`](./config.example.json).

### Endpoint and model

Two strings. `endpoint` is the whole request URL.

| Deployment | `endpoint` | `model` |
|---|---|---|
| TypeSafe official | `https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| OpenRouter | `https://openrouter.ai/api/v1/systemone` | `~typesafe/jev-latest`, or any System One model |
| Ollama | `http://127.0.0.1:11434/v1/systemone` | your model |

The request and response bodies are the same on all of them, so only these two strings change. Verified against OpenRouter with `inception/mercury-decide:free`, which also works when your OpenRouter balance is zero.

### API key

A literal, or `${NAME}` to read the environment:

```jsonc
"apiKey": "${TYPESAFE_API_KEY}"
"apiKey": "sk-live-abc123"
```

Only the braced form is a reference; `$NAME` is a literal string. `/typesafe-approve status` says which one it resolved, and the key is never logged, never put in an error, and never prefilled into a dialog.

### What crossing the line means

```jsonc
{
  "thresholds": { "violation": 0.3 },
  "action": "escalate",
  "noUiFallback": "block",
  "promptTimeoutSeconds": 300,
  "failMode": "open"
}
```

| Key | Meaning |
|---|---|
| `action` | `escalate` (ask), `monitor` (report only), `block` (refuse) |
| `noUiFallback` | `escalate` with nobody to ask: `block` or `allow` |
| `promptTimeoutSeconds` | how long a prompt waits before refusing on its own; `0` waits forever |
| `failMode` | `open` lets commands run when the model is unreachable, `closed` refuses |

A prompt nobody answers is a decline, because the command must not run — but the agent is told *which* happened. A decline means you looked and said no; a timeout means you were away, so the agent is told to leave that command out, get on with the rest, and let you know.

## The policy

`policy.json` holds the categories the model chooses between, created from the built-in set on first run.

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
      "what": "Makes a file less accessible than it was, on a path already the user's: chmod 600 or 700.",
      "examples": ["chmod 600 ~/.ssh/id_ed25519"]
    }
  ]
}
```

`negative` means this must stop the command. `positive` means the command may run. A missing `polarity` counts as negative, and at least one positive category is required.

The verdict is the **sum of every non-positive probability**, compared against `thresholds.violation`. Summing beats reading the top category: two violations at 0.4 each are over a 0.3 line even though neither is, and that is more violation mass than a clean 0.5 split with ordinary work.

### Positive categories are how you fix a false stop

A rule and its exception in one sentence do not work. "Absolute paths need approval, but tightening permissions is not this violation" still stops `chmod 600 ~/.ssh/id_ed25519`, because the same tokens appear in both halves and lexical overlap beats the negation.

A separate positive category fixes it: the model picks between two descriptions that are each true, instead of reasoning about a negation.

So when a command keeps getting stopped and you believe it is fine, **give it a positive category** rather than raising the threshold.

### The built-in categories

Eight stops — unrecoverable destruction, secret exposure, weakened security, code fetched from elsewhere and run, privilege escalation, service disruption, writes outside the allowed paths, misplaced scratch files — and four allows: `credential_handled_safely`, `permission_tightened`, `scoped_process_control`, and `routine_work`.

They avoid arguments: nothing here mandates a working style, and there is no rule about git or `/tmp` beyond the scratch category.

### The state

```json
"state": {
  "context": "Reviewing one shell command an AI coding agent wants to run ...",
  "command": "${command}",
  "working_directory": "$(pwd -P)"
}
```

Add whatever the model needs to read your categories correctly — a scratch directory, a home path, a list of project checkouts. Flat strings, and three substitutions:

| Written | Becomes |
|---|---|
| `${NAME}` | environment variable `NAME`, if set and non-empty |
| `${command}` | the command being judged |
| `$(pwd)` / `$(pwd -P)` / `${PWD}` | the physical working directory |

Only the braced form expands. `$NAME`, `$HOME`, and `~` stay exactly as written, which is what lets a value describe a syntax without the description being mangled. Any other `$(…)` is refused at load rather than executed: config text is not code.

## Commands

| Command | Effect |
|---|---|
| `/typesafe-approve` | Settings screen |
| `/typesafe-approve status` | One-line status |
| `/typesafe-approve policy` | The categories as sent |
| `/typesafe-approve test <command>` | Classify one command, show signals |
| `/typesafe-approve on` / `off` | Toggle the gate |
| `/typesafe-approve path` | Config path |

The settings screen shows every option with its current value in one list; enums change in place, everything else opens a one-field editor.

Changes apply by themselves. `policy.json` is read per command and never cached, so an edit is live at the next command. `config.json` is re-read when it changes, guarded so that a half-written file cannot silently disarm the check.

## How it works

```text
bash tool call
      │
      ├─ not bash / gate off / not configured ─────────────────► pass through
      ├─ cache hit ────────────────────────────────────────────► replay verdict
      ├─ POST {model, state, questions} ───────────────────────► sum, compare, act
      └─ network failure ──────────────────────────────────────► failMode
```

The gate attaches to Pi's `tool_call` event rather than replacing the Bash tool, which means it composes with other gates and can only *add* a block — it can never weaken a hard policy extension beside it. A repeated command within a session is cached, and the request is bounded by `timeoutMs` and the turn's abort signal.

It has no allow/deny pattern list on purpose. Hard deterministic rules belong to the policy layer, where a bug is not a probability. Run both: [pi-permission-system](https://github.com/gotgenes/pi-packages) enforces rules, this clears routine prompts.

Decisions are appended to `decisions.jsonl` beside the config, mode `0600`, capped at 20 MB.

## Limitations

- A System One model has about one step of reasoning and sees only the command. It cannot tell a legitimate domain from a malicious one, or know what a glob expands to. Those belong in `policy.json` or the policy layer.
- It over-flags scary-but-routine operations. That is why the default action asks rather than blocks.
- Tune with `/typesafe-approve test` and `action: "monitor"`, then promote a repeated false stop to a positive category.

## Tests

```bash
npm test        # 125 tests, including an end-to-end run against a local stub
npm run check   # typecheck too
```

## License

MIT
