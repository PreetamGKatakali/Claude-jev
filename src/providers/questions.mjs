// What we ask Jev, and how to read what comes back.
//
// TypeSafe's own API and OpenRouter's Decisions API take the same question and answer
// shapes, so everything except the transport lives here. The two differ in three ways the
// transports handle: the endpoint, the model identifier, and whether the response reports
// a cost.

const SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];
export const MAX_SCORE = SCALE.length - 1;

const score = (instructions) => ({ type: "score", instructions, criteria: SCALE });

/**
 * What each tier is for, sent as the `criteria` body of the model choice. Jev reads these
 * as the definition of each option, so they carry the whole routing intent: everything the
 * policy layer does afterwards is a correction, not the decision.
 */
const GUIDANCE = {
  haiku: {
    what: "Trivial, mechanical, or purely factual work.",
    signals: ["Rename, reformat, comment, or run one obvious command"],
    not_for: "Design judgement or multi-file reasoning.",
  },
  sonnet: {
    what: "Ordinary day-to-day engineering with a clear, bounded shape.",
    signals: ["Implement a specified function, test known behaviour, fix an understood local bug"],
    not_for: "Open-ended architecture, subtle concurrency, or unknown-cause debugging.",
  },
  opus: {
    what: "Hard reasoning, ambiguity, or high blast radius.",
    signals: ["Unknown-cause debugging, cross-module design, security, auth, concurrency, migrations"],
    not_for: "Routine work with a clear implementation.",
  },
  fable: {
    what: "Very large or long-running work beyond a normal focused session.",
    signals: ["Whole-repo migration, unusually large context, multi-hour autonomous execution"],
    not_for: "Anything a strong model can finish in one focused session.",
  },
};

export const QUESTIONS = {
  task_complexity: score(
    "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
  ),
  reasoning_required: score(
    "How much reasoning is required to complete the request correctly in one pass?",
  ),
  tool_complexity: score(
    "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
  ),
};

/** The model choice, built from the exact models this account can run. */
export const modelQuestion = (models) => ({
  type: "choice",
  instructions: [
    "Pick the cheapest exact model that can fully complete this coding request in one pass,",
    "without needing to retry on a stronger model. Treat different versions as separate",
    "choices. Judge the reasoning required, not the length of the reply requested.",
  ].join(" "),
  criteria: Object.fromEntries(
    models.map(({ id, tier, description }) => [
      id,
      { model: description || id, ...GUIDANCE[tier] },
    ]),
  ),
});

/** The body both providers post, minus the `model` field each names differently. */
export const buildPayload = ({ prompt, current, contextTokens, models }) => ({
  state: {
    request: prompt,
    session: { current_model: current, context_tokens: contextTokens },
    environment: { available_models: models.map((m) => m.id) },
  },
  questions: { ...QUESTIONS, model: modelQuestion(models) },
});

/**
 * Normalises one response into the shape the policy layer expects. Scores come back on the
 * rubric's own 0..9 scale and are reported as fractions so a change to the scale does not
 * silently change what a metric means.
 */
export function readAnswers(result) {
  const answers = result?.answers;
  if (typeof answers?.model?.choice !== "string") return null;
  const ratio = (q) =>
    typeof answers[q]?.score === "number" ? answers[q].score / MAX_SCORE : null;
  return {
    choice: answers.model.choice,
    confidence: typeof answers.model.confidence === "number" ? answers.model.confidence : 0,
    probabilities: answers.model.probabilities ?? {},
    metrics: {
      taskComplexity: ratio("task_complexity"),
      reasoningRequired: ratio("reasoning_required"),
      toolComplexity: ratio("tool_complexity"),
    },
    // OpenRouter bills the call and reports it; TypeSafe's own API reports tokens only.
    cost: result?.usage?.cost ?? null,
    tokens: result?.usage
      ? { input: result.usage.input_tokens, output: result.usage.output_tokens }
      : null,
    decisionModel: result?.model ?? null,
  };
}
