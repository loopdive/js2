---
id: 3644
title: "`trap-growth-allow` is honored on the PR but unreadable in the baseline writers — one landed allowance wedges promotion permanently, forcing the blanket emergency valve"
status: done
sprint: 77
created: 2026-07-26
updated: 2026-07-30
completed: 2026-07-26
priority: high
horizon: m
feasibility: medium
task_type: ci
area: ci, merge-queue
es_edition: multi
goal: release-pipeline
assignee: ttraenkler/opus-loop-b
related: [3596, 3370, 3335, 3189, 3303, 3629, 3634, 3611, 3645]
origin: "Live outage 2026-07-25 19:52 → 2026-07-26. Diagnosed by the tech lead from a parked PR traced back four hops; root cause corrected during implementation (see below)."
---

# #3644 — an allowance must be readable everywhere it is enforced

## Status update — the outage was cleared OPERATIONALLY while this was in flight

**Do not read this issue as the thing that unblocked the queue. It is not.**
Measured 2026-07-26 shortly after the fix was written:

| when (UTC) | what |
| --- | --- |
| 19:54 | `write-run-cache-bot` fails: `previous illegal_cast=74`, `candidate=75`, `(tolerance 0)` |
| 22:43:12 | the same job, re-run, succeeds: `previous=74`, `candidate=75`, **`(tolerance 1)`** |
| 22:44:21 | repo variable `BASELINE_TRAP_GROWTH_ALLOW` reset `1 → 0` |
| 22:46:52 | next promote: `previous=75`, `candidate=75`, `(tolerance 0)` — clean |

So the wedge was cleared by **option (c)** — the repo Actions variable
`BASELINE_TRAP_GROWTH_ALLOW=1` for one cycle, correctly reset one minute later.
Verified: the baseline now reports `illegal_cast` = **75**
(`grep -ac '"error_category":"illegal_cast"'` on the force-fetched JSONL), the
declared test's row is `status: fail`, `error_category: illegal_cast`, and the
variable currently reads `0`. **No manual `workflow_dispatch` is needed, and the
emergency valve is not left open.**

Note the 22:43 log has **no** `using change-scoped per-category ceiling` line —
the tolerance came from `--allow`, not from the declaration. That distinction is
the whole point of this issue:

**What (c) cost, and why this fix still matters.** `BASELINE_TRAP_GROWTH_ALLOW=1`
is a **blanket +1 for every trap category**, unscoped and unverified, for the
duration of the cycle. It banked the growth into the floor rather than attributing
it. Had this fix been in place, #3629's declaration would have been consumed
instead: **scoped to one named test, machine-verified as non-passing on the
baseline, and self-expiring** (later refreshes see no granting issue in their
change-set). Same promotion, but the ratchet stays sharp for every other category
and every other file, and the reason is recorded in the issue file rather than in
a repo variable someone must remember to reset.

So this is a **durability fix, not the unblock**: it stops the *next* correctly
declared allowance from wedging the pipeline and forcing the blunt lever again.

## The rule this violates

**A gate that runs after merge and can only ever say "no" has no repair path.**
The code is already on `main`; refusing to promote does not undo it — it only
blinds every downstream gate and blocks the fix for the very condition it
detects. So any post-merge gate must either be advisory, or read the **same
allowances the pre-merge gate reads**. This one did neither.

## Root cause — one conditional

`scripts/check-baseline-trap-growth.ts` read the change-scoped declaration
**only across a forward oracle bump**:

```ts
let scopedAllow = 0;
if (forwardOracleBump) {                       // ← the entire bug
  const loaded = await readChangeScopedNumericAllowance({ key: TRAP_GROWTH_ALLOW_KEY, … });
```

That is the pre-#3596 rule. #3596 replaced it on the PR side with a
**shape-driven** contract — a declaration carrying a nested `tests:` list is
honoured in *both* modes and machine-verified — but the baseline writers were
never updated. So the same frontmatter was honoured at PR and `merge_group`
level and then ignored by the post-merge writers.

### The hypothesis this replaces

