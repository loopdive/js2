---
name: reference-silent-empty-is-indistinguishable-from-real
description: "The dominant defect family in this project — a tool returning empty/zero/green looks identical to a tool returning a real result, and no line records which happened. Eight measured instances; the cure is always the same"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-01T11:43:57.835Z
  modified: 2026-08-01T10:10:12.701Z
---

## Recurring instance: un-awaited async `compile()` scores a fictitious 100% failure

**Hit by two independent agents in one session (2026-08-01).** `compile()` in
`src/index.ts` is **async**. A probe that forgets `await` gets a Promise, reads
no `.wasm`/`.errors` off it, and scores **every case as a compile failure** —
a clean, plausible, completely fictitious result (one agent scored 28/28
`compile_error`; another read every case as a compile failure and nearly
triaged the wrong defect).

It is the perfect silent-empty: 100% failure looks exactly like "this feature
is entirely broken", which is often the very hypothesis being tested.

**Guard:** have the probe **throw on a malformed result** rather than treating
a missing `.wasm` as a failure — `if (!r || typeof r.then === "function" ||
!("errors" in r)) throw new Error("probe: compile() result malformed")`. And
keep a **known-passing control row** in every probe: if the control also
"fails", the instrument is broken, not the subject.

**The benign-looking outcome is indistinguishable from the broken one, and
nothing records which happened.** Eight measured instances in a single session
(2026-07-25/26). Treat this as the default hypothesis whenever a result looks
clean.

