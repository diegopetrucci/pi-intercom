import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter, once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DEFAULT_BLOCKING_REPLY_TIMEOUT_MS, DEFAULT_BLOCKING_REPLY_TIMEOUT_TEXT, ReplyTracker } from "./reply-tracker.ts";
import type { Message, SessionInfo } from "./types.ts";

const repoDir = process.cwd();
const childEnvKeys = [
  "PI_SUBAGENT_ORCHESTRATOR_TARGET",
  "PI_SUBAGENT_RUN_ID",
  "PI_SUBAGENT_CHILD_AGENT",
  "PI_SUBAGENT_CHILD_INDEX",
  "PI_SUBAGENT_INTERCOM_SESSION_NAME",
  "PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH",
] as const;
const intercomEnvKeys = ["PI_INTERCOM_SURFACE"] as const;
const sharedHomeDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-home-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.HOME = sharedHomeDir;
process.env.USERPROFILE = sharedHomeDir;
process.env.PI_CODING_AGENT_DIR = path.join(sharedHomeDir, "a");
const { IntercomClient } = await import("./broker/client.ts");
process.on("exit", () => {
  process.env.HOME = previousHome;
  process.env.USERPROFILE = previousUserProfile;
  if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  rmSync(sharedHomeDir, { recursive: true, force: true });
});

async function waitForBrokerReady(broker: ChildProcessWithoutNullStreams): Promise<void> {
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Broker startup timed out"));
    }, 10000);
    const onStdout = (chunk: Buffer) => {
      if (chunk.toString().includes("Intercom broker started")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Broker exited before startup (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      broker.stdout.off("data", onStdout);
      broker.off("exit", onExit);
    };

    broker.stdout.on("data", onStdout);
    broker.once("exit", onExit);
  });

  await ready;
}

async function withChildOrchestratorEnv<T>(metadata: {
  orchestratorTarget?: string;
  runId?: string;
  agent?: string;
  index?: string;
  sessionName?: string;
  blockingSupervisorReplyPath?: "live" | "unavailable";
}, fn: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of childEnvKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  if (metadata.orchestratorTarget !== undefined) process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET = metadata.orchestratorTarget;
  if (metadata.runId !== undefined) process.env.PI_SUBAGENT_RUN_ID = metadata.runId;
  if (metadata.agent !== undefined) process.env.PI_SUBAGENT_CHILD_AGENT = metadata.agent;
  if (metadata.index !== undefined) process.env.PI_SUBAGENT_CHILD_INDEX = metadata.index;
  if (metadata.sessionName !== undefined) process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = metadata.sessionName;
  if (metadata.blockingSupervisorReplyPath !== undefined) process.env.PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH = metadata.blockingSupervisorReplyPath;
  try {
    return await fn();
  } finally {
    for (const key of childEnvKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withIntercomSurfaceEnv<T>(surface: "full" | "bridge" | "off", fn: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of intercomEnvKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.PI_INTERCOM_SURFACE = surface;
  try {
    return await fn();
  } finally {
    for (const key of intercomEnvKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface CapturedToolResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
  details?: Record<string, unknown>;
}

interface RenderToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

interface RenderedComponent {
  render(width: number): string[];
}

interface RenderTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

interface CapturedTool {
  name: string;
  parameters?: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<CapturedToolResult>;
  renderCall?: (args: Record<string, unknown>, theme: RenderTheme, context: Record<string, unknown>) => RenderedComponent;
  renderResult?: (result: RenderToolResult, options: { expanded?: boolean; isPartial?: boolean }, theme: RenderTheme, context: Record<string, unknown>) => RenderedComponent;
}

const renderTheme: RenderTheme = {
  fg: (_name, text) => text,
  bold: (text) => text,
};

function renderToText(component: RenderedComponent): string {
  return component.render(120).map((line) => line.trimEnd()).join("\n");
}

function createExtensionHarness(sessionName = "child-worker", options: {
  abort?: () => void;
  hasUI?: boolean;
  isIdle?: () => boolean;
  ui?: unknown;
} = {}) {
  const events = new EventEmitter();
  const lifecycleHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const shortcuts: string[] = [];
  const tools: CapturedTool[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const sentMessages: Array<{ message: { customType?: string; content?: string; display?: boolean; details?: unknown }; options?: { triggerTurn?: boolean; deliverAs?: string } }> = [];
  const pi = {
    getSessionName: () => sessionName,
    events: {
      on: (channel: string, handler: (payload: unknown) => void) => {
        events.on(channel, handler);
        return () => events.off(channel, handler);
      },
      emit: (channel: string, payload: unknown) => events.emit(channel, payload),
    },
    on: (event: string, handler: (payload: unknown, ctx: unknown) => unknown) => {
      const handlers = lifecycleHandlers.get(event) ?? [];
      handlers.push(handler);
      lifecycleHandlers.set(event, handlers);
    },
    registerMessageRenderer: () => undefined,
    registerTool: (tool: CapturedTool) => {
      tools.push(tool);
    },
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => {
      commands.set(name, command.handler);
    },
    registerShortcut: (key: string) => {
      shortcuts.push(key);
    },
    sendMessage: (message: { customType?: string; content?: string; display?: boolean; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: string }) => {
      sentMessages.push({ message, options });
    },
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
  };
  const ctx = {
    cwd: repoDir,
    model: { id: "child-model" },
    sessionManager: { getSessionId: () => "session-child-test" },
    isIdle: options.isIdle ?? (() => true),
    hasUI: options.hasUI ?? false,
    abort: options.abort ?? (() => undefined),
    ui: options.ui,
  };
  return {
    pi,
    ctx,
    tools,
    commands,
    shortcuts,
    entries,
    sentMessages,
    async emitLifecycle(event: string, payload: unknown = {}, eventContext: unknown = ctx) {
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        await handler(payload, eventContext);
      }
    },
  };
}

async function setupClients() {
  const broker = spawn("npx", ["--no-install", "tsx", path.join(repoDir, "broker", "broker.ts")], {
    cwd: repoDir,
    env: { ...process.env, HOME: sharedHomeDir, USERPROFILE: sharedHomeDir },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForBrokerReady(broker);
    const planner = new IntercomClient();
    const orchestrator = new IntercomClient();

    await planner.connect({
      name: "planner",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    });
    await orchestrator.connect({
      name: "orchestrator",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    });

    return {
      planner,
      orchestrator,
      cleanup: async () => {
        await planner.disconnect().catch(() => undefined);
        await orchestrator.disconnect().catch(() => undefined);
        broker.kill("SIGTERM");
        await once(broker, "exit").catch(() => undefined);
      },
    };
  } catch (error) {
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
    throw error;
  }
}

function waitForReply(client: InstanceType<typeof IntercomClient>, replyTo: string, timeoutMs = 5000): Promise<{ from: SessionInfo; message: Message; }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off("message", handler);
      reject(new Error(`Timed out waiting for reply to ${replyTo}`));
    }, timeoutMs);
    const handler = (from: SessionInfo, message: Message) => {
      if (message.replyTo !== replyTo) {
        return;
      }
      clearTimeout(timeout);
      client.off("message", handler);
      resolve({ from, message });
    };
    client.on("message", handler);
  });
}

async function expectNoMessage(client: InstanceType<typeof IntercomClient>, action: () => Promise<void>, waitMs = 150): Promise<void> {
  let messageCount = 0;
  const handler = () => {
    messageCount += 1;
  };
  client.on("message", handler);
  try {
    await action();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  } finally {
    client.off("message", handler);
  }
  assert.equal(messageCount, 0, `Expected no intercom message, saw ${messageCount}`);
}

async function waitForCondition(check: () => boolean, description: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForSessionByName(client: InstanceType<typeof IntercomClient>, name: string): Promise<SessionInfo> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const session = (await client.listSessions()).find((candidate) => candidate.name === name);
    if (session) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const sessions = await client.listSessions();
  throw new Error(`Timed out waiting for ${name}; saw ${JSON.stringify(sessions.map((session) => session.name))}`);
}

async function waitForSessionStatus(client: InstanceType<typeof IntercomClient>, name: string, status: string): Promise<SessionInfo> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const session = (await client.listSessions()).find((candidate) => candidate.name === name);
    if (session?.status === status) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const sessions = await client.listSessions();
  throw new Error(`Timed out waiting for ${name} status ${status}; saw ${JSON.stringify(sessions.map((session) => ({ name: session.name, status: session.status })))}`);
}

