# Sprint 54 Retrospective

**Sprint**: 54
**Dates**: 2026-05-23 → 2026-05-23 (single-day compressed cycle, retroactively
tagged at close)
**Theme**: CI infrastructure hardening + agent-driven conflict resolution wave

---

## Results

| Metric | Value |
|--------|-------|
| test262 at start (sprint-54/begin) | 28,842 / 43,159 (66.8%) |
| test262 at close (sprint/54) | 29,239 / 43,159 (67.7%) |
| Net gain | **+397 passes** (+0.9 pp) |
| PRs merged in cycle | ~25 (issue PRs + CI infra + conflict-resolution + planning) |
| Issue files marked done (from S54 plan) | 0 of the planned W1–W3 issues; several issue PRs from S52/S53 carry-over landed instead |
| Sprint plan issues deferred to S55 | 5 (#1553b, #1553c, #1553d, #820d, #1580) plus essentially the whole W1–W3 plan |

(The +397 is computed against the test262 baseline at sprint 53 close, after
the #440 regression revert via #516.)

---

## What landed

The cycle was dominated by three concurrent streams, not the planned wave
structure:

### Stream 1 — CI infrastructure hardening (~10 PRs)

- **#503** bump shards 50 → 115 (the headline throughput win — shards now
  finish in ~45 s each instead of ~95 s)
- **#505** slow-lane shard: sort shard test list by descending duration so
  the longest tests start first and overall wall-time tightens
- **#511** per-ref CI concurrency + auto-retry on `compile_timeout` — the
  single biggest unblocker for queue throughput; before this, queued
  merge_groups kept cancelling each other across unrelated PRs
- **#491** promote-baseline writes ONLY to the `js2wasm-baselines` repo
  (stop double-writing to main, which had been causing baseline drift)
- **#492 / #495 / #496 / #497 / #499** workflow flag chasing around
  `auto-refresh-prs.yml`, `github-actions[bot]` synchronize events, and
  required-check stubs — each one a small fix, all serialised to land
  the right gate behavior
- **#506 / #513 / #514 / #517 / #518 / #519 / #520** further auxiliary
  CI policy + admin-merge cancellation fixes
- **#485** local 16-shards fix (for in-container `local-ci.sh`)

### Stream 2 — Agent-driven conflict resolution wave (13 PRs in parallel)

Sprint 53's hand-off left ~15 PRs blocked on merge conflicts (mostly
`src/codegen/index.ts` + `src/runtime.ts` collisions). A wave of dev
agents was dispatched to resolve them in parallel. Outcome:

- **Resolved and merged**: #502, #509, #404, #403, #379, #392, #394, #395,
  #396, #397, #398, #430, #425, #428, #419, #408 (sprint 53 cap)
- **Net effect**: the PR queue was cleared from ~20 open conflict-blocked
  PRs to a much smaller backlog, with mostly clean spec/runtime work
  remaining

### Stream 3 — Issue PRs (compiler / spec-completeness)

These mostly were S52/S53 carry-over PRs that finally landed today:

- #415 JSX parsing (#1531)
- #416 BigInt-Promise TypeErrors (#1526)
- #429 JSX runtime (#1540)
- #433 dstr init skipped (#1550)
- #434 catch dstr (#1552)
- #436 promise resolution (#1116)
- #437 class static prototype (#846)
- #438 super-call eval (#1551)
- #441 IR async CPS (#1373b)
- #443 dstr default path B (#1543/#1544)
- #454 decl-dstr (#1553e — S53 carry)
- #457 resolver bare-package (#1559 — S53 carry)
- #474 default standard pass rate (#106)
- #483 branch protection v2 (#1525)
- #391 WASI console stderr (#1480)
- #482 string-hash perf (#1580)

### Regression + revert

- **#440** issue-1542 class-dstr-default landed and introduced a **-1,219**
  test262 regression
- **#516** reverted #440 within ~90 min, identified by post-merge baseline
  diff against the sharded run
- **#1589A** filed as a hot-spot diagnosis + skips to keep the queue moving
  until #440 gets a real fix in S55

### Planning & scope

