import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const probe = path.join(repositoryRoot, "scripts", "probe_acp_runtime.py");

const fakeRuntime = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  const environment = {
    home: process.env.HOME,
    homeExists: fs.existsSync(process.env.HOME),
    xdgHomes: [
      process.env.XDG_CONFIG_HOME,
      process.env.XDG_DATA_HOME,
      process.env.XDG_STATE_HOME,
      process.env.XDG_CACHE_HOME
    ],
    inheritedSecret: process.env.KILO_PROBE_TEST_SECRET ?? null
  };
  const result = request.method === "initialize"
    ? { protocolVersion: 1, agentInfo: { name: "fake", version: "1" }, environment }
    : { sessionId: "redacted-by-probe", configOptions: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  if (request.method === "session/new") {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "available_commands_update" } }
      }) + "\n");
    }, 25);
  }
});
`;

test("clean environment uses a fresh disposable HOME on every run", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "kilo-probe-test-cwd-"));
  const inheritedHome = path.join(tmpdir(), "kilo-probe-sensitive-home");
  const first = runCleanProbe(cwd, inheritedHome);
  const second = runCleanProbe(cwd, inheritedHome);

  for (const result of [first, second]) {
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const environment = payload.initialize.environment;
    assert.equal(environment.homeExists, true);
    assert.notEqual(environment.home, inheritedHome);
    assert.equal(environment.inheritedSecret, null);
    assert.ok(environment.xdgHomes.every((item) => item.startsWith(environment.home)));
    assert.equal(existsSync(environment.home), false);
    assert.deepEqual(payload.notifications, {
      count: 1,
      methods: ["session/update"],
      sessionUpdateTypes: ["available_commands_update"]
    });
  }
  assert.notEqual(
    JSON.parse(first.stdout).initialize.environment.home,
    JSON.parse(second.stdout).initialize.environment.home
  );
});

function runCleanProbe(cwd, inheritedHome) {
  return spawnSync(
    "python3",
    [
      "-B",
      probe,
      "--cwd",
      cwd,
      "--clean-env",
      "--",
      process.execPath,
      "-e",
      fakeRuntime
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: inheritedHome,
        KILO_PROBE_TEST_SECRET: "must-not-leak"
      }
    }
  );
}
