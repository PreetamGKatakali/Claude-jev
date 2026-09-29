#!/usr/bin/env node
// Everything the plugin's commands and hooks actually do.
//
// The slash commands are prompts, so the real work lives here where it is deterministic and
// testable. Each subcommand prints a short report and exits non-zero only when the user has
// to act.

import { isMainModule } from "../src/is-main.mjs";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProvider } from "../src/providers/index.mjs";
import { keyFingerprint } from "../src/key.mjs";
import { readLatest } from "../src/status.mjs";
import { readAll } from "../src/ledger.mjs";
import { costOf, loadPrices, PRICES_AS_OF } from "../src/prices.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.JEV_PORT ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;
/**
 * Claude Code reads its own configuration from `CLAUDE_CONFIG_DIR` when that is set, so
 * writing to a fixed `~/.claude` would edit a file it never reads.
 */
const configDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const settingsFile = () => join(configDir(), "settings.json");
const stateDir = () => join(configDir(), "claude-jev");

/**
 * The key only ever arrives through a hook process, which is where the plugin option lands.
 * A slash command runs in a plain process that Claude Code does not give plugin options to,
 * so this is empty there even when the key is configured perfectly.
 */
const apiKey = () =>
  process.env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY ??
  process.env.JEV_API_KEY ??
  process.env.OPENROUTER_API_KEY ??
  "";

/**
 * Whether a usable key exists, which is not the same question as whether *this* process can
 * see one. The daemon is started by the SessionStart hook and is the only process the key
 * reaches, so when the local environment is empty the daemon is asked instead -- reporting
 * MISSING from a command that structurally cannot see the key sends people to re-enter a key
 * that was never wrong.
 */
function keyState(up) {
  const key = apiKey();
  if (key) {
    const provider = resolveProvider(key);
    return { ok: Boolean(provider), key, provider: provider?.name ?? null, source: "env" };
  }
  if (up?.hasKey) {
    // A daemon older than this command reports no `provider` field at all. Absent is not the
    // same answer as "the key matched no provider": the daemon outlives the session that
    // started it, so it is routinely older than the command asking, and reading silence as
    // failure accuses a working install of holding a malformed key.
    if (up.provider === undefined) return { ok: true, key: "", provider: null, source: "daemon", stale: true };
    return { ok: Boolean(up.provider), key: "", provider: up.provider, source: "daemon" };
  }
  return { ok: false, key: "", provider: null, source: null };
}

/** One line describing the key, phrased for wherever it was found. */
function keyLine(k) {
  if (k.source === "env") return `${k.key.slice(0, 7)}\u2026 (${k.key.length} chars), provider ${k.provider ?? "UNRECOGNISED"}`;
  if (k.source === "daemon") {
    if (k.stale) return "held by the daemon, which predates this build - restart Claude Code to refresh it";
    return k.provider
      ? `held by the daemon, provider ${k.provider}`
      : "held by the daemon, but its format matches no known provider";
  }
  return "not set - run /plugin configure claude-jev, then restart Claude Code";
}

/**
 * The environment Claude Code needs before it starts. A plugin cannot set these itself --
 * only `agent` and `subagentStatusLine` take effect from a plugin's settings -- so they go
 * into the user's own settings file, and `off` takes them out again.
 */
const managedEnv = () => ({
  ANTHROPIC_BASE_URL: BASE,
  ANTHROPIC_MODEL: "jev-auto",
  ANTHROPIC_CUSTOM_MODEL_OPTION: "jev-auto",
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Jev Auto",
  ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Route each turn to the cheapest model that can do it",
  // Without this Claude Code issues its session-title and other side queries against the
  // sentinel, so they reach the router needing a decision they should never have needed.
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001",
  // Hint headers are off by default behind a custom base URL, because a proxy that rejects
  // unknown headers would fail the request. This one wants them.
  CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  // The sentinel is not a model Claude Code knows; defer the window check to the API.
  CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
});

const STATUS_LINE_MARK = "claude-jev";

// --- settings ------------------------------------------------------------------------

export const readSettings = () => {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
};

