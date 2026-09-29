import { readFileSync } from "node:fs";

// Per-token prices, used only to put a number on what routing saved.
//
// These are Anthropic first-party API rates in US dollars per million tokens, from the
// Claude API model table cached 2026-06-24. Sonnet 5's introductory $2/$10 rate expired
// 2026-08-31 and is not used. Amazon Bedrock and Vertex AI are partner-operated and priced
// separately, so a report for those is wrong by an unknown amount.
//
// Prices change. `JEV_PRICES` points at a JSON file in this same shape to override the
// table, and every report says which prices it used and how old they are.

export const PRICES_AS_OF = "2026-06-24";

/** Dollars per million tokens. */
export const PRICES = {
  haiku: { input: 1.0, output: 5.0 },
  sonnet: { input: 3.0, output: 15.0 },
  opus: { input: 5.0, output: 25.0 },
  fable: { input: 10.0, output: 50.0 },
};

/**
 * Cache tokens are priced as multiples of the input rate: a write costs about 1.25x and a
 * read about 0.1x. Applying the multiplier to each tier's own input price keeps the ratio
 * right even when the table above is replaced.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

const MILLION = 1_000_000;

export function loadPrices(file = process.env.JEV_PRICES) {
  if (!file) return { prices: PRICES, asOf: PRICES_AS_OF, source: "built-in" };
  try {
    return { prices: JSON.parse(readFileSync(file, "utf8")), asOf: "your file", source: file };
  } catch {
    return { prices: PRICES, asOf: PRICES_AS_OF, source: "built-in (your JEV_PRICES file was unreadable)" };
  }
}

/**
 * Dollar cost of one turn's tokens at a tier's rates.
 *
 * @param {{input?: number, output?: number, cacheWrite?: number, cacheRead?: number}} usage
 */
export function costOf(usage, tier, prices = PRICES) {
  const rate = prices[tier];
  if (!rate) return 0;
  const { input = 0, output = 0, cacheWrite = 0, cacheRead = 0 } = usage;
  return (
    (input * rate.input +
      output * rate.output +
      cacheWrite * rate.input * CACHE_WRITE_MULTIPLIER +
      cacheRead * rate.input * CACHE_READ_MULTIPLIER) /
    MILLION
  );
}
