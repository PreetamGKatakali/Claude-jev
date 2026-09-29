// Tests against a body captured from the real Claude Code CLI rather than one I invented.
// Every assertion here failed before the capture: the shapes below are not what the
// documented examples suggest, and guessing them wrong meant nothing routed at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newTurnPrompt, lastUserMessage, textOf } from "../src/daemon.mjs";

const wire = JSON.parse(readFileSync(new URL("./fixtures/claude-code-2.1.236.json", import.meta.url)));
const body = (capture) => ({
  model: "jev-auto",
  tools: Array.from({ length: capture.toolCount }, (_, i) => ({ name: `tool${i}` })),
  messages: capture.messages,
});

test("a real turn ends in a system-role message, not the user's", () => {
  assert.equal(wire.realTurn.messages.at(-1).role, "system");
  assert.equal(lastUserMessage(body(wire.realTurn)).role, "user");
});

test("reads the prompt out of a real turn", () => {
  const prompt = newTurnPrompt(body(wire.realTurn));
  assert.equal(prompt, "rename the variable foo to bar");
});

test("strips the system-reminder block Claude Code prepends", () => {
  const first = wire.realTurn.messages[0].content[0].text;
  assert.match(first, /^<system-reminder>/, "fixture still has the reminder to strip");
  assert.ok(!newTurnPrompt(body(wire.realTurn)).includes("system-reminder"));
});

test("the session-title call is not a turn", () => {
  assert.equal(wire.sessionTitleCall.toolCount, 0);
  assert.equal(newTurnPrompt(body(wire.sessionTitleCall)), null);
});

test("Claude Code 2.1.236 sends no gateway hint headers", () => {
  // Hint headers need 2.1.273 and the prompt id needs 2.1.283, so the body fallback is the
  // live path on this version. If this ever starts failing, the primary path is reachable.
  const hints = Object.keys(wire.realTurn.headers).filter((h) => h.startsWith("x-claude-code-"));
  assert.deepEqual(hints, ["x-claude-code-session-id"]);
});

test("a tool-result continuation is still rejected with a trailing system message", () => {
  const continuation = {
    model: "jev-auto",
    tools: [{ name: "Read" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "do the thing" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
      { role: "system", content: [{ type: "text", text: "a trailing reminder" }] },
    ],
  };
  assert.equal(newTurnPrompt(continuation), null);
});

test("a prompt that is only a system reminder is not a turn", () => {
  assert.equal(textOf([{ type: "text", text: "<system-reminder>x</system-reminder>" }]), null);
});

// --- mid-conversation system messages -------------------------------------------------

import { applyTier, hoistSystemMessages } from "../src/tiers.mjs";

test("a system-role message is hoisted for a tier that rejects it", () => {
  // Observed live: routing a real Claude Code turn down to Haiku returned
  // 400 "role 'system' is not supported on this model". Claude Code retried and the retry
  // succeeded, so the failure was invisible from the outside -- it only cost a round trip.
  const body = {
    system: [{ type: "text", text: "attribution block" }, { type: "text", text: "system prompt" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "do the thing" }] },
      { role: "system", content: [{ type: "text", text: "an operator reminder" }] },
    ],
  };
  applyTier(body, "haiku");
  assert.deepEqual(body.messages.map((m) => m.role), ["user"]);
  assert.equal(body.system.at(-1).text, "an operator reminder");
  assert.equal(body.system[0].text, "attribution block", "the attribution block must stay first");
});

test("sonnet rejects them too, so it hoists as well", () => {
  const body = { messages: [{ role: "system", content: "x" }] };
  applyTier(body, "sonnet");
  assert.equal(body.messages.length, 0);
});

test("opus keeps them where they were", () => {
  const body = {
    system: [{ type: "text", text: "s" }],
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: [{ type: "text", text: "reminder" }] },
    ],
  };
  applyTier(body, "opus");
  assert.deepEqual(body.messages.map((m) => m.role), ["user", "system"]);
  assert.equal(body.system.length, 1);
});

test("a string system prompt becomes an array with the block appended", () => {
  const body = { system: "plain string", messages: [{ role: "system", content: "reminder" }] };
  hoistSystemMessages(body);
  assert.deepEqual(body.system, [
    { type: "text", text: "plain string" },
    { type: "text", text: "reminder" },
  ]);
});

test("no system prompt at all still gets one", () => {
  const body = { messages: [{ role: "system", content: "reminder" }] };
  hoistSystemMessages(body);
  assert.deepEqual(body.system, [{ type: "text", text: "reminder" }]);
});

test("a turn with no system-role message is left exactly as it was", () => {
  const body = { system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }] };
  const before = JSON.stringify(body);
  hoistSystemMessages(body);
  assert.equal(JSON.stringify(body), before);
});

test("the real captured turn stops being a 400 after hoisting", () => {
  const real = {
    system: [{ type: "text", text: "attribution" }],
    tools: [{ name: "Read" }],
    messages: structuredClone(wire.realTurn.messages),
  };
  assert.ok(real.messages.some((m) => m.role === "system"), "fixture still carries one");
  applyTier(real, "haiku");
  assert.ok(!real.messages.some((m) => m.role === "system"));
});
