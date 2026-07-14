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
const originalIntercomSurface = process.env.PI_INTERCOM_SURFACE;

function restoreEnv(): void {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
  if (originalIntercomSurface === undefined) delete process.env.PI_INTERCOM_SURFACE;
  else process.env.PI_INTERCOM_SURFACE = originalIntercomSurface;
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
  assert.equal(config.surface, "full");
});

test("loadConfig accepts configured surface values and preserves enabled semantics", () => {
  const root = join(tmpdir(), `pi-intercom-surface-${process.pid}-${Date.now()}`);
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(agentDir, "intercom"), { recursive: true });
  writeFileSync(join(agentDir, "intercom", "config.json"), JSON.stringify({ enabled: false, surface: "bridge" }), "utf-8");

  const config = loadConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.surface, "bridge");
});

test("PI_INTERCOM_SURFACE overrides config without modifying other settings", () => {
  const root = join(tmpdir(), `pi-intercom-env-surface-${process.pid}-${Date.now()}`);
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_INTERCOM_SURFACE = "off";
  mkdirSync(join(agentDir, "intercom"), { recursive: true });
  writeFileSync(join(agentDir, "intercom", "config.json"), JSON.stringify({ enabled: false, surface: "bridge", replyHint: false }), "utf-8");

  const config = loadConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.replyHint, false);
  assert.equal(config.surface, "off");
});

test("invalid configured surface warns and falls back safely", () => {
  const root = join(tmpdir(), `pi-intercom-invalid-config-surface-${process.pid}-${Date.now()}`);
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(agentDir, "intercom"), { recursive: true });
  writeFileSync(join(agentDir, "intercom", "config.json"), JSON.stringify({ surface: "shadow", enabled: false }), "utf-8");

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const config = loadConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.surface, "full");
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /config\.json#surface/);
  assert.match(warnings[0], /full\|bridge\|off/);
});

test("invalid PI_INTERCOM_SURFACE forces full instead of configured bridge", () => {
  const root = join(tmpdir(), `pi-intercom-invalid-env-surface-${process.pid}-${Date.now()}`);
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_INTERCOM_SURFACE = "sidecar";
  mkdirSync(join(agentDir, "intercom"), { recursive: true });
  writeFileSync(join(agentDir, "intercom", "config.json"), JSON.stringify({ surface: "bridge", enabled: false }), "utf-8");

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const config = loadConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.surface, "full");
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PI_INTERCOM_SURFACE/);
  assert.match(warnings[0], /sidecar/);
  assert.match(warnings[0], /full\|bridge\|off/);
});
