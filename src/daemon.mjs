// The router. A loopback proxy speaking Claude Code's Anthropic Messages format.
//
// Claude Code reaches this through ANTHROPIC_BASE_URL. Every request is forwarded upstream
// with the user's own credentials untouched; the only thing this changes is `body.model`,
// and only when the request names the routing sentinel. That single rule is what keeps a
// model the human chose with /model authoritative.
//
// The daemon is a dumb pipe on every failure path. Because ANTHROPIC_BASE_URL is set for
// the whole machine, a routing bug that failed closed would break every Claude Code session
// on it, so nothing in here may block, reject, or stall a request.

import { isMainModule } from "./is-main.mjs";
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { askJev } from "./providers/index.mjs";
import { decide, usedExactModel } from "./policy.mjs";
import {
  applyTier,
  availableTiers,
  catalogModels,
  isAuto,
  modelForTier,
  rankOf,
  tierOf,
} from "./tiers.mjs";
import { debug, log } from "./log.mjs";
import { writeDecision, writeStatus, readStatus } from "./status.mjs";
import { record } from "./ledger.mjs";

const upstreamURL = () => process.env.JEV_UPSTREAM ?? "https://api.anthropic.com";
const defaultPort = () => Number(process.env.JEV_PORT ?? 8787);

/**
 * Tier a brand-new conversation is measured against. This is the `current` the policy
 * protects when it refuses to downgrade, so it is also where an unsure first turn lands.
 * Seeding at the ceiling rather than the top of the ladder matters: on turn one there is no
 * prompt cache to preserve and no prior task to stay faithful to, so the only thing a high
 * seed buys is an expensive model for an ambiguous question.
 */
const seedTier = () => process.env.JEV_SEED_TIER ?? "sonnet";

const apiKey = () => process.env.JEV_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "";

/**
 * Claude Code rewrites draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans. Fixing it here
 * is unrelated to routing; it is the price of sitting on this path at all.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const value of Object.values(node)) sanitizeSchema(value);
}

/** Session id from the documented header, falling back to the id Claude Code embeds in metadata. */
export function sessionOf(headers = {}, body = {}) {
  const header = headers["x-claude-code-session-id"];
  if (typeof header === "string" && header) return header;
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

/**
 * Identifies the conversation a request belongs to. Subagents run through this same
 * endpoint, so keying on the session alone would let a subagent's cheap tier leak into the
 * main thread. Only stable fields may be used: Claude Code moves its `cache_control`
 * breakpoint between requests and rewrites message metadata, so the fallback is the text of
 * the first message, which is fixed once a conversation starts.
 */
const hash = (text) => createHash("sha1").update(text).digest("hex").slice(0, 16);

export function conversationKey(headers = {}, body = {}) {
  const session = sessionOf(headers, body);
  const agent = headers["x-claude-code-agent-id"] ?? "";
  if (session) return `${session}:${agent}`;
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((b) => b.type === "text").map((b) => b.text).join("")
        : "";
  return createHash("sha1").update(`${agent}|${text}`).digest("hex").slice(0, 12);
}

/** The last message with role "user", or null. */
export function lastUserMessage(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages[i];
  }
  return null;
}

/**
 * Typed text of one message's content, with Claude Code's injected `<system-reminder>`
 * blocks removed: they are noise to a router and measurably blunt Jev's confidence.
 */
export function textOf(content) {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
        : "";
  return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
}

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn runs for many requests while Claude works through tool calls, and routing each of
 * them would re-ask Jev on every tool result and let the model flip mid-task. When Claude
 * Code sends `x-claude-code-prompt-id` the answer is exact -- every request serving one
 * prompt shares the value -- and this body inspection is the fallback for the versions that
 * predate it, which is every version before 2.1.283.
 *
 * The last message is not necessarily the user's: Claude Code 2.1.236 appends a
 * `system`-role reminder after it, so the last *user* message is what has to be read. A
 * turn whose last user message carries a `tool_result` is a continuation, not a new turn.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null; // side call
  const last = lastUserMessage(body);
  if (!last) return null;
  if (Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result")) return null;
  return textOf(last.content);
}

/** Rough conversation size, used only for the cache-rebuild guard. */
export const estimateTokens = (body) =>
  Math.round(JSON.stringify(body?.messages ?? []).length / 4);

