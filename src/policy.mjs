// The routing policy: one pure function turning a Jev answer into the model we will run.
//
// Every rule here exists because the obvious behaviour loses money or breaks a task.
// Ported from gargpratyush/jev-router (MIT), whose measurements the thresholds come from.

import { TIER_NAMES, rankOf } from "./tiers.mjs";

export const THRESHOLDS = {
  /** Below this Jev confidence we refuse to downgrade, and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.3,
  /** Where an unsure decision lands: strong enough for real work, cheap enough to be wrong. */
  uncertainCeiling: "sonnet",
  /**
   * Switching models invalidates the prompt cache, so the next turn re-sends the whole
   * conversation. Measured upstream at ~23.6k cache-creation tokens switching into Opus,
   * which means a downgrade only pays for itself while the conversation is still small.
   */
  downgradeMaxContextTokens: 20_000,
  /** Per-attempt HTTP timeout and hard wall-clock deadline for the whole routing call. */
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};

/** Phrases that mean the human already decided, matched against the raw prompt. */
const ALIASES = {
  haiku: "haiku|fast|cheap",
  sonnet: "sonnet|balanced",
  opus: "opus|strong|smart",
  fable: "fable|long",
};

export const OVERRIDE_PATTERNS = TIER_NAMES.map((tier) => ({
  tier,
  re: new RegExp(`\\b(?:use|using|switch to|with|on)\\s+(?:${ALIASES[tier]})\\b`, "i"),
}));

/** The tier named explicitly in the prompt, or null. */
export function detectOverride(prompt) {
  return OVERRIDE_PATTERNS.find((p) => p.re.test(prompt ?? ""))?.tier ?? null;
}

/**
 * Nearest tier the account can actually run. Steps up rather than down on a miss, so a
 * hard task is never quietly handed to a weaker model, but never steps up into `fable`,
 * which bills extra usage credits, unless fable is what was asked for.
 */
export function clampToAvailable(tier, available) {
  if (available.includes(tier)) return tier;
  const rank = rankOf(tier);
  const up = TIER_NAMES.filter(
    (t, i) => i > rank && available.includes(t) && (t !== "fable" || tier === "fable"),
  );
  if (up.length) return up[0];
  const down = TIER_NAMES.filter((t, i) => i < rank && available.includes(t));
  return down.length ? down.at(-1) : null;
}

/**
 * Decides the tier to run. Pure and total: any missing, malformed, or unavailable input
 * settles on the model already in use, because a routing failure must never block a prompt
 * or move a conversation somewhere the user did not ask for.
 *
 * @param {object}   input
 * @param {string}   input.prompt         raw prompt, for explicit-override detection
 * @param {?{choice: string, confidence: number}} input.jev  null when Jev failed
 * @param {string}   input.current        tier the prompt cache was built on
 * @param {string[]} input.available      tier names this account can run
 * @param {number}   input.contextTokens  approximate conversation size so far
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function decide({ prompt, jev, current, available, contextTokens = 0 }) {
  const settle = (tier, reason) => {
    const final = clampToAvailable(tier, available) ?? current;
    const why = final === tier ? reason : `${reason}+unavailable`;
    return {
      tier: final,
      reason: final === current ? `${why}/no-change` : why,
      changed: final !== current,
    };
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  if (!jev || !TIER_NAMES.includes(jev.choice)) return settle(current, "jev-unavailable");

  const target = jev.choice;

  if (jev.confidence < THRESHOLDS.minConfidence) {
    if (rankOf(target) < rankOf(current)) return settle(current, "low-confidence-no-downgrade");
    const ceiling = Math.max(rankOf(current), rankOf(THRESHOLDS.uncertainCeiling));
    if (rankOf(target) > ceiling) return settle(TIER_NAMES[ceiling], "low-confidence-capped");
  }

  if (rankOf(target) < rankOf(current) && contextTokens > THRESHOLDS.downgradeMaxContextTokens) {
    return settle(current, "downgrade-not-worth-cache-rebuild");
  }

  return settle(target, "jev");
}

/** Whether policy took Jev's exact model, including a version change inside one tier. */
export const usedExactModel = (reason, chosenTier, finalTier) =>
  (reason === "jev" || reason === "jev/no-change") && chosenTier === finalTier;
