---
id: 3634
title: "Baseline-promote can fail silently for hours, degrading every PR's regression gate — needs alerting + retry"
status: ready
created: 2026-07-25
priority: high
horizon: m
feasibility: medium
area: ci
goal: ci-hardening
related: [3467, 3468, 2562, 1235, 2547, 3635]
---

# #3634 — baseline-promote fails silently; every PR's regression gate degrades

## What happened (measured, 2026-07-24/25)

The job **"promote root baseline + cache per-SHA for queue merge (#3467/#3468)"**, step
*"Promote root baseline + per-SHA cache to baselines repo"*, **failed on SIX CONSECUTIVE
push-to-main runs** over ~2h45m:

| run | time | merge |
|---|---|---|
| 30130790253 | 22:23Z | #3574 |
| 30134053780 | 23:32Z | #3581 |
| 30134654044 | 23:46Z | #3580 |
| 30135274700 | 00:01Z | #3586 |
| 30137169278 | 00:49Z | #3563 |
| 30137847398 | 01:07Z | #3589 |

It then self-recovered from 01:41Z onward.

## Why it matters far beyond one job

Every failed promote leaves the baselines-repo reference un-refreshed, so **each subsequent
PR's regression gate diffs against an ever-staler baseline**. Observed on PR #3583:
`SRC_BEHIND` climbed **3 → 8** in ~70 minutes with `CONTENT_CURRENT="false"` on both runs.

#3583 was then **parked twice** on 26 then 32 "regressions" that were entirely Temporal
`skip → compile_error` rows with **zero non-Temporal regressions** — transitions it did not
cause. It merged unaided at 01:41Z once the promote recovered. **No code change was ever
needed.** Three separate manual investigations that day traced back to this single cause.

## The actual defect: nothing alerts

The push-to-main runs show as `failure` in the Actions list and **nobody watches them** —
the team watches PR checks. A silent multi-hour outage of the baseline publisher degrades
the regression gate for *every open PR* and surfaces as unrelated PRs mysteriously parking.
That misdirection is the expensive part, not the outage itself.

## Fix, in order of value

1. **ALERT on a failed baseline-promote.** This is the big one; the failure is currently
   invisible and its blast radius is every open PR.
2. **RETRY the promote step — but NEVER blindly.** Six sequential merges each pushing to the
   baselines repo smells like a push race — a retry-with-rebase would likely have absorbed
   all six. Confirm against the six job logs before assuming. **Retry MUST be conditional on
   the failure being a push race** (see "Cause 3" below): a *gate* failure is deterministic,
   so an unconditional retry loops forever, burns CI, and — worse — makes the outage
   *quieter* by hiding the real verdict behind N identical attempts.
3. **Consider making the regression gate REFUSE TO VERDICT when `SRC_BEHIND` exceeds a
   threshold**, rather than confidently diffing against a known-stale baseline and emitting
   false regressions. A gate that says *"baseline too stale to judge"* is far cheaper than a
   spurious park plus the investigation it triggers.

## Cause 3 — `trap-growth-allow` evaporates in the promote job (measured 2026-07-25/26)

**A THIRD distinct cause with the same silent symptom.** Do not pattern-match this issue onto
"push race" — the symptom (promote fails, baseline freezes, dashboard goes stale) is identical
across all three causes, and the remedy is different for each.

The baseline froze again for **~9 hours** (last good promote 15:29Z; noticed 00:26Z next day).
`baseline-summary-sync.yml` was **healthy the whole time** — active, hourly, every run SUCCESS —
it simply had nothing new to commit. The failure was upstream, in promote:

```
[trap-growth] previous:  null_deref=159 illegal_cast=74 oob=60 unreachable=3
[trap-growth] candidate: null_deref=159 illegal_cast=75 oob=60 unreachable=3 (tolerance 0)
##[error] trap category "illegal_cast" grew 74 → 75 (+1) — uncatchable-trap ratchet (#3189).
          Newly trapping: test/language/module-code/top-level-await/pending-async-dep-from-cycle.js
```

