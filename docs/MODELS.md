# Models: which one runs each role, and how to change it

Zulu Assistant does not call a model itself. It starts **Claude Code** or **Codex** sessions and tells
them which model to use. One file holds the choice: `overlay/config/models.json` (your copy;
`examples/config/models.json` is the shipped default).

## The roles

| Role | What it does | Key | Shipped default |
|---|---|---|---|
| **Mission Control** | the master agent that routes work and reports to you | `master` | `claude-fable-5-1` |
| **Workers** | short-lived sessions spawned for one task | `worker` | `claude-opus-5-5` |
| **Worker fallback** | used when the worker model is not available to your account | `workerFallback` | `claude-opus-5` |
| **Residents** | long-lived sessions, one per repo | the worker model | as workers |
| **Scheduled triage** | the headless pass four times a day | the worker model | as workers |

The model ids are the ones the Claude Code CLI accepts. The current ids need Claude Code 2.1.280 or
later.

## Which engine: Claude Code or Codex

```json
"engine": { "master": "claude", "worker": "claude", "triage": "claude" }
```

Each role runs on `claude` or `codex`. `resident` falls back to `worker`, and a missing key means
`claude`. `zulu setup --step engines` asks and writes this for you. For Codex roles:

```json
"codex": { "model": "", "workerModel": "" }
```

`model` is for Mission Control, `workerModel` for workers, residents and triage. An empty string
means Codex's own default from `~/.codex/config.toml`.

More on how each engine is launched: [MISSION-CONTROL.md](MISSION-CONTROL.md), Choosing the engine.

## Changing a model

1. Edit `overlay/config/models.json` and set `master`, `worker` or `workerFallback` to a model id your
   account can use.
2. For the worker model, delete `data/.model-probe`. The board probes once whether the worker model
   answers and remembers the result for 24 hours; with the file gone the next spawn probes again.
3. New sessions use the new model. A running session keeps the model it was started with: restart it,
   or switch inside the session.

How the worker model is chosen (`scripts/worker-model.sh`): it tries `worker` with one short
request. If that fails, it uses `workerFallback`. Either way the answer is cached for 24 hours in
`data/.model-probe`.

## Context windows

```json
"contextWindows": { "default": 1000000, "claude-haiku-4-5": 200000 }
```

The context gauge on each agent tile divides the tokens of the last turn by the model's window.
Windows are matched by model-id prefix; `default` covers the rest. Add a line when you use a model
whose window differs. Codex sessions report their own window, so they need no entry.

## What this costs

Every session bills to your own Claude plan or API key, or your own OpenAI account for Codex. The
only thing that runs a model without you starting it is scheduled triage
([INSTALL.md](INSTALL.md) §3 says how to turn it off). The board itself makes no model calls.
