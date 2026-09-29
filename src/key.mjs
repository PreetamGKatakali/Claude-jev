// Comparing two keys without either side handling one.
//
// The daemon holds the key; the SessionStart hook holds whatever the user has configured now.
// When those differ the daemon is running on a key the user has replaced, and nothing would
// otherwise notice: it still reports a key, so every liveness check passes while every routing
// call authenticates with the old one.
//
// A truncated digest settles that comparison. It is enough to tell two keys apart and useless
// for recovering either, so it is safe on a control endpoint that reports no other secret.

import { createHash } from "node:crypto";

/** Stable short digest of a key, or null when there is no key. */
export const keyFingerprint = (key = "") =>
  key ? createHash("sha256").update(key).digest("hex").slice(0, 12) : null;