This was **not a spurious gate**. PR #3629 (#2900 module-binding fix) legitimately lets that
test run further than before, where it hits an illegal cast — and the author *anticipated it*
and declared a bounded `trap-growth-allow` with a `reason:` naming that exact test.

**The declared allowance never reached the promote job: `tolerance 0`.** The #3370 allowance is
resolved from the **change-set**, which works at PR level and does not in the post-merge promote
job.

### Why this deadlocks rather than self-heals

The promoted baseline stays at 74 while main sits at 75, so **every subsequent push fails
identically, forever** — confirmed on two consecutive merges (#3629 19:52Z, #3630 20:06Z), and
it would have continued for every merge after. Each failure compounds the staleness for every
open PR's regression gate. This is the cause that argues hardest against fix #2 being
unconditional.

### Unstick recipe (used 2026-07-26)

Prefer this over the `force_baseline_refresh=true` emergency dispatch in
`refresh-baseline.yml`, whose own description says it *ignores regressions* — plural. That
disarms the regression diff, catastrophic guard, and floor gates on the same promotion, to
clear a single measured +1.

1. **Read the census first** and confirm the only delta is the one you intend to waive.
   `--allow N` is **not per-category** — on a fresh push it would silently absorb a `null_deref`
   or `oob` delta too.
2. Re-run **the already-failed run** (`gh run rerun <id> --failed`), not a new push: its census
   is already measured, which turns the valve from "blanket tolerance" into "waive one measured
   delta".
3. Set repo var `BASELINE_TRAP_GROWTH_ALLOW=1` **before** firing the re-run — the job reads
   `vars.*` at start, so a re-run fired first picks up the old value and fails identically
   (cost us one wasted cycle).
4. **Unset it in the same session.** One successful promote re-anchors the baseline at 75, after
   which later runs compare 75 vs 75 and pass with no allowance at all.

`gh` 2.23 in this container has **no `gh variable` subcommand** — use
`gh api -X PATCH repos/{owner}/{repo}/actions/variables/{name} -f name=… -f value=…`.

### The real fix

Make a declared `trap-growth-allow` survive into the promote job (resolve it from the merge
commit's change-set, or persist the granted ceiling alongside the baseline). Until then, every
intentional trap reclassification freezes the baseline until someone notices and hand-waives it
— which is exactly the invisible-outage problem this issue exists to kill.

## Discarded hypothesis — do not chase it

The `github.actor != 'github-actions[bot]'` guard on *"promote merged report to main
baseline"* is **NOT** the problem: the actor is `github-merge-queue[bot]`, which passes that
clause. That job legitimately skips on push because the shard matrix has been
merge_group-only since the #2519 slim-down.

## Discarded hypothesis 2 — "this is a symptom of artifact storage exhaustion" (#3635)

**Do not deprioritise this issue as knock-on damage from #3635.** #3635 proposed that these
six failures were caused by Actions storage exhaustion, and therefore that the alerting +
retry asked for here was "treating a symptom". **Measured 2026-07-31, that is false:**

- **Storage is not exhausted** — an artifact was uploaded 31 s before the check. A
  quota-exhausted repo cannot upload.
- **Storage has only GROWN since these failures** (984,897 → 1,017,559 artifact rows), so
  conditions today are no better than on 2026-07-24/25.
- **These failures stopped anyway**, with nothing reclaimed by anyone.

If exhaustion had been the cause, point 2 says they should have got *worse*, not stopped.

#3635's own headline was also falsified in the same measurement: **99.1 % of those
artifacts are already `expired`** (content deleted, zero storage), so the count is a
metadata-row count and live storage is ~4.9 GB, not the ~1.2 TB a naive scale suggests.

**So this issue stands on its own merits and remains unexplained.** The alerting it asks
for is what would have surfaced the six failures at the time — independent of cause, which
is precisely the point of alerting.

## Documentation bug found alongside

CLAUDE.md states `test262-current.json` is *"refreshed by the promote-baseline job (every
push to main)"*. Observed behaviour differs: **"promote merged report to main baseline" is
SKIPPED on push**; the job that actually publishes is **"promote root baseline + cache
per-SHA"**. Anyone diagnosing this from the docs looks at the wrong job first — I did.
