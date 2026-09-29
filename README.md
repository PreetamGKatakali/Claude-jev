# claude-jev

Routes each Claude Code turn to the cheapest model that can actually do it, using a
[Jev](https://openrouter.ai/docs/guides/community/jev) decision call.

Status: **complete**, verified end to end against real Claude Code, real Jev, and the real
Anthropic API.

## Requirements

- **Claude Code** — any recent version. 2.1.283 or later gets exact turn detection; earlier
  versions use a prompt-text fallback that works just as well, and `/jev:doctor` tells you which
  one you are on.
- **Node.js 20.12 or later** — `node --version` to check.
- **A Jev key**, from either service:
  - [OpenRouter](https://openrouter.ai/keys) — `sk-or-…`. Use this if you already have an
    OpenRouter account; the same key works for everything else there.
  - [TypeSafe](https://api.typesafe.ai) — `apikey_…`.

  Either works. The key format selects the provider, so there is nothing else to configure.
  A routing decision costs a fraction of a cent and takes about 320 ms, once per turn.

## Install

Two commands in any Claude Code session:

```
/plugin marketplace add PreetamGKatakali/Claude-jev
/plugin install claude-jev@claude-jev
```

Installing opens a dialog asking for your key. The input is masked; the value goes to Claude
Code's secure storage, and this plugin never writes it to disk. It reaches the router through
the `SessionStart` hook's environment, which is the only place Claude Code hands a plugin its
configuration.

Then, once:

```
/jev:setup
```

and **restart Claude Code** — the environment it writes is only read at startup.

That is the whole install. There is no service to configure and no launcher to remember: after
the restart, plain `claude` routes, and so do the VS Code and JetBrains extensions and
`claude -p` in CI.

<details>
<summary>Installing from a local clone instead</summary>

```bash
git clone https://github.com/PreetamGKatakali/Claude-jev
claude --plugin-dir ./claude-jev
```

`--plugin-dir` loads the plugin for that session only, and skips the key dialog — export
`JEV_API_KEY` in your shell instead.
</details>

## Using it

Nothing to learn. Ask for things the way you already do, and watch the status line:

```
> rename the `cfg` variable to `config` across the auth module

  haiku p=0.99 · my-project · 8% context
```

```
> the checkout page renders blank in production but works locally and I cannot reproduce it

  opus p=0.80 · my-project · 11% context
```

The tier on the left is what actually ran. Claude Code's own header still shows **Jev Auto**,
because that is the model it asked for — the router resolved it afterwards, which is why the
status line exists.

### Taking over

Three ways, strongest first:

**Name it in the prompt.** Jev is not even asked.

```
> use opus — refactor the session handling
```

**Pick a model with `/model`.** Anything other than **Jev Auto** passes straight through, and
the status line switches to `manual`. Choose Jev Auto again to hand control back.

**Turn it off entirely** with `/jev:off`, which removes every change it made.

### Asking what it did

```
> /jev:why

  prompt      the checkout page renders blank in production but works locally…
  chose       claude-opus-5  confidence 0.80
    task complexity     76%
    reasoning needed    67%
    tool complexity     15%
  policy      jev
  decision    322ms
```

```
> /jev:stats

  47 routed turns since 2026-09-14

  tier      turns      input     output   cache rd      cost
  haiku        28       4192        891     412003     $0.12
  sonnet       14       2077       6640     288411     $0.21
  opus          5        934       9102      95220     $0.31

  actual                                                $0.64
  same tokens at Opus rates                             $1.42
  difference                                            $0.78  (55%)
```

### When something is wrong

```
> /jev:doctor

  OK    settings env block       all 9 keys set
  OK    this session is routed   http://127.0.0.1:8787
  OK    daemon                   up on http://127.0.0.1:8787, pid 23551
  OK    key                      held by the daemon, provider typesafe
  OK    provider                 typesafe
  OK    provider reachable       answered in 431ms
  OK    turn detection           Claude Code 2.1.236 predates 2.1.283, using the prompt-text fallback
```

Every failing line names its own fix. The one worth knowing in advance: `ANTHROPIC_BASE_URL`
points at the router for every session on the machine, so if the daemon is down, sessions fail
until it is back. `/jev:setup` restarts it and `/jev:off` reverts to stock Claude Code
immediately.

### Changing your key

```
/plugin configure claude-jev
```

then **restart Claude Code**. The daemon deliberately outlives the session that started it, so
a new key does not reach the running one; the `SessionStart` hook compares a short digest of
the configured key against the one the daemon reports and replaces the daemon when they differ.
Nothing has to be stopped by hand, and no key is ever compared in the clear.

`key held by the daemon` is the normal reading, not a fallback. Claude Code gives plugin
options to hook processes only, so a slash command has no key in its own environment however
correctly the key is configured; the daemon is started by the `SessionStart` hook and is the
one process the key reaches. `/jev:doctor` therefore asks the daemon, and has it make the
provider call too. Reporting `MISSING` from a command that structurally cannot see a key would
send you to re-enter a key that was never wrong.

| Command | What it does |
| --- | --- |
| `/jev:setup` | Writes the `env` block and status line, starts the daemon |
| `/jev:doctor` | Seven checks, each naming the fix |
| `/jev:why` | Why the last turn was routed the way it was |
| `/jev:stats` | Tokens and cost per tier, against an Opus baseline |
| `/jev:off` | Removes everything it added, stops the daemon |

There is no login service. Every Claude Code session runs `SessionStart`, so the hook starts the
daemon whenever it is not already up, and a daemon that dies is restarted by the next session
rather than needing a supervisor.

## Providers

Bring either key; the format says which service it belongs to, so there is nothing to declare.

| Key prefix | Service | Endpoint | Reports cost |
| --- | --- | --- | --- |
| `sk-or-…` | OpenRouter Decisions API | `POST /api/alpha/decisions` | yes |
| `apikey_…` | TypeSafe directly | `POST https://api.typesafe.ai/v1/systemone` | no, tokens only |

The two take identical question and answer shapes, with one difference that is not optional to
get right: OpenRouter accepts a `session_id` field and TypeSafe rejects the entire request with
a `400` when it is present. `JEV_PROVIDER` overrides detection.

Measured against TypeSafe on 2026-09-28: **p50 324 ms** warm over 8 calls (min 292, max 403),
~400 ms cold. That cost is paid once per turn, not once per tool call.

## How it works

Claude Code talks to a loopback proxy through `ANTHROPIC_BASE_URL`. The proxy forwards every
request upstream with the caller's own credentials untouched, and changes exactly one thing:
`body.model`, and only when the request names the routing sentinel `jev-auto`.

```
Claude Code ──▶ daemon :8787 ──▶ api.anthropic.com
                    │
                    └──▶ openrouter.ai/api/alpha/decisions   (first request of each turn)
```

One Jev call per turn, not per tool call: every request serving one prompt shares an
`x-claude-code-prompt-id`, so continuations reuse the tier pinned at the start of the turn
and the model cannot flip mid-task.

## Try it without touching your config

```bash
npm test          # 101 tests, no network
JEV_API_KEY=sk-or-… npm run daemon
```

Then point one session at it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 \
ANTHROPIC_CUSTOM_MODEL_OPTION=jev-auto \
ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="Jev Auto" \
ANTHROPIC_MODEL=jev-auto \
ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5-20251001 \
CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 \
claude
```

Pinning `ANTHROPIC_DEFAULT_HAIKU_MODEL` matters: without it Claude Code issues its session-title
and other side queries against the sentinel, and they reach the daemon needing a tier decision
they should never have needed. Pinned, they carry a real model id and pass straight through.

Claude Code logs one `[claude-code:unrecognized_model]` line for the sentinel at startup. It is
cosmetic -- the session runs normally -- and is inherent to registering a model id the client
does not know.

### Version note

`x-claude-code-prompt-id` requires Claude Code 2.1.283 and the gateway hint headers require
2.1.273. Verified against 2.1.236, which sends only `x-claude-code-session-id`, so on that
version the body-inspection fallback is the live path, not the backup. Both paths are tested.

`curl 127.0.0.1:8787/_jev/health` reports whether the key resolved and how many models the
daemon has learned from the account's catalog.

## Seeing what it did

`/jev:why` explains the last turn -- what Jev judged, before any policy correction:

```
prompt      In two sentences: design a zero-downtime multi-tenant Postgres migration…
chose       claude-opus-5  confidence 0.82
  task complexity     76%
  reasoning needed    67%
  tool complexity     15%
policy      jev
decision    339ms
```

`/jev:stats` reports tokens and cost per tier against a baseline. That baseline prices the
**same token counts** at Opus rates -- it is not a measurement of what Opus would have cost,
because a stronger model writes different responses and uses a different number of tokens.
Prices come from a dated built-in table; `JEV_PRICES` points at your own JSON file in the same
shape, which is what you want on Bedrock or Vertex, where pricing is partner-operated.

## What a routed request has to be rewritten for

Claude Code composes each request body for the model it believes it is talking to, so a
downgrade has to strip whatever the cheaper tier cannot accept. Each of these is a hard `400`
if left in place:

| Field | Rejected by | What happens |
| --- | --- | --- |
| `thinking` | Haiku 4.5 | removed, along with any `clear_thinking` context-management edit, which is itself rejected once thinking is gone |
| `output_config.effort` | Haiku 4.5 | removed |
| `{role: "system"}` in `messages` | Haiku 4.5, Sonnet 5 | hoisted onto the end of the top-level `system` array, which keeps it system content and keeps the attribution block first |
| draft-04 `exclusiveMinimum`/`exclusiveMaximum` in MCP tool schemas | the API | converted to draft 2020-12. Claude Code does this itself when talking to the API directly, and skips it behind a custom base URL |

The system-message one is worth knowing about: Claude Code appends a `{role: "system"}` entry
to every turn, and Opus 5 and Fable 5 accept it while Sonnet 5 and Haiku 4.5 reject the whole
request. Without the hoist, every downgraded turn returned `400 role 'system' is not supported
on this model`, Claude Code retried, and the retry succeeded -- so the session looked fine and
quietly paid for an extra round trip and a rebuilt prompt cache on every single downgrade.

## The rules

Routing is an optimisation, so it never blocks a prompt. Jev unreachable, key invalid,
response malformed — the daemon holds the current tier and forwards anyway.

| Rule | Why |
| --- | --- |
| A tier named in the prompt wins | "use opus" means the human already decided |
| A model picked with `/model` wins | anything other than the sentinel passes straight through |
| Confidence below 0.3 never downgrades | an unsure router must not hand a hard task to a weak model |
| Confidence below 0.3 caps upgrades at Sonnet | and must not spend Opus rates on a guess |
| No downgrade above ~20k context | switching models dumps the prompt cache; measured at ~23.6k cache-creation tokens into Opus |
| An unavailable tier steps up, never down | but never up into Fable, which bills extra credits |
| Side calls take the cheaper of the pin and the seed | a compaction must not be billed at an Opus conversation's rate |

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `JEV_API_KEY` / `OPENROUTER_API_KEY` | — | Enables routing. Without it every turn passes through |
| `JEV_PORT` | `8787` | Loopback port |
| `JEV_UPSTREAM` | `https://api.anthropic.com` | Where routed requests go |
| `JEV_SEED_TIER` | `sonnet` | Tier a new conversation is measured against |
| `JEV_ALLOW_FABLE` | off | Adds Fable to the ladder |
| `JEV_DECISION_MODEL` | `typesafe/jev-1.13` | Jev version |
| `JEV_DEBUG` | off | Logs every decision to `~/.claude-jev.log` |

## Credit

The routing policy — the confidence floor, the upgrade ceiling, the cache-rebuild guard and
its measured threshold — is ported from [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router)
(MIT), which solved these problems first.

## License

MIT
