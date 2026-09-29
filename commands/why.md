---
description: Explain why the last turn was routed the way it was
---

Run this and report the result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" why
```

It prints the most recent routing decision: the prompt Jev saw, the model it chose, its
confidence, the three complexity judgements, and what the policy did with them.

Read the `policy` line for the user. It says which rule decided:

- `jev` — Jev's answer was taken as-is.
- `override` — they named a model in the prompt, so Jev was never asked.
- `jev-unavailable` — the decision call failed and the current model was kept. Routing fails
  open, so the turn still ran.
- `low-confidence-no-downgrade` / `low-confidence-capped` — Jev was unsure, so the policy
  refused to move down, or capped the move up at Sonnet.
- `downgrade-not-worth-cache-rebuild` — a cheaper model was available, but the conversation
  was large enough that switching would have cost more in a rebuilt prompt cache than it saved.
- anything ending `+unavailable` — the chosen tier is not on this account, so the nearest
  stronger one ran instead.
- anything ending `/no-change` — the decision landed on the model already in use.

If they are surprised by a choice, the complexity percentages are the thing to look at: they
are what Jev actually judged, before any policy correction.
