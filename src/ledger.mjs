// An append-only record of routed turns, so `/jev:stats` can say what routing actually did.
//
// One JSON object per line, written after the response completes and its usage is known.
// Append-only because a report that silently loses turns is worse than no report, and
// because two daemons on one machine must not be able to corrupt each other's history.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ledgerFile = () =>
  process.env.JEV_LEDGER ??
  join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "claude-jev", "ledger.jsonl");

/** Records one routed turn. Never throws: accounting must not break a request. */
export function record(entry) {
  try {
    const file = ledgerFile();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // A full disk or an unwritable path costs a report, not a turn.
  }
}

/** Every turn recorded, oldest first. A corrupt line is skipped rather than failing the read. */
export function readAll(file = ledgerFile()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line torn by a crash mid-append; the rest of the history is still good.
    }
  }
  return entries;
}

export function clear(file = ledgerFile()) {
  try {
    writeFileSync(file, "", { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