/**
 * Whether this request should be routed at all.
 *
 * `compaction` and `auxiliary` are Claude Code's own side calls -- summaries, session
 * titles, classifiers -- already issued against a cheap model. Pinning them to the
 * conversation's tier would make them cost more than doing nothing.
 */
export const isRoutableClass = (requestClass) =>
  requestClass === undefined || requestClass === "main" || requestClass === "subagent";

/**
 * Tier for a request Claude Code issues on its own behalf -- a compaction summary, a
 * session title, a classifier. These carry the sentinel but must not be routed, and they
 * must not ride the conversation's pin either: a compaction on an Opus conversation would
 * then cost Opus rates to produce a summary. The cheaper of the pin and the seed is never
 * an upgrade over either.
 */
export const sideCallTier = (pinned, seed) =>
  pinned && rankOf(pinned) < rankOf(seed) ? pinned : seed;

/** Most tokens each field reported anywhere in a response. */
const USAGE_FIELDS = {
  input: /"input_tokens"\s*:\s*(\d+)/g,
  output: /"output_tokens"\s*:\s*(\d+)/g,
  cacheWrite: /"cache_creation_input_tokens"\s*:\s*(\d+)/g,
  cacheRead: /"cache_read_input_tokens"\s*:\s*(\d+)/g,
};

/**
 * Token usage out of a streamed response.
 *
 * `message_start` carries the input and cache counts and `message_delta` carries the final
 * output count, so the two ends of the stream hold everything and the middle holds none of
 * it. Only a bounded head and tail are kept: a long response can be megabytes, and buffering
 * it to count tokens would cost more than the counting is worth. The largest value seen wins,
 * because `output_tokens` appears more than once and grows.
 */
export function readUsage(text) {
  const usage = {};
  for (const [name, pattern] of Object.entries(USAGE_FIELDS)) {
    let best = null;
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (best === null || value > best) best = value;
    }
    if (best !== null) usage[name] = best;
  }
  return Object.keys(usage).length ? usage : null;
}

/** Keeps the first and last `limit` bytes of a stream as text, and nothing in between. */
export function makeWindow(limit = 4096) {
  let head = "";
  let tail = "";
  return {
    push(chunk) {
      const text = chunk.toString("utf8");
      if (head.length < limit) head += text.slice(0, limit - head.length);
      tail = (tail + text).slice(-limit);
    },
    text: () => (head === tail ? head : `${head}\n${tail}`),
  };
}

