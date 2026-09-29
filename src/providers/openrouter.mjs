// Jev decision calls over OpenRouter's Decisions API. Keys look like `sk-or-v1-...`.
//
// Docs: https://openrouter.ai/docs/guides/community/jev
// Unlike TypeSafe's own API this meters each call and reports `usage.cost`.

import { makeProvider } from "./transport.mjs";

export const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

export const openrouter = makeProvider({
  endpoint: ENDPOINT,
  model: process.env.JEV_DECISION_MODEL ?? "typesafe/jev-1.13",
  name: "openrouter",
  supportsSession: true,
});

// Kept so the provider-contract tests can exercise the shared layers by name.
export { buildPayload, readAnswers, modelQuestion } from "./questions.mjs";
export const askJev = (args) => openrouter.ask(args);
export const buildRequest = (args) => openrouter.build(args);
