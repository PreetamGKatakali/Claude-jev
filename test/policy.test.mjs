import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride, clampToAvailable, THRESHOLDS } from "../src/policy.mjs";

const ALL = ["haiku", "sonnet", "opus"];
const jev = (choice, confidence = 0.9) => ({ choice, confidence });

test("takes a confident answer", () => {
  const r = decide({ prompt: "fix it", jev: jev("opus"), current: "sonnet", available: ALL });
  assert.deepEqual([r.tier, r.reason, r.changed], ["opus", "jev", true]);
});

test("an explicit request in the prompt beats Jev", () => {
  const r = decide({ prompt: "use haiku to rename this", jev: jev("opus"), current: "sonnet", available: ALL });
  assert.equal(r.tier, "haiku");
  assert.equal(r.reason, "override");
});

test("override matches only the documented verbs", () => {
  assert.equal(detectOverride("switch to opus"), "opus");
  assert.equal(detectOverride("run it with sonnet"), "sonnet");
  assert.equal(detectOverride("the opus number is wrong"), null);
});

test("a failed Jev call holds the current model", () => {
  const r = decide({ prompt: "x", jev: null, current: "opus", available: ALL });
  assert.equal(r.tier, "opus");
  assert.equal(r.changed, false);
  assert.match(r.reason, /^jev-unavailable/);
});

test("a nonsense choice holds the current model", () => {
  const r = decide({ prompt: "x", jev: jev("gpt-9"), current: "sonnet", available: ALL });
  assert.equal(r.tier, "sonnet");
  assert.match(r.reason, /^jev-unavailable/);
});

test("low confidence never downgrades", () => {
  const r = decide({ prompt: "x", jev: jev("haiku", 0.1), current: "opus", available: ALL });
  assert.equal(r.tier, "opus");
  assert.match(r.reason, /low-confidence-no-downgrade/);
});

test("low confidence caps an upgrade at the ceiling", () => {
  const r = decide({ prompt: "x", jev: jev("opus", 0.1), current: "haiku", available: ALL });
  assert.equal(r.tier, THRESHOLDS.uncertainCeiling);
  assert.match(r.reason, /low-confidence-capped/);
});

test("confidence exactly at the threshold is trusted", () => {
  const r = decide({
    prompt: "x",
    jev: jev("haiku", THRESHOLDS.minConfidence),
    current: "opus",
    available: ALL,
  });
  assert.equal(r.tier, "haiku");
});

test("refuses a downgrade that would rebuild a large prompt cache", () => {
  const r = decide({
    prompt: "x",
    jev: jev("haiku"),
    current: "opus",
    available: ALL,
    contextTokens: THRESHOLDS.downgradeMaxContextTokens + 1,
  });
  assert.equal(r.tier, "opus");
  assert.match(r.reason, /downgrade-not-worth-cache-rebuild/);
});

test("a large context still allows an upgrade", () => {
  const r = decide({
    prompt: "x",
    jev: jev("opus"),
    current: "haiku",
    available: ALL,
    contextTokens: 500_000,
  });
  assert.equal(r.tier, "opus");
});

test("an unavailable tier steps up, never silently down", () => {
  const r = decide({ prompt: "x", jev: jev("haiku"), current: "opus", available: ["sonnet", "opus"] });
  assert.equal(r.tier, "sonnet");
  assert.match(r.reason, /\+unavailable/);
});

test("stepping up never lands on fable unless fable was asked for", () => {
  assert.equal(clampToAvailable("opus", ["haiku", "fable"]), "haiku");
  assert.equal(clampToAvailable("fable", ["haiku", "fable"]), "fable");
});

test("no tier available at all holds the current model", () => {
  const r = decide({ prompt: "x", jev: jev("opus"), current: "sonnet", available: [] });
  assert.equal(r.tier, "sonnet");
  assert.equal(r.changed, false);
});

test("a decision that changes nothing is marked so", () => {
  const r = decide({ prompt: "x", jev: jev("sonnet"), current: "sonnet", available: ALL });
  assert.equal(r.changed, false);
  assert.equal(r.reason, "jev/no-change");
});
