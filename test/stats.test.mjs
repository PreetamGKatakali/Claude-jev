import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costOf, PRICES, CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER } from "../src/prices.mjs";
import { readUsage, makeWindow } from "../src/daemon.mjs";

const dir = mkdtempSync(join(tmpdir(), "jev-ledger-"));
process.env.JEV_LEDGER = join(dir, "ledger.jsonl");
const { record, readAll, clear } = await import("../src/ledger.mjs");

beforeEach(() => clear());
after(() => rmSync(dir, { recursive: true, force: true }));

// --- prices ---------------------------------------------------------------------------

test("prices a turn at its tier's rates", () => {
  // 1M input at $5 plus 1M output at $25 on opus.
  assert.equal(costOf({ input: 1_000_000, output: 1_000_000 }, "opus"), 30);
  assert.equal(costOf({ input: 1_000_000, output: 1_000_000 }, "haiku"), 6);
});

test("cache tokens are priced off the tier's own input rate", () => {
  const read = costOf({ cacheRead: 1_000_000 }, "opus");
  const write = costOf({ cacheWrite: 1_000_000 }, "opus");
  assert.equal(read, PRICES.opus.input * CACHE_READ_MULTIPLIER);
  assert.equal(write, PRICES.opus.input * CACHE_WRITE_MULTIPLIER);
  assert.ok(read < write, "a read must be cheaper than a write");
});

test("an unknown tier costs nothing rather than crashing a report", () => {
  assert.equal(costOf({ input: 1000 }, "nonesuch"), 0);
});

test("missing usage fields count as zero", () => {
  assert.equal(costOf({}, "opus"), 0);
});

// --- usage capture --------------------------------------------------------------------

const STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-opus-5",',
  '"usage":{"input_tokens":1200,"output_tokens":1,"cache_creation_input_tokens":800,"cache_read_input_tokens":23600}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":742}}\n\n',
];

test("reads usage out of a streamed response", () => {
  const usage = readUsage(STREAM.join(""));
  assert.deepEqual(usage, { input: 1200, output: 742, cacheWrite: 800, cacheRead: 23600 });
});

test("takes the largest output count, because it grows through the stream", () => {
  assert.equal(readUsage('"output_tokens":1 ... "output_tokens":742').output, 742);
});

test("a response with no usage reports none rather than zeroes", () => {
  assert.equal(readUsage('data: {"type":"ping"}'), null);
});

test("the window keeps both ends of a long stream", () => {
  const window = makeWindow(64);
  window.push(Buffer.from(STREAM[0] + STREAM[1]));
  for (let i = 0; i < 500; i++) window.push(Buffer.from(STREAM[2]));
  window.push(Buffer.from(STREAM[3]));
  const text = window.text();
  assert.ok(text.length < 200, "the middle of the stream is not kept");
  assert.match(text, /message_start/);
  assert.match(text, /742/);
});

test("usage survives a field split across two chunks", () => {
  // The window concatenates before matching, so a torn number is rejoined.
  const window = makeWindow(4096);
  window.push(Buffer.from('{"usage":{"input_to'));
  window.push(Buffer.from('kens":4096}}'));
  assert.equal(readUsage(window.text()).input, 4096);
});

// --- ledger ---------------------------------------------------------------------------

test("records and reads back turns in order", () => {
  record({ at: 1, tier: "haiku", input: 10, output: 2 });
  record({ at: 2, tier: "opus", input: 20, output: 4 });
  assert.deepEqual(readAll().map((t) => t.tier), ["haiku", "opus"]);
});

test("a line torn by a crash does not lose the rest of the history", async () => {
  const { appendFileSync } = await import("node:fs");
  record({ at: 1, tier: "haiku" });
  appendFileSync(process.env.JEV_LEDGER, '{"at":2,"tier":"opu\n');
  record({ at: 3, tier: "sonnet" });
  assert.deepEqual(readAll().map((t) => t.tier), ["haiku", "sonnet"]);
});

test("reading a ledger that does not exist yet is empty, not an error", () => {
  assert.deepEqual(readAll(join(dir, "nope.jsonl")), []);
});

test("routing to a cheaper tier costs less than the same tokens on opus", () => {
  const usage = { input: 50_000, output: 3_000, cacheRead: 200_000 };
  const saved = costOf(usage, "opus") - costOf(usage, "haiku");
  assert.ok(saved > 0);
});
