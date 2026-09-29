import { test } from "node:test";
import assert from "node:assert/strict";
import { askJev, buildRequest, readAnswers, modelQuestion } from "../src/providers/openrouter.mjs";

const MODELS = [
  { id: "claude-haiku-4-5-20251001", tier: "haiku", description: "Haiku 4.5" },
  { id: "claude-sonnet-5", tier: "sonnet", description: "Sonnet 5" },
  { id: "claude-opus-5", tier: "opus", description: "Opus 5" },
];

const ok = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });
const status = (code) => async () => ({ ok: false, status: code, json: async () => ({}) });

const ANSWER = {
  answers: {
    model: { type: "choice", choice: "claude-opus-5", confidence: 0.84, probabilities: { "claude-opus-5": 0.84 } },
    task_complexity: { type: "score", score: 7, confidence: 0.9 },
    reasoning_required: { type: "score", score: 8, confidence: 0.9 },
    tool_complexity: { type: "score", score: 4, confidence: 0.9 },
  },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
};

const call = (fetchImpl, extra = {}) =>
  askJev({
    apiKey: "k",
    prompt: "why does checkout blank?",
    current: "claude-sonnet-5",
    contextTokens: 1200,
    models: MODELS,
    fetchImpl,
    ...extra,
  });

test("builds a request in the documented Decisions shape", () => {
  const r = buildRequest({
    prompt: "p",
    current: "claude-sonnet-5",
    contextTokens: 10,
    models: MODELS,
    sessionId: "s",
  });
  assert.equal(r.model, "typesafe/jev-1.13");
  assert.equal(r.state.request, "p");
  assert.equal(r.session_id, "s");
  assert.equal(r.questions.model.type, "choice");
  assert.deepEqual(Object.keys(r.questions.model.criteria), MODELS.map((m) => m.id));
  for (const q of ["task_complexity", "reasoning_required", "tool_complexity"]) {
    assert.equal(r.questions[q].type, "score");
    assert.ok(Array.isArray(r.questions[q].criteria));
  }
});

test("every model choice carries its guidance", () => {
  const q = modelQuestion(MODELS);
  assert.match(q.criteria["claude-haiku-4-5-20251001"].what, /Trivial/);
  assert.ok(q.criteria["claude-opus-5"].not_for);
});

test("normalises scores onto 0..1", () => {
  const a = readAnswers(ANSWER);
  assert.equal(a.choice, "claude-opus-5");
  assert.equal(a.confidence, 0.84);
  assert.ok(Math.abs(a.metrics.taskComplexity - 7 / 9) < 1e-9);
  assert.equal(a.cost, 0.000019992);
});

test("a response without a model answer is rejected", () => {
  assert.equal(readAnswers({ answers: { task_complexity: { score: 3 } } }), null);
  assert.equal(readAnswers({}), null);
});

test("sends the key as a bearer token", async () => {
  let sent;
  await call(async (url, init) => {
    sent = { url, init };
    return { ok: true, status: 200, json: async () => ANSWER };
  });
  assert.equal(sent.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(sent.init.headers.authorization, "Bearer k");
  assert.equal(JSON.parse(sent.init.body).state.session.context_tokens, 1200);
});

test("returns the parsed answer", async () => {
  const r = await call(ok(ANSWER));
  assert.equal(r.choice, "claude-opus-5");
  assert.equal(r.error, undefined);
  assert.equal(typeof r.ms, "number");
});

test("no key means no call at all", async () => {
  let called = false;
  const r = await call(async () => ((called = true), ok(ANSWER)()), { apiKey: "" });
  assert.equal(r, null);
  assert.equal(called, false);
});

test("an empty model list means no call at all", async () => {
  assert.equal(await call(ok(ANSWER), { models: [] }), null);
});

test("a bad key fails immediately without retrying", async () => {
  let attempts = 0;
  const r = await call(async (...a) => (attempts++, status(401)(...a)));
  assert.equal(attempts, 1);
  assert.match(r.error, /401/);
});

test("a server error is retried, then gives up", async () => {
  let attempts = 0;
  const r = await call(async (...a) => (attempts++, status(503)(...a)));
  assert.equal(attempts, 2, "one retry, as configured");
  assert.ok(r.error);
});

test("a transport failure returns an error rather than throwing", async () => {
  const r = await call(async () => {
    throw new Error("ECONNRESET");
  });
  assert.match(r.error, /ECONNRESET/);
});

test("a malformed success body returns an error rather than throwing", async () => {
  const r = await call(ok({ answers: {} }));
  assert.match(r.error, /no model answer/);
});

// --- provider selection -------------------------------------------------------------

import { providerForKey, resolveProvider, PROVIDERS } from "../src/providers/index.mjs";

test("picks the provider from the key format", () => {
  assert.equal(providerForKey("sk-or-v1-abc").name, "openrouter");
  assert.equal(providerForKey("apikey_abc_def").name, "typesafe");
  assert.equal(providerForKey("nonsense"), null);
  assert.equal(providerForKey(""), null);
});

test("each provider posts to its own endpoint", () => {
  assert.match(PROVIDERS.openrouter.endpoint, /openrouter\.ai\/api\/alpha\/decisions$/);
  assert.match(PROVIDERS.typesafe.endpoint, /api\.typesafe\.ai\/v1\/systemone$/);
  assert.notEqual(PROVIDERS.openrouter.model, PROVIDERS.typesafe.model);
});

test("an explicit override beats key detection", () => {
  assert.equal(resolveProvider("sk-or-v1-abc", "typesafe").name, "typesafe");
  assert.equal(resolveProvider("apikey_a_b", "openrouter").name, "openrouter");
  assert.equal(resolveProvider("sk-or-v1-abc", "nope"), null);
});

test("a TypeSafe response without a cost is read without inventing one", () => {
  const a = readAnswers({
    model: "jev-1.13.0",
    answers: { model: { type: "choice", choice: "claude-opus-5", confidence: 0.78, probabilities: {} } },
    usage: { input_tokens: 784, output_tokens: 85 },
  });
  assert.equal(a.cost, null);
  assert.deepEqual(a.tokens, { input: 784, output: 85 });
  assert.equal(a.decisionModel, "jev-1.13.0");
});

test("session_id is sent only to the provider that accepts it", () => {
  const args = { prompt: "p", current: "c", contextTokens: 1, models: MODELS, sessionId: "s-1" };
  assert.equal(PROVIDERS.openrouter.build(args).session_id, "s-1");
  assert.ok(
    !("session_id" in PROVIDERS.typesafe.build(args)),
    "TypeSafe rejects the whole request with a 400 when session_id is present",
  );
});
