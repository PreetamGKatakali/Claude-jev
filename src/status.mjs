// Where a routing decision goes so the status line can show it.
//
// One file per session rather than a shared map, so concurrent sessions cannot clobber each
// other. These files hold prompt text and the exact Jev exchange, so they are owner-only:
// on Linux the temp dir is the shared /tmp, while macOS and Windows temp dirs are already
// per-user, where the modes are harmless.

import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Read per call rather than at load, so a test or a relaunch can redirect it. */
export const statusDir = () => process.env.JEV_STATUS_DIR ?? join(tmpdir(), "claude-jev");
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Files untouched for this long belong to finished sessions. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 20;
let pruned = false;

const fileFor = (sessionId) => join(statusDir(), `${String(sessionId).replace(/[^\w-]/g, "")}.json`);

function ensureDir() {
  const dir = statusDir();
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // `mode` only applies on creation, so tighten a directory an earlier version left loose.
  chmodSync(dir, DIR_MODE);
}

/** Publishes the latest state for a session. Cosmetic: never interferes with a request. */
export function writeStatus(sessionId, status) {
  if (!sessionId) return;
  try {
    ensureDir();
    const file = fileFor(sessionId);
    writeFileSync(file, JSON.stringify(status), { mode: FILE_MODE });
    chmodSync(file, FILE_MODE);
    if (!pruned) {
      pruned = true;
      pruneStale();
    }
  } catch {
    // Status display is decoration; a failure here must not surface.
  }
}

/** Publishes a routing decision, keeping the recent ones for `/jev:why`. */
export function writeDecision(sessionId, decision) {
  const previous = readStatus(sessionId);
  const history = [...(previous?.history ?? []), decision].slice(-HISTORY_LIMIT);
  writeStatus(sessionId, { ...decision, history });
}

/**
 * The most recently written session's status, for a caller that has no session id of its
 * own -- `/jev:why` runs in a shell, not inside the session whose decision it explains.
 */
export function readLatest() {
  try {
    const files = readdirSync(statusDir())
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(statusDir(), name))
      .map((file) => ({ file, at: statSync(file).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    if (!files.length) return null;
    return JSON.parse(readFileSync(files[0].file, "utf8"));
  } catch {
    return null;
  }
}

export function readStatus(sessionId) {
  try {
    return JSON.parse(readFileSync(fileFor(sessionId), "utf8"));
  } catch {
    return null;
  }
}

/** Deletes status files untouched for `maxAgeMs`. Runs once per process, on first write. */
export function pruneStale(maxAgeMs = STALE_AFTER_MS, now = Date.now()) {
  let removed = 0;
  try {
    for (const name of readdirSync(statusDir())) {
      if (!name.endsWith(".json")) continue;
      const file = join(statusDir(), name);
      try {
        if (now - statSync(file).mtimeMs > maxAgeMs) {
          unlinkSync(file);
          removed++;
        }
      } catch {
        // Another session may have replaced or removed it.
      }
    }
  } catch {
    // Missing directory: nothing to prune.
  }
  return removed;
}
