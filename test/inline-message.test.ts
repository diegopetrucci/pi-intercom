import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@mariozechner/pi-tui";
import { InlineMessageComponent } from "../ui/inline-message.ts";
import type { Message, SessionInfo } from "../types.ts";

const theme = {
  fg(_name: string, text: string): string {
    return text;
  },
};

const from: SessionInfo = {
  id: "session-12345678",
  name: "sender",
  cwd: "/tmp/project",
  model: "model",
  pid: 1,
  startedAt: 0,
  lastActivity: 0,
};

const longMessage: Message = {
  id: "message-1",
  timestamp: 0,
  content: {
    text: [
      "First preview line stays visible.",
      "Second preview line stays visible.",
      "Third hidden line should only be available after expansion.",
      "UNSEEN_ENDING should not appear in the collapsed preview.",
    ].join("\n"),
  },
};

const blankSeparatedMessage: Message = {
  id: "message-blank-separated",
  timestamp: 0,
  content: {
    text: [
      "First meaningful preview line stays visible.",
      "",
      "Second meaningful preview line skips over the blank line.",
      "Third meaningful line should remain hidden.",
    ].join("\n"),
  },
};

const subagentResultMessage: Message = {
  id: "message-subagent-result",
  timestamp: 0,
  content: {
    text: [
      "subagent results",
      "",
      "Run: 78f659a3",
      "Mode: fanout",
      "Status: completed",
      "Children: 2 completed, 0 failed",
      "",
      "Child: worker-a completed its assigned implementation.",
      "Session: subagent-worker-a",
      "Summary: Detailed task result hidden until expanded.",
    ].join("\n"),
  },
};

function renderText(lines: string[]): string {
  return lines.join("\n");
}

function assertRenderedWidth(lines: string[], width: number): void {
  assert.ok(lines.length > 0);
  for (const line of lines) assert.equal(visibleWidth(line), width);
}

test("collapsed inline intercom messages show a compact long-body preview", () => {
  const component = new InlineMessageComponent(from, longMessage, theme as any);

  const output = renderText(component.render(80));

  assert.match(output, /First preview line stays visible/);
  assert.match(output, /Second preview line stays visible/);
  assert.doesNotMatch(output, /Third hidden line/);
  assert.doesNotMatch(output, /UNSEEN_ENDING/);
  assert.match(output, /… 2 more lines/);
  assert.match(output, /Ctrl\+O \/ app\.tools\.expand to expand/);
});

test("collapsed inline intercom messages skip blank lines when selecting previews", () => {
  const component = new InlineMessageComponent(from, blankSeparatedMessage, theme as any);

  const output = renderText(component.render(80));

  assert.match(output, /First meaningful preview line stays visible/);
  assert.match(output, /Second meaningful preview line skips over the blank line/);
  assert.doesNotMatch(output, /Third meaningful line should remain hidden/);
  assert.match(output, /… 1 more line/);
});

test("collapsed subagent-result messages show key result metadata", () => {
  const component = new InlineMessageComponent(from, subagentResultMessage, theme as any);

  const output = renderText(component.render(100));

  assert.match(output, /subagent results/);
  assert.match(output, /Run: 78f659a3/);
  assert.match(output, /Status: completed/);
  assert.match(output, /Children: 2 completed, 0 failed/);
  assert.doesNotMatch(output, /Child: worker-a/);
  assert.doesNotMatch(output, /Session: subagent-worker-a/);
  assert.doesNotMatch(output, /Summary: Detailed task result/);
});

test("expanded inline intercom messages preserve full body rendering", () => {
  const component = new InlineMessageComponent(
    from,
    longMessage,
    theme as any,
    undefined,
    undefined,
    true,
  );

  const output = renderText(component.render(80));

  assert.match(output, /First preview line stays visible/);
  assert.match(output, /Second preview line stays visible/);
  assert.match(output, /Third hidden line should only be available after expansion/);
  assert.match(output, /UNSEEN_ENDING should not appear in the collapsed preview/);
  assert.doesNotMatch(output, /app\.tools\.expand/);
});

test("collapsed reply-needed messages keep reply context visible", () => {
  const replyNeededMessage: Message = {
    ...longMessage,
    expectsReply: true,
  };
  const component = new InlineMessageComponent(
    from,
    replyNeededMessage,
    theme as any,
    "intercom({ action: \"reply\", message: \"...\" })",
  );

  const output = renderText(component.render(100));

  assert.match(output, /Ctrl\+O \/ app\.tools\.expand to read full request/);
  assert.match(output, /Reply needed/);
  assert.match(output, /intercom\(\{ action: "reply", message: "\.\.\." \}\)/);
});

test("inline intercom messages render at the available terminal width", () => {
  const collapsed = new InlineMessageComponent(from, longMessage, theme as any);
  const expanded = new InlineMessageComponent(
    from,
    longMessage,
    theme as any,
    undefined,
    undefined,
    true,
  );

  assertRenderedWidth(collapsed.render(64), 64);
  assertRenderedWidth(expanded.render(120), 120);
});
