---
id: 3611
title: "promote-baseline skips on the per-SHA-reuse path, so the #2097 standalone high-water never re-raises on queue merges — the floor drifts permissively, silently"
status: done
completed: 2026-08-01
sprint: 78
created: 2026-07-25
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
task_type: ci
area: ci, merge-queue, test262
goal: release-pipeline
related: [2097, 3467, 3468, 3448, 3592, 2562, 1078, 3601, 3953]
origin: "PR-queue shepherd verification of the #3601 (#3592 RC2) landing, 2026-07-25. Surfaced only because a deliberate ~5,000-test move was being watched."
---

> ## Adjudication 2026-08-02 (from #3953): this issue is CORRECTLY `done`
>
> #3953 was dispatched to determine whether this issue was a **false-done**, a
> **regression**, or an **incomplete fix**, because its exact symptom — a frozen
> high-water mark — was live again on 2026-08-02. **It is none of the three.**
>
> The fix here works. Verified by content, not by title:
>
> - `957adc7b8` (PR #3938) is on main and carries both halves of the `if:` —
>   `!cancelled()` **and** the explicit `needs.*.result == 'success'` terms.
> - **AC1 is now satisfiable with a run id**, which this issue explicitly refused
>   to tick off the structural tests: push:main runs **`30756312728`** and
>   **`30755117423`** show `promote merged report to main baseline` with
>   conclusion **`success`**. The pre-fix `skipped` ×30 audit is the control.
> - The raise itself executes — job **`91518979710`**:
>   `[standalone-highwater] raised host-free mark 26546 → 27019`.
> - **AC3 partially landed for real**: the mark advanced **11 times** on main
>   between 2026-08-01T02:57 and 2026-08-02T12:14 (22626 → 26546). Before this
>   fix it had not moved on a queue merge at all. That is the direct,
>   observable, on-main effect this issue was asking for.
>
> **The live 2026-08-02 symptom has a THIRD, independent cause downstream of
> this one** — the raise runs and writes the file, then the main-repo commit
> carrying it is discarded by the #1951 non-empty-queue deferral, whose named
> fallback (`baseline-summary-sync.yml`) did not stage the high-water file at
> all (`grep -c highwater` → 0). Fixed in **#3953**; the measurement and the
> full evidence table live there.
>
> This issue's own diagnosis anticipated the shape but not the layer: it warned
> that _"a job can succeed while its update step no-ops"_. The update step does
> not no-op — **its commit is thrown away.** Worth recording precisely, because
> the two have identical symptoms and different fixes.

# #3611 — the standalone high-water mark never re-raises on queue merges

## Problem

On the `#3601` landing (`Test262 Sharded` run **`30152055371`**, merge commit
`31139d0a902c`):

```
success  promote root baseline + cache per-SHA for queue merge (#3467/#3468)
skipped  promote merged report to main baseline          ← carries the #2097 raise
```

The skipped job is the one that runs
`check-standalone-highwater.mjs --update`. When it skips, **the high-water mark
does not re-raise.**

This is not the bot-actor guard: the actor was `github-merge-queue[bot]`, which
is the normal actor for a queue merge. The cause is the **per-SHA-reuse (HIT)
path** interacting with the job's gating —
`needs: [merge-report, mg-artifact-probe]`. That job's own comment asserts:

> Both jobs run+succeed on push and workflow_dispatch, so the implicit
> `success()` over `needs` holds (merge-report green-skips on the HIT path —
> still success).

**That assumption did not hold on this run.** `probe merge_group baseline
artifact` succeeded, the shard matrix green-skipped, and the promote job skipped
along with them rather than running.

## Why this is systemic, not a one-off

Every merge-queue landing takes the per-SHA-reuse path — that is the point of
#3467/#3468. If the promote skips there, **the high-water raise never runs on
merges at all.** The only other thing that advances it is the scheduled
`refresh-baseline.yml`.

**And that workflow is currently `disabled_manually`** (verified 2026-07-25:
`gh api repos/loopdive/js2/actions/workflows/265204741` → `state=disabled_manually`;
a `workflow_dispatch` returns **HTTP 422 "Cannot trigger a 'workflow_dispatch' on
a disabled workflow"**).

So **both** paths that can raise the mark are currently inoperative:

| path                                                     | status                 |
| -------------------------------------------------------- | ---------------------- |
| `promote merged report to main baseline` on queue merges | **skips** (this issue) |
| `refresh-baseline.yml` scheduled 8h cron                 | **disabled_manually**  |

The mark can therefore only fall behind. And the failure is **silent in the
permissive direction**: a floor that is too _low_ never fires, so nothing
complains, ever. It surfaced today only because a deliberate ~5,000-test move was
being watched closely; on an ordinary landing nobody would notice.

### The same disabled workflow also breaks the documented wedge recovery

This is worse than a missing maintenance backstop. The runbook's
disaster-recovery lever for a **wedged #1897** is "dispatch
`refresh-baseline.yml` in EMERGENCY mode" — and that dispatch **cannot execute
at all** while the workflow is disabled. It returns HTTP 422 before doing
anything.

So the failure is not only silent, it is **latent in the recovery path**: it
would be discovered _during an actual queue wedge_, which is exactly when there
is no time to discover it, and when the obvious improvisation — re-enabling a
workflow mid-incident in order to run an unconditional, guard-ignoring promote —
is the most dangerous available version of that action.

It was found here only incidentally, while attempting the _scheduled_ (normal)
mode for an unrelated purpose. Nobody had exercised the emergency path since the
workflow was disabled, because by design nobody exercises it until it is needed.

## Measured impact on the #3601 landing

The #2097 gate reads **`full_summary.host_free_pass`** (full corpus:
standard + annex_b + …), not the official-scope number
(`scripts/check-standalone-highwater.mjs`, line 28), and fails only below
**mark − tolerance** (line 60; `tolerance: 50`).

Independently counted from the authoritative standalone JSONLs
(`loopdive/js2wasm-baselines`, 48,088 rows both sides):

|                                                                |                                                           full-corpus `pass` |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------: |
| pre-landing baseline (live)                                    |                                                                   **27,709** |
| post-landing baseline (re-seeded, `baseline_sha 31139d0a902c`) |                                                                   **22,626** |
| measured removal                                               | **−5,083** (the merge_group's own diff reported −5,088; ±5 run-to-run drift) |

Meanwhile the committed mark stayed at the PR's _estimate_, `pass: 19400`,
`sha: "3592-devacuification-estimate"` — so the effective floor was
`19400 − 50 = 19,350` against a reality of 22,626:

**a ~3,276-test permissive gap.** A subsequent standalone regression of up to
~3,276 tests would have cleared #2097 in silence.

## ⚠️ Stale marks mislead — record this precisely

The high-water is a **raise-only** mark, **not** a pass count. It had lagged
since 2026-07-18, and reasoning from it produced _two independent wrong answers_
during this landing:

- Comparing the stale full-corpus mark (25,453) against the fresh **official**
  number (22,394) gives "−3,059 removed". **Wrong twice over** — stale
  denominator _and_ crossed scopes (full-corpus before vs official-scope after).
- The same-scope, same-freshness answer is **27,709 → 22,626 = −5,083/−5,088**,
  i.e. **18.36 %** of the pass set — which reconciles with the independently
  sampled **18.91 % ± 1.57 %**.

The estimate that drove the PR's ceiling was therefore **accurate as a rate** and
missed only in absolute terms, because it was scaled against the lagging mark.
**Denominator staleness, not measurement error** — a materially different lesson,
and the reason this issue exists.

## User-facing consequence

Until the mark and summary are re-synced, the README / landing page advertises
the **estimate** — `18,400 / 43,106 = 42.7 %` — rather than the measured
`22,394 / 43,106 = 51.9 %`. **A ~9-point understatement of standalone
conformance**, visible to anyone reading the project page.

(PR #3603 closes today's instance by committing the promoted measurement with
provenance. It is the correct _remedy_; it is not a _fix_ for the mechanism —
without this issue the same drift resumes on the next queue merge.)

## Acceptance criteria

> **Disposition, 2026-08-01.** The mechanism is fixed here (2, 6). The criteria that
> **cannot be settled by a code diff** — the observable post-merge verification (1, 3)
> and the loudness work (4) — are carried by **#3953** rather than left as unticked
> boxes inside a `done` issue, because an unowned box is exactly how this defect
> survived a week unnoticed. **AC5 is deliberately NOT done** — see the position below.
>
> | #   | criterion                                | status                                                            |
> | --- | ---------------------------------------- | ----------------------------------------------------------------- |
> | 1   | raise runs on a HIT-path landing         | **→ #3953** (needs a real merge + run id)                         |
> | 2   | gating corrected                         | **done** — and the criterion itself was misdirected; see below    |
> | 3   | mark left raised, verified on a merge    | **→ #3953**                                                       |
> | 4   | the silent failure becomes loud          | **→ #3953** (not attempted here)                                  |
> | 5   | `refresh-baseline.yml` disposition       | **open by design** — rationale unrecorded; escalated, not guessed |
> | 6   | runbook stops naming a lever that 422s   | **done** — `docs/ci-policy.md`                                    |
> | 7   | README derives from promoted measurement | untouched by this change                                          |

1. A merge-queue landing that takes the per-SHA-reuse (HIT) path **runs** the
   high-water raise; the mark advances without manual intervention.
2. The `needs`/`if` gating is corrected so the promote job's own documented
   `success()`-over-`needs` assumption actually holds on the HIT path — or the
   raise is moved to a job that reliably runs on queue merges.
3. A landing whose measured `host_free_pass` exceeds the mark leaves the mark
   **raised**, verified on a real merge.
4. The **silent** failure becomes loud: if the raise is skipped or the mark is
   more than one landing stale, something reports it. A floor that is too low
   must stop being cost-free.
5. Decide the disposition of `refresh-baseline.yml` — it is currently
   `disabled_manually`, removing the only backstop. Either re-enable it (its
   scheduled mode is a normal, guard-respecting promote of already-merged main)
   or record explicitly why the repo runs without that safety net.
6. **Correct the runbook.** The documented disaster-recovery lever for a wedged
   #1897 is "dispatch `refresh-baseline.yml` in EMERGENCY mode" — and that
   dispatch **cannot execute today**, because the workflow is disabled
   (HTTP 422). Whatever is decided in (5), the runbook must not continue to
   name a lever that would fail.
7. The README / landing-page standalone number derives from the promoted
   measurement, never from an in-PR estimate.

## The finding, stated first (2026-08-01)

> **The standalone high-water mark has not risen at all in the observable window,
> because BOTH paths that can raise it are dead** — `promote-baseline` skipped on
> **30 of 30** available push:main runs, and `refresh-baseline.yml` has been
> `disabled_manually` for over a week.

That is the finding. The `always()`-skip propagation below is only the _mechanism_,
and the title understates it: this is not "the mark drifts", it is "the mark cannot
move." And because a floor that is too **low** never fires, the whole thing is
invisible from the inside.

## Verification 2026-08-01 — still true, and it is 30/30, not intermittent

Re-verified before touching anything. Two of the three claims hold exactly; the third
(the stated root cause) is **disproved**, and the correct one is different.

### 1. The skip is universal, not occasional — 30 of 30

Audited every `push:main` `Test262 Sharded` run available (30 runs, 2026-07-30 18:17Z →
2026-07-31 23:47Z, `.tmp/promote-audit.sh`):

| jobs                                         | outcome across all 30 runs |
| -------------------------------------------- | -------------------------- |
| `probe merge_group baseline artifact`        | `success` ×30              |
| `merge shard reports`                        | `success` ×30              |
| **`promote merged report to main baseline`** | **`skipped` ×30**          |

Actor was `github-merge-queue[bot]` on all 30. So this is not a rate — **the
high-water raise has not executed on a queue merge in the entire observable window.**

### 2. `refresh-baseline.yml` is STILL `disabled_manually` — the backstop is still gone

`gh api repos/loopdive/js2/actions/workflows/265204741` → `state=disabled_manually`, and
it is **the only non-active workflow in the repo**. Corroborated independently from the
record rather than the API: `git log origin/main --grep="scheduled baseline refresh"` is
**empty** since at least 2026-07-20.

Both rows of this issue's original table are therefore unchanged, seven days on.

### 3. The stated root cause is WRONG — the `if:` is provably TRUE

This issue attributes the skip to the job's `success()`-over-`needs` assumption failing.
Both direct `needs` are `success` on all 30 runs, so that is not it. Nor is the actor
guard, and there is a **positive control in the same run** that settles it:

```yaml
# promote-baseline (SKIPS)
if: (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
    && github.actor != 'github-actions[bot]' && !(… && inputs.ir_first)

# promote root baseline + cache per-SHA (RUNS, success ×30)
if: github.event_name == 'push' && github.actor == 'github-merge-queue[bot]'
```

The second job **runs**, which proves `github.actor == 'github-merge-queue[bot]'` in this
context — so `github.actor != 'github-actions[bot]'` is TRUE, `event_name == 'push'` is
TRUE, and the `inputs.ir_first` clause is TRUE on a push. **Every conjunct of
`promote-baseline`'s `if:` holds, and it skips anyway.** Reading the two `if:`s side by
side is what settles this; reasoning about either one alone does not.

The timing says where the skip comes from:

```
23:47:53Z  run created
23:47:57Z  test262-shard            skipped   (HIT path — matrix green-skipped)
23:47:58Z  mg-artifact-probe        success
23:48:04Z  merge shard reports      success   ← ran only because of its own always()
23:48:04Z  promote merged report    SKIPPED   ← same second, 0 steps, started==completed
```

`promote-baseline` is skipped in the **same second** `merge-report` resolves, having run
zero steps. `merge-report` itself only ran because it carries
`if: always() && …` (line ~932) over a `needs` set whose shards were **skipped**.
So the skip **propagates through** the `always()` job to any dependent that does not
itself use a status-check function — the implicit `success()` on `promote-baseline` is
satisfied and it is skipped regardless.

**Correcting the record matters here**, because acceptance criterion 2 as written
("correct the `needs`/`if` gating so the documented `success()`-over-`needs` assumption
holds") points at an assumption that is not the defect. The gating that needs to change
is the **absence of a status-check function** on `promote-baseline`, and the fix has an
in-file precedent: `merge-report`, the job directly above it in the same chain, already
does exactly this and is exactly why it survives.

### What shipped, and how acceptance must be judged

`promote-baseline`'s `if:` gains `!cancelled()` — the status-check function whose
absence let the skip propagate — **plus explicit `needs.merge-report.result ==
'success'` / `needs.mg-artifact-probe.result == 'success'` terms.** That second half
is not decoration: `!cancelled()` alone re-enables the job unconditionally, so it
would also promote a baseline **after `merge-report` FAILED** — a worse bug than the
stale mark it fixes. The explicit terms restore exactly what the implicit `success()`
was providing. `!cancelled()` rather than bare `always()` so a cancelled run still
cancels.

`tests/issue-3611-promote-baseline-runs-on-hit-path.test.ts` pins both halves, and
each was **positive-controlled by injecting the corresponding defect**: dropping the
`needs.*.result` terms fails only _"still refuses to promote when either dependency
did not succeed"_; removing `!cancelled()` fails only _"does not use bare
`always()`"_. 1 of 7 each, different tests — specific, not merely sensitive. (Writing
that second test also caught a real slicing bug in the test itself: the job's own
prose _explains_ `merge-report`'s `always()`, so a naive substring slice matched the
comment rather than the condition. A substring assertion over YAML is only as good as
its slice.)

> **⚠️ Acceptance here must be OBSERVABLE, not structural.** The test above is a
> **guard against regression**, not evidence the bug is fixed. It asserts the shape
> of the `if:`, and a structural assertion would keep passing while some _other_
> propagation path kept the job skipped. **Criterion 1/3 is satisfied only by a real
> queue merge whose run shows `promote merged report to main baseline` with
> conclusion `success`, cited by run id** — the same audit that produced the 30/30,
> re-run after this lands (`.tmp/promote-audit.sh`). Do not tick it off the tests.

### Why nothing caught it

The failure is silent **in the permissive direction** — a floor that is too low never
fires. Combined with the two jobs having confusingly similar names
(`promote root baseline …` vs `promote merged report to main baseline`), a reader
skimming the run sees a green `promote …` job and moves on. **One of them succeeded on
all 30 runs; the other one is the one that carries the raise.**

### AC5 — position: do NOT re-enable `refresh-baseline.yml` here, and the reason is UNRECORDED

Searched `plan/`, `docs/` and `.claude/memory/` for why it was switched off. **Nothing
states a rationale.** Recording that as _unknown_ rather than guessing, because the
honest answer to "why is this off?" is load-bearing: a workflow someone deliberately
disabled may have been disabled for a reason that still holds, and silently
re-enabling a **main-pusher** is precisely the class #3915 just had to gate.

Three reasons this issue should not flip it:

1. **Repairing the PRIMARY beats re-enabling a BACKSTOP.** `promote-baseline` is the
   mechanism; `refresh-baseline` is the safety net. Fixing the net while the
   mechanism is broken hides the mechanism's failure again.
2. **Re-enabling is a repo-config change with standing effect** — it restarts an
   8-hourly cron — and it is not something a code PR can even express. It cannot be
   reviewed as part of this diff.
3. **Its rationale is unrecorded**, so re-enabling would be inferring permission.
   ([[reference_untested_recovery_paths_rot_silently]] reaches the same conclusion
   independently: _escalate, don't infer permission_.)

**Proposal:** treat re-enablement as its own change with its own justification, after
criterion 1/3 confirms the primary path works on a real merge. If nobody can state
why it was disabled, that fact should be recorded in the re-enablement request rather
than quietly resolved. #3915 already added the merge-queue gate to its main push, so
whenever it _is_ re-enabled it cannot silently reintroduce the rebuild tax.

### AC6 — the runbook is corrected here

`docs/ci-policy.md` now states, at the point where it lists `refresh-baseline.yml`
among the deploy-key promoters, that the workflow is `disabled_manually` and that a
dispatch returns **HTTP 422 before doing anything** — so the historical "dispatch it
in EMERGENCY mode" lever will not execute. Verified today, and the verification
command is inline so a reader can re-check rather than trust the date.

Two generalisations added alongside it, because the specific line will rot the same
way the last one did:

- **Check a lever is `state=active`, not merely that it exists**, before relying on
  it — with the one-liner that lists every non-active workflow.
- **`gh workflow list` OMITS disabled workflows**, so absence there is not evidence of
  non-existence. That is exactly the false-empty shape that makes this class hard to
  see.

## Notes

- Do **not** reach for `refresh-baseline.yml` EMERGENCY mode for this class of
  problem. EMERGENCY does an **unconditional promote that ignores the regression
  guards**; it exists for a _wedged queue_. Using it to correct a number would
  disable the very guards that make the number trustworthy. The scheduled
  (non-force) mode is the guard-respecting path — when the workflow is enabled.
- Equally, hand-writing a mark is only safe when the value is a **promoted
  measurement with provenance** and the change **self-validates** by clearing its
  own #2097 check in its own merge_group (as #3603 does). An invented floor set
  even slightly high false-fails every later PR and wedges the queue.
- Related: #3592/#3601 (the landing that exposed this), #3610 (the 65 real
  callee defects underneath), #3603 (today's remedy).
