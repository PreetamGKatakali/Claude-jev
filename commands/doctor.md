---
description: Check why Jev routing is not working
---

Run this and report the result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" doctor
```

Each line is one check. For any that says `FAIL`, tell the user what to do:

- **settings env block** — run `/jev:setup`.
- **this session is routed** — setup ran but this session started before it. Restart Claude Code.
- **daemon** — nothing is answering on the loopback port. Because `ANTHROPIC_BASE_URL` points
  at it, every request in every session fails while it is down. Run `/jev:setup` to restart it,
  or `/jev:off` to go back to stock Claude Code immediately.
- **key** or **provider** — run `/plugin configure claude-jev`.
- **provider reachable** — the key was rejected or the service is down. A `401` means a bad key;
  anything else is usually transient, and routing fails open in the meantime: turns keep working
  on the current model rather than stopping.

The **turn detection** line is informational. Before Claude Code 2.1.283 there is no
`x-claude-code-prompt-id` header, so the router identifies a turn by the prompt text instead.
Both paths work; the header is exact.