- **#498** Wasm-GC-native bytecode interpreter strategy doc (#1584)
- **#500** sprint 55 planning worktree — added #1586 / #1587 / #1588 to s55
- **#521** close sprint 53, move 5 issues to sprint 54 (the prerequisite
  for this very closeout)

---

## What went well

- **Per-ref concurrency fix (#511) unblocked queue throughput.** Before this
  landed, the GitHub merge queue was a serial pipe — every queued
  merge_group ran the full required-checks suite and admin-merges kept
  cancelling other queued runs. After #511 we ran multiple unrelated PRs
  concurrently against the merge gate; the rest of the day's wave of ~13
  parallel conflict-resolution merges was only possible because of this.
- **Agent-driven conflict resolution worked at scale.** 13 PRs were
  dispatched concurrently to a pool of conflict-resolver dev agents and
  all landed cleanly. The `[CONFLICT]` task pattern (route compiler-source
  conflicts to senior-developer instead of resolving inline) proved its
  worth — no merged PR introduced new compile errors.
- **Regression caught + reverted within 90 min.** #440's -1,219 cost was
  identified by the post-merge baseline diff and reverted via #516 before
  it could compound across other PRs (which were still queued).
- **Auto-retry on `compile_timeout` covers ~95% of CI flake.** Once #511
  landed, the once-painful `compile_timeout` runner-load flakes stopped
  blocking PRs; the queue actually drained.
- **Sprint 55 planning ran in parallel.** While the merge wave was
  in-flight, a planning worktree (#500) added #1586/#1587/#1588 to s55 —
  no context-switching cost to the merge work.

---

## What hurt

- **#440 regression cost an hour to identify + revert.** -1,219 is large
  enough that the post-merge baseline diff fingerprint was obvious, but
  the lag between "PR merged" → "baseline updated" → "diff inspected"
  → "revert PR opened" → "revert merged" was ~90 min. While that
  cleared, ~5 other queued PRs sat blocked because they had merged main
  including #440 and had to be re-based after the revert.
- **Multiple CI infra layers needed flag chasing.** stringref,
  custom-descriptors, `NODE_OPTIONS`, `github-actions[bot]` synchronize
  filtering, `auto-refresh-prs.yml` triggers, baseline-write target —
  each one a separate workflow flag adjustment landing as its own PR.
  Cumulatively this consumed several hours of session attention.
- **Admin-merges kept cancelling queued merge_groups before #517 landed.**
  Before the per-ref concurrency model was deployed, every admin-merge
  fired by a dev (during the conflict-resolution wave) cancelled the
  in-flight merge_group of unrelated queued PRs, causing them to
  re-queue from scratch. This burned ~30 min of CI time per cancellation
  and effectively made the queue serial.
- **The structured W1–W3 spec-compliance plan was not executed.** None of
  the planned big-impact issues (#779b, #821, #1522, #1471, #1042, #1116
  v2 WI1–WI4) were attempted as their planned waves. The cycle was
  reactive (CI fires, conflict resolution, regression revert) rather
  than driven by the spec-completeness goal that the sprint 54 plan
  described.
- **No real DoD evaluation was possible.** The sprint Definition of Done
  (in the plan) listed concrete merge gates for #779b, #1471, async
  cluster, etc. — none of which were touched. The +397 test262 delta
  came from S52/S53 carry-over PRs that finally landed today, not from
  S54-scoped work.

---

## Lessons / changes

1. **Dev-self-merge protocol now waits synchronously** (per #508 — the
   skill's update to block on `gh pr checks` for the full CI cycle
   instead of opening + walking away). This removes the
   tech-lead-as-mailbox handoff that was burning a notification per PR.
2. **Per-ref CI concurrency is the right default.** Branch-level
   concurrency was the wrong model for a merge-queue workflow — the gate
   needs per-ref so that admin-merges and `merge_group` events from
   different PRs don't cross-cancel. Keep this configuration; do not
   revisit.
3. **Auto-retry covers ~95% of CI flake** (#511). The remaining 5% need
   manual triage; do not push the auto-retry depth past 1 attempt
   (otherwise we hide real timeouts).
4. **115 shards is the sweet spot under a 120-runner pool.** 50 shards
   left runners idle; ~120 saturates and starts contending. Settle on
   115 and revisit only if the runner pool size changes.
5. **A compressed cycle is fine for a CI-infra sprint, NOT for a
   spec-compliance sprint.** Today's "sprint" was effectively
   "stabilise the queue + clear conflicts." That's a legitimate goal but
   it shouldn't have been scoped under the S54 plan's spec-completeness
   framing — the W1–W3 issues remain to be done in a future sprint that
   actually dispatches them.
6. **Tag at sprint start, always.** Sprint 53 didn't tag begin, sprint 54
   only got begin retroactively (via this closeout). Add
   `git tag sprint-N/begin && git push origin sprint-N/begin` to the
   sprint-kickoff checklist (same lesson as S53 retro, still not
   automated).

---

## Next sprint (S55) candidates

The compressed-cycle leftovers feed directly into S55:

1. **Revisit #1589A** (real fix for hot-spot A) — today we shipped
   diagnosis + skips, not the actual fix. S55 should dispatch the
   underlying compile-time spike to a dev with a proper repro.
2. **Host-independence series** — #1471 / #1472 / #1473 / #1474 are still
   un-attempted. The plan in sprint 54's body remains accurate; just
   re-target it at S55 with actual wave-1 dispatch.
3. **The 5 carry-over from S53** — #1553b, #1553c, #1553d (destructuring
   decl-mode delegation chain, sequential ownership), #820d
   (async-gen-meth unresolvable cast), #1580 (string-hash perf). All
   moved into `plan/issues/sprints/54/` by PR #521 but not picked up;
   they need to migrate further into `sprints/55/` at S55 planning.
4. **Spec-compliance harvest from the unspent S54 plan** — #779b,
   #821, #1522, #820c residual, #779c, the easy spec batches A/B/C,
   #1116 v2 WI1–WI4. These were sized + spec'd in S54 planning; the
   specs remain valid (compiler hasn't moved in those areas), so they
   can be dispatched directly without re-architecting.
5. **#1042 async-cps.ts module skeleton** — the async-cluster joint
   spec exists in `sprints/53/async-cluster-architect-spec.md`. S55
   should pin the API surface (one-day architect task) and then
   dispatch.
6. **Process change for next CI-infra heavy day**: scope it as a
   "stabilisation cycle" rather than a sprint, and don't pre-plan
   spec-compliance work alongside — the two workloads don't coexist
   well in the same window.

---

## Tag handling

- `sprint-54/begin` created locally at `de610f41d` (PR #408 merge,
  sprint 53 close, 2026-05-23 11:12Z). **Not pushed** — tech lead to
  push.
- `sprint/54` created locally at HEAD on `main`. **Not pushed** — tech
  lead to push.
- This closeout PR (`close-sprint-54-compressed-cycle`) is plan-only —
  no source changes.

## Issue migration into S55

As part of this closeout, 11 issue files were moved into
`plan/issues/sprints/55/` so S55 starts with a clean carry-in
manifest:

- **From s54**: #1589A (Hot Spot A real fix — today landed
  diagnosis+skips via #1589/#509 only, not the underlying fix).
- **From s53 carry-over (via PR #521)**: #1553b/c/d (decl-mode
  destructuring chain), #820d (async-gen-meth `unresolvable` cast).
- **From s52**: #1471/#1472/#1473/#1474 (host-independence series —
  un-attempted in s52, s53, and s54; needs a dedicated runtime-owner
  dispatch in s55).
- **From backlog**: #1130 (Array accessor-observability), #1116
  (Promise resolution v2 — #436 landed a partial slice; the v2 plan
  in the issue body has further WI1–WI8 work outstanding).

Also marked done as part of cleanup:
- s54: #1583 (PR #489), #1589 (PR #509)
- s53: #1580 (PR #482 — landed 2026-05-22 but status never updated)

The s55 sprint.md got a new "Carry-in from sprint 54" section
documenting these arrivals with ownership / dependency notes.
