# Release notes — v0.6.1

## Highlights

This release publishes the tlh-maintained fork as the scoped npm package `@diegopetrucci/pi-intercom@0.6.1` and rolls up the latest intercom reliability updates for blocking reply flows, timeout labeling, and runtime path resolution.

## pi-intercom

- publishes this fork to npm as `@diegopetrucci/pi-intercom@0.6.1` with public package metadata and pinned-install guidance for tlh automation
- defaults blocking reply waits for `intercom ask`, `contact_supervisor need_decision`, and `contact_supervisor interview_request` to 2 minutes
- preserves the original user-facing target label in blocking ask timeout errors while routing still uses the resolved session ID
- resolves intercom config and broker runtime files from `PI_CODING_AGENT_DIR` when set, with the existing `~/.pi/agent` fallback for normal Pi sessions
- stops expired incoming asks from remaining replyable after they time out before the receiver's current turn starts

## Packaging

- scoped package: `@diegopetrucci/pi-intercom@0.6.1`
- publish access: `public`
- repository: `https://github.com/diegopetrucci/pi-intercom`

## Install

```bash
pi install npm:@diegopetrucci/pi-intercom@0.6.1
```

Then reload Pi:

```text
/reload
```

## Validation status

- release-prep validation is tracked in `docs/publish-checklist-v0.6.1.md`
- npm registry availability was checked with `npm view @diegopetrucci/pi-intercom@0.6.1 version --json` and returned the expected not-yet-published 404
- `npm test` passed locally
- `npm pack --dry-run --json` was inspected locally before publish handoff
