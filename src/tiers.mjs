// The model ladder and everything that depends on knowing a model's tier.
//
// `id` is only a cold-start fallback: once the daemon has proxied one `GET /v1/models`
// it prefers the exact ids the account actually reports, so a new release routes without
// a code change. `family` is the substring used to place a model Claude Code names --
// which may be an older version within the same tier, such as `claude-sonnet-4-6`.
//
// `thinking`, `effort` and `systemMessages` say what a tier's request body may carry. Claude
// Code composes the body for whatever model it believes it is talking to, so routing down to
// Haiku while leaving `thinking: {type: "adaptive"}` in place is a hard 400 from the API.
//
// `systemMessages` is mid-conversation system messages -- a `{role: "system"}` entry inside
// `messages`, which Claude Code appends to every turn. Opus 5 and Fable 5 accept them; Sonnet
// 5 and Haiku 4.5 reject the whole request with
// `role 'system' is not supported on this model`.

export const TIERS = [
  { name: "haiku", id: "claude-haiku-4-5-20251001", family: "haiku", thinking: false, effort: false, systemMessages: false },
  { name: "sonnet", id: "claude-sonnet-5", family: "sonnet", thinking: true, effort: true, systemMessages: false },
  { name: "opus", id: "claude-opus-5", family: "opus", thinking: true, effort: true, systemMessages: true },
  { name: "fable", id: "claude-fable-5", family: "fable", thinking: true, effort: true, systemMessages: true },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name) => TIER_NAMES.indexOf(name);
export const specOf = (name) => TIERS.find((t) => t.name === name);
export const idOf = (name) => specOf(name)?.id;

/** Tier a model string belongs to, or null when it names nothing we recognise. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Sentinel offered as an extra row in the `/model` picker through
 * ANTHROPIC_CUSTOM_MODEL_OPTION. Claude Code skips validation for that id, so it arrives
 * here verbatim -- which is exactly what separates "route this turn" from "the human
 * picked a model themselves", a choice that must always win.
 */
export const AUTO_MODEL = "jev-auto";
export const isAuto = (model) => model === AUTO_MODEL;

/** Fable bills extra usage credits, so it stays out of the ladder unless asked for. */
export const availableTiers = (allowFable = process.env.JEV_ALLOW_FABLE === "1") =>
  TIER_NAMES.filter((n) => n !== "fable" || allowFable);

/**
 * The exact models this account can run, newest first, as reported by `/v1/models`.
 * Falls back to the static ladder before the first catalog response arrives.
 */
export function catalogModels(catalog = [], allowed = availableTiers()) {
  const seen = catalog
    .filter((m) => tierOf(m?.id))
    .map((m) => ({
      id: m.id,
      tier: tierOf(m.id),
      description: [
        m.display_name,
        m.created_at && `released ${String(m.created_at).slice(0, 10)}`,
      ]
        .filter(Boolean)
        .join("; "),
    }));
  const models = seen.length
    ? seen
    : TIERS.map((t) => ({ id: t.id, tier: t.name, description: t.id }));
  return models.filter((m) => allowed.includes(m.tier));
}

/** Preferred concrete model id for a tier, given what the catalog offers. */
export const modelForTier = (models, tier) =>
  models.find((m) => m.tier === tier)?.id ?? idOf(tier);

/**
 * Points a request body at a tier, removing fields that tier cannot accept.
 * Mutates and returns `body`.
 */
export function applyTier(body, tierName, model = idOf(tierName)) {
  const tier = specOf(tierName);
  if (!tier) return body;
  body.model = model;
  if (!tier.thinking) {
    delete body.thinking;
    // A context-management strategy that prunes thinking blocks is itself rejected once
    // thinking is gone, so it has to go with it.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }
  if (!tier.effort && body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  if (!tier.systemMessages) hoistSystemMessages(body);
  return body;
}

/**
 * Moves `{role: "system"}` entries out of `messages` and onto the end of the top-level
 * `system` array, for a tier that rejects them.
 *
 * The content stays system content rather than becoming user text, and appending keeps
 * Claude Code's attribution block first in the array, which is what lets the API strip it
 * and leave first-party prompt caching intact. What is lost is position: a mid-conversation
 * instruction applied from its point in the conversation, and hoisted it applies throughout.
 * For the reminders Claude Code sends, that is the smaller of the two costs -- the
 * alternative is a 400.
 */
export function hoistSystemMessages(body) {
  if (!Array.isArray(body?.messages)) return body;
  const hoisted = [];
  body.messages = body.messages.filter((message) => {
    if (message?.role !== "system") return true;
    hoisted.push(message.content);
    return false;
  });
  if (!hoisted.length) return body;

  const blocks = hoisted.flatMap((content) =>
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? content.filter((b) => b?.type === "text")
        : [],
  );
  if (!blocks.length) return body;

  if (Array.isArray(body.system)) body.system = [...body.system, ...blocks];
  else if (typeof body.system === "string") body.system = [{ type: "text", text: body.system }, ...blocks];
  else body.system = blocks;
  return body;
}
