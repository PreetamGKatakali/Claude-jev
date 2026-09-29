---
description: What routing has cost, and what it saved
---

Run this and report the result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" stats
```

It reads every routed turn and reports tokens and cost per tier, then compares the total
against the same tokens priced at Opus rates.

Be straight with the user about what that comparison is and is not. It prices **these exact
token counts** at Opus rates. It is not a measurement of what Opus would have cost, because a
stronger model would have written different responses and used a different number of tokens.
Treat it as an indication of scale, not an invoice.

Two more things worth saying if the numbers look off:

- The prices are a built-in table with a date on it. If it is stale, or they are on Bedrock or
  Vertex, where pricing is partner-operated and different, they can point `JEV_PRICES` at their
  own JSON file in the same shape.
- Turns only appear here once the response completes, and only when the turn was routed. A turn
  on a model they picked themselves with `/model` is not counted.
