# Release notes — v0.6.2

## Highlights

This release packages the post-0.6.1 foreground grouped subagent result card suppression update for the tlh-maintained fork without changing the public intercom tool contract.

## pi-intercom

- suppresses local inline cards for foreground `subagent:result-intercom` deliveries that target the current orchestrator session
- still acknowledges foreground result delivery and clears stale queued child progress updates for the completed run
- preserves existing async grouped result delivery behavior for other sessions and non-foreground result relays

## Packaging

- scoped package: `@diegopetrucci/pi-intercom@0.6.2`
- git tag: `tlh-v0.6.2`
- publish access: `public`
- repository: `https://github.com/diegopetrucci/pi-intercom`

## Install

```bash
pi install npm:@diegopetrucci/pi-intercom@0.6.2
```

Then reload Pi:

```text
/reload
```

## Publish handoff

- release docs and manual release steps are tracked in `docs/publish-checklist-v0.6.2.md`
- Human-only: npm publish depends on the authenticated npm session
- commit, PR, tag, and GitHub release steps can be performed later with explicit maintainer approval

## Validation status

- release-candidate validation for `@diegopetrucci/pi-intercom@0.6.2` is tracked in `docs/publish-checklist-v0.6.2.md`
- npm registry availability was checked with `npm view @diegopetrucci/pi-intercom@0.6.2 version --json` and returned the expected not-yet-published 404
- `npm test` passed locally
- `npm pack --dry-run --json` was inspected locally before publish handoff
