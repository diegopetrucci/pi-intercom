import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BLOCKING_REPLY_TIMEOUT_MS, ReplyTracker } from "./reply-tracker.ts";
import type { Message, SessionInfo } from "./types.ts";

function createSession(id: string, name: string): SessionInfo {
  return {
    id,
    name,
    cwd: "/tmp/project",
    model: "test-model",
    pid: 1,
    startedAt: 1,
    lastActivity: 1,
  };
}

function createMessage(id: string, text: string, expectsReply = true): Message {
  return {
    id,
    timestamp: 1,
    expectsReply,
    content: { text },
  };
}

test("reply resolves from current triggered message context", () => {
  const tracker = new ReplyTracker();
  const from = createSession("planner-id", "planner");
  const message = createMessage("ask-1", "Need a decision");

  const context = tracker.recordIncomingMessage(from, message, 1000);
  tracker.queueTurnContext(context);
  tracker.beginTurn(1001);

  assert.equal(tracker.resolveReplyTarget({}, 1002).message.id, "ask-1");
  assert.equal(tracker.resolveReplyTarget({}, 1002).from.id, "planner-id");
});

test("reply resolves from single pending ask without current turn context", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  assert.equal(tracker.resolveReplyTarget({}, 1001).message.id, "ask-1");
});

test("reply with to resolves matching pending ask", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);

  assert.equal(tracker.resolveReplyTarget({ to: "reviewer" }, 1002).message.id, "ask-2");
  assert.equal(tracker.resolveReplyTarget({ to: "planner-id" }, 1002).message.id, "ask-1");
});

test("reply errors when no context and no pending asks", () => {
  const tracker = new ReplyTracker();

  assert.throws(() => tracker.resolveReplyTarget({}, 1000), /No active intercom context to reply to/);
});

test("reply errors when multiple pending asks and no to", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "First"), 1000);
  tracker.recordIncomingMessage(createSession("reviewer-id", "reviewer"), createMessage("ask-2", "Second"), 1001);

  assert.throws(() => tracker.resolveReplyTarget({}, 1002), /Multiple pending asks — specify `to`/);
});

test("reply removes pending ask after successful reply", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  tracker.markReplied("ask-1");

  assert.deepEqual(tracker.listPending(1001), []);
});

test("default blocking reply timeout expires pending asks after two minutes", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  assert.equal(tracker.listPending(1000 + DEFAULT_BLOCKING_REPLY_TIMEOUT_MS).length, 1);
  assert.deepEqual(tracker.listPending(1001 + DEFAULT_BLOCKING_REPLY_TIMEOUT_MS), []);
});

test("reply drops a queued current-turn ask once it times out before the turn starts", () => {
  const tracker = new ReplyTracker();
  const context = tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  tracker.queueTurnContext(context);
  tracker.beginTurn(1001 + DEFAULT_BLOCKING_REPLY_TIMEOUT_MS);

  assert.throws(() => tracker.resolveReplyTarget({}, 1001 + DEFAULT_BLOCKING_REPLY_TIMEOUT_MS), /No active intercom context to reply to/);
  assert.deepEqual(tracker.listPending(1001 + DEFAULT_BLOCKING_REPLY_TIMEOUT_MS), []);
});

test("reply tracker ignores missing queued turn contexts", () => {
  const tracker = new ReplyTracker();
  const context = tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-1", "Need a decision"), 1000);

  tracker.queueTurnContext(undefined);
  tracker.queueTurnContext(context);
  tracker.beginTurn(1001);

  assert.equal(tracker.resolveReplyTarget({}, 1002).message.id, "ask-1");
});

test("reply errors with the expiry reason after the sender session exits", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("child-id", "subagent-worker"), createMessage("ask-1", "Need a decision"), 1000);

  const expired = tracker.expireRepliesFromSession("child-id", "Reply expired because the child session has exited.", 1001);

  assert.equal(expired.length, 1);
  assert.throws(() => tracker.resolveReplyTarget({}, 1002), /Reply expired because the child session has exited/);
  assert.equal(tracker.listPending(1002)[0]?.replyState, "expired");
});

test("reply skips an expired current turn context when targeting another live pending ask", () => {
  const tracker = new ReplyTracker();
  const expiredContext = tracker.recordIncomingMessage(createSession("child-id", "subagent-worker"), createMessage("ask-1", "Child ask"), 1000);
  tracker.queueTurnContext(expiredContext);
  tracker.beginTurn(1001);
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-2", "Planner ask"), 1002);
  tracker.expireReply("ask-1", "Reply expired because the child session has exited.", 1003);

  const target = tracker.resolveReplyTarget({ to: "planner" }, 1004);

  assert.equal(target.message.id, "ask-2");
});

test("reply with explicit to prefers the expired matching ask over an unrelated live ask", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("child-id", "subagent-worker"), createMessage("ask-1", "Child ask"), 1000);
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-2", "Planner ask"), 1001);
  tracker.expireReply("ask-1", "Reply expired because the child session has exited.", 1002);

  assert.throws(
    () => tracker.resolveReplyTarget({ to: "child-id" }, 1003),
    /Reply expired because the child session has exited/,
  );
});

test("pending asks can be expired by live-session reconciliation", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(createSession("child-id", "subagent-worker"), createMessage("ask-1", "Child ask"), 1000);
  tracker.recordIncomingMessage(createSession("planner-id", "planner"), createMessage("ask-2", "Planner ask"), 1001);

  const expired = tracker.expireMissingSessions(new Set(["planner-id"]), () => "Reply expired because the sender session is no longer connected.", 1002);

  assert.deepEqual(expired.map((context) => context.message.id), ["ask-1"]);
  const pending = tracker.listPending(1003);
  assert.equal(pending[0]?.replyState, "expired");
  assert.equal(pending[1]?.replyState, "active");
});