async function waitForSessionModel(client: InstanceType<typeof IntercomClient>, name: string, model: string): Promise<SessionInfo> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const session = (await client.listSessions()).find((candidate) => candidate.name === name);
    if (session?.model === model) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const sessions = await client.listSessions();
  throw new Error(`Timed out waiting for ${name} model ${model}; saw ${JSON.stringify(sessions.map((session) => ({ name: session.name, model: session.model })))}`);
}

test("intercom tool renders compact call and result rows", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const harness = createExtensionHarness();

  piIntercomExtension(harness.pi as never);
  const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;

  assert.ok(intercomTool.renderCall);
  assert.ok(intercomTool.renderResult);
  assert.match(renderToText(intercomTool.renderCall({
    action: "ask",
    to: "planner",
    message: "Need a decision before I continue with this implementation.",
    attachments: [{ type: "snippet", name: "note.ts", content: "const ok = true;" }],
  }, renderTheme, {})), /intercom ask → planner \(1 attachment\)\n  Need a decision/);

  const resultText = renderToText(intercomTool.renderResult({
    content: [{ type: "text", text: "Message sent to planner" }],
    details: { delivered: true, messageId: "abcdef123456" },
  }, { isPartial: false, expanded: false }, renderTheme, { isError: false, expanded: false }));
  assert.match(resultText, /✓ Message sent to planner \(abcdef12\)/);

  const errorText = renderToText(intercomTool.renderResult({
    content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
    details: { error: true, reason: "Missing target" },
  }, { isPartial: false, expanded: true }, renderTheme, { isError: false, expanded: true }));
  assert.match(errorText, /✗ Missing 'to' or 'message' parameter/);
  assert.match(errorText, /Reason: Missing target/);
});

test("contact supervisor tool renders reason and reply state", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");

  await withChildOrchestratorEnv({
    orchestratorTarget: "orchestrator",
    runId: "78f659a3",
    agent: "worker",
    index: "0",
  }, () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;

    assert.ok(supervisorTool.renderCall);
    assert.ok(supervisorTool.renderResult);
    assert.match(renderToText(supervisorTool.renderCall({
      reason: "interview_request",
      message: "Please answer these before I continue.",
      interview: { title: "API migration", questions: [] },
    }, renderTheme, {})), /contact_supervisor interview_request API migration\n  Please answer/);

    const warningText = renderToText(supervisorTool.renderResult({
      content: [{ type: "text", text: "Reply from supervisor:\nUse stable API" }],
      details: { structuredReplyParseError: "reply JSON must include a responses array" },
    }, { isPartial: false }, renderTheme, { isError: false }));
    assert.match(warningText, /⚠ Reply from supervisor:\nUse stable API/);
    assert.match(warningText, /Structured reply parse issue: reply JSON must include a responses array/);

    const failureText = renderToText(supervisorTool.renderResult({
      content: [{ type: "text", text: "Invalid reason" }],
      details: { error: true },
    }, { isPartial: false }, renderTheme, { isError: false }));
    assert.match(failureText, /✗ Invalid reason/);
  });
});

