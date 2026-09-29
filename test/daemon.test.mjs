import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, readBody, listen } from "./helpers.mjs";

process.env.JEV_STATUS_DIR = mkdtempSync(join(tmpdir(), "jev-test-"));
process.env.JEV_LOG_FILE = join(process.env.JEV_STATUS_DIR, "test.log");
process.env.JEV_API_KEY = "test-key";

const { startDaemon } = await import("../src/daemon.mjs");

const CATALOG = {
  data: [
    { id: "claude-opus-5", display_name: "Opus 5" },
    { id: "claude-sonnet-5", display_name: "Sonnet 5" },
    { id: "claude-haiku-4-5-20251001", display_name: "Haiku 4.5" },
    { id: "gpt-9-ignored" },
  ],
};

/** Everything the daemon forwarded, so assertions read the exact wire request. */
let seen = [];
let jevCalls = [];
let jevAnswer;
let upstream;
let daemon;

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    // One test forwards a deliberately invalid body, so this must never throw: an upstream
    // that dies without replying hangs the client rather than failing the assertion.
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    seen.push({ url: req.url, headers: req.headers, raw, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(req.url.startsWith("/v1/models") ? CATALOG : { type: "message", model: "ok" }),
    );
  });
  const upstreamPort = await listen(upstream);
  daemon = await startDaemon({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    route: async (args) => {
      jevCalls.push(args);
      if (jevAnswer instanceof Error) throw jevAnswer;
      return jevAnswer;
    },
  });
});

after(() => {
  daemon.close();
  upstream.close();
});

beforeEach(() => {
  seen = [];
  jevCalls = [];
  jevAnswer = { choice: "claude-opus-5", confidence: 0.9, ms: 10 };
});

const send = (body, headers = {}) =>
  request(daemon.port, "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer user-token", ...headers },
    body: JSON.stringify(body),
  });