| # | instrument | benign reading | truth |
|---|---|---|---|
| 1 | `grep` on `scripts/diff-test262.ts` | "the valve doesn't exist" | file binary-classified despite UTF-8 — **use `grep -a`** |
| 2 | `gh run view --log-failed` | "no failure found" | log expired; returns empty |
| 3 | `${PIPESTATUS:-$?}` under `sh` | `EXIT=0` for **every** case | bashism returning `sed`'s status; table asserted nothing |
| 4 | `trap-growth-allow` reader | "ceiling too small" | **never read** (gated behind `forwardOracleBump`) |
| 5 | `regressions-allow` reader | gate refused, no mention | **never read** (rebase-mode only) |
| 6 | merge_group regression gate | a park = "your change regressed" | baseline cloned **at step time**; verdict depends on wall-clock (#3648) |
| 7 | `mergeable` field | PR looks healthy, `cla-check` green | wedged at `null`; **`pull_request` workflows never fired** |
| 8 | a CI watcher | "0 pending ⇒ checks finished" | only 2 checks had **started** — **RECURRED 2026-08-01**: the required jobs had not been **created**, so the pending list enumerated only jobs that *exist* and was empty for that reason. Cure: floor the required-check COUNT and pin the watcher to the expected SHA |
| 9 | `__vec_len` discriminator | `typeof … === "number"` true | not-a-vec default is `i32.const 0` — vacuously true |
| 10 | a corpus sweep | "0 spurious firings" | a concurrent arm had swapped in an instrumented harness |

## The generalised form — it is not only about EMPTY results

**A proxy that returns a plausible number for a question it is not answering.**
That shape caught the lead, a census author, and three separate agents in one
session. Six premises dissolved under measurement, each individually reasonable:

- `git log @{u}..HEAD` to find *unpushed* commits — on a branch tracking
  `origin/main` it answers *"how far ahead of main?"* and reports 2 for a fully
  pushed branch.
- A probe reading `'x' in o` **after** a `delete` that throws — the expression
  never evaluates, so the recorded value is a swallowed-exception artifact.
- Filtering a vacuity sweep on *"cites a test262 number"* — **excludes 234 of
  414 candidates**, because *"the tests pass now"* is the same defect with no
  digits in it.
- An expectation encoding where every case **and the sentinel** map to `0`.
- Varying descriptor *literal* shape but never `new`-construction — the axis the
  real population actually used.
- Sizing a cohort from a date range someone handed you rather than the corpus
  (~20 → 996 → 414 of 2,668 `done`; every correction upward).

**Make the check REQUIRED, not remembered.** It caught every one of these and
costs one script. Remembering it did not work — the rule was known and missed
anyway, by people who had stated it earlier the same session.

## Named sub-shape: TREATING A COMPLEMENT AS A CATEGORY

Published twice by the same agent, and inherited once by another — the most
repeated single error of the session:

> `332 = 1066 − 734`, then labelled *"the non-`verifyProperty` failures"*.

`1066 − 734` is only *"everything that is not sole-enumerability-clause"*. The
real partition was **734 / 304 / 28** — 304 of the "unowned" set was the **same**
`verifyProperty` family failing on different clauses. A whole phantom work
programme was scoped from the arithmetic.

Same shape produced 852 / 838 / 734, where three population figures were computed
with **filters that do not compose** and quoted interchangeably; the correct
figure was the **intersection**.

**Rule: a complement is not a category. Verify the partition SUMS to the whole
before reasoning about any part of it.** If it doesn't sum, a filter doesn't
compose.

## Why cross-checking beats self-checking

Neither agent caught their own error. One withdrew an explanation on a `grep` the
other ran; the other withdrew a population figure on a reconstruction the first
ran. Each had verified the thing they thought was load-bearing and still missed
the actual gap.

⇒ **Report a contradiction to the other party rather than reconciling it
yourself.** A reconciliation you author is another proxy; a contradiction handed
over gets tested by someone whose instrument has different blind spots. Every
correction that landed this session came from the other side.

## The one-line test — apply BEFORE running any check

> **A verification is only worth running if you can say in advance what result
> would falsify it.**

The whole family reduces to this. Every instance below is **a check whose
passing state is indistinguishable from its vacuous state** — and you can detect
that in advance, for free, by asking what a failure would look like. If you
can't answer, the check is decorative.

Three instances in one session came from two agents **while each was checking
someone else's work**:
- `grep -cE "externref|widen"` run on a file named **`object-shape-widening.ts`** — 63 hits, proving nothing.
- `git stash push -- <file>` printing *"No local changes to save"* because the change was already **committed**, so the run labelled *"fix reverted"* still contained the fix. Two runs agreed; the agreement was meaningless.
- A regex that never captured the token it was asserting on, so it passed **by absence**.

## `contents` API on a big directory: empty = TRUNCATION, not absence (2× in one day, 2026-08-02/03)

`gh api repos/<o>/<r>/contents/plan/issues --jq '.[].name' | grep '^NNNN'` came
back EMPTY for files that were ON MAIN — the endpoint caps at 1000 entries and
`plan/issues/` holds 4000+. Two independent near-misses in one session (one
almost reported a live id collision that had already been resolved). The
canonical "does main contain X" check is the git tree API **with an explicit
truncation check**:

```bash
gh api "repos/<o>/<r>/git/trees/main?recursive=1" --jq '.truncated'  # must be false
# then grep the tree for the path; or fetch the exact path via contents/<full/path>
```

A single exact-path `contents/<dir>/<file>` GET is also safe (404 = absent).
Never grep a listing that can silently cap.

## An HONEST negative from an unvalidated instrument is still unvalidated (2026-08-03, #4096)

An agent marked "all 463 single-statement `ref.null.extern` push sites across
60 files", got no marker hit on the repro, and honestly reported "the null
comes from another spelling — not one of these sites." The next agent pinned
the emit site by chokepoint instrumentation **on the first try** — and it WAS
a plain single-statement push, squarely inside the class the sweep claimed to
cover. **The sweep's negative was an instrument failure**: it had no positive
control (mark a site KNOWN to be reached; confirm the marker fires through the
same build/run path). The honesty of the report ("not pinned, here is what was
ruled out") was real and still valuable — but "ruled out" was itself a result
from an unproven tool, and it misdirected the follow-up brief. Rule: a
negative sweep without a fired positive control rules out NOTHING; say "the
sweep found nothing AND was not validated" — those are different handoffs.

The same agent had built structural positive controls into an instrument hours
earlier and then failed to apply the principle three feet away. **Knowing the
rule does not protect you; running the falsifiability test does.**

## Two git/GitHub instances that are NOT about probes

**1. A PR's `commits` list and `headRefOid` are NOT evidence those commits
merged.** A merge can **race a push**: GitHub merges the tip it had, and the PR
object afterwards reports a commits list and head SHA that were **never
merged**. The head then looks "stuck" — it isn't; it is showing a commit that
was left behind.

> Observed 2026-07-26: `gh pr view --json commits` listed a correction commit;
> `git merge-base --is-ancestor <sha> upstream/main` → **not an ancestor**. Only
> the *first* docs commit of the branch merged. Result: `main` published a
> **retracted** characterisation while the correction sat unmerged.

**The only reliable check is `git merge-base --is-ancestor <sha> upstream/main`
plus a content grep for something the change adds or removes.** Never a merge
commit's *title*, never the PR's own metadata. (The lead made the title version
of this mistake in the same session and reported a fix as landed when only docs
had.)

**2. A clean cherry-pick can produce an incoherent file.** Non-overlapping hunks
apply with zero conflicts, so a "Fix (landed)" section landed directly above the
*retracted* matrix it superseded. **A conflict would have warned; silence did
not.** Verify the *content* after a cherry-pick, not that it applied.

In both cases the honest signal came from elsewhere — a CI `ENOENT` on a missing
fixture is what revealed the partial merge.

## `/workspace` IS A SHALLOW CLONE — ancestry checks there fail toward "unique"

**Measured 2026-08-01.** `git rev-parse --is-shallow-repository` → **true** (642 commits
reachable from `origin/main`, 5 boundary points). So `git merge-base` returns nothing and
`git merge-tree` says **`fatal: refusing to merge unrelated histories`** — for **14 of 16**
stash entries, including one whose base commit is *titled* "Merge remote-tracking branch
'origin/main' into …".

> That is the **clone's horizon**, not a fact about the work. Any ancestry-based triage
> reads those 14 as *"not superseded / unique unmerged work"* — the alarming answer,
> produced by a tool that simply cannot see.

Use **server-side** queries instead (`gh api .../compare/A...B`,
`commits?path=<f>&sha=main`) or grep `main` for a distinctive identifier. Validate the
replacement two-sided before trusting it: a commit known to be on main must read
SUPERSEDED, and a known-unmerged branch must read NOT-superseded with exactly its own
files as residual.

**Two more ways a containment check lies, same session:**

- **Renumbering** — the **#3889** issue file (`editions…`) read as absent from main; it
  landed **renumbered as `3892-editions….md`**. Index by post-id slug, not by path.
- **File splits** — `declarations.ts` read 0% contained; the symbols were on main in
  `declarations/import-collector.ts`. Only grepping for the *identifier* settled it.

**And a ratio is not a verdict.** One entry read "PARTIAL, 86% of added lines on main" —
all 26 missing lines were **comments**. Split missing lines into **code vs prose** and read
the code; that turned every ambiguous case into a confident one.

## The cures, in order of power

1. **Positive control.** Never accept an empty/zero/green from a tool you have
   not seen produce a non-empty result **in the same environment, same
   invocation**. Prove the detector *can* say no before believing it said yes.
2. **Floor the expected output.** An emptiness check needs a **minimum expected
   count**, or *"not started"* reads as *"finished"* (#8). "Zero pending" is not
   "done" unless at least N have reported.
3. **Print the provenance.** Not *did it work* but **what did it use, and which
   arm ran**: the baseline commit, the allowance actually consulted, the file
   actually read. Every one of the above collapses to a one-line fact.
4. **Verify by reverting — this is DIFFERENT from a control, and stronger.**
   > *A control proves your **detector** works. Only removing the change proves
   > the **finding was yours**.*

   Both are needed and they answer different questions. Every time an agent was
   wrong about a mechanism in the 2026-07-26 session, **removal is what told
   them — never the reasoning**, which was plausible in every single case.

   The decisive example: a fix that compiled clean, typechecked, and left the
   suite **byte-identical to the merge base**. It looked like work. Only running
   the suite with and without it revealed a total no-op — and a no-op is itself
   evidence (the code path is never reached), so it redirects rather than merely
   disappointing.

   Corollary: **do not buy a ratchet/LOC/regression allowance for a change you
   have not shown moves anything.** An allowance is a permanent floor; a no-op
   is not worth one.
5. **Distinguish absence from failure.** In #7 the signal was *which checks were
   missing*, not any check failing. Required-check **absence** is a signal.

## Corollaries

- **Read the job STATUS, not its NAME.** A job called *"Cancel Test262 after
  quality failure"* with status `skipping` looks exactly like a quality failure.
- **A broken instrument means UNKNOWN, not FALSE** — see
  [[reference_broken_instrument_can_still_give_right_answer]].
- **An unvaried axis is an assumption, not a measurement.**

Related: [[feedback_measure_never_extrapolate]],
[[reference_change_scoped_allowance_wedges_postmerge_promote]],
[[reference_merge_group_gate_reads_a_moving_baseline]],
[[reference_pr_stuck_mergeable_null_only_cla_runs]],
[[reference_abmts_harness_swap_is_not_self_safe]],
[[reference_grep_false_empties_diff_test262]].
