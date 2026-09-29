// The setup/off round trip, against a throwaway config dir rather than the real one.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "jev-ctl-"));
process.env.CLAUDE_CONFIG_DIR = dir;
process.env.JEV_PORT = "8799"; // nothing listens here, so daemon steps just fail quietly
process.env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY = "apikey_test_test";

const { setup, off, managedEnv, readSettings, writeSettings, STATUS_LINE_MARK, keyState, keyLine } =
  await import("../scripts/ctl.mjs");

const settingsPath = join(dir, "settings.json");
const read = () => JSON.parse(readFileSync(settingsPath, "utf8"));

beforeEach(() => writeSettings({}));
after(() => rmSync(dir, { recursive: true, force: true }));

test("setup writes every key Claude Code needs before startup", async () => {
  await setup();
  const env = read().env;
  for (const [k, v] of Object.entries(managedEnv())) assert.equal(env[k], v, `${k} not written`);
});

test("setup keeps settings the user already had", async () => {
  writeSettings({ model: "opus", env: { MY_OWN: "keep me" }, permissions: { allow: ["Bash"] } });
  await setup();
  const s = read();
  assert.equal(s.model, "opus");
  assert.equal(s.env.MY_OWN, "keep me");
  assert.deepEqual(s.permissions.allow, ["Bash"]);
});

test("setup installs a status line when there is none", async () => {
  await setup();
  assert.match(read().statusLine.command, new RegExp(STATUS_LINE_MARK));
});

test("setup never replaces a status line the user chose", async () => {
  writeSettings({ statusLine: { type: "command", command: "my-own-statusline" } });
  await setup();
  assert.equal(read().statusLine.command, "my-own-statusline");
});

test("setup updates its own status line rather than duplicating it", async () => {
  await setup();
  const first = read().statusLine.command;
  await setup();
  assert.equal(read().statusLine.command, first);
});

test("off removes everything setup added", async () => {
  await setup();
  await off();
  const s = read();
  assert.equal(s.env, undefined, "an env block with nothing left in it should go too");
  assert.equal(s.statusLine, undefined);
});

test("off leaves the user's own env keys and settings alone", async () => {
  writeSettings({ model: "opus", env: { MY_OWN: "keep me" } });
  await setup();
  await off();
  const s = read();
  assert.equal(s.model, "opus");
  assert.deepEqual(s.env, { MY_OWN: "keep me" });
});

test("off leaves a value the user changed after setup", async () => {
  await setup();
  const s = read();
  s.env.ANTHROPIC_MODEL = "opus"; // they decided they want this one
  writeSettings(s);
  await off();
  assert.equal(read().env.ANTHROPIC_MODEL, "opus", "a value they changed is theirs now");
});

test("off does not touch a status line that is not ours", async () => {
  writeSettings({ statusLine: { type: "command", command: "my-own-statusline" } });
  await setup();
  await off();
  assert.equal(read().statusLine.command, "my-own-statusline");
});

test("setup is safe to run when no settings file exists at all", async () => {
  rmSync(settingsPath, { force: true });
  await setup();
  assert.equal(read().env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8799");
});

test("a module reached through a symlink still counts as the entry point", async () => {
  // On macOS /tmp is a symlink to /private/tmp. Comparing import.meta.url to
  // `file://${process.argv[1]}` fails there, and every command silently exits 0 having done
  // nothing -- which is exactly how a marketplace-installed plugin can behave.
  const { isMainModule } = await import("../src/is-main.mjs");
  const { symlinkSync, writeFileSync, mkdirSync } = await import("node:fs");
  const real = join(dir, "real");
  mkdirSync(real, { recursive: true });
  const file = join(real, "script.mjs");
  writeFileSync(file, "");
  const link = join(dir, "link.mjs");
  symlinkSync(file, link);

  const argv = process.argv[1];
  try {
    process.argv[1] = link;
    assert.equal(isMainModule(file), true, "the real path is still the entry point");
    process.argv[1] = file;
    assert.equal(isMainModule(link), true, "and so is the link");
    process.argv[1] = join(dir, "something-else.mjs");
    assert.equal(isMainModule(file), false, "a different file is not");
  } finally {
    process.argv[1] = argv;
  }
});

test("a missing entry point is not the main module", async () => {
  const { isMainModule } = await import("../src/is-main.mjs");
  const argv = process.argv[1];
  try {
    process.argv[1] = undefined;
    assert.equal(isMainModule("/anything.mjs"), false);
  } finally {
    process.argv[1] = argv;
  }
});

// --- where the key is allowed to come from ------------------------------------------------
//
// Claude Code hands plugin options to hook processes only, so a slash command runs with no
// key in its environment however correctly the key is configured. Reporting MISSING there
// sends people to re-enter a key that was never wrong.

const withoutEnvKey = async (fn) => {
  const saved = process.env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY;
  delete process.env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY;
  try {
    return await fn();
  } finally {
    process.env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY = saved;
  }
};

test("a key in this process's environment is used directly", () => {
  const k = keyState(null);
  assert.equal(k.source, "env");
  assert.equal(k.provider, "typesafe");
  assert.ok(k.ok);
});

test("with no key here, the daemon's is authoritative", async () => {
  const k = await withoutEnvKey(() => keyState({ hasKey: true, provider: "typesafe" }));
  assert.equal(k.source, "daemon");
  assert.equal(k.provider, "typesafe");
  assert.ok(k.ok, "a key the daemon holds is a working key");
});

test("the daemon's key is never reported back, only which provider it is", async () => {
  const line = await withoutEnvKey(() => keyLine(keyState({ hasKey: true, provider: "typesafe" })));
  assert.match(line, /typesafe/);
  assert.doesNotMatch(line, /apikey_|sk-or-/, "the key itself must not appear");
});

test("a key the daemon cannot place is not treated as working", async () => {
  const k = await withoutEnvKey(() => keyState({ hasKey: true, provider: null }));
  assert.equal(k.source, "daemon");
  assert.equal(k.ok, false);
});

test("no key anywhere still reports missing", async () => {
  const k = await withoutEnvKey(() => keyState({ hasKey: false, provider: null }));
  assert.equal(k.source, null);
  assert.equal(k.ok, false);
  assert.match(keyLine(k), /not set/);
});

test("a daemon that is down does not hide a missing key", async () => {
  const k = await withoutEnvKey(() => keyState(null));
  assert.equal(k.source, null);
  assert.equal(k.ok, false);
});
