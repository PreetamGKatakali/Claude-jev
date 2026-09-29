// The one HTTP call both providers make.
//
// Routing is an optimisation, so this never throws and never blocks: a failure returns an
// object carrying `error`, which the policy layer reads as "keep the current model".

import { THRESHOLDS } from "../policy.mjs";
import { buildPayload, readAnswers } from "./questions.mjs";

/**
 * @param {object} spec
 * @param {string}  spec.endpoint        full URL to post to
 * @param {string}  spec.model           decision-model identifier for this provider
 * @param {string}  spec.name            provider name, used in error text
 * @param {boolean} spec.supportsSession whether the API accepts a `session_id` field.
 *   OpenRouter's Decisions API documents one; TypeSafe's own API rejects the whole request
 *   with a 400 when it is present, so this is not a field that can be sent hopefully.
 */
export function makeProvider({ endpoint, model, name, supportsSession = false }) {
  const build = (args) => ({
    model,
    ...buildPayload(args),
    ...(supportsSession && args.sessionId ? { session_id: args.sessionId.slice(0, 256) } : {}),
  });

  async function ask({ apiKey, prompt, current, contextTokens, models, sessionId, fetchImpl = fetch }) {
    if (!apiKey || !models?.length) return null;
    const request = build({ prompt, current, contextTokens, models, sessionId });
    const started = Date.now();
    const deadline = started + THRESHOLDS.jevDeadlineMs;
    const fail = (error) => ({ error, ms: Date.now() - started });

    for (let attempt = 0; attempt <= THRESHOLDS.jevMaxRetries; attempt++) {
      const budget = Math.min(THRESHOLDS.jevTimeoutMs, deadline - Date.now());
      if (budget <= 0) break;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), budget);
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          signal: abort.signal,
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!res.ok) {
          // A 4xx is a bad key or a malformed question; retrying cannot fix either.
          if (res.status < 500 && res.status !== 429) return fail(`${name} ${res.status}`);
          continue;
        }
        const answers = readAnswers(await res.json());
        if (!answers) return fail(`${name} returned no model answer`);
        return { ...answers, request, ms: Date.now() - started };
      } catch (err) {
        if (attempt === THRESHOLDS.jevMaxRetries) {
          return fail(err.name === "AbortError" ? `${name} timed out` : err.message);
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return fail(`${name} deadline exceeded`);
  }

  return { ask, build, endpoint, model, name, supportsSession };
}