test("bridge surface omits local tools, command, and shortcut while keeping rich async result relay", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const deliveryAcks: unknown[] = [];

  await withIntercomSurfaceEnv("bridge", async () => {
    await withChildOrchestratorEnv({
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
    }, async () => {
      const harness = createExtensionHarness("orchestrator");
      harness.pi.events.on("subagent:result-intercom-delivery", (payload) => deliveryAcks.push(payload));

      piIntercomExtension(harness.pi as never);

      assert.deepEqual(harness.tools.map((tool) => tool.name), []);
      assert.deepEqual([...harness.commands.keys()], []);
      assert.deepEqual(harness.shortcuts, []);

      harness.pi.events.emit("subagent:result-intercom", {
        to: "orchestrator",
        requestId: "bridge-result-1",
        source: "async",
        message: [
          "subagent result",
          "",
          "Run: 78f659a3",
          "Agent: worker",
          "Status: completed",
          "Summary:",
          "- Added bridge-only registration gating.",
          "- Preserved acknowledgements and wake-up delivery.",
          "",
          "```json",
          '{"ok":true,"mode":"bridge"}',
          "```",
        ].join("\n"),
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(harness.sentMessages.length, 1);
      assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
      assert.equal(harness.sentMessages[0]?.options?.triggerTurn, true);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /Summary:/);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /```json/);
      assert.deepEqual(deliveryAcks, [{ requestId: "bridge-result-1", delivered: true }]);
    });
  });
});

test("bridge surface keeps broker lifecycle and control relay compatibility", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();

  try {
    await withIntercomSurfaceEnv("bridge", async () => {
      const harness = createExtensionHarness("bridge-worker", { hasUI: true });

      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      const bridgeSession = await waitForSessionByName(planner, "bridge-worker");

      const peerAsk = await planner.send(bridgeSession.id, {
        messageId: "bridge-peer-ask",
        text: "Can bridge mode receive this peer ask?",
        expectsReply: true,
      });
      assert.equal(peerAsk.delivered, true);
      await waitForCondition(() => harness.sentMessages.length === 1, "the bridge-mode inbound peer ask");
      assert.match(harness.sentMessages[0]?.message.content ?? "", /Can bridge mode receive this peer ask\?/);
      assert.doesNotMatch(harness.sentMessages[0]?.message.content ?? "", /To reply, use the intercom tool/);
      harness.sentMessages.length = 0;

      harness.pi.events.emit("subagent:control-intercom", {
        to: "bridge-worker",
        source: "foreground",
        message: "subagent needs attention\n\nworker needs attention in run 91bc2d44.",
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(harness.sentMessages.length, 1);
      assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
      assert.equal(harness.sentMessages[0]?.options?.triggerTurn, true);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /needs attention in run 91bc2d44/);

      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("off surface installs no runtime or public intercom surface", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const deliveryAcks: unknown[] = [];
  const { planner, cleanup } = await setupClients();

  try {
    await withIntercomSurfaceEnv("off", async () => {
      const harness = createExtensionHarness("off-worker");
      harness.pi.events.on("subagent:result-intercom-delivery", (payload) => deliveryAcks.push(payload));

      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      harness.pi.events.emit("subagent:result-intercom", {
        to: "off-worker",
        requestId: "off-result-1",
        source: "async",
        message: "subagent result should be ignored while off",
      });
      await new Promise((resolve) => setImmediate(resolve));

      const sessions = await planner.listSessions();
      assert.equal(sessions.some((session) => session.name === "off-worker"), false);
      assert.deepEqual(harness.tools.map((tool) => tool.name), []);
      assert.deepEqual([...harness.commands.keys()], []);
      assert.deepEqual(harness.shortcuts, []);
      assert.equal(harness.sentMessages.length, 0);
      assert.deepEqual(deliveryAcks, []);
    });
  } finally {
    await cleanup();
  }
});

test("sessions publish automatic lifecycle status", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();
  const harness = createExtensionHarness("status-worker", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    await waitForSessionStatus(planner, "status-worker", "idle");

    const freshEventContext = {
      ...harness.ctx,
      model: { id: "fresh-model" },
      sessionManager: { getSessionId: () => "session-child-test" },
    };
    await harness.emitLifecycle("model_select", { model: { id: "fresh-model" } }, freshEventContext);
    await waitForSessionModel(planner, "status-worker", "fresh-model");

    await harness.emitLifecycle("agent_start");
    await waitForSessionStatus(planner, "status-worker", "thinking");

    await harness.emitLifecycle("tool_execution_start", { toolCallId: "tool-1", toolName: "bash" });
    await waitForSessionStatus(planner, "status-worker", "tool:bash");
    await harness.emitLifecycle("tool_execution_start", { toolCallId: "tool-2", toolName: "read" });

    await harness.emitLifecycle("tool_execution_end", { toolCallId: "tool-1", toolName: "bash" });
    await waitForSessionStatus(planner, "status-worker", "tool:read");

    await harness.emitLifecycle("tool_execution_end", { toolCallId: "tool-2", toolName: "read" });
    await waitForSessionStatus(planner, "status-worker", "thinking");

    await harness.emitLifecycle("agent_end");
    await waitForSessionStatus(planner, "status-worker", "idle");
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("busy interactive sessions idle-gate top-level asks without aborting", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();
  let abortCount = 0;
  let idle = false;
  const harness = createExtensionHarness("interactive-worker", {
    abort: () => { abortCount += 1; },
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    const target = await waitForSessionByName(planner, "interactive-worker");

    const delivered = await planner.send(target.id, {
      messageId: "interactive-busy-ask",
      text: "Can you respond after your current turn?",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(abortCount, 0);
    assert.equal(harness.sentMessages.length, 0);

    idle = true;
    await harness.emitLifecycle("agent_end");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(abortCount, 0);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
    assert.equal(harness.sentMessages[0]?.options?.triggerTurn, true);
    assert.equal(harness.sentMessages[0]?.message.display, true);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /Can you respond after your current turn/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("showIncomingMessages=false injects messages with display:false while keeping content intact", { concurrency: false }, async () => {
  const intercomDir = path.join(sharedHomeDir, "a", "intercom");
  const configPath = path.join(intercomDir, "config.json");
  mkdirSync(intercomDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ showIncomingMessages: false }));

  try {
    const { default: piIntercomExtension } = await import("./index.ts");
    const { planner, cleanup } = await setupClients();
    let idle = false;
    const harness = createExtensionHarness("quiet-worker", {
      hasUI: true,
      isIdle: () => idle,
    });

    try {
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");

      const target = await waitForSessionByName(planner, "quiet-worker");

      const delivered = await planner.send(target.id, {
        messageId: "quiet-mode-ask",
        text: "Should this be hidden from the TUI?",
        expectsReply: true,
      });
      assert.equal(delivered.delivered, true);

      idle = true;
      await harness.emitLifecycle("agent_end");
      await waitForCondition(() => harness.sentMessages.length === 1, "the quiet-mode inbound message");

      assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
      assert.equal(harness.sentMessages[0]?.message.display, false);
      assert.match(harness.sentMessages[0]?.message.content ?? "", /Should this be hidden from the TUI\?/);
    } finally {
      await harness.emitLifecycle("session_shutdown");
      await cleanup();
    }
  } finally {
    unlinkSync(configPath);
  }
});

test("foreground grouped subagent results suppress local cards but still clear stale queued child progress", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const deliveryAcks: unknown[] = [];
  const { planner, cleanup } = await setupClients();
  const staleChild = new IntercomClient();
  const unrelatedChild = new IntercomClient();
  let idle = false;
  const harness = createExtensionHarness("busy-parent", {
    hasUI: true,
    isIdle: () => idle,
  });
  harness.pi.events.on("subagent:result-intercom-delivery", (payload) => deliveryAcks.push(payload));

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    await staleChild.connect({
      name: "subagent-worker-78f659a3-1",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    });
    await unrelatedChild.connect({
      name: "subagent-worker-2b7f16c4-1",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    });

    const target = await waitForSessionByName(planner, "busy-parent");
    const staleDelivered = await staleChild.send(target.id, {
      messageId: "child-progress-stale",
      text: [
        "Subagent progress update.",
        "Run: 78f659a3",
        "Agent: worker",
        "Child index: 0",
        "Child intercom target: subagent-worker-78f659a3-1",
        "",
        "This update should be suppressed after the result arrives.",
      ].join("\n"),
      subagent: {
        runId: "78f659a3",
        agent: "worker",
        index: "0",
        sessionName: "subagent-worker-78f659a3-1",
        capabilities: { blockingSupervisorReplyPath: "live" },
      },
    });
    assert.equal(staleDelivered.delivered, true);

    const unrelatedDelivered = await unrelatedChild.send(target.id, {
      messageId: "child-progress-unrelated",
      text: [
        "Subagent progress update.",
        "Run: 2b7f16c4",
        "Agent: worker",
        "Child index: 0",
        "Child intercom target: subagent-worker-2b7f16c4-1",
        "",
        "This unrelated progress update should still be delivered.",
      ].join("\n"),
      subagent: {
        runId: "2b7f16c4",
        agent: "worker",
        index: "0",
        sessionName: "subagent-worker-2b7f16c4-1",
        capabilities: { blockingSupervisorReplyPath: "live" },
      },
    });
    assert.equal(unrelatedDelivered.delivered, true);

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(harness.sentMessages.length, 0);

    harness.pi.events.emit("subagent:result-intercom", {
      to: "busy-parent",
      requestId: "result-1",
      source: "foreground",
      message: "subagent result\n\nRun: 78f659a3\nAgent: worker\nStatus: completed",
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.sentMessages.length, 0);
    assert.deepEqual(deliveryAcks, [{ requestId: "result-1", delivered: true }]);

    idle = true;
    await harness.emitLifecycle("agent_end");
    await waitForCondition(() => harness.sentMessages.length === 1, "the unrelated queued progress update");
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0]?.options?.triggerTurn, true);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /Run: 2b7f16c4/);
    assert.match(harness.sentMessages[0]?.message.content ?? "", /This unrelated progress update should still be delivered/);
    assert.doesNotMatch(harness.sentMessages[0]?.message.content ?? "", /This update should be suppressed after the result arrives/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await staleChild.disconnect().catch(() => undefined);
    await unrelatedChild.disconnect().catch(() => undefined);
    await cleanup();
  }
});

test("deferred startup connect is cancelled on shutdown", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();
  const harness = createExtensionHarness("shutdown-before-start", { hasUI: true });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await harness.emitLifecycle("session_shutdown");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const sessions = await planner.listSessions();
    assert.equal(sessions.some((session) => session.name === "shutdown-before-start"), false);
  } finally {
    await cleanup();
  }
});

test("stale overlay work stops after same-session restart", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();
  let customCalls = 0;
  let resolveFirstCustom: ((value: unknown) => void) | undefined;
  const ui = {
    notify: () => undefined,
    custom: async () => {
      customCalls += 1;
      if (customCalls > 1) {
        return { sent: false };
      }
      return new Promise((resolve) => {
        resolveFirstCustom = resolve;
      });
    },
  };
  const harness = createExtensionHarness("overlay-worker", { hasUI: true, ui });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    await waitForSessionByName(planner, "overlay-worker");

    const overlayPromise = Promise.resolve(harness.commands.get("intercom")!("", harness.ctx));
    const deadline = Date.now() + 2000;
    while (!resolveFirstCustom && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(resolveFirstCustom, "overlay should reach the session picker");

    const plannerSession = await waitForSessionByName(planner, "planner");
    await harness.emitLifecycle("session_shutdown");
    await harness.emitLifecycle("session_start");
    resolveFirstCustom(plannerSession);
    await overlayPromise;

    assert.equal(customCalls, 1);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("queued inbound messages are discarded after shutdown", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();
  let idle = false;
  const harness = createExtensionHarness("disposed-worker", {
    hasUI: true,
    isIdle: () => idle,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");
    const target = await waitForSessionByName(planner, "disposed-worker");

    const delivered = await planner.send(target.id, {
      messageId: "disposed-ask",
      text: "This should not deliver after shutdown.",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(harness.sentMessages.length, 0);

    await harness.emitLifecycle("session_shutdown");
    idle = true;
    await harness.emitLifecycle("agent_end");
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(harness.sentMessages.length, 0);
  } finally {
    await cleanup();
  }
});

test("busy non-interactive sessions auto-reply to top-level asks without aborting", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, cleanup } = await setupClients();
  let abortCount = 0;
  const harness = createExtensionHarness("pipe-worker", {
    abort: () => { abortCount += 1; },
    hasUI: false,
    isIdle: () => false,
  });

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    const target = await waitForSessionByName(planner, "pipe-worker");

    const askId = "pipe-mode-ask";
    const replyPromise = waitForReply(planner, askId, 1000);
    const delivered = await planner.send(target.id, {
      messageId: askId,
      text: "Can you respond while busy?",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);

    const reply = await replyPromise;
    assert.equal(reply.message.replyTo, askId);
    assert.match(reply.message.content.text, /non-interactive|cannot respond/i);
    assert.equal(abortCount, 0);

  } finally {
    await harness.emitLifecycle("session_shutdown");
    await cleanup();
  }
});

test("supervisor tool registers only when child metadata is present", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");

  await withChildOrchestratorEnv({}, () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    assert.deepEqual(harness.tools.map((tool) => tool.name), ["intercom"]);
  });

  await withChildOrchestratorEnv({
    orchestratorTarget: "orchestrator",
    runId: "78f659a3",
    agent: "worker",
    index: "0",
    sessionName: "subagent-worker-78f659a3-1",
  }, () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    assert.deepEqual(harness.tools.map((tool) => tool.name), ["contact_supervisor", "intercom"]);
    const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor");
    assert.match(JSON.stringify(supervisorTool?.parameters), /interview_request/);
    assert.match(JSON.stringify(supervisorTool?.parameters), /questions/);
  });
});

test("child supervisor tool resolves target and includes run metadata", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, orchestrator, cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
      sessionName: "subagent-worker-78f659a3-1",
      blockingSupervisorReplyPath: "live",
    }, async () => {
      const harness = createExtensionHarness("subagent-worker-78f659a3-1");
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");

      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;
      const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;

      const askReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const askResultPromise = supervisorTool.execute("ask-1", { reason: "need_decision", message: "Which API should I use?" }, new AbortController().signal, undefined, harness.ctx);
      const [askFrom, askMessage] = await askReceived;
      assert.equal(askMessage.expectsReply, true);
      assert.match(askMessage.content.text, /Subagent needs a supervisor decision/);
      assert.match(askMessage.content.text, /Run: 78f659a3/);
      assert.match(askMessage.content.text, /Agent: worker/);
      assert.match(askMessage.content.text, /Child index: 0/);
      assert.match(askMessage.content.text, /Which API should I use\?/);
      assert.deepEqual(askMessage.subagent, {
        runId: "78f659a3",
        agent: "worker",
        index: "0",
        sessionName: "subagent-worker-78f659a3-1",
        capabilities: { blockingSupervisorReplyPath: "live" },
      });

      const reply = await orchestrator.send(askFrom.id, { text: "Use the stable API.", replyTo: askMessage.id });
      assert.equal(reply.delivered, true);
      const askResult = await askResultPromise;
      assert.equal(askResult.isError, false);
      assert.match(askResult.content[0]?.text ?? "", /Use the stable API/);

      const updateReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const updateResult = await supervisorTool.execute("update-1", { reason: "progress_update", message: "Found a schema mismatch." }, new AbortController().signal, undefined, harness.ctx);
      const [_updateFrom, updateMessage] = await updateReceived;
      assert.equal(updateMessage.expectsReply, undefined);
      assert.match(updateMessage.content.text, /Subagent progress update/);
      assert.match(updateMessage.content.text, /Run: 78f659a3/);
      assert.match(updateMessage.content.text, /Agent: worker/);
      assert.match(updateMessage.content.text, /Found a schema mismatch/);
      assert.equal(updateMessage.subagent?.capabilities?.blockingSupervisorReplyPath, "live");
      assert.equal(updateResult.isError, false);

      const liveAskReceived = once(planner, "message") as Promise<[SessionInfo, Message]>;
      const liveAskResultPromise = intercomTool.execute("generic-ask-live", { action: "ask", to: "planner", message: "Can you verify the live reply path?" }, new AbortController().signal, undefined, harness.ctx);
      const [liveAskFrom, liveAskMessage] = await liveAskReceived;
      assert.equal(liveAskMessage.expectsReply, true);
      assert.equal(liveAskMessage.subagent?.capabilities?.blockingSupervisorReplyPath, "live");
      const liveAskReply = await planner.send(liveAskFrom.id, { text: "Live path verified.", replyTo: liveAskMessage.id });
      assert.equal(liveAskReply.delivered, true);
      const liveAskResult = await liveAskResultPromise;
      assert.equal(liveAskResult.isError, false);
      assert.match(liveAskResult.content[0]?.text ?? "", /Live path verified/);

      const interviewReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const interview = {
        title: "API migration choices",
        description: "Choose the implementation path before edits continue.",
        questions: [
          { id: "context", type: "info", question: "Migration context", context: "Use the existing auth boundary." },
          { id: "api", type: "single", question: "Which API should I target?", options: [" Stable API ", "Experimental API"] },
          { id: "notes", type: "text", question: "Any constraints to preserve?" },
        ],
      };
      const interviewResultPromise = supervisorTool.execute("interview-1", {
        reason: "interview_request",
        message: "Please answer both so I can continue safely.",
        interview,
      }, new AbortController().signal, undefined, harness.ctx);
      const [interviewFrom, interviewMessage] = await interviewReceived;
      assert.equal(interviewMessage.expectsReply, true);
      assert.match(interviewMessage.content.text, /Subagent requests a structured supervisor interview/);
      assert.match(interviewMessage.content.text, /Interview: API migration choices/);
      assert.match(interviewMessage.content.text, /\[context\] \(info\) Migration context/);
      assert.match(interviewMessage.content.text, /Info questions are context-only/);
      assert.match(interviewMessage.content.text, /\[api\] \(single\) Which API should I target\?/);
      assert.match(interviewMessage.content.text, /   - Stable API/);
      assert.match(interviewMessage.content.text, /\[notes\] \(text\) Any constraints to preserve\?/);
      assert.match(interviewMessage.content.text, /"responses"/);
      assert.doesNotMatch(interviewMessage.content.text, /"id": "context"/);

      const structuredReply = {
        responses: [
          { id: "api", value: "Stable API" },
          { id: "notes", value: "Keep the public error shape unchanged." },
        ],
      };
      const interviewReply = await orchestrator.send(interviewFrom.id, {
        text: `\`\`\`json\n${JSON.stringify(structuredReply, null, 2)}\n\`\`\``,
        replyTo: interviewMessage.id,
      });
      assert.equal(interviewReply.delivered, true);
      const interviewResult = await interviewResultPromise;
      assert.equal(interviewResult.isError, false);
      assert.match(interviewResult.content[0]?.text ?? "", /Stable API/);
      assert.deepEqual(interviewResult.details?.structuredReply, structuredReply);

      const invalidReplyReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const invalidReplyResultPromise = supervisorTool.execute("interview-invalid-reply", {
        reason: "interview_request",
        interview,
      }, new AbortController().signal, undefined, harness.ctx);
      const [invalidReplyFrom, invalidReplyMessage] = await invalidReplyReceived;
      const invalidReply = await orchestrator.send(invalidReplyFrom.id, {
        text: '{"responses":[{"id":"api","value":"Removed API"}]}',
        replyTo: invalidReplyMessage.id,
      });
      assert.equal(invalidReply.delivered, true);
      const invalidReplyResult = await invalidReplyResultPromise;
      assert.equal(invalidReplyResult.isError, false);
      assert.equal(invalidReplyResult.details?.structuredReply, undefined);
      assert.match(String(invalidReplyResult.details?.structuredReplyParseError), /must match one of the question options/);

      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("child supervisor tool rejects invalid reasons and interview payloads", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");

  await withChildOrchestratorEnv({
    orchestratorTarget: "orchestrator",
    runId: "78f659a3",
    agent: "worker",
    index: "0",
  }, async () => {
    const harness = createExtensionHarness();
    piIntercomExtension(harness.pi as never);
    const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;
    const result = await supervisorTool.execute("invalid-1", { reason: "done", message: "Finished." }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Invalid reason/);

    const missingMessageResult = await supervisorTool.execute("invalid-message", { reason: "need_decision" }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(missingMessageResult.isError, true);
    assert.match(missingMessageResult.content[0]?.text ?? "", /Missing 'message'/);

    const invalidInterviewResult = await supervisorTool.execute("invalid-interview", { reason: "interview_request", interview: { title: "Bad" } }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(invalidInterviewResult.isError, true);
    assert.match(invalidInterviewResult.content[0]?.text ?? "", /interview\.questions must be a non-empty array/);

    const invalidInfoOptionsResult = await supervisorTool.execute("invalid-info-options", {
      reason: "interview_request",
      interview: {
        questions: [{ id: "context", type: "info", question: "Context", options: ["Not an answer"] }],
      },
    }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(invalidInfoOptionsResult.isError, true);
    assert.match(invalidInfoOptionsResult.content[0]?.text ?? "", /options is only valid for single and multi questions/);
  });
});

test("child blocking asks fail fast without a live supervisor reply path while non-blocking sends still work", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, orchestrator, cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
      sessionName: "subagent-worker-78f659a3-1",
      blockingSupervisorReplyPath: "unavailable",
    }, async () => {
      const harness = createExtensionHarness("subagent-worker-78f659a3-1");
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;
      const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;

      await expectNoMessage(orchestrator, async () => {
        const result = await supervisorTool.execute("ask-unavailable", { reason: "need_decision", message: "Which API should I use?" }, new AbortController().signal, undefined, harness.ctx);
        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", /Blocking supervisor replies are unavailable in this child session/);
        assert.match(result.content[0]?.text ?? "", /contact_supervisor\(\{ reason: "progress_update"/);
      });

      await expectNoMessage(orchestrator, async () => {
        const result = await supervisorTool.execute("interview-unavailable", {
          reason: "interview_request",
          interview: {
            title: "Blocked migration",
            questions: [{ id: "api", type: "single", question: "Which API should I use?", options: ["Stable", "Experimental"] }],
          },
        }, new AbortController().signal, undefined, harness.ctx);
        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", /Blocking supervisor replies are unavailable in this child session/);
      });

      const updateReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const updateResultPromise = supervisorTool.execute("update-unavailable", { reason: "progress_update", message: "Still investigating the blocker." }, new AbortController().signal, undefined, harness.ctx);
      const [_updateFrom, updateMessage] = await updateReceived;
      assert.equal(updateMessage.expectsReply, undefined);
      assert.equal(updateMessage.subagent?.capabilities?.blockingSupervisorReplyPath, "unavailable");
      const updateResult = await updateResultPromise;
      assert.equal(updateResult.isError, false);

      await expectNoMessage(planner, async () => {
        const result = await intercomTool.execute("generic-ask-unavailable", { action: "ask", to: "planner", message: "Can you verify this?" }, new AbortController().signal, undefined, harness.ctx);
        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", /Blocking intercom asks are unavailable in this child session/);
      });

      const sendReceived = once(planner, "message") as Promise<[SessionInfo, Message]>;
      const sendResultPromise = intercomTool.execute("generic-send-unavailable", { action: "send", to: "planner", message: "FYI: I can only send non-blocking updates right now." }, new AbortController().signal, undefined, harness.ctx);
      const [_sendFrom, sendMessage] = await sendReceived;
      assert.equal(sendMessage.expectsReply, undefined);
      assert.equal(sendMessage.subagent?.capabilities?.blockingSupervisorReplyPath, "unavailable");
      const sendResult = await sendResultPromise;
      assert.equal(sendResult.isError, false);

      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("child generic intercom ask returns the unavailable-reply-path blocker before connecting", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");

  await withChildOrchestratorEnv({
    orchestratorTarget: "orchestrator",
    runId: "78f659a3",
    agent: "worker",
    index: "0",
    sessionName: "subagent-worker-78f659a3-1",
    blockingSupervisorReplyPath: "unavailable",
  }, async () => {
    const harness = createExtensionHarness("subagent-worker-78f659a3-1");
    piIntercomExtension(harness.pi as never);
    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;

    const result = await intercomTool.execute("generic-ask-unavailable-no-connect", {
      action: "ask",
      to: "planner",
      message: "Can you verify this?",
    }, new AbortController().signal, undefined, harness.ctx);

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Blocking intercom asks are unavailable in this child session/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /Intercom not connected/);
  });
});

test("legacy child metadata without reply-path capability preserves blocking asks", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, orchestrator, cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
      sessionName: "subagent-worker-78f659a3-1",
    }, async () => {
      const harness = createExtensionHarness("subagent-worker-78f659a3-1");
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;
      const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;

      const supervisorAskReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const supervisorAskResultPromise = supervisorTool.execute("legacy-supervisor-ask", { reason: "need_decision", message: "Should I keep the legacy compatibility path?" }, new AbortController().signal, undefined, harness.ctx);
      const [supervisorAskFrom, supervisorAskMessage] = await supervisorAskReceived;
      assert.equal(supervisorAskMessage.expectsReply, true);
      assert.equal(supervisorAskMessage.subagent?.capabilities?.blockingSupervisorReplyPath, undefined);
      const supervisorAskReply = await orchestrator.send(supervisorAskFrom.id, { text: "Yes, keep it for now.", replyTo: supervisorAskMessage.id });
      assert.equal(supervisorAskReply.delivered, true);
      const supervisorAskResult = await supervisorAskResultPromise;
      assert.equal(supervisorAskResult.isError, false);
      assert.match(supervisorAskResult.content[0]?.text ?? "", /keep it for now/);

      const intercomAskReceived = once(planner, "message") as Promise<[SessionInfo, Message]>;
      const intercomAskResultPromise = intercomTool.execute("legacy-intercom-ask", { action: "ask", to: "planner", message: "Can you sanity-check this fallback?" }, new AbortController().signal, undefined, harness.ctx);
      const [intercomAskFrom, intercomAskMessage] = await intercomAskReceived;
      assert.equal(intercomAskMessage.expectsReply, true);
      assert.equal(intercomAskMessage.subagent?.capabilities?.blockingSupervisorReplyPath, undefined);
      const intercomAskReply = await planner.send(intercomAskFrom.id, { text: "Fallback looks safe.", replyTo: intercomAskMessage.id });
      assert.equal(intercomAskReply.delivered, true);
      const intercomAskResult = await intercomAskResultPromise;
      assert.equal(intercomAskResult.isError, false);
      assert.match(intercomAskResult.content[0]?.text ?? "", /Fallback looks safe/);

      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("child supervisor tool preserves delivery failure reasons", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "missing-orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
    }, async () => {
      const harness = createExtensionHarness();
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;
      const updateResult = await supervisorTool.execute("update-1", { reason: "progress_update", message: "Blocked." }, new AbortController().signal, undefined, harness.ctx);
      assert.equal(updateResult.isError, true);
      assert.match(updateResult.content[0]?.text ?? "", /Session not found/);
      assert.equal(updateResult.details?.reason, "Session not found");

      const askResult = await supervisorTool.execute("ask-1", { reason: "need_decision", message: "Which path?" }, new AbortController().signal, undefined, harness.ctx);
      assert.equal(askResult.isError, true);
      assert.match(askResult.content[0]?.text ?? "", /Session not found/);

      const secondAskResult = await supervisorTool.execute("ask-2", { reason: "need_decision", message: "Still blocked." }, new AbortController().signal, undefined, harness.ctx);
      assert.equal(secondAskResult.isError, true);
      assert.match(secondAskResult.content[0]?.text ?? "", /Session not found/);
      assert.doesNotMatch(secondAskResult.content[0]?.text ?? "", /Already waiting/);
      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("child supervisor tool clears reply waiter when cancelled", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { orchestrator, cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
      sessionName: "subagent-worker-78f659a3-1",
    }, async () => {
      const harness = createExtensionHarness("subagent-worker-78f659a3-1");
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;

      const controller = new AbortController();
      const cancelledMessage = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const cancelledResultPromise = supervisorTool.execute("ask-cancelled", { reason: "need_decision", message: "Should I continue?" }, controller.signal, undefined, harness.ctx);
      await cancelledMessage;
      controller.abort();
      const cancelledResult = await cancelledResultPromise;
      assert.equal(cancelledResult.isError, true);
      assert.match(cancelledResult.content[0]?.text ?? "", /Cancelled/);

      const nextMessage = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
      const nextResultPromise = supervisorTool.execute("ask-next", { reason: "need_decision", message: "Can I ask again?" }, new AbortController().signal, undefined, harness.ctx);
      const [from, message] = await nextMessage;
      assert.match(message.content.text, /Can I ask again/);
      const reply = await orchestrator.send(from.id, { text: "Yes.", replyTo: message.id });
      assert.equal(reply.delivered, true);
      const nextResult = await nextResultPromise;
      assert.equal(nextResult.isError, false);
      assert.match(nextResult.content[0]?.text ?? "", /Yes\./);
      await harness.emitLifecycle("session_shutdown");
    });
  } finally {
    await cleanup();
  }
});

test("blocking asks use the default two-minute timeout", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, orchestrator, cleanup } = await setupClients();

  try {
    await withChildOrchestratorEnv({
      orchestratorTarget: "orchestrator",
      runId: "78f659a3",
      agent: "worker",
      index: "0",
      sessionName: "subagent-worker-78f659a3-1",
      blockingSupervisorReplyPath: "live",
    }, async () => {
      const harness = createExtensionHarness("subagent-worker-78f659a3-1");
      piIntercomExtension(harness.pi as never);
      await harness.emitLifecycle("session_start");
      const supervisorTool = harness.tools.find((tool) => tool.name === "contact_supervisor")!;
      const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
      const originalSetTimeout = globalThis.setTimeout;
      const scheduledDelays: number[] = [];
      const capturedBlockingTimeouts: Array<() => void> = [];
      // Each ask schedules its 2-minute timer synchronously, in the same tick as
      // (and immediately before) the underlying client.send() call. Track each
      // send() call's settlement in the same order so the test can await the
      // matching send before firing the corresponding captured timeout. This
      // guarantees the tool's own `await replyPromise` has already been reached
      // (production code resumes past `await connectedClient.send(...)` before
      // our tracking promise's continuation runs), so manually rejecting the
      // reply waiter can never race an unawaited promise.
      const originalSend = IntercomClient.prototype.send;
      const sendSettlements: Array<Promise<unknown>> = [];
      IntercomClient.prototype.send = function (this: InstanceType<typeof IntercomClient>, ...sendArgs: Parameters<typeof originalSend>) {
        const result = originalSend.apply(this, sendArgs);
        sendSettlements.push(result.catch(() => undefined));
        return result;
      } as typeof originalSend;

      globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        const delay = Number(timeout ?? 0);
        scheduledDelays.push(delay);
        if (delay === DEFAULT_BLOCKING_REPLY_TIMEOUT_MS) {
          // Capture the handler instead of letting it fire near-immediately, which
          // would race the ask's socket round-trip. The test fires it manually,
          // after the corresponding ask has been observed.
          capturedBlockingTimeouts.push(() => {
            if (typeof handler === "function") {
              handler(...args);
            }
          });
          // Return a real timer handle that never fires within the test's lifetime
          // so callers holding the handle (e.g. for clearTimeout) still work.
          // unref() so this stray timer never keeps the process alive.
          const staleTimer = originalSetTimeout(() => {}, 2 ** 31 - 1);
          staleTimer.unref?.();
          return staleTimer;
        }
        return originalSetTimeout(handler, delay, ...args);
      }) as typeof globalThis.setTimeout;

      try {
        const supervisorAskReceived = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
        const supervisorResultPromise = supervisorTool.execute("ask-timeout", { reason: "need_decision", message: "Should I continue?" }, new AbortController().signal, undefined, harness.ctx);
        const [_supervisorFrom, supervisorAsk] = await supervisorAskReceived;
        assert.equal(supervisorAsk.expectsReply, true);
        assert.equal(capturedBlockingTimeouts.length, 1);
        await sendSettlements[0];
        capturedBlockingTimeouts[0]!();
        const supervisorResult = await supervisorResultPromise;
        assert.equal(supervisorResult.isError, true);
        assert.ok((supervisorResult.content[0]?.text ?? "").includes(`No reply from "orchestrator" within ${DEFAULT_BLOCKING_REPLY_TIMEOUT_TEXT}`));

        const intercomAskReceived = once(planner, "message") as Promise<[SessionInfo, Message]>;
        const intercomResultPromise = intercomTool.execute("generic-ask-timeout", { action: "ask", to: "planner", message: "Can you review this?" }, new AbortController().signal, undefined, harness.ctx);
        const [_plannerFrom, plannerAsk] = await intercomAskReceived;
        assert.equal(plannerAsk.expectsReply, true);
        assert.equal(capturedBlockingTimeouts.length, 2);
        await sendSettlements[1];
        capturedBlockingTimeouts[1]!();
        const intercomResult = await intercomResultPromise;
        assert.equal(intercomResult.isError, true);
        assert.ok((intercomResult.content[0]?.text ?? "").includes(`No reply from "planner" within ${DEFAULT_BLOCKING_REPLY_TIMEOUT_TEXT}`));

        assert.ok(scheduledDelays.filter((delay) => delay === DEFAULT_BLOCKING_REPLY_TIMEOUT_MS).length >= 2);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        IntercomClient.prototype.send = originalSend;
        await harness.emitLifecycle("session_shutdown");
      }
    });
  } finally {
    await cleanup();
  }
});

test("full ask/reply round-trip works with reply target resolved from current turn context", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();
  const replyTracker = new ReplyTracker();

  try {
    const askId = "ask-current-turn";
    const askPromise = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
    const replyPromise = waitForReply(planner, askId);

    const delivered = await planner.send(orchestrator.sessionId!, {
      messageId: askId,
      text: "What should I do next?",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);

    const [from, message] = await askPromise;
    const context = replyTracker.recordIncomingMessage(from, message, Date.now());
    replyTracker.queueTurnContext(context);
    replyTracker.beginTurn(Date.now());

    const target = replyTracker.resolveReplyTarget({}, Date.now());
    const sent = await orchestrator.send(target.from.id, {
      text: "Ship it.",
      replyTo: target.message.id,
    });
    assert.equal(sent.delivered, true);
    replyTracker.markReplied(target.message.id);

    const reply = await replyPromise;
    assert.equal(reply.message.content.text, "Ship it.");
    assert.equal(reply.message.replyTo, askId);
    assert.deepEqual(replyTracker.listPending(Date.now()), []);
  } finally {
    await cleanup();
  }
});

test("subagent control intercom events wake the current orchestrator session", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const harness = createExtensionHarness("orchestrator");

  piIntercomExtension(harness.pi as never);
  harness.pi.events.emit("subagent:control-intercom", {
    to: "orchestrator",
    source: "foreground",
    message: "subagent needs attention\n\nworker needs attention in run 78f659a3.",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
  assert.match(harness.sentMessages[0]?.message.content ?? "", /From subagent-control/);
  assert.match(harness.sentMessages[0]?.message.content ?? "", /worker needs attention in run 78f659a3/);
  assert.equal(harness.sentMessages[0]?.options?.triggerTurn, true);
  await assert.doesNotReject(() => harness.emitLifecycle("turn_start"));
});

test("async subagent result intercom events still wake the current orchestrator session", async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const deliveryAcks: unknown[] = [];
  const harness = createExtensionHarness("orchestrator");
  harness.pi.events.on("subagent:result-intercom-delivery", (payload) => deliveryAcks.push(payload));

  piIntercomExtension(harness.pi as never);
  harness.pi.events.emit("subagent:result-intercom", {
    to: "orchestrator",
    requestId: "result-1",
    source: "async",
    message: "subagent result\n\nRun: 78f659a3\nAgent: worker\nStatus: completed",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0]?.message.customType, "intercom_message");
  assert.match(harness.sentMessages[0]?.message.content ?? "", /From subagent-result/);
  assert.match(harness.sentMessages[0]?.message.content ?? "", /Status: completed/);
  assert.equal(harness.sentMessages[0]?.options?.triggerTurn, true);
  assert.deepEqual(deliveryAcks, [{ requestId: "result-1", delivered: true }]);
  await assert.doesNotReject(() => harness.emitLifecycle("turn_start"));
});

test("async ask can be replied to later from the single pending ask fallback", { concurrency: false }, async () => {
  const { planner, orchestrator, cleanup } = await setupClients();
  const replyTracker = new ReplyTracker();

  try {
    const askId = "ask-later";
    const askPromise = once(orchestrator, "message") as Promise<[SessionInfo, Message]>;
    const replyPromise = waitForReply(planner, askId);

    const delivered = await planner.send(orchestrator.sessionId!, {
      messageId: askId,
      text: "Need an answer later.",
      expectsReply: true,
    });
    assert.equal(delivered.delivered, true);

    const [from, message] = await askPromise;
    replyTracker.recordIncomingMessage(from, message, Date.now());

    const target = replyTracker.resolveReplyTarget({}, Date.now());
    const sent = await orchestrator.send(target.from.id, {
      text: "Answering later worked.",
      replyTo: target.message.id,
    });
    assert.equal(sent.delivered, true);
    replyTracker.markReplied(target.message.id);

    const reply = await replyPromise;
    assert.equal(reply.message.content.text, "Answering later worked.");
    assert.equal(reply.message.replyTo, askId);
  } finally {
    await cleanup();
  }
});

test("child asks become expired and non-replyable after the child session exits", { concurrency: false }, async () => {
  const { default: piIntercomExtension } = await import("./index.ts");
  const { planner, orchestrator, cleanup } = await setupClients();
  const child = new IntercomClient();
  const harness = createExtensionHarness("orchestrator-worker");

  try {
    piIntercomExtension(harness.pi as never);
    await harness.emitLifecycle("session_start");

    await child.connect({
      name: "subagent-worker-78f659a3-1",
      cwd: repoDir,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    });

    const supervisorSession = await waitForSessionByName(planner, "orchestrator-worker");
    const delivered = await child.send(supervisorSession.id, {
      messageId: "child-ask-1",
      text: "Need a supervisor decision before I continue.",
      expectsReply: true,
      subagent: {
        runId: "78f659a3",
        agent: "worker",
        index: "0",
        sessionName: "subagent-worker-78f659a3-1",
        capabilities: { blockingSupervisorReplyPath: "live" },
      },
    });
    assert.equal(delivered.delivered, true);

    await waitForCondition(() => harness.sentMessages.length === 1, "the supervisor intercom card");

    await child.disconnect();
    await waitForCondition(() => {
      const details = harness.sentMessages[0]?.message.details as { replyCommand?: string; bodyText?: string; message?: { expectsReply?: boolean } } | undefined;
      return details?.replyCommand === undefined && details?.message?.expectsReply === false;
    }, "the child ask to expire");

    const intercomTool = harness.tools.find((tool) => tool.name === "intercom")!;
    const pendingResult = await intercomTool.execute("pending-expired-child", { action: "pending" }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(pendingResult.isError, false);
    assert.match(pendingResult.content[0]?.text ?? "", /Expired asks/);
    assert.match(pendingResult.content[0]?.text ?? "", /subagent-worker-78f659a3-1/);
    assert.match(pendingResult.content[0]?.text ?? "", /completed child session\/artifact path/);

    const replyResult = await intercomTool.execute("reply-expired-child", { action: "reply", message: "Use the stable API." }, new AbortController().signal, undefined, harness.ctx);
    assert.equal(replyResult.isError, true);
    assert.match(replyResult.content[0]?.text ?? "", /Reply to "subagent-worker-78f659a3-1" expired/);
    assert.doesNotMatch(replyResult.content[0]?.text ?? "", /Session not found/);

    const details = harness.sentMessages[0]?.message.details as { replyCommand?: string; bodyText?: string; message?: { expectsReply?: boolean } } | undefined;
    assert.equal(details?.replyCommand, undefined);
    assert.equal(details?.message?.expectsReply, false);
    assert.match(details?.bodyText ?? "", /Reply expired:/);
    assert.match(details?.bodyText ?? "", /completed child session\/artifact path/);
  } finally {
    await harness.emitLifecycle("session_shutdown");
    await child.disconnect().catch(() => undefined);
    await cleanup();
  }
});
