import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Read per call rather than at load, so a test or a relaunch can redirect it. */
export const logFile = () => process.env.JEV_LOG_FILE ?? join(homedir(), ".claude-jev.log");

/** Appends one line. Logging must never be the reason a request fails. */
export function log(line) {
  try {
    appendFileSync(logFile(), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // Unwritable path or full disk; the request carries on regardless.
  }
}

export const debug = (line) => {
  if (process.env.JEV_DEBUG) log(line);
};
