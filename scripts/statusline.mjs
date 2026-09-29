#!/usr/bin/env node
// Status line for Claude Code. Session JSON arrives on stdin; whatever this prints is the
// line. See https://code.claude.com/docs/en/statusline
//
// Claude Code's own UI always shows the model it asked for -- the sentinel -- never the one
// the router resolved to, so this is the only place the decision is visible.
//
// It reads the status file directly rather than asking the daemon over HTTP: this runs on
// every render, and a round trip per keystroke would be felt.

import { readStatus } from "../src/status.mjs";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const TIER_COLOR = { haiku: "\x1b[32m", sonnet: "\x1b[36m", opus: "\x1b[35m", fable: "\x1b[33m" };

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let input = {};
try {
  input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
} catch {
  // Malformed input still produces a usable line below.
}

const status = readStatus(input.session_id);
const dir = (input.workspace?.current_dir ?? input.cwd ?? "").split(/[\\/]/).pop();
const pct = Math.round(input.context_window?.used_percentage ?? 0);

let routed;
if (status?.manual) {
  // The user picked this model with /model, so show their choice rather than a tier.
  routed = `${DIM}manual${RESET} ${input.model?.display_name ?? status.model ?? ""}`.trimEnd();
} else if (status?.tier) {
  const color = TIER_COLOR[status.tier] ?? "";
  const p = status.confidence != null ? ` ${DIM}p=${status.confidence.toFixed(2)}${RESET}` : "";
  // Name the reason only when routing declined to do the obvious thing, so the common case
  // stays short and the interesting case explains itself.
  const held =
    status.reason && !status.reason.startsWith("jev") && !status.reason.startsWith("override");
  const why = held ? ` ${DIM}(${status.reason.split("/")[0]})${RESET}` : "";
  routed = `${color}${status.tier}${RESET}${p}${why}`;
} else {
  routed = `${DIM}jev: waiting for first prompt${RESET}`;
}

// A status line replaces Claude Code's footer hints, so carry the basics it stops showing.
process.stdout.write(`${routed} ${DIM}·${RESET} ${dir} ${DIM}· ${pct}% context${RESET}\n`);
