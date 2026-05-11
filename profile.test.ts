import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPiAgentDir, getIntercomDir } from "./profile.js";
import { getBrokerSocketPath } from "./broker/paths.js";
import { loadConfig } from "./config.js";

const originalHome = process.env.HOME;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;

function restoreEnv(): void {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
}

afterEach(restoreEnv);

test("profile paths honor PI_CODING_AGENT_DIR and tilde expansion", () => {
  const home = join(tmpdir(), `pi-intercom-home-${process.pid}`);
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = "~/tlh agent";

  const expectedAgentDir = join(home, "tlh agent");
  assert.equal(getPiAgentDir(), expectedAgentDir);
  assert.equal(getIntercomDir(), join(expectedAgentDir, "intercom"));
  assert.equal(getBrokerSocketPath("linux"), join(expectedAgentDir, "intercom", "broker.sock"));
  assert.match(getBrokerSocketPath("win32"), /^\\\\\.\\pipe\\pi-intercom-/);
});

test("loadConfig reads from the selected profile", () => {
  const root = join(tmpdir(), `pi-intercom-profile-${process.pid}-${Date.now()}`);
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(home, ".pi", "agent", "intercom"), { recursive: true });
  mkdirSync(join(agentDir, "intercom"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "intercom", "config.json"), JSON.stringify({ enabled: true, replyHint: true }), "utf-8");
  writeFileSync(join(agentDir, "intercom", "config.json"), JSON.stringify({ enabled: false, replyHint: false }), "utf-8");

  const config = loadConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.replyHint, false);
});
