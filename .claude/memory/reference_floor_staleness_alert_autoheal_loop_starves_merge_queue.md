---
name: reference_floor_staleness_alert_autoheal_loop_starves_merge_queue
description: "baseline-floor-staleness-alert auto-heals a stale standalone floor by dispatching host-only refresh-baseline, which can never heal it → perpetual re-dispatch storm (57 shards each) saturates runners and starves the merge queue"
metadata: 
  node_type: memory
  type: reference
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
---

Diagnosed 2026-07-17. The merge queue stopped draining (head PR sat
`AWAITING_CHECKS` ~1h) even though a full test262 sharded run takes only ~2
min. Root cause was **runner-pool starvation**, not test duration.

## The loop

`.github/workflows/baseline-floor-staleness-alert.yml` (#2178) detects a stale
standalone/host floor and **auto-heals by dispatching `refresh-baseline.yml`**.
It triggers on `workflow_run` after EVERY "Test262 Sharded" completion (plus
hourly cron :23). But `refresh-baseline.yml` promotes the **HOST baseline only**
— it has zero standalone handling — so it can **never heal the STANDALONE
floor**. The alert therefore detects the same stale standalone floor forever and
re-dispatches refresh-baseline every ~15 min. Each dispatch spawns **57 test262
shards**, saturating the GitHub Actions runner pool, so the merge queue's
`merge_group` re-validation shards sit `queued` for runners and the head never
completes → queue won't drain.

Self-amplifying: the alert fires on Test262 Sharded completions, and the
merge_group's own Test262 Sharded runs are completions → more alert fires →
more dispatches, under any queue activity.

## Mitigation (reversible)

- `gh workflow disable baseline-floor-staleness-alert.yml -R loopdive/js2wasm`
  (surgical — stops the loop source; leaves refresh-baseline available for its
  legit 8h-scheduled + emergency use). Verify: `gh workflow list --all` shows
  `disabled_manually`.
- Cancel in-flight refresh-baseline runs to free runners now
  (`gh run cancel <id>`).
- Re-enable with `gh workflow enable` once the durable fix lands.

## Durable fix (#3381 + #3382)

Give `refresh-baseline.yml` **standalone handling** so the auto-heal actually
heals the standalone floor (the file the #1897/#2178 guard reads —
`test262-standalone-current.json` in `loopdive/js2wasm-baselines`). Then the
alert stops perpetually re-dispatching. Also **debounce** the alert so it can't
dispatch a new refresh while one is in flight (the `workflow_run`-on-every-
sharded-completion trigger is far too chatty). Related:
[[project_standalone_floor_only_on_merge_group]],
[[reference_standalone_floor_object_identity_and_real_vs_drift]].

Lesson: an auto-heal that dispatches a fix which CANNOT fix the detected
condition becomes an infinite retry storm. Any auto-heal must verify its remedy
actually clears the breach, and must not fire while a remedy is in flight.