const turn = (text, extra = {}) => ({
  model: "jev-auto",
  tools: [{ name: "Read", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  ...extra,
});

const forwarded = () => seen.filter((s) => s.url.startsWith("/v1/messages"));
const models = () => forwarded().map((r) => r.body.model);

test("warms the connection", async () => {
  assert.equal((await request(daemon.port, "/", { method: "HEAD" })).status, 200);
});

test("reports health without reaching upstream", async () => {
  const health = (await request(daemon.port, "/_jev/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.hasKey, true);
  assert.equal(seen.length, 0);
});

test("rewrites the sentinel to the routed model", async () => {
  await send(turn("why does checkout blank after Pay?"), { "x-claude-code-prompt-id": "p1" });
  assert.deepEqual(models(), ["claude-opus-5"]);
  assert.equal(jevCalls.length, 1);
});

test("never forwards the sentinel, even when routing throws", async () => {
  jevAnswer = new Error("network down");
  await send(turn("do a thing"), { "x-claude-code-prompt-id": "p-err" });
  assert.deepEqual(models(), ["claude-sonnet-5"], "falls back to the seed tier");
});

test("a model the human picked passes through untouched", async () => {
  await send(turn("anything", { model: "claude-haiku-4-5-20251001" }));
  assert.deepEqual(models(), ["claude-haiku-4-5-20251001"]);
  assert.equal(jevCalls.length, 0);
});

test("routes once per turn, not once per tool call", async () => {
  const id = { "x-claude-code-prompt-id": "p2" };
  await send(turn("refactor the auth module"), id);
  await send(
    {
      model: "jev-auto",
      tools: [{ name: "Read" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "refactor the auth module" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    },
    id,
  );
  assert.equal(jevCalls.length, 1, "Jev is asked only for the opening request");
  assert.deepEqual(models(), ["claude-opus-5", "claude-opus-5"]);
});

test("a new prompt id starts a new turn", async () => {
  const s = { "x-claude-code-session-id": "s-turns" };
  await send(turn("first"), { ...s, "x-claude-code-prompt-id": "a" });
  await send(turn("second"), { ...s, "x-claude-code-prompt-id": "a" });
  await send(turn("third"), { ...s, "x-claude-code-prompt-id": "b" });
  assert.equal(jevCalls.length, 2, "the repeat of prompt id \"a\" is the same turn");
});

test("conversations without a session header are told apart by their first message", async () => {
  await send(turn("conversation one"), { "x-claude-code-prompt-id": "z" });
  await send(turn("conversation two"), { "x-claude-code-prompt-id": "z" });
  assert.equal(jevCalls.length, 2, "a shared prompt id must not pin one onto the other");
});

test("detects a fresh turn without the prompt-id header", async () => {
  const s = { "x-claude-code-session-id": "s-nohdr" };
  await send(turn("no header here"), s);
  await send(
    {
      model: "jev-auto",
      tools: [{ name: "Read" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "no header here" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
      ],
    },
    s,
  );
  await send(turn("a second real turn"), s);
  assert.equal(jevCalls.length, 2, "the tool-result continuation is not a turn");
});

test("Claude Code's own side calls are not routed", async () => {
  await send(turn("summarise this"), {
    "x-claude-code-prompt-id": "p3",
    "x-claude-code-request-class": "auxiliary",
  });
  assert.equal(jevCalls.length, 0);
  assert.notEqual(models()[0], "jev-auto", "but the sentinel still gets resolved");
});

test("a subagent is pinned separately from the main thread", async () => {
  const session = { "x-claude-code-session-id": "s1" };
  await send(turn("main thread work"), { ...session, "x-claude-code-prompt-id": "p4" });
  jevAnswer = { choice: "claude-haiku-4-5-20251001", confidence: 0.9, ms: 5 };
  await send(turn("subagent work"), {
    ...session,
    "x-claude-code-agent-id": "agent-1",
    "x-claude-code-prompt-id": "p4",
    "x-claude-code-request-class": "subagent",
  });
  assert.deepEqual(models(), ["claude-opus-5", "claude-haiku-4-5-20251001"]);
});

test("strips request fields the routed tier cannot accept", async () => {
  jevAnswer = { choice: "claude-haiku-4-5-20251001", confidence: 0.95, ms: 5 };
  await send(
    turn("rename this variable", {
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      context_management: { edits: [{ type: "clear_thinking_20250101" }] },
    }),
    { "x-claude-code-prompt-id": "p5" },
  );
  const [req] = forwarded();
  assert.equal(req.body.model, "claude-haiku-4-5-20251001");
  assert.equal(req.body.thinking, undefined);
  assert.equal(req.body.output_config, undefined);
  assert.equal(req.body.context_management, undefined);
});

test("keeps thinking and effort when the tier supports them", async () => {
  await send(
    turn("hard problem", { thinking: { type: "adaptive" }, output_config: { effort: "high" } }),
    { "x-claude-code-prompt-id": "p6" },
  );
  const [req] = forwarded();
  assert.deepEqual(req.body.thinking, { type: "adaptive" });
  assert.equal(req.body.output_config.effort, "high");
});

test("forwards the caller's credentials and system prompt untouched", async () => {
  const system = [
    { type: "text", text: "attribution block" },
    { type: "text", text: "real system prompt" },
  ];
  await send(turn("hello", { system }), {
    "x-claude-code-prompt-id": "p7",
    "anthropic-beta": "some-beta,another",
    "anthropic-version": "2023-06-01",
  });
  const [req] = forwarded();
  assert.equal(req.headers.authorization, "Bearer user-token");
  assert.equal(req.headers["anthropic-beta"], "some-beta,another");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(req.body.system, system, "the system array must arrive unchanged");
});

test("repairs draft-04 MCP tool schemas Claude Code skips behind a custom base URL", async () => {
  await send(
    turn("call the tool", {
      tools: [
        {
          name: "mcp__thing",
          input_schema: {
            type: "object",
            properties: {
              a: { type: "number", minimum: 5, exclusiveMinimum: true },
              b: { type: "number", maximum: 9, exclusiveMaximum: false },
            },
          },
        },
      ],
    }),
    { "x-claude-code-prompt-id": "p8" },
  );
  const props = forwarded()[0].body.tools[0].input_schema.properties;
  assert.deepEqual(props.a, { type: "number", exclusiveMinimum: 5 });
  assert.deepEqual(props.b, { type: "number", maximum: 9 });
});

test("learns the account's real model catalog and offers it to Jev", async () => {
  await request(daemon.port, "/v1/models?limit=1000");
  await send(turn("something"), { "x-claude-code-prompt-id": "p9" });
  const ids = jevCalls[0].models.map((m) => m.id);
  assert.ok(ids.includes("claude-opus-5"));
  assert.ok(!ids.includes("gpt-9-ignored"), "non-Claude entries are not routing targets");
});

test("an unparseable body is forwarded byte-for-byte", async () => {
  const res = await request(daemon.port, "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 200);
  assert.equal(forwarded()[0].raw, "{not json");
});

test("a side call never rides the conversation's expensive pin", async () => {
  const s = { "x-claude-code-session-id": "s-side" };
  await send(turn("a hard architectural question"), { ...s, "x-claude-code-prompt-id": "c1" });
  await send(turn("summarise the conversation so far"), {
    ...s,
    "x-claude-code-prompt-id": "c2",
    "x-claude-code-request-class": "compaction",
  });
  assert.deepEqual(
    models(),
    ["claude-opus-5", "claude-sonnet-5"],
    "the compaction must not be billed at the pinned tier's rate",
  );
});

test("a side call is not upgraded above a cheap pin either", async () => {
  jevAnswer = { choice: "claude-haiku-4-5-20251001", confidence: 0.95, ms: 5 };
  const s = { "x-claude-code-session-id": "s-side2" };
  await send(turn("rename a variable"), { ...s, "x-claude-code-prompt-id": "d1" });
  await send(turn("title this"), {
    ...s,
    "x-claude-code-prompt-id": "d2",
    "x-claude-code-request-class": "auxiliary",
  });
  assert.deepEqual(models(), ["claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"]);
});

test("the same turn re-sent without a prompt-id header is not re-routed", async () => {
  // Claude Code before 2.1.283 sends no prompt id, and a single turn can span more than one
  // request whose last user message is still the same typed text. Asking Jev twice doubles
  // the cost and lets the answer differ mid-turn.
  const s = { "x-claude-code-session-id": "s-dup" };
  await send(turn("explain this regex"), s);
  await send(turn("explain this regex"), s);
  assert.equal(jevCalls.length, 1);
});

test("a different prompt in the same session is still a new turn", async () => {
  const s = { "x-claude-code-session-id": "s-dup2" };
  await send(turn("first question"), s);
  await send(turn("second question"), s);
  assert.equal(jevCalls.length, 2);
});
