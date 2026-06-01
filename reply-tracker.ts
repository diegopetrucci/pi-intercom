import type { Message, SessionInfo } from "./types.ts";

export const DEFAULT_BLOCKING_REPLY_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_BLOCKING_REPLY_TIMEOUT_TEXT = "2 minutes";

export interface IntercomContext {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
  replyState?: "active" | "expired";
  replyExpiryReason?: string;
  replyStateChangedAt?: number;
}

function matchesPendingSender(context: IntercomContext, to: string): boolean {
  if (context.from.id === to) {
    return true;
  }

  return context.from.name?.toLowerCase() === to.toLowerCase();
}

function isReplyable(context: IntercomContext): boolean {
  return context.replyState !== "expired";
}

function formatExpiredReplyError(context: IntercomContext): string {
  return context.replyExpiryReason ?? `Reply to "${context.from.name || context.from.id}" expired because the sender session is no longer available.`;
}

export class ReplyTracker {
  private readonly pendingAsks = new Map<string, IntercomContext>();
  private readonly pendingTurnContexts: IntercomContext[] = [];
  private currentTurnContext: IntercomContext | null = null;

  constructor(private readonly askTimeoutMs = DEFAULT_BLOCKING_REPLY_TIMEOUT_MS) {}

  recordIncomingMessage(from: SessionInfo, message: Message, receivedAt = Date.now()): IntercomContext {
    const context: IntercomContext = {
      from,
      message,
      receivedAt,
      ...(message.expectsReply ? { replyState: "active" as const } : {}),
    };
    if (message.expectsReply) {
      this.pendingAsks.set(message.id, context);
    }
    return context;
  }

  queueTurnContext(context: IntercomContext): void {
    this.pendingTurnContexts.push(context);
  }

  beginTurn(now = Date.now()): void {
    this.pruneExpired(now);
    this.currentTurnContext = this.pendingTurnContexts.shift() ?? null;
  }

  endTurn(): void {
    this.currentTurnContext = null;
  }

  reset(): void {
    this.pendingAsks.clear();
    this.pendingTurnContexts.length = 0;
    this.currentTurnContext = null;
  }

  resolveReplyTarget(options: { to?: string }, now = Date.now()): IntercomContext {
    this.pruneExpired(now);

    const currentTurnContext = this.currentTurnContext;
    if (currentTurnContext) {
      if (!options.to || matchesPendingSender(currentTurnContext, options.to)) {
        if (!isReplyable(currentTurnContext)) {
          throw new Error(formatExpiredReplyError(currentTurnContext));
        }
        return currentTurnContext;
      }
    }

    const pending = Array.from(this.pendingAsks.values());
    const activePending = pending.filter(isReplyable);
    const expiredPending = pending.filter((context) => !isReplyable(context));

    if (options.to) {
      const matches = activePending.filter((context) => matchesPendingSender(context, options.to!));
      if (matches.length === 1) {
        return matches[0]!;
      }
      if (matches.length > 1) {
        throw new Error(`Multiple pending asks from \"${options.to}\" — use the sender session ID instead.`);
      }

      const expiredMatches = expiredPending.filter((context) => matchesPendingSender(context, options.to!));
      if (expiredMatches.length === 1) {
        throw new Error(formatExpiredReplyError(expiredMatches[0]!));
      }
      if (expiredMatches.length > 1) {
        throw new Error(`Multiple expired pending asks from \"${options.to}\" remain in history — use the sender session ID for a live target.`);
      }
      throw new Error(`No pending ask from \"${options.to}\"`);
    }

    if (activePending.length === 1) {
      return activePending[0]!;
    }

    if (activePending.length === 0) {
      if (expiredPending.length === 1) {
        throw new Error(formatExpiredReplyError(expiredPending[0]!));
      }
      if (expiredPending.length > 1) {
        throw new Error(`No replyable intercom asks remain — ${expiredPending.length} pending ask${expiredPending.length === 1 ? " has" : "s have"} expired.`);
      }
      throw new Error("No active intercom context to reply to");
    }

    throw new Error("Multiple pending asks — specify `to`");
  }

  markReplied(replyTo: string): void {
    this.pendingAsks.delete(replyTo);
    if (this.currentTurnContext?.message.id === replyTo) {
      this.currentTurnContext = null;
    }
  }

  expireReply(replyTo: string, reason: string, now = Date.now()): IntercomContext | undefined {
    const context = this.pendingAsks.get(replyTo);
    if (!context) {
      return undefined;
    }
    return this.markContextExpired(context, reason, now) ? context : undefined;
  }

  expireRepliesFromSession(sessionId: string, reason: string | ((context: IntercomContext) => string), now = Date.now()): IntercomContext[] {
    const expired: IntercomContext[] = [];
    for (const context of this.pendingAsks.values()) {
      if (context.from.id !== sessionId) {
        continue;
      }
      const expiryReason = typeof reason === "function" ? reason(context) : reason;
      if (this.markContextExpired(context, expiryReason, now)) {
        expired.push(context);
      }
    }
    return expired;
  }

  expireMissingSessions(liveSessionIds: Set<string>, reason: (context: IntercomContext) => string, now = Date.now()): IntercomContext[] {
    const expired: IntercomContext[] = [];
    for (const context of this.pendingAsks.values()) {
      if (liveSessionIds.has(context.from.id)) {
        continue;
      }
      if (this.markContextExpired(context, reason(context), now)) {
        expired.push(context);
      }
    }
    return expired;
  }

  listPending(now = Date.now()): IntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private markContextExpired(context: IntercomContext, reason: string, now: number): boolean {
    if (context.replyState === "expired") {
      return false;
    }
    context.replyState = "expired";
    context.replyExpiryReason = reason;
    context.replyStateChangedAt = now;
    return true;
  }

  private pruneExpired(now: number): void {
    for (const [messageId, context] of this.pendingAsks) {
      if (now - context.receivedAt > this.askTimeoutMs) {
        this.pendingAsks.delete(messageId);
        if (this.currentTurnContext?.message.id === messageId) {
          this.currentTurnContext = null;
        }
      }
    }
  }
}
