---
description: Turn on Jev routing for every Claude Code session on this machine
---

Run this and report the result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" setup
```

It writes an `env` block and a `statusLine` into `~/.claude/settings.json`, then starts the
router daemon on `127.0.0.1:8787`.

Tell the user what changed, in plain terms:

- Which keys went into settings, and that this is what makes **plain `claude` route** — along
  with the IDE extensions and `claude -p` in CI, none of which a launcher wrapper could reach.
- That they must **restart Claude Code**, because the environment is only read at startup.
- If the `key` line says `MISSING` or `UNRECOGNISED`, tell them to run
  `/plugin configure claude-jev` and paste an OpenRouter key (`sk-or-…`) or a TypeSafe key
  (`apikey_…`). Nothing routes without one; every turn just passes through.
- If `statusLine` says it was left alone, say so and explain they already have one configured,
  so routing decisions will not be visible until they add
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs"` to it themselves.

Do not paste the key anywhere, and do not read it back to the user.
