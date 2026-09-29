---
description: Turn off Jev routing and go back to stock Claude Code
---

Run this and report the result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" off
```

It removes the keys it added from `~/.claude/settings.json`, removes its status line, and
stops the daemon. A value the user has since changed themselves is left alone.

Tell them to restart Claude Code, and that the plugin can stay installed — `/jev:setup` turns
routing back on whenever they want it.