export function startDaemon({ port = defaultPort(), upstream = upstreamURL(), route = askJev } = {}) {
  /** Tier pinned per conversation, plus the turn it was pinned for. */
  const convos = new Map();
  const catalog = new Map();

  // Upstream connections are pooled and reused: TLS handshakes to the API are far more
  // expensive than anything else this proxy does. The pool belongs to the daemon rather
  // than the global agent so that shutting down actually releases every socket.
  const target = new URL(upstream);
  const transport = target.protocol === "http:" ? http : https;
  const agent = new transport.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 256 });
  const wire = { upstream, catalog, transport, target, agent };

  const stateFor = (key) => {
    let state = convos.get(key);
    if (!state) {
      if (convos.size > 200) convos.delete(convos.keys().next().value);
      convos.set(key, (state = { tier: null, model: null, turnId: null }));
    }
    return state;
  };

  /**
   * Decides and pins the tier for one request, and rewrites the body to a real model.
   * Mutates `body`. Never throws: the caller's fallback depends on that promise being kept
   * only for the decision, not for the rewrite, which happens here unconditionally.
   */
  async function routeBody(body, headers) {
    const key = conversationKey(headers, body);
    const state = stateFor(key);
    const session = sessionOf(headers, body);
    const promptId = headers["x-claude-code-prompt-id"];
    const requestClass = headers["x-claude-code-request-class"];
    const prompt = newTurnPrompt(body);

    // Identity of the turn this request serves. `x-claude-code-prompt-id` says so exactly,
    // but it only exists from Claude Code 2.1.283. Before that, the prompt text stands in:
    // one turn can span several requests whose last user message is still the same typed
    // text, and treating each as new asks Jev the same question twice and lets the answer
    // differ between them. Two identical prompts in a row collapse into one turn, which
    // costs nothing -- the second would have got the same answer.
    const turnId = promptId ?? (prompt ? `text:${hash(prompt)}` : null);
    const freshTurn = turnId !== null && turnId !== state.turnId;

    const routable = isRoutableClass(requestClass);

    let fresh = null;
    if (routable && freshTurn && prompt) {
      const models = catalogModels([...catalog.values()]);
      const available = [...new Set(models.map((m) => m.tier))];
      const current = state.tier ?? seedTier();
      const currentModel = state.model ?? modelForTier(models, current);
      const contextTokens = estimateTokens(body);

      const jev = await route({
        apiKey: apiKey(),
        prompt,
        current: currentModel,
        contextTokens,
        models,
        sessionId: session,
      });
      // Jev answers with an exact model id; the policy reasons in tiers.
      const chosen = models.find((m) => m.id === jev?.choice);
      const answer = jev && !jev.error ? { ...jev, choice: chosen?.tier ?? tierOf(jev.choice) } : null;

      const { tier, reason } = decide({ prompt, jev: answer, current, available, contextTokens });
      const model = usedExactModel(reason, chosen?.tier, tier)
        ? chosen.id
        : tier === current
          ? currentModel
          : modelForTier(models, tier);

      state.tier = tier;
      state.model = model;
      state.turnId = turnId;
      fresh = {
        prompt: prompt.slice(0, 2000),
        tier,
        model,
        confidence: answer?.confidence ?? null,
        metrics: answer?.metrics ?? null,
        reason,
        error: jev?.error ?? null,
        jevMs: jev?.ms ?? null,
        jevCost: jev?.cost ?? null,
        at: Date.now(),
      };
      debug(
        `${key} ${jev?.error ?? `${jev?.ms}ms p=${(answer?.confidence ?? 0).toFixed(2)}`} ` +
          `${current} -> ${tier} (${reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
      );
    }

    // The sentinel is not a real model, so every request carrying it is rewritten -- the
    // tool-loop continuations that reuse the tier chosen at the start of the turn, and the
    // side calls that were never routed at all.
    const models = catalogModels([...catalog.values()]);
    const tier = routable
      ? (state.tier ?? seedTier())
      : sideCallTier(state.tier, seedTier());
    const model = routable && state.model ? state.model : modelForTier(models, tier);
    applyTier(body, tier, model);

    if (fresh) writeDecision(session || key, fresh);
    return fresh;
  }

  const server = http.createServer((req, res) => {
    // Set once a request is routed, so the response's usage can be filed against the
    // decision that produced it.
    let onUsage = null;
    // Claude Code warms the connection with `HEAD /api/hello` before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();
    if (req.url?.startsWith("/_jev/")) return serveControl(req, res, wire);

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);

      if (req.method === "POST" && /^\/v1\/messages(?:\?|$)/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));

          if (isAuto(body.model)) {
            try {
              const decision = await routeBody(body, req.headers);
              const tier = decision?.tier ?? tierOf(body.model);
              onUsage = (usage) => {
                debug(`ledger ${tier} ${decision?.reason ?? "pinned"} ${JSON.stringify(usage)}`);
                record({ at: Date.now(), tier, model: body.model, reason: decision?.reason ?? "pinned", ...usage });
              };
            } catch (err) {
              // Routing failed after the body was parsed. The sentinel is still in place and
              // would 400 upstream, so land on the seed tier rather than forwarding it.
              log(`routing failed, falling back to ${seedTier()}: ${err.message}`);
              if (isAuto(body.model)) applyTier(body, seedTier());
            }
          } else {
            // Anything else is a model the human picked, and that always wins. Only a real
            // agent turn reflects their choice: Claude Code's own tool-less side calls must
            // not flip the status line to manual mid-session.
            debug(`passthrough, user selected ${body.model}`);
            if (Array.isArray(body.tools) && body.tools.length) {
              writeStatus(sessionOf(req.headers, body), {
                manual: true,
                model: body.model,
                at: Date.now(),
              });
            }
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          // Unparseable body: forward the original bytes untouched.
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      forward(req, res, out, wire, onUsage);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        close: () => {
          server.close();
          server.closeAllConnections();
          agent.destroy();
        },
      }),
    );
  });
}


/**
 * Pipes one request upstream. Credentials, `anthropic-*` headers and the `system` array all
 * pass through untouched: the API strips Claude Code's attribution block only while it is
 * still the first entry of an unmodified array, and losing that costs every user their
 * first-party prompt caching.
 */
function forward(req, res, out, { catalog, transport, target, agent }, onUsage = null) {
  const isModels = req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "");

  const headers = { ...req.headers, host: target.host };
  delete headers["content-length"];
  if (out.length) headers["content-length"] = String(out.length);
  // The catalog has to be read as JSON, so ask for it uncompressed. Under JEV_DEBUG the
  // message stream is read too, to report the model the API says it served; that costs
  // bandwidth, which is why it is not done in normal operation.
  if (isModels || process.env.JEV_DEBUG || onUsage) delete headers["accept-encoding"];

  const upstreamReq = transport.request(
    {
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
      method: req.method,
      headers,
      agent,
    },
    (up) => {
      if (!isModels) {
        res.writeHead(up.statusCode, up.headers);
        if (process.env.JEV_DEBUG && up.statusCode >= 400) {
          const parts = [];
          up.on("data", (c) => parts.length < 8 && parts.push(c));
          up.on("end", () => debug(`upstream ${up.statusCode}: ${Buffer.concat(parts).toString().slice(0, 600)}`));
        }
        if (onUsage && up.statusCode === 200) {
          const window = makeWindow();
          up.on("data", (chunk) => window.push(chunk));
          up.on("end", () => {
            const usage = readUsage(window.text());
            if (usage) onUsage(usage);
          });
        }
        // Under JEV_DEBUG, report the model the API itself says it served, so a routing
        // decision can be confirmed from the wire instead of trusted from our own log.
        // Claude Code's UI only ever shows the model it asked for.
        if (process.env.JEV_DEBUG) {
          let found = false;
          up.on("data", (chunk) => {
            if (found) return;
            const m = /"model"\s*:\s*"([^"]+)"/.exec(chunk.toString("utf8"));
            if (!m) return;
            found = true;
            debug(`${up.statusCode} served by ${m[1]}`);
          });
        }
        return up.pipe(res);
      }
      const parts = [];
      up.on("data", (c) => parts.push(c));
      up.on("end", () => {
        const data = Buffer.concat(parts);
        const before = catalog.size;
        try {
          for (const model of JSON.parse(data.toString()).data ?? []) {
            if (tierOf(model?.id)) catalog.set(model.id, model);
          }
          debug(`catalog: ${up.statusCode}, learned ${catalog.size - before} new, ${catalog.size} total`);
        } catch (err) {
          // A gateway that cannot serve this endpoint is not an error: routing falls back to
          // the static tier table. It is logged because a silently empty catalog looks the
          // same as a working one until a new model ships and is never routed to.
          debug(`catalog: ${up.statusCode}, unreadable (${err.message}) - using the static tiers`);
        }
        const outHeaders = { ...up.headers };
        delete outHeaders["content-length"];
        res.writeHead(up.statusCode, outHeaders);
        res.end(data);
      });
    },
  );

  upstreamReq.on("error", (err) => {
    log(`upstream error: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
  });
  if (out.length) upstreamReq.write(out);
  upstreamReq.end();
}

/** `/_jev/*`: health for the SessionStart hook, status for the status line and `/jev:why`. */
function serveControl(req, res, { upstream, catalog }) {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (code, value) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === "/_jev/health") {
    return json(200, {
      ok: true,
      upstream,
      hasKey: Boolean(apiKey()),
      catalog: catalog.size,
      seedTier: seedTier(),
      availableTiers: availableTiers(),
      pid: process.pid,
    });
  }
  if (url.pathname === "/_jev/status") {
    return json(200, readStatus(url.searchParams.get("session")) ?? {});
  }
  return json(404, { error: "unknown control path" });
}

// Started directly rather than imported by a test.
if (isMainModule(import.meta.filename)) {
  const { port } = await startDaemon();
  log(`claude-jev listening on 127.0.0.1:${port} -> ${upstreamURL()}`);
  if (process.stdout.isTTY) {
    process.stdout.write(`claude-jev listening on 127.0.0.1:${port} -> ${upstreamURL()}\n`);
    if (!apiKey()) process.stdout.write("warning: no JEV_API_KEY set - every turn passes through\n");
  }
}
