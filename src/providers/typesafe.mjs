// TypeSafe's own API. Keys look like `apikey_<id>_<secret>`.
//
// Verified live on 2026-09-28: POST https://api.typesafe.ai/v1/systemone returns
// `{model, answers, usage:{input_tokens, output_tokens}}` -- the same answer shapes as
// OpenRouter's Decisions API, but no `cost` field, because TypeSafe bills the account
// rather than metering the call.

import { makeProvider } from "./transport.mjs";

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export const typesafe = makeProvider({
  endpoint: ENDPOINT,
  model: process.env.JEV_DECISION_MODEL ?? "jev-latest",
  name: "typesafe",
});
