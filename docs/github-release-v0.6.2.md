Packages the tlh-maintained fork as `@diegopetrucci/pi-intercom@0.6.2` and captures the post-0.6.1 foreground grouped subagent result card suppression update without changing the public intercom tool contract.

## Highlights

- Scoped npm release: `@diegopetrucci/pi-intercom@0.6.2`
- Git tag: `tlh-v0.6.2`
- Foreground grouped subagent result relays targeting the current orchestrator session no longer render a duplicate local inline result card
- Foreground result delivery still acknowledges success and clears stale queued child progress updates for the completed run
- Existing async grouped result delivery behavior remains unchanged for other sessions and non-foreground relays

## Install

```bash
pi install npm:@diegopetrucci/pi-intercom@0.6.2
```

Then reload Pi:

```text
/reload
```

## Publish handoff

Commit, PR, tag, GitHub release, release-candidate validation, and human-only npm publish steps are tracked in `docs/publish-checklist-v0.6.2.md`. npm publish remains the human-only handoff because it depends on the authenticated npm session.
