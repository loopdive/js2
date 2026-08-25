---
id: 3953
title: "verify the #2097 high-water raise actually executes on a real merge, and make its silence loud — a floor that is too low must stop being cost-free"
status: done
completed: 2026-08-02
sprint: 78
created: 2026-08-01
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
task_type: ci
area: ci, merge-queue, test262
goal: release-pipeline
depends_on: [3611]
related: [2097, 3448, 3467, 1078, 2562]
---

## Resolution 2026-08-02 — #3611's fix WORKS; a THIRD defect downstream of it kept the mark frozen

**Adjudication first, because it was the assigned precondition: #3611 is
correctly `done`. Not regressed, not a false-done, not incomplete in the way it
was suspected of being.** Its fix executes exactly as designed — and saying so
matters as much as the new finding, because a false "false-done" verdict would
have sent someone re-fixing a working fix.

Evidence, by CONTENT rather than by title (a merged PR citing an issue is not
evidence that issue is done — measured 0/26 in this project):

| claim                                         | evidence                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| the fix is on main                            | `957adc7b8` (PR #3938) adds `!cancelled()` + explicit `needs.*.result == 'success'` to `promote-baseline`'s `if:` — read the diff, not the subject |
| **AC1** the job RUNS on a HIT-path landing    | push:main runs `30756312728` and `30755117423` — `promote merged report to main baseline` conclusion **`success`** (pre-fix control: `skipped` ×30) |
| **the raise ITSELF executes**                 | job `91518979710` log: `[standalone-highwater] raised host-free mark 26546 → 27019 (commit de9f10bea…)`                                     |
| **AC3** the mark advanced ON MAIN             | **PARTIAL — 11 raises DID land** (22626 → 25765 → … → 26546 across 2026-08-01T02:57 → 08-02T12:14), then froze                              |

That partial row is the whole story. #3611 predicted the residual risk almost
exactly — _"a job can succeed while its update step no-ops"_ — and the truth is
one layer further out still: **the update step succeeds, and the commit that
carries it is thrown away.**

### The actual gap: the #1951 deferral discards the raise, and its named fallback could not carry it

```
Merge queue has 4 entrie(s) — deferring main-repo baseline summary commit (#1951).
It will land via the next promote on an empty queue or the hourly baseline-summary-sync.
```

The high-water file is written by the raise step and then staged into the **same
atomic main-repo commit** as the baseline summary. When #1951 defers that commit
— which it does whenever the merge queue is non-empty — the raise goes with it.

And the fallback that sentence names **provably could not carry it**:
`grep -c highwater .github/workflows/baseline-summary-sync.yml` → **0**. That
workflow re-derives its file set from the baselines repo, which does not hold the
high-water mark at all, and never staged the file.

So both landing paths were conditional on the same coincidence:

| path                                              | condition                                    |
| ------------------------------------------------- | -------------------------------------------- |
| `promote-baseline` main-repo commit               | merge queue **empty at promote time**        |
| `baseline-summary-sync.yml` hourly fallback       | **never** — file not in its staging set      |

**The mark was load-bearing on an empty-queue coincidence.** Under two-lane
velocity the queue is rarely empty, so it froze.

### Measured motivation (2026-08-02T16:33Z)

| quantity                                       | value                                                    |
| ---------------------------------------------- | -------------------------------------------------------- |
| committed mark                                 | `26546` (`generated_at` 2026-08-02T12:14:07Z)            |
| merge_group current (run `30756313038`)        | `27021`                                                  |
| effective #2097 floor (mark − tolerance 50)    | `26496`                                                  |
| **silent permissive headroom**                 | **525 passes**                                           |
| staleness                                      | **4.3 h / 37 merge commits**                             |

Standalone conformance could have dropped **525 passes** before #2097 fired,
while every run reported green — because a floor that is too LOW never fires.

### What shipped

1. **`baseline-summary-sync.yml` now genuinely IS the fallback the deferral
   claims.** It raises the mark from the baselines repo's own standalone report
   (provenance = that report's `baseline_sha`, the revision actually measured,
   not this job's unrelated checkout sha) and **stages the file**. A stale mark
   is also a third drift axis in the `decide` step, and earns the busy-queue
   bypass at the same 6h floor the summary uses — without that term the two
   guards **deadlock**: promote defers because the queue is busy, and the sync
   skips because the queue is busy and the reports are fresh.
2. **`scripts/check-highwater-staleness.mjs`** — the detector, with a real third
   state (below).
3. **The merge_group `#2097` step now annotates a stale mark** — that is the one
   place in CI holding both the committed mark and a fresh measurement, and it
   already printed the gap as an ordinary log line among thousands. Deliberately
   **non-fatal**: `merge shard reports` is required, and a lagging mark is an
   infrastructure fault, never the queued PR's fault.

### Controls

| control                                                    | result                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| **positive** — replay the real frozen state (26546 vs 27021) | **FIRES**, exit 1, reports floor 26496 / headroom 525      |
| **negative** — mark tracks reality (excess 14 ≤ tol 50)      | quiet, exit 0                                              |
| **negative** — same 475 gap but 30 min old                   | quiet (a promote is plausibly in flight)                   |
| **third state** — mark absent / garbled / current unreadable | **UNKNOWN, exit 2, `::error::`** — never green             |
| **third state** — mark has no parseable `generated_at`       | **UNKNOWN**, not "brand new" (the subtle one)              |
| **defect injection** — delete the `git add` staging line      | **1 of 18** tests fail, and it is the right one            |

Freshness is judged on the artifact's own `generated_at`, never on sha-equality
with the revision that measured it — per the #3988 lesson, a sha check defers
100% of the time because main always advances underneath a long promote.

**Two-writer race.** The mark now has two writers (promote on an empty queue,
and the hourly sync). Both are **raise-only ratchets** — the script rewrites only
when the measured count strictly exceeds the committed one — so any interleaving
yields `max(writes)` and neither can lower the mark. The one real ordering hazard
is writing a value computed against an older committed mark than the one on disk
at commit time, which is why the sync's re-anchor loop discards its snapshot,
re-reads the mark from the freshly fetched tip, and recomputes.

### Deliberately NOT done

**The mark was not hand-seeded.** Re-seeding would make ~475 passes of headroom
non-refundable instantly, and that is a stakeholder decision, not a dev one. If
this fix works the next qualifying sync raises the mark on its own — which is
both the proof and the production positive control. AC5 (`refresh-baseline.yml`
disposition) remains open by design in #3611.

---

# The two halves of #3611 that a code PR cannot close

#3611 fixed the **mechanism**: `promote-baseline` lacked a status-check function, so
GitHub propagated the #3448 HIT-path skip through `merge-report`'s `always()` and into
it, and the #2097 standalone high-water raise was skipped on **30 of 30** available
push:main runs. That change is structural and reviewable.

Two of its acceptance criteria are **not** structural, and are carried here rather than
ticked off the tests.

## 1. Observable verification — the part that must not be inferred

**A structural test asserting the shape of the `if:` is a regression guard, not
evidence the bug is fixed.** It would keep passing while some _other_ propagation path
kept the job skipped. The only thing that settles it is a real merge:

- [ ] After #3611 lands, a **merge-queue landing** produces a `Test262 Sharded`
      `push:main` run whose `promote merged report to main baseline` job has conclusion
      **`success`** — cited **by run id** in this issue.
- [ ] Re-run the same audit that produced the 30/30 (`.tmp/promote-audit.sh` in the
      #3611 branch, or the equivalent: enumerate `push:main` runs of workflow
      `265204744` and print that job's conclusion). Expect `success` on runs after the
      fix; the pre-fix runs stay `skipped` and are the control.
- [ ] Confirm the **effect**, not just the job status: `scripts/check-standalone-highwater.mjs`
      target actually advanced (mark `pass`/`sha` changed on main), because a job can
      succeed while its update step no-ops.

**Do not close this on the tests passing.** That is the whole point of splitting it out.

## 2. Make the silence loud (#3611 AC4)

The reason this survived a week is not that the skip was subtle — it is that
**nothing anywhere reports a skipped raise.** A high-water mark that is too **low**
never fires its gate, so the permissive direction is completely silent. Combined with
two jobs whose names both start `promote …` (one green on all 30 runs, and it is _not_
the one carrying the raise), a reader skimming a run summary sees green and moves on.

- [ ] If the raise is skipped on a `push:main` run, something says so — an annotation
      on the run, or an alert like the existing
      `baseline-floor-staleness-alert.yml` / `trap-tolerance-staleness-alert.yml`.
- [ ] If the committed mark is more than N landings / hours older than the newest
      promoted standalone report, that is reported. There is precedent to copy:
      `baseline-floor-staleness-alert.yml` already does this shape for a sibling
      artifact.
- [ ] The detector must have a **third state**. "Could not determine the mark's age"
      must not render as "fresh" — that is the same false-empty that made the original
      bug invisible, and it is a documented recurring failure in this repo.

**Cheapest useful version:** a step in `promote-baseline` that fails (or annotates)
when the raise did not run, plus a scheduled staleness check on the mark. The bar is
_"a floor that is too low stops being cost-free"_, not full observability.

## 3. Also open, tracked in #3611, NOT here

**AC5 — `refresh-baseline.yml` disposition.** It is `disabled_manually` and **the
reason is unrecorded** (searched `plan/`, `docs/`, `.claude/memory/`; nothing states
one). Re-enabling is a repo-config change with standing effect that restarts an
8-hourly cron, cannot be expressed in a code diff, and would be inferring permission.
It should be its own change with its own justification — and it should come **after**
criterion 1 above confirms the primary path works, because repairing the primary beats
re-enabling a backstop.

AC6 (the runbook naming a lever that returns HTTP 422) is **done** in #3611.

## Why this is a separate issue rather than a checkbox left open

A criterion that can only be verified after merge, on someone else's PR landing, is
invisible if it stays as an unticked box inside a `done` issue — that is how the
original defect stayed unnoticed for a week. Giving it an id gives it an owner and a
queue position.