export const writeSettings = (settings) => {
  mkdirSync(dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`);
};

// --- daemon --------------------------------------------------------------------------

/** Asks the daemon to call the provider, for when this process has no key of its own. */
async function probeViaDaemon(timeoutMs = 8000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/_jev/probe`, { signal: abort.signal });
    // 404 means this daemon is older than the command: the path did not exist yet.
    if (res.status === 404) return { unsupported: true };
    if (!res.ok) return { error: `daemon answered ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: err.name === "AbortError" ? "timed out" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function health(timeoutMs = 1000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/_jev/health`, { signal: abort.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the daemon detached so it outlives this session, and waits until it answers.
 * The key is passed in the environment and never written to disk: it arrived through
 * secure storage, and persisting it here would quietly undo that.
 */
async function start() {
  const key = apiKey();
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [join(ROOT, "src", "daemon.mjs")], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, JEV_API_KEY: key, JEV_PORT: String(PORT) },
  });
  child.unref();
  writeFileSync(join(stateDir(), "daemon.pid"), String(child.pid), { mode: 0o600 });

  for (let i = 0; i < 30; i++) {
    const up = await health(300);
    if (up) return up;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/**
 * Stops whatever is actually listening, which is not always what the pid file says: a daemon
 * can be started by hand or by a different install, and killing the recorded pid then leaves
 * the real one serving. `/_jev/health` reports the pid of the process that answered, so it is
 * the more reliable target; the file is the fallback for a daemon that has stopped answering.
 */
async function stop() {
  const up = await health();
  const pidFile = join(stateDir(), "daemon.pid");
  const recorded = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : null;
  let stopped = false;
  for (const pid of new Set([up?.pid, recorded].filter(Boolean))) {
    try {
      process.kill(pid);
      stopped = true;
    } catch {}
  }
  return stopped;
}

// --- subcommands ---------------------------------------------------------------------

/** Idempotent: starts the daemon only when nothing is answering. Used by SessionStart. */
async function ensure({ quiet = false } = {}) {
  let up = await health();
  // The daemon outlives the session that started it, which is what makes routing survive a
  // restart -- and also what would pin it to a stale key forever. This runs from the
  // SessionStart hook, the one place the current key is known, so it is where a daemon running
  // on the wrong key gets replaced: none at all (started from a slash command, which is given
  // no key) or one the user has since changed.
  if (up && apiKey() && up.keyFingerprint !== keyFingerprint(apiKey())) {
    await stop();
    up = null;
  }
  if (!up) up = await start();
  if (!up) {
    // Fail loudly here but never block the session: without the daemon, Claude Code is
    // pointed at a dead base URL and every request fails, so the user has to know.
    console.error(`claude-jev: daemon did not start on ${BASE}. Run /jev:doctor.`);
    return 1;
  }
  if (!quiet) console.log(`claude-jev: routing on ${BASE}${up.hasKey ? "" : " (no key - every turn passes through)"}`);
  return 0;
}

export async function setup() {
  const settings = readSettings();
  const env = { ...(settings.env ?? {}) };
  const want = managedEnv();
  const added = [];
  for (const [k, v] of Object.entries(want)) {
    if (env[k] !== v) {
      env[k] = v;
      added.push(k);
    }
  }
  settings.env = env;

  const statusCommand = `node "${join(ROOT, "scripts", "statusline.mjs")}"`;
  let statusNote;
  if (!settings.statusLine) {
    settings.statusLine = { type: "command", command: statusCommand };
    statusNote = "installed";
  } else if (String(settings.statusLine.command ?? "").includes(STATUS_LINE_MARK)) {
    settings.statusLine = { type: "command", command: statusCommand };
    statusNote = "updated";
  } else {
    // A status line the user chose is a deliberate choice; replacing it silently would be
    // worse than showing nothing.
    statusNote = "left alone (you already have one)";
  }

  writeSettings(settings);
  console.log(`settings   ${settingsFile()}`);
  console.log(`env        ${added.length ? `wrote ${added.length} keys` : "already correct"}`);
  console.log(`statusLine ${statusNote}`);

  await ensure({ quiet: true });
  const up = await health();
  console.log(`daemon     ${up ? `running on ${BASE}` : "NOT RUNNING"}`);
  const k = keyState(up);
  console.log(`key        ${keyLine(k)}`);
  console.log("");
  console.log("Restart Claude Code to activate: the environment is read at startup.");
  return up && k.ok ? 0 : 1;
}

async function doctor() {
  const checks = [];
  const settings = readSettings();
  const env = settings.env ?? {};
  const want = managedEnv();
  const missing = Object.entries(want).filter(([k, v]) => env[k] !== v).map(([k]) => k);
  // Listing nine key names when none of them are set reads as nine problems rather than one.
  const envDetail =
    missing.length === 0
      ? `all ${Object.keys(want).length} keys set`
      : missing.length === Object.keys(want).length
        ? "not configured - run /jev:setup"
        : `${missing.length} missing or changed: ${missing.join(", ")}`;
  checks.push(["settings env block", missing.length === 0, envDetail]);

  const live = process.env.ANTHROPIC_BASE_URL === BASE;
  checks.push(["this session is routed", live, live ? BASE : `ANTHROPIC_BASE_URL is ${process.env.ANTHROPIC_BASE_URL ?? "unset"} - restart Claude Code`]);

  const up = await health();
  checks.push(["daemon", Boolean(up), up ? `up on ${BASE}, pid ${up.pid}` : `nothing answering on ${BASE}`]);

  const k = keyState(up);
  checks.push(["key", Boolean(k.source), keyLine(k)]);
  checks.push([
    "provider",
    Boolean(k.provider) || Boolean(k.stale),
    k.provider ??
      (k.stale
        ? "cannot tell - the running daemon predates this build"
        : k.source
          ? "key format matches no known provider"
          : "no key to identify"),
  ]);
  if (k.stale)
    checks.push([
      "daemon build",
      false,
      "older than this plugin - restart Claude Code, which replaces it with the current one",
    ]);

  if (k.ok) {
    // When the key is only in the daemon, the daemon makes the call: this process has
    // nothing to authenticate with.
    const probe = k.source === "env"
      ? await resolveProvider(k.key).ask({
          apiKey: k.key,
          prompt: "ping",
          current: "claude-sonnet-5",
          contextTokens: 10,
          models: [{ id: "claude-sonnet-5", tier: "sonnet", description: "Sonnet 5" }],
        })
      : await probeViaDaemon();
    // An old daemon has no probe path; that is a fact about the daemon, not the provider.
    if (probe?.unsupported)
      checks.push(["provider reachable", true, "not checked - the running daemon predates this build"]);
    else checks.push(["provider reachable", !probe?.error, probe?.error ?? `answered in ${probe?.ms}ms`]);
  }

  let version = "unknown";
  try {
    version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim().split(" ")[0];
  } catch {}
  const parts = version.split(".").map(Number);
  const hasPromptId = parts[0] > 2 || (parts[0] === 2 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 283)));
  checks.push([
    "turn detection",
    true,
    hasPromptId
      ? `Claude Code ${version} sends x-claude-code-prompt-id (exact)`
      : `Claude Code ${version} predates 2.1.283, using the prompt-text fallback`,
  ]);

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "OK  " : "FAIL"}  ${name.padEnd(24)} ${detail}`);
  }
  return failed ? 1 : 0;
}

export async function off() {
  const settings = readSettings();
  const want = managedEnv();
  let removed = 0;
  if (settings.env) {
    for (const [k, v] of Object.entries(want)) {
      // Only remove what we set: a value the user changed is theirs now.
      if (settings.env[k] === v) {
        delete settings.env[k];
        removed++;
      }
    }
    if (Object.keys(settings.env).length === 0) delete settings.env;
  }
  let status = "none of ours";
  if (String(settings.statusLine?.command ?? "").includes(STATUS_LINE_MARK)) {
    delete settings.statusLine;
    status = "removed";
  }
  writeSettings(settings);
  const stopped = await stop();

  console.log(`env        removed ${removed} keys from ${settingsFile()}`);
  console.log(`statusLine ${status}`);
  console.log(`daemon     ${stopped ? "stopped" : "was not running"}`);
  console.log("");
  console.log("Restart Claude Code to go back to stock behaviour.");
  return 0;
}

async function status() {
  const up = await health();
  console.log(up ? JSON.stringify(up, null, 2) : `nothing answering on ${BASE}`);
  return up ? 0 : 1;
}

// Running directly is what the commands and the hook do; importing is what the tests do.
const pct = (n) => `${(n * 100).toFixed(0)}%`;
const usd = (n) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/** Explains the most recent routing decision. */
export async function why() {
  const status = readLatest();
  if (!status?.history?.length) {
    console.log("No routing decisions recorded yet. Send a prompt in a routed session first.");
    return 1;
  }
  const [last] = status.history.slice(-1);
  console.log(`prompt      ${last.prompt?.slice(0, 200) ?? "(none)"}`);
  console.log(`chose       ${last.model ?? last.tier}${last.confidence != null ? `  confidence ${last.confidence.toFixed(2)}` : ""}`);
  if (last.metrics) {
    const m = last.metrics;
    const row = (name, v) => (v == null ? null : `  ${name.padEnd(20)}${pct(v)}`);
    for (const line of [
      row("task complexity", m.taskComplexity),
      row("reasoning needed", m.reasoningRequired),
      row("tool complexity", m.toolComplexity),
    ]) if (line) console.log(line);
  }
  console.log(`policy      ${last.reason}`);
  if (last.error) console.log(`error       ${last.error}`);
  const cost = last.jevCost != null ? `, cost ${usd(last.jevCost)}` : "";
  if (last.jevMs != null) console.log(`decision    ${last.jevMs}ms${cost}`);

  const earlier = status.history.slice(0, -1).slice(-5).reverse();
  if (earlier.length) {
    console.log("");
    console.log("earlier this session, most recent first:");
    for (const d of earlier) {
      console.log(`  ${String(d.tier).padEnd(8)} ${(d.confidence?.toFixed(2) ?? "-").padStart(4)}  ${String(d.prompt ?? "").slice(0, 56)}`);
    }
  }
  return 0;
}

/** What routing has actually done, in tokens and in dollars. */
export async function stats() {
  const turns = readAll();
  if (!turns.length) {
    console.log("No turns recorded yet.");
    return 1;
  }
  const { prices, asOf, source } = loadPrices();
  const byTier = new Map();
  let actual = 0;
  let baseline = 0;

  for (const t of turns) {
    const usage = { input: t.input ?? 0, output: t.output ?? 0, cacheWrite: t.cacheWrite ?? 0, cacheRead: t.cacheRead ?? 0 };
    const tier = t.tier ?? "unknown";
    const row = byTier.get(tier) ?? { turns: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
    row.turns++;
    for (const k of ["input", "output", "cacheWrite", "cacheRead"]) row[k] += usage[k];
    const cost = costOf(usage, tier, prices);
    row.cost += cost;
    actual += cost;
    // The comparison is against the same tokens priced at the top tier, which is the only
    // honest baseline available: running everything on Opus would have produced different
    // responses and therefore different token counts.
    baseline += costOf(usage, "opus", prices);
    byTier.set(tier, row);
  }

  const first = new Date(turns[0].at).toISOString().slice(0, 10);
  console.log(`${turns.length} routed turns since ${first}`);
  console.log("");
  console.log("tier      turns      input     output   cache rd      cost");
  for (const [tier, r] of [...byTier].sort((a, b) => b[1].turns - a[1].turns)) {
    console.log(
      `${tier.padEnd(9)} ${String(r.turns).padStart(5)} ${String(r.input).padStart(10)} ${String(r.output).padStart(10)} ${String(r.cacheRead).padStart(10)} ${usd(r.cost).padStart(9)}`,
    );
  }
  console.log("");
  console.log(`actual                                              ${usd(actual).padStart(9)}`);
  console.log(`same tokens at Opus rates                           ${usd(baseline).padStart(9)}`);
  const saved = baseline - actual;
  console.log(`difference                                          ${usd(saved).padStart(9)}${baseline > 0 ? `  (${pct(saved / baseline)})` : ""}`);
  console.log("");
  console.log(`Prices: ${source}, as of ${asOf}. Set JEV_PRICES to a JSON file to use your own.`);
  console.log("The baseline prices these exact tokens at Opus rates. It is not a measurement:");
  console.log("a stronger model would have written different responses, so the real figure differs.");
  return 0;
}

const COMMANDS = { ensure, setup, doctor, off, status, why, stats, stop: async () => (await stop(), 0) };
if (isMainModule(import.meta.filename)) {
  const name = process.argv[2] ?? "status";
  const run = COMMANDS[name];
  if (!run) {
    console.error(`unknown command "${name}". One of: ${Object.keys(COMMANDS).join(", ")}`);
    process.exit(2);
  }
  process.exit(await run());
}

export { managedEnv, STATUS_LINE_MARK, keyState, keyLine };
