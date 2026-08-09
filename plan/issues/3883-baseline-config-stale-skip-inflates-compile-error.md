---
id: 3883
title: "The test262 baseline is configuration-stale: ~1,200 skip rows become compile_error in every candidate, and CONTENT-CURRENT cannot see it"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: ci-pipeline
language_feature: n/a
goal: n/a
sprint: current
horizon: m
es_edition: n/a
related: [3881, 2562, 1235, 3467, 3468]
---

# #3883 — The test262 baseline is configuration-stale, and `CONTENT-CURRENT` cannot see it

## Problem

**~1,200 tests that the baseline records as `skip` are attempted, and fail as
`compile_error`, in every candidate run.** The promoted baseline is
**configuration-stale** relative to every candidate — while the regression gate
reports it as **`CONTENT-CURRENT`**, because that freshness check counts
test262-relevant *commits*, not config equivalence. **It cannot see this class of
staleness by construction.**

The result: **every** regression diff produced tonight is inflated by roughly
1,200 spurious `compile_error` rows, and the gate's own freshness banner
actively reassures the reader that the baseline is sound.

## Evidence

Measured 2026-07-31 from the `test262-regressions-report` artifacts of three
independent merge_group runs. Note the third row is a run that **PASSED**:

| run | verdict | `skip` | `compile_error` |
| --- | --- | --- | --- |
| #3871 group `9d888281` | FAIL | 1312 → 108 (**−1204**) | 661 → 1852 (**+1191**) |
| #3871 group `542add71` | FAIL | 1312 → 108 (**−1204**) | 661 → 1856 (**+1195**) |
| **#3867 (control)** | **PASS** | 1295 → 108 (**−1187**) | 660 → 1865 (**+1205**) |

Both failing runs and the passing control show the same ~1,200-row swing.

**That the passing control exhibits it too is the load-bearing observation.** It
proves the swing is (a) not caused by the PR under test, and (b) not
verdict-driving. Which is precisely what makes it dangerous: it is invisible in
the pass/fail signal, so nothing surfaces it, and it sits in every report waiting
to be misread as a finding.

## Why the freshness check misses it

The gate emits:

```
Baseline is CONTENT-CURRENT (#2562): 0 test262-relevant commits behind,
despite 106m clock age — ratio gate waiver enabled.
```

and then:

```
❌  LIKELY-REAL REGRESSION (baseline content-current, #2562)
    0 test262-relevant commits separate the baseline from main HEAD ...
    the baseline reflects current src, so these regressions are far more
    likely PR-caused than baseline drift. Do not dismiss them.
```

`CONTENT-CURRENT` is a statement about **commit lineage** — how many
test262-relevant commits separate the baseline from `main` HEAD. It is *not* a
statement about whether the baseline and the candidate ran the **same effective
skip configuration**. A baseline can be zero commits behind and still have been
produced under a different skip policy. The check is structurally incapable of
detecting that, yet its wording ("the baseline reflects current src") invites the
reader to conclude the opposite.

## The near-miss this caused (include this — the next reader will repeat it)

While triaging #3871, this ~1,200-row `skip`→`compile_error` swing looked like a
substantial finding and was nearly handed to the implementing dev as a lead. It
would have cost a wasted investigation into a defect they did not cause. The only
thing that prevented it was pulling the **passing** control's artifact and seeing
the identical swing there.

The generalisable rule: **a large delta is not a finding until you have checked
it against a run that passed.**

## This is the seventh member of a family seen in one session

A signal that reports itself as authoritative and is not:

- a green CI job that ran no measurement (`SHARDS_RAN: false` — #3881)
- `prunable` on live worktrees
- `$?` read through a pipe (reports the last command's status, not the one you meant)
- "granted by \<other issue\>" allowances that grant nothing
- a short-SHA `actions/runs?head_sha=` query silently returning 0 runs
- a regression **bucket signature** that is not stable across re-runs of identical source
- **`CONTENT-CURRENT` on a configuration-stale baseline (this issue)**

The pattern is the useful part: in each case the mechanism advertises validity it
does not possess, so the failure is silent and the reader is actively misled
rather than merely uninformed.

## Proposed fix

Either, in order of preference:

1. **Compare effective skip-configuration, not just commit lineage.** Record the
   skip policy (feature-skip list, harness flags, runner config) in the baseline
   metadata and have the freshness check assert equivalence. `CONTENT-CURRENT`
   should mean "same source *and* same measurement configuration."
2. **Cheaper, and worth doing regardless: surface `skip`-delta as a first-class
   warning.** A ~1,200-row swing must not be able to hide inside
   `compile_error`. If `|Δskip|` exceeds a small threshold, emit an explicit
   warning that the baseline and candidate did not measure the same test set,
   and state that `compile_error` counts are correspondingly inflated.

Option 2 alone would have prevented the near-miss above.

## Acceptance criteria

- [ ] A baseline whose skip configuration differs from the candidate's is NOT
      reported as `CONTENT-CURRENT`, or is reported with an explicit
      configuration-mismatch warning.
- [ ] The regression report surfaces `skip`-delta prominently when it is large,
      rather than leaving it to be inferred from a `compile_error` swing.
- [ ] The `LIKELY-REAL REGRESSION` banner does not assert "the baseline reflects
      current src" when only commit lineage has been checked.

## Notes

Filed 2026-07-31 by the PR shepherd from artifact evidence gathered while
triaging #3871. **This issue does not affect #3871's verdict** — the control
(#3867) shows the noise floor for `other`-category regressions is 0, so #3871's
stable ~28 remain genuinely PR-attributable. The two findings are independent and
should not be conflated.

Id reserved via `scripts/claim-issue.mjs --allocate`.