The outage was first diagnosed as *"the promote job runs on a `push` event with
no PR context and cannot read the allowance."* **That is not what happened.**
`resolveChangeBase` (`scripts/lib/change-scope.mjs:68-85`) explicitly handles
`pull_request`, `merge_group`, `push` **and** `workflow_dispatch` via `HEAD^1`
of the synthetic merge commit, and `tests/issue-3303.test.ts:126` already pins
`fetch-depth: 2` on the writer's checkout so that parent resolves. The context
was reachable; the code simply never looked.

**The evidence that distinguishes the two** — from the failing run (job
`89715789577`): the log prints `(tolerance 0)` and **no** `oracle vN → vM: using
change-scoped per-category ceiling` line and **no** reader notes. That is the
allowance *never being read*, not being read and rejected. A wrong root cause
here would have produced a much larger and entirely unnecessary change.

## What it cost (measured)

1. **PR #3629** landed a correct, named, verifiable declaration in
   `plan/issues/2900-…md` for one fail→fail reclassification of
   `test/language/module-code/top-level-await/pending-async-dep-from-cycle.js`.
   Nothing wrong was done.
2. The queue-merge writer hard-failed `illegal_cast 74 → 75`. **Permanently, not
   transiently** — nothing on `main` will ever lower that count again.
3. Baseline froze at 74 while `main` sat at 75. Verified directly against the
   force-fetched baseline: `grep -ac '"error_category":"illegal_cast"'` → **74**,
   and the declared test's row is `status: fail`, `error_category: type_error`,
   `oracle_version: 11` — i.e. genuinely non-passing, genuinely same-oracle.
4. **Cascade:** every later PR's `merge_group` compared merged-state 75 against
   the frozen 74 and failed on a trap belonging to `main`. PR #3627 — `scripts/`
   + `tests/` + `plan/` only, and a healthy **+56 pass** — was parked twice on
   the identical trap on the identical test that `main`'s own writer cites.

**The `merge_group` half needs no separate valve, and must not get one.** It is
a cascade of (2), not a second defect: once promotion succeeds the baseline
becomes 75 and every PR compares 75 vs 75. A per-PR valve would also be *wrong*
in principle — **a change-scoped allowance is correctly unreachable for a change
you did not make.** Fixing the writer fixes both.

## Fix

The declaration's **shape** selects the contract, in every enforcement context —
byte-for-byte the rule `diff-test262.ts` already applies:

| declaration shape | PR / `merge_group` | baseline writers (was) | baseline writers (now) |
| --- | --- | --- | --- |
| `tests:` present | honoured, verified | **ignored unless oracle bumped** | honoured, verified |
| bare `count:` | oracle-bump only | oracle-bump only | oracle-bump only (unchanged) |

Verification is `evaluateTrapReclassification` — the existing pure function, so
the two enforcement points cannot drift: every named test must be non-passing on
the previous baseline (a `pass → trap` transition is a real regression and still
hard-fails), and every file responsible for the growth must be named.

Both writers in `test262-sharded.yml` — `promote-baseline` **and**
`write-run-cache-bot` (the queue-merge writer, which is the one that actually
wedged) — call this one script, so the single change covers both.

### Two secondary fixes in the same PR

- **A false comment.** The header claimed *"The FORCED refresh path bypasses the
  gate."* True of `refresh-baseline.yml` (`:490` guards on `IS_FORCED`), **false
  of `test262-sharded.yml`**, where the wedge lives and there is no force guard
  at all — `force_baseline_refresh` is consulted only by the separate
  `regression-gate` job (hence its narrow "regardless of **regressions**"
  wording) and by an audit step that merely echoes a warning. A comment that
  asserts a guarantee holding in one caller and not another is worse than no
  comment; it is now stated per caller. *(This is the third inert-or-misstated
  mechanism found in one day, alongside the retired `ci-status` feed and
  `refresh-baseline.yml` itself being `disabled_manually`. **Establish that a
  mechanism is live in the caller you mean before relying on it.**)*
- **Silent-vs-loud.** When the gate refuses and no declaration was found, it now
  prints the resolved base, how it was resolved, and the change-set's
  `plan/issues` files — including an explicit *"diff failed — scoping is BROKEN,
  not merely empty"*. Previously "never read" and "read and rejected" looked
  identical in the log, which is why this took four hops to diagnose.

## Validation

