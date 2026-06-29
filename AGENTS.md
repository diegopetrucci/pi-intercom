# AGENTS

## Repository role

- This repository is the `pi-intercom` fork maintained for **The Last Harness (tlh)**.
- Fork origin: `diegopetrucci/pi-intercom`
- Upstream source of truth: `nicobailon/pi-intercom`
- Purpose: maintain a reviewable fork of the local Pi session-to-session intercom extension while preserving upstream compatibility unless an approved fork delta is required.

## Fork sync policy

- Keep this fork close to upstream `nicobailon/pi-intercom`.
- Prefer small, auditable diffs that are easy to rebase or replay during upstream sync.
- Treat upstream behavior, public tool contracts, and user-visible workflows as the default.
- Add TLH-specific behavior only when required for compatibility, safety, or clearly approved fork needs.
- Avoid speculative refactors while the fork carries local deltas.

## Important TLH / pi-intercom hotspots

- **Local IPC broker and session coordination**: `broker/` and `index.ts`
  - Intercom depends on a local broker, session registration, routing, reply tracking, and inline delivery behavior.
  - Changes here can break session discovery, send/ask/reply flows, or busy/idle delivery semantics.
- **Config and profile runtime behavior**: `config.ts` and `profile.ts`
  - Respect `$PI_CODING_AGENT_DIR`, `~/.pi/agent`, and `intercom/config.json` resolution.
  - Preserve defaults and safe fallback behavior for `enabled`, `replyHint`, `confirmSend`, and broker command settings.
- **`pi-subagents` supervisor bridge semantics**: `index.ts`, `README.md`, `skills/pi-intercom/`
  - `contact_supervisor` is child-session-only and should exist only when `pi-subagents` provides the required bridge metadata.
  - Blocking `need_decision` and `interview_request` flows require a live reply path; foreground children should fail fast and return blockers instead of hanging.
  - Keep transcript guidance and tool wording aligned with actual bridge behavior.

## Development commands

- Validation command: `npm test`

## Working rules

- Prefer the smallest correct change.
- Preserve upstream-compatible APIs, attachment shapes, and message semantics unless an approved ticket says otherwise.
- Keep user-owned configuration and on-disk state stable unless the task explicitly changes them.
- Update docs/tests together with behavior changes when they materially reduce fork risk.
- For docs-only work, inspect `git status` and `git diff`; run `npm test` when runtime behavior is touched or when confidence requires it.
