import test from "node:test";
import assert from "node:assert/strict";
import { getBrokerSocketPath } from "./paths.js";

test("getBrokerSocketPath scopes the Windows named pipe to the agent profile", () => {
  const pipePath = getBrokerSocketPath("win32", "C:/Users/rcroh/.the-last-harness/agent");
  assert.match(pipePath, /^\\\\\.\\pipe\\pi-intercom-/);
  assert.match(pipePath, /the-last-harness/);
  assert.doesNotMatch(pipePath, /broker\.sock$/);
});

test("getBrokerSocketPath uses broker.sock under the agent profile on non-Windows", () => {
  const socketPath = getBrokerSocketPath("linux", "/home/rcroh/.the-last-harness/agent");
  assert.equal(socketPath, "/home/rcroh/.the-last-harness/agent/intercom/broker.sock");
});
