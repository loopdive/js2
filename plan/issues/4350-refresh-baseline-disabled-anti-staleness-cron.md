---
id: 4350
title: "refresh-baseline.yml was disabled, killing the 8h anti-staleness cron — the baseline went stale during merge droughts and manufactured phantom regressions"
status: done
sprint: 78
created: 2026-08-10
updated: 2026-08-18
completed: 2026-08-10
priority: high
horizon: s
feasibility: easy
task_type: bug
area: ci
goal: test-infrastructure
related: [1235, 2562, 2547, 4351, 4354]
---

# The anti-staleness cron was dead, so the baseline rotted

`refresh-baseline.yml` was `disabled_manually`. A `workflow_dispatch` returned:

```
422 Cannot trigger a 'workflow_dispatch' on a disabled workflow
```

Its own docstring states why it exists:

> a NORMAL baseline promote of current main's ACTUAL test262 state, run on a
> timer **so the baseline never goes content-stale during a stretch of
> docs/CI-only merges** (which advance main but never re-promote, because the
> test262-sharded.yml promote-baseline job only fires on test262-relevant
> pushes). Cadence: every 8h.

With it disabled the only remaining promotion path was `test262-sharded.yml`'s
`promote-baseline`, which requires a **test262-relevant push to main**. The last
successful run of this workflow was 2026-07-18 — three weeks.

## Observed failure

Nothing merged to main between 02:06 and 11:13 UTC on 2026-08-10. The baseline
sat at `3371fa1` and aged out, and the regression gate began self-reporting:

```
⚠️  baseline is 8h 31m old (commit 3371fa1) — consider force-refresh
BASELINE DRIFT WARNING (#1235): the js2wasm-baselines JSONL is 281m older than main HEAD
```

PRs measured against it showed single-test `net_per_test -1` diffs, which
hard-fail the gate and trigger `auto-park`. #4310 and #4295 were both parked on
this basis. The regressed test was **different on each run** — three distinct
bucket signatures on #4310 alone (`069346de91f7dfaf`, `e70534ab6be0e7ae`, …) —
which is the documented drift signature, not a stable defect. Both PRs
subsequently merged clean once the baseline was current, confirming the
diagnosis.

## The loop

Staleness both caused and was caused by the parking:

> stale baseline → PRs show phantom −1 → PRs park → nothing merges → no
> test262-relevant push → baseline stays stale

It broke only because an unrelated PR (#4283) happened to merge at 11:13,
promoting a fresh baseline two minutes later.

## Resolution

The workflow was re-enabled, restoring the 8h cron. Note this immediately
exposed #4354: the workflow could not produce a correct standalone baseline at
all, so re-enabling it briefly made things worse before #4355/#4356/#4357 fixed
the provider wiring. Re-enabling and #4354 must be considered together.

## Permanent repro

`tests/issue-4350-baseline-refresh-cron.test.ts` pins that
`refresh-baseline.yml` keeps a `schedule:` trigger and that its cron hour field
stays `*/N` with `N <= 8`, so the anti-staleness cadence cannot be deleted or
widened to once-daily by an edit.

**Scope limit, stated plainly:** the actual failure was GitHub-side workflow
state (`disabled_manually`), which is not represented in the repository and so
cannot be asserted by any in-repo test. This covers the in-repo half — the
schedule itself. A disabled workflow still requires the Actions UI to notice.
The same workflow's provider wiring is separately guarded by
`tests/issue-2928-e6-provider-cache.test.ts` (#4354).

## Follow-up worth considering

`auto-park` could suppress parking when the gate has emitted a
`BASELINE DRIFT WARNING` — in that state a small `net -1` is not trustworthy
evidence, and parking on it is what created the loop above.
