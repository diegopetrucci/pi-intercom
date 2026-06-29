Publishes the tlh-maintained fork as the scoped npm package `@diegopetrucci/pi-intercom@0.6.1` and includes the latest intercom reliability fixes for blocking reply flows, timeout labeling, and runtime path resolution.

## Highlights

- Scoped npm release: `@diegopetrucci/pi-intercom@0.6.1`
- Blocking reply waits for `intercom ask` and child `contact_supervisor` decision flows now default to 2 minutes
- Blocking ask timeout errors now preserve the original user-facing target label while routing still uses the resolved session ID
- Intercom config and broker runtime files now resolve from `PI_CODING_AGENT_DIR` when set, with `~/.pi/agent` fallback preserved
- Expired incoming asks no longer remain replyable after timing out before the receiver's current turn starts

## Install

```bash
pi install npm:@diegopetrucci/pi-intercom@0.6.1
```

Then reload Pi:

```text
/reload
```