Local reproduction of the real row (`.tmp/repro/`, not committed), driven through
the documented `TRAP_GROWTH_ALLOW_FILE` hook so it is hermetic. **Real** exit
codes (the first harness reported a vacuous `EXIT=0` for every case via a `sh`
bashism — `${PIPESTATUS:-$?}` after a pipe returns `sed`'s status; fixed before
drawing any conclusion):

| case | expected | got |
| --- | --- | --- |
| no declaration | fail | **exit 1** — strict ratchet intact |
| the real #3629 declaration (named, same oracle) | pass | **exit 0**, `tolerance 1`, VERIFIED |
| bare `count:`, no oracle bump | fail | **exit 1** — inert, #3370 unchanged |
| names a test that was **passing** on baseline | fail | **exit 1** — not an escape hatch |

A/B against stock `main` with the **identical** declaration file present: stock
exits **1** at `tolerance 0` with no ceiling line (allowance never read); the fix
exits **0** at `tolerance 1` with the VERIFIED note. `tsc --noEmit` clean;
`tests/issue-3303.test.ts` 44/44 pass unchanged.

## ⚠️ This fix does NOT self-trigger (kept for the record — no longer needed)

*Superseded by the status update above: the baseline is already at 75, so no
dispatch is required now. The mechanics below remain true and will matter the
next time a promote needs triggering.*

`test262-sharded.yml`'s `push` trigger carries the `&test262-paths` filter
(`:33-35`). This PR deliberately touches only
`scripts/check-baseline-trap-growth.ts`, which is **not** on that list — that is
what lets it green-skip the shard matrix and land at all (a PR that ran the
shards would hit the very trap it fixes and be parked, as #3627 was).

The same property means **merging it produces no push-triggered run, so the
promote job never fires and the baseline stays at 74.** To take effect it needs a
plain, **non-forced** `workflow_dispatch` of `test262-sharded.yml` on `main`:
that satisfies the `workflow_dispatch` arm of `promote-baseline`'s `if`, runs the
corrected gate, reads and verifies the allowance, promotes to 75, and reopens the
queue. **Nothing is banked or bypassed — every gate still enforces; it is only
being triggered manually.** Strictly better than the two alternatives, both of
which suppress a gate:

- `BASELINE_TRAP_GROWTH_ALLOW=1` for one cycle — banks the growth into the floor.
- a forced `refresh-baseline.yml` dispatch — bypasses the gate by design, **and
  is not available anyway: that workflow is currently `disabled_manually`.**

## Follow-ups

- **#3645** — the regression test. Deliberately **not** in this PR: a file under
  `tests/` pulls the change-set into the shard matrix and would block the very
  fix that unblocks it. Not an oversight.
- **Should `scripts/check-baseline-trap-growth.ts` go on `&test262-paths`?
  RULED: no — on principle, not on expedience.** (Raised during this PR and
  settled, so nobody reopens it as an oversight.) That path list answers exactly
  one question: *could this change alter test **results**, such that the 106-shard
  matrix must re-run?* A gate script cannot alter results — it alters the
  **verdict**. Adding it would (i) charge a full matrix run for every
  gate-logic change, and (ii) **make the gate's own repair path depend on the
  gate passing** — which is precisely the deadlock this issue exists to unwind.
  A gate whose fix is gated by itself has no repair path; that property is the
  bug, and it must not be deliberately re-created in a second place. The correct
  validation for a gate script is **unit tests on its verdicts** (#3645), not the
  shard matrix — the four-row exit-code table above already proves more about
  this gate than a matrix run would. If belt-and-braces is ever wanted, the right
  form is a required check that runs the gate's unit tests, not a paths entry.
- Same family as the open task on `regressions-allow` being rebase-mode only.
  The durable framing for both: **an allowance must be readable everywhere it is
  enforced.**

## Acceptance criteria

- [x] A same-oracle named declaration is honoured by both baseline writers.
- [x] It is **verified**, not trusted — pass→trap and undeclared growth still fail.
- [x] Bare-count semantics unchanged (`effectiveBaselineTrapTolerance` intact,
      its 4 existing assertions still pass).
- [x] The false force-bypass comment corrected per caller.
- [x] A refusal with no declaration prints why the scoping came up empty.
- [ ] Regression test — tracked as #3645.
