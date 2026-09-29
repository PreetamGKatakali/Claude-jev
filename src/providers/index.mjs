// Picks the provider for whatever key the user has.
//
// This is a bring-your-own-key tool, so the key format is the most reliable signal of which
// service it belongs to: asking the user to also declare the provider is a setup step that
// can be got wrong, and a wrong answer looks like an authentication failure.

import { openrouter } from "./openrouter.mjs";
import { typesafe } from "./typesafe.mjs";

export const PROVIDERS = { openrouter, typesafe };

/** Provider a key belongs to, or null when the format matches neither. */
export function providerForKey(key = "") {
  if (key.startsWith("sk-or-")) return openrouter;
  if (key.startsWith("apikey_")) return typesafe;
  return null;
}

/**
 * The provider to route through. `JEV_PROVIDER` overrides detection, for a key format that
 * changes or a self-hosted endpoint.
 */
export function resolveProvider(key = "", override = process.env.JEV_PROVIDER) {
  if (override) return PROVIDERS[override] ?? null;
  return providerForKey(key);
}

/** Asks whichever provider the key belongs to. Returns null when no provider matches. */
export function askJev(args) {
  const provider = resolveProvider(args.apiKey);
  if (!provider) return Promise.resolve(null);
  return provider.ask(args);
}
